"""ResilientRaleigh API: live Southeast Raleigh gauges, heat, and civic alerts."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from uuid import uuid4

import sentry_sdk
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.db import (
    alert_severity,
    build_simulation_rows,
    close_pool,
    fetch_latest_sensors,
    init_schema,
    insert_flood_alert,
    insert_telemetry,
    ping,
    refresh_rate_aggregate,
)
from app.services.gemini_service import (
    analyze_flood_photo,
    generate_community_alert,
    take_alert_source,
)

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

sentry_sdk.init(
    dsn=os.getenv("SENTRY_DSN") or None,
    traces_sample_rate=1.0,
    environment=os.getenv("SENTRY_ENVIRONMENT", "development"),
    send_default_pii=False,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        init_schema()
    except Exception:
        logger.exception(
            "Tiger Data schema init failed; telemetry routes stay up and return 503 until the database is reachable"
        )
    yield
    close_pool()


app = FastAPI(
    title="ResilientRaleigh",
    summary="Climate equity early warning for Southeast Raleigh.",
    lifespan=lifespan,
)

_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


class AlertRequest(BaseModel):
    neighborhood: str = Field(default="Walnut Creek", min_length=1, max_length=80)
    temp_f: float = Field(default=98.6, ge=-40, le=140)
    water_level_ft: float = Field(default=7.5, ge=-5, le=80)


class CommunityAlertResponse(BaseModel):
    neighborhood: str
    severity: str
    temp_f: float
    water_level_ft: float
    english: str
    spanish: str
    source: str
    created_at: datetime


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "database": "up" if ping() else "down"}


@app.post("/api/telemetry/simulate")
def simulate_telemetry() -> dict:
    """Seed 10 stream-gauge and heat readings along Walnut Creek and Downtown Raleigh."""
    rows = build_simulation_rows()
    try:
        inserted = insert_telemetry(rows)
    except Exception as exc:
        logger.exception("telemetry simulate failed")
        raise HTTPException(status_code=503, detail="telemetry store unavailable") from exc
    try:
        refresh_rate_aggregate()
    except Exception:
        logger.exception("continuous aggregate refresh failed after simulate")
    return {
        "inserted": inserted,
        "records": [
            {
                **row,
                "time": row["time"].isoformat(),
            }
            for row in rows
        ],
    }


@app.get("/api/sensors/live")
def live_sensors() -> dict:
    """Latest gauge and heat metrics for the Southeast Raleigh map."""
    try:
        sensors = fetch_latest_sensors()
    except Exception as exc:
        logger.exception("live sensor query failed")
        raise HTTPException(status_code=503, detail="telemetry store unavailable") from exc
    return {"sensors": sensors, "source": "tigerdata"}


@app.post("/api/alerts/generate", response_model=CommunityAlertResponse)
def generate_alert(body: AlertRequest) -> CommunityAlertResponse:
    """Ask Gemini 1.5 Flash for bilingual Walnut Creek corridor guidance."""
    neighborhood = body.neighborhood.strip()
    english = generate_community_alert(
        neighborhood, body.temp_f, body.water_level_ft, language="en"
    )
    english_source = take_alert_source()
    spanish = generate_community_alert(
        neighborhood, body.temp_f, body.water_level_ft, language="es"
    )
    spanish_source = take_alert_source()
    source = "gemini" if english_source == "gemini" and spanish_source == "gemini" else "fallback"
    severity = alert_severity(body.temp_f, body.water_level_ft)
    created_at = datetime.now(timezone.utc)

    for guidance in (english, spanish):
        try:
            insert_flood_alert(
                alert_id=uuid4(),
                neighborhood=neighborhood,
                severity=severity,
                gauge_reading=body.water_level_ft,
                ai_guidance=guidance,
                created_at=created_at,
            )
        except Exception:
            logger.exception("flood_alerts insert failed; returning guidance anyway")
            break

    return CommunityAlertResponse(
        neighborhood=neighborhood,
        severity=severity,
        temp_f=body.temp_f,
        water_level_ft=body.water_level_ft,
        english=english,
        spanish=spanish,
        source=source,
        created_at=created_at,
    )


@app.post("/api/alerts/analyze-photo")
async def analyze_photo(file: UploadFile = File(...)) -> dict:
    """Run Gemini Vision on a resident flood photo."""
    content_type = (file.content_type or "").lower()
    if content_type and not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="upload an image file")
    payload = await file.read()
    try:
        return analyze_flood_photo(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
