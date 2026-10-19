"""Gemini 1.5 Flash civic alerts and resident flood-photo checks.

Calls are wrapped in a Sentry span named ``ai.gemini.alert_synthesis``. If the
API key is missing or the model call fails, the service returns a clearly
labeled local template so a demo still has something honest to show.
"""

from __future__ import annotations

import json
import logging
import os
import re
from contextvars import ContextVar
from io import BytesIO

import sentry_sdk
from PIL import Image, UnidentifiedImageError

logger = logging.getLogger(__name__)

MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")
_ALERT_SOURCE: ContextVar[str] = ContextVar("resilient_raleigh_alert_source", default="fallback")

_LANGUAGE_NAMES = {
    "en": "English",
    "es": "Spanish",
}

_CIVIC_FACTS = """
Use only these public facts. Do not invent shelters, addresses, or an official order.
- Walnut Creek Greenway floods. Tell people to stay off it and not to drive through water.
- John Chavis Memorial Park, 505 Martin Luther King Jr Blvd, sits north of the Walnut Creek
  floodplain. Mention it only as a place to confirm if the City of Raleigh has opened a
  cooling site. Do not say it is already open.
- Do not send people to the Walnut Creek Wetland Center during high water; it is in the floodplain.
- Residents should confirm cooling sites and any evacuation message with the City of Raleigh
  and AlertWake. You are not issuing an official evacuation order.
""".strip()


def gemini_configured() -> bool:
    return bool(os.getenv("GEMINI_API_KEY"))


def take_alert_source() -> str:
    """Source of the most recent ``generate_community_alert`` call in this task."""
    return _ALERT_SOURCE.get()


def _normalize_language(language: str) -> str:
    code = (language or "en").strip().lower()
    return code if code in _LANGUAGE_NAMES else "en"


def fallback_community_alert(
    neighborhood: str,
    temp_f: float,
    water_level_ft: float,
    language: str = "en",
) -> str:
    """Two-sentence template used when Gemini is not available."""
    code = _normalize_language(language)
    place = neighborhood.strip() or "Southeast Raleigh"
    temp = f"{temp_f:.1f}"
    stage = f"{water_level_ft:.1f}"
    hot = temp_f >= 95
    high_water = water_level_ft >= 4.5

    if code == "es":
        if hot and high_water:
            return (
                f"{place} está a {temp}°F y el medidor de Walnut Creek marca {stage} pies; no use el "
                "sendero ni cruce calles inundadas. Si necesita refrescarse, confirme en AlertWake si "
                "la Ciudad abrió un sitio en John Chavis Memorial Park "
                "(505 Martin Luther King Jr Blvd) antes de ir."
            )
        if hot:
            return (
                f"{place} está a {temp}°F, un calor peligroso donde hay poca sombra, así que limite "
                "el tiempo afuera y tome agua. Confirme en AlertWake si hay un centro de enfriamiento "
                "abierto en John Chavis Memorial Park, 505 Martin Luther King Jr Blvd, antes de salir."
            )
        if high_water:
            return (
                f"Walnut Creek llegó a {stage} pies cerca de {place}; no entre al sendero ni maneje "
                "por agua en las calles bajas. Busque terreno más alto hacia el norte del arroyo, como "
                "la zona de John Chavis Memorial Park, y siga los avisos de la Ciudad en AlertWake."
            )
        return (
            f"{place} está a {temp}°F y el medidor cercano de Walnut Creek marca {stage} pies, sin "
            "una subida que active esta demostración. Mantenga flexible cualquier plan de usar el "
            "sendero y revise AlertWake si se forman tormentas."
        )

    if hot and high_water:
        return (
            f"{place} is at {temp}°F and the Walnut Creek gauge is {stage} ft, so stay off the "
            "greenway and do not drive through flooded streets. If you need to cool down, check "
            "AlertWake to see whether the City has opened a site at John Chavis Memorial Park "
            "(505 Martin Luther King Jr Blvd) before you go."
        )
    if hot:
        return (
            f"{place} is at {temp}°F, hot enough to be dangerous in a low-canopy neighborhood, so "
            "limit time outside and drink water. Confirm on AlertWake whether a City cooling site "
            "is open at John Chavis Memorial Park, 505 Martin Luther King Jr Blvd, before you head over."
        )
    if high_water:
        return (
            f"Walnut Creek is at {stage} ft near {place}, so stay off the greenway and do not drive "
            "through water on low streets. Move toward higher ground north of the creek, around "
            "John Chavis Memorial Park, and follow any AlertWake message from the City."
        )
    return (
        f"{place} is at {temp}°F and the nearest Walnut Creek gauge reads {stage} ft, below this "
        "demo's flash-flood flag. Keep afternoon greenway plans flexible and check AlertWake if storms build."
    )


def _alert_prompt(neighborhood: str, temp_f: float, water_level_ft: float, language: str) -> str:
    language_name = _LANGUAGE_NAMES[language]
    return f"""
You write short civic warnings for ResilientRaleigh, the City of Raleigh's climate equity
early-warning demo for Bloomberg American Sustainable Cities. The neighborhoods in focus are
legacy Southeast Raleigh communities, especially Walnut Creek and Rochester Heights.

Write a friendly warning in {language_name}. Use exactly two sentences. No title, no bullets,
no hashtags, no greeting.
- Sentence 1: what is happening, in plain language, using the readings below.
- Sentence 2: one concrete action a neighbor can take.

Neighborhood: {neighborhood}
Air temperature: {temp_f:.1f} °F
Nearest Walnut Creek stream gauge: {water_level_ft:.1f} ft

{_CIVIC_FACTS}
""".strip()


def _model():
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return None
    import google.generativeai as genai

    genai.configure(api_key=api_key)
    return genai.GenerativeModel(MODEL_NAME)


def generate_community_alert(
    neighborhood: str,
    temp_f: float,
    water_level_ft: float,
    language: str = "en",
) -> str:
    """Return a friendly, two-sentence actionable warning in the requested language."""
    code = _normalize_language(language)
    place = neighborhood.strip()[:80] or "Southeast Raleigh"
    fallback = fallback_community_alert(place, temp_f, water_level_ft, code)

    with sentry_sdk.start_span(
        op="ai.gemini.alert_synthesis",
        description="generate_community_alert",
    ) as span:
        span.set_tag("model", MODEL_NAME)
        span.set_data("neighborhood", place)
        span.set_data("language", code)
        try:
            model = _model()
            if model is None:
                span.set_data("source", "fallback")
                _ALERT_SOURCE.set("fallback")
                return fallback
            import google.generativeai as genai

            response = model.generate_content(
                _alert_prompt(place, temp_f, water_level_ft, code),
                generation_config=genai.GenerationConfig(
                    temperature=0.4,
                    max_output_tokens=256,
                ),
                request_options={"timeout": 20},
            )
            text = (response.text or "").strip()
            text = re.sub(r"\s+", " ", text)
            if not text:
                raise ValueError("Gemini returned an empty alert")
            span.set_data("source", "gemini")
            _ALERT_SOURCE.set("gemini")
            return text
        except Exception:
            logger.exception("Gemini alert synthesis failed")
            sentry_sdk.capture_exception()
            span.set_data("source", "fallback")
            _ALERT_SOURCE.set("fallback")
            return fallback


def _load_resident_photo(image_bytes: bytes) -> Image.Image:
    if not image_bytes:
        raise ValueError("empty image")
    if len(image_bytes) > 8 * 1024 * 1024:
        raise ValueError("image is larger than 8 MB")
    try:
        image = Image.open(BytesIO(image_bytes))
        image.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("file is not a readable image") from exc
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    image.thumbnail((1600, 1600))
    return image


def _fallback_photo(note: str) -> dict:
    return {
        "standing_water_detected": False,
        "estimated_depth_inches": None,
        "depth_reference": "unverified",
        "confidence": "low",
        "hazard_notes": note,
        "recommend_field_alert": False,
        "source": "fallback",
    }


def _coerce_photo_result(payload: dict) -> dict:
    confidence = str(payload.get("confidence", "low")).lower()
    if confidence not in {"low", "medium", "high"}:
        confidence = "low"
    depth = payload.get("estimated_depth_inches")
    depth_value: float | None
    if isinstance(depth, (int, float)) and not isinstance(depth, bool) and 0 <= float(depth) <= 96:
        depth_value = round(float(depth), 1)
    else:
        depth_value = None
    reference = str(payload.get("depth_reference") or "unverified").strip()[:160]
    notes = str(payload.get("hazard_notes") or "").strip()
    if not notes:
        notes = "The model did not describe the water hazard."
    detected = bool(payload.get("standing_water_detected"))
    # A field alert needs a measured depth or at least medium confidence.
    recommend = bool(payload.get("recommend_field_alert")) and detected and (
        depth_value is not None or confidence != "low"
    )
    return {
        "standing_water_detected": detected,
        "estimated_depth_inches": depth_value,
        "depth_reference": reference or "unverified",
        "confidence": confidence,
        "hazard_notes": notes[:500],
        "recommend_field_alert": recommend,
        "source": "gemini",
    }


def _parse_model_json(text: str) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    data = json.loads(cleaned)
    if not isinstance(data, dict):
        raise ValueError("Gemini photo response was not a JSON object")
    return data


def analyze_flood_photo(image_bytes: bytes) -> dict:
    """Estimate standing-water depth from a resident photo. Returns a JSON-ready dict."""
    image = _load_resident_photo(image_bytes)
    unclear = _fallback_photo(
        "This photo was not measured. If you see standing water near Walnut Creek, "
        "stay out of it and do not drive through it."
    )

    with sentry_sdk.start_span(
        op="ai.gemini.alert_synthesis",
        description="analyze_flood_photo",
    ) as span:
        span.set_tag("model", MODEL_NAME)
        span.set_data("image_bytes", len(image_bytes))
        prompt = """
You verify a resident photo for ResilientRaleigh flood early warning in Southeast Raleigh.
Estimate whether standing flood water is visible and how deep it appears.
Return only JSON with these keys:
- standing_water_detected: boolean
- estimated_depth_inches: number or null
- depth_reference: short string naming the visual cue (curb, ankle, tire, wheel, unknown)
- confidence: "low", "medium", or "high"
- hazard_notes: one sentence of plain-language safety context
- recommend_field_alert: boolean, true only when standing water clearly blocks a street or path
Do not invent people, injuries, addresses, or a precise depth the photo cannot support.
If the image is unclear, set confidence to "low" and estimated_depth_inches to null.
""".strip()
        try:
            model = _model()
            if model is None:
                span.set_data("source", "fallback")
                return _fallback_photo(
                    "Gemini Vision is not configured, so this photo was not measured. "
                    "Treat standing water on Walnut Creek streets as dangerous and stay out of it."
                )
            import google.generativeai as genai

            response = model.generate_content(
                [prompt, image],
                generation_config=genai.GenerationConfig(
                    temperature=0.1,
                    response_mime_type="application/json",
                ),
                request_options={"timeout": 25},
            )
            parsed = _coerce_photo_result(_parse_model_json(response.text or ""))
            span.set_data("source", "gemini")
            return parsed
        except Exception:
            logger.exception("Gemini flood-photo analysis failed")
            sentry_sdk.capture_exception()
            span.set_data("source", "fallback")
            return unclear
