"""Tiger Data / TimescaleDB access for stream gauges and heat sensors.

Tiger Data speaks the PostgreSQL wire protocol with the TimescaleDB extension.
``DATABASE_URL`` (or ``TIGERDATA_URL``) should be the service connection string.
Locally, ``docker compose up -d`` provides a compatible TimescaleDB instance.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

logger = logging.getLogger(__name__)

LOCAL_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/resilient_raleigh"

# Demo screening threshold for these small urban creeks, not NWS flash-flood guidance.
# NWS guidance is basin-specific rainfall; this flags a 15-minute directional rise
# of at least 1 foot per hour so operators can see a flashy Walnut Creek pulse.
FLASH_FLOOD_FT_PER_HOUR = 1.0

SENSOR_CATALOG: dict[str, dict[str, Any]] = {
    "wc-gauge-saunders": {
        "name": "Walnut Creek at S. Saunders",
        "neighborhood": "Rochester Heights",
        "sensor_type": "stream_gauge",
        "unit": "ft",
        "lat": 35.7572,
        "lng": -78.6368,
    },
    "wc-gauge-greenway": {
        "name": "Walnut Creek Greenway at Peterson",
        "neighborhood": "Walnut Creek",
        "sensor_type": "stream_gauge",
        "unit": "ft",
        "lat": 35.7518,
        "lng": -78.6195,
    },
    "wc-gauge-barwell": {
        "name": "Walnut Creek at Barwell Rd",
        "neighborhood": "Walnut Creek",
        "sensor_type": "stream_gauge",
        "unit": "ft",
        "lat": 35.7622,
        "lng": -78.5924,
    },
    "heat-rochester": {
        "name": "Rochester Heights canopy",
        "neighborhood": "Rochester Heights",
        "sensor_type": "heat",
        "unit": "F",
        "lat": 35.7642,
        "lng": -78.6268,
    },
    "heat-southpark": {
        "name": "South Park canopy",
        "neighborhood": "South Park",
        "sensor_type": "heat",
        "unit": "F",
        "lat": 35.7694,
        "lng": -78.6432,
    },
    "heat-walnut": {
        "name": "Walnut Creek neighborhood",
        "neighborhood": "Walnut Creek",
        "sensor_type": "heat",
        "unit": "F",
        "lat": 35.7468,
        "lng": -78.6145,
    },
    "heat-downtown": {
        "name": "Fayetteville Street",
        "neighborhood": "Downtown Raleigh",
        "sensor_type": "heat",
        "unit": "F",
        "lat": 35.7789,
        "lng": -78.6391,
    },
}

# Stage pairs sit inside one 15-minute bucket so first()/last() yield a real rise.
_GAUGE_PULSE: tuple[tuple[str, float, float], ...] = (
    ("wc-gauge-saunders", 3.6, 4.6),
    ("wc-gauge-greenway", 2.4, 2.9),
    ("wc-gauge-barwell", 6.2, 7.5),
)
_HEAT_PULSE: tuple[tuple[str, float], ...] = (
    ("heat-rochester", 98.6),
    ("heat-southpark", 102.1),
    ("heat-walnut", 95.4),
    ("heat-downtown", 93.2),
)

CREATE_TELEMETRY = """
CREATE TABLE IF NOT EXISTS sensor_telemetry (
    time TIMESTAMPTZ NOT NULL,
    sensor_id TEXT NOT NULL,
    neighborhood TEXT NOT NULL,
    sensor_type TEXT NOT NULL,
    value FLOAT NOT NULL,
    unit TEXT NOT NULL
);
"""

CREATE_TELEMETRY_INDEX = """
CREATE INDEX IF NOT EXISTS sensor_telemetry_sensor_time_idx
    ON sensor_telemetry (sensor_id, time DESC);
"""

CREATE_FLOOD_ALERTS = """
CREATE TABLE IF NOT EXISTS flood_alerts (
    alert_id UUID PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    neighborhood TEXT NOT NULL,
    severity TEXT NOT NULL,
    gauge_reading FLOAT NOT NULL,
    ai_guidance TEXT NOT NULL
);
"""

CREATE_FLOOD_ALERTS_INDEX = """
CREATE INDEX IF NOT EXISTS flood_alerts_created_at_idx
    ON flood_alerts (created_at DESC);
"""

# 15-minute continuous aggregate: average stage plus directional rate of rise.
# rise is (close - open) across samples in the bucket; / 0.25 converts that
# 15-minute change into feet per hour. The boolean flags the demo threshold.
RATE_OF_RISE_CAGG_SQL = """
CREATE MATERIALIZED VIEW IF NOT EXISTS water_level_rate_of_rise_15m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket(INTERVAL '15 minutes', time) AS bucket,
    sensor_id,
    neighborhood,
    AVG(value) AS avg_water_level_ft,
    first(value, time) AS level_open_ft,
    last(value, time) AS level_close_ft,
    (last(value, time) - first(value, time)) AS rise_ft,
    (last(value, time) - first(value, time)) / 0.25 AS rate_of_rise_ft_per_hour,
    ((last(value, time) - first(value, time)) / 0.25) >= 1.0 AS flash_flood_anomaly
FROM sensor_telemetry
WHERE sensor_type = 'stream_gauge'
GROUP BY time_bucket(INTERVAL '15 minutes', time), sensor_id, neighborhood
WITH NO DATA;
"""

# Stricter Timescale versions reject arithmetic over first()/last() inside a
# continuous aggregate. The base view still stores the open and close stage so
# the same feet-per-hour calculation can run in a follow-on query.
RATE_OF_RISE_CAGG_BASE_SQL = """
CREATE MATERIALIZED VIEW IF NOT EXISTS water_level_rate_of_rise_15m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket(INTERVAL '15 minutes', time) AS bucket,
    sensor_id,
    neighborhood,
    AVG(value) AS avg_water_level_ft,
    first(value, time) AS level_open_ft,
    last(value, time) AS level_close_ft
FROM sensor_telemetry
WHERE sensor_type = 'stream_gauge'
GROUP BY time_bucket(INTERVAL '15 minutes', time), sensor_id, neighborhood
WITH NO DATA;
"""

RATE_OF_RISE_POLICY_SQL = """
SELECT add_continuous_aggregate_policy(
    'water_level_rate_of_rise_15m',
    start_offset => INTERVAL '7 days',
    end_offset => INTERVAL '15 minutes',
    schedule_interval => INTERVAL '15 minutes',
    if_not_exists => TRUE
);
"""

RATE_OF_RISE_REALTIME_SQL = """
ALTER MATERIALIZED VIEW water_level_rate_of_rise_15m
    SET (timescaledb.materialized_only = false);
"""

_pool: ConnectionPool | None = None


def database_url() -> str:
    return os.getenv("DATABASE_URL") or os.getenv("TIGERDATA_URL") or LOCAL_DATABASE_URL


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            conninfo=database_url(),
            min_size=0,
            max_size=5,
            timeout=2,
            open=True,
            kwargs={"connect_timeout": 2},
        )
    return _pool


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def _connect_autocommit() -> psycopg.Connection:
    return psycopg.connect(database_url(), autocommit=True, connect_timeout=5)


def _step(conn: psycopg.Connection, sql: str, label: str, *, required: bool) -> bool:
    try:
        conn.execute(sql)
        logger.info("schema ok: %s", label)
        return True
    except Exception:
        logger.exception("schema step failed: %s", label)
        if required:
            raise
        return False


def init_schema() -> None:
    """Create telemetry + alert tables, the hypertable, and the 15-minute aggregate."""
    try:
        conn = _connect_autocommit()
    except psycopg.OperationalError:
        logger.warning(
            "Tiger Data is not reachable; telemetry routes return 503 until DATABASE_URL connects"
        )
        return
    with conn:
        timescale = _step(
            conn,
            "CREATE EXTENSION IF NOT EXISTS timescaledb;",
            "timescaledb extension",
            required=False,
        )
        _step(conn, CREATE_TELEMETRY, "sensor_telemetry", required=True)
        _step(conn, CREATE_TELEMETRY_INDEX, "sensor_telemetry index", required=True)
        _step(conn, CREATE_FLOOD_ALERTS, "flood_alerts", required=True)
        _step(conn, CREATE_FLOOD_ALERTS_INDEX, "flood_alerts index", required=True)
        if not timescale:
            logger.warning(
                "TimescaleDB is not available; sensor_telemetry will stay a plain table"
            )
            return
        _step(
            conn,
            "SELECT create_hypertable('sensor_telemetry', 'time', if_not_exists => TRUE);",
            "sensor_telemetry hypertable",
            required=False,
        )
        created = _step(
            conn,
            RATE_OF_RISE_CAGG_SQL,
            "water_level_rate_of_rise_15m continuous aggregate",
            required=False,
        )
        if not created:
            created = _step(
                conn,
                RATE_OF_RISE_CAGG_BASE_SQL,
                "water_level_rate_of_rise_15m base aggregate",
                required=False,
            )
        if created:
            _step(conn, RATE_OF_RISE_REALTIME_SQL, "realtime aggregate", required=False)
            _step(conn, RATE_OF_RISE_POLICY_SQL, "aggregate refresh policy", required=False)


def ping() -> bool:
    try:
        with get_pool().connection() as conn:
            conn.execute("SELECT 1")
        return True
    except Exception:
        logger.exception("database ping failed")
        return False


def _bucket_sample_times(now: datetime) -> tuple[datetime, datetime]:
    minute = (now.minute // 15) * 15
    start = now.replace(minute=minute, second=0, microsecond=0)
    opened = start + timedelta(minutes=1)
    closed = min(now, start + timedelta(minutes=13))
    if closed <= opened:
        closed = opened + timedelta(minutes=1)
    return opened, closed


def build_simulation_rows(now: datetime | None = None) -> list[dict[str, Any]]:
    """Ten realistic rows: three Walnut Creek gauges sampled twice, plus four heat sensors."""
    moment = now or datetime.now(timezone.utc)
    opened, closed = _bucket_sample_times(moment)
    rows: list[dict[str, Any]] = []
    for sensor_id, level_open, level_close in _GAUGE_PULSE:
        site = SENSOR_CATALOG[sensor_id]
        for sample_time, value in ((opened, level_open), (closed, level_close)):
            rows.append(
                {
                    "time": sample_time,
                    "sensor_id": sensor_id,
                    "neighborhood": site["neighborhood"],
                    "sensor_type": site["sensor_type"],
                    "value": value,
                    "unit": site["unit"],
                }
            )
    for sensor_id, value in _HEAT_PULSE:
        site = SENSOR_CATALOG[sensor_id]
        rows.append(
            {
                "time": moment,
                "sensor_id": sensor_id,
                "neighborhood": site["neighborhood"],
                "sensor_type": site["sensor_type"],
                "value": value,
                "unit": site["unit"],
            }
        )
    return rows


def insert_telemetry(rows: list[dict[str, Any]]) -> int:
    sql = """
        INSERT INTO sensor_telemetry (time, sensor_id, neighborhood, sensor_type, value, unit)
        VALUES (%(time)s, %(sensor_id)s, %(neighborhood)s, %(sensor_type)s, %(value)s, %(unit)s)
    """
    with get_pool().connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(sql, rows)
    return len(rows)


def refresh_rate_aggregate() -> None:
    with _connect_autocommit() as conn:
        conn.execute(
            "CALL refresh_continuous_aggregate('water_level_rate_of_rise_15m', NULL, NULL)"
        )


def status_for(sensor_type: str, value: float, rate_of_rise: float | None) -> str:
    anomaly = rate_of_rise is not None and rate_of_rise >= FLASH_FLOOD_FT_PER_HOUR
    if sensor_type == "stream_gauge":
        if value >= 7.0:
            return "warning"
        if value >= 4.5 or anomaly:
            return "watch"
        return "ok"
    if value >= 100.0:
        return "warning"
    if value >= 95.0:
        return "watch"
    return "ok"


def fetch_latest_sensors() -> list[dict[str, Any]]:
    latest_sql = """
        SELECT DISTINCT ON (sensor_id)
            time, sensor_id, neighborhood, sensor_type, value, unit
        FROM sensor_telemetry
        ORDER BY sensor_id, time DESC
    """
    rich_rate_sql = """
        SELECT DISTINCT ON (sensor_id)
            sensor_id,
            bucket,
            avg_water_level_ft,
            level_open_ft,
            level_close_ft,
            rate_of_rise_ft_per_hour,
            flash_flood_anomaly
        FROM water_level_rate_of_rise_15m
        ORDER BY sensor_id, bucket DESC
    """
    base_rate_sql = """
        SELECT DISTINCT ON (sensor_id)
            sensor_id,
            bucket,
            avg_water_level_ft,
            level_open_ft,
            level_close_ft
        FROM water_level_rate_of_rise_15m
        ORDER BY sensor_id, bucket DESC
    """
    with get_pool().connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(latest_sql)
            readings = cur.fetchall()
            rates = _load_rates(cur, conn, rich_rate_sql, base_rate_sql)

    sensors: list[dict[str, Any]] = []
    for reading in readings:
        site = SENSOR_CATALOG.get(reading["sensor_id"], {})
        rate_row = rates.get(reading["sensor_id"])
        rate_value = _rate_ft_per_hour(rate_row)
        anomaly = bool(rate_value is not None and rate_value >= FLASH_FLOOD_FT_PER_HOUR)
        sensors.append(
            {
                "time": reading["time"],
                "sensor_id": reading["sensor_id"],
                "name": site.get("name", reading["sensor_id"]),
                "neighborhood": reading["neighborhood"],
                "sensor_type": reading["sensor_type"],
                "value": float(reading["value"]),
                "unit": reading["unit"],
                "lat": site.get("lat"),
                "lng": site.get("lng"),
                "status": status_for(reading["sensor_type"], float(reading["value"]), rate_value),
                "rate_of_rise_ft_per_hour": rate_value,
                "flash_flood_anomaly": anomaly if reading["sensor_type"] == "stream_gauge" else False,
                "avg_water_level_ft": (
                    None
                    if rate_row is None or rate_row.get("avg_water_level_ft") is None
                    else float(rate_row["avg_water_level_ft"])
                ),
            }
        )
    rank = {"warning": 0, "watch": 1, "ok": 2}
    sensors.sort(key=lambda item: (rank.get(item["status"], 9), item["neighborhood"], item["name"]))
    return sensors


def _load_rates(cur: Any, conn: Any, rich_sql: str, base_sql: str) -> dict[str, dict[str, Any]]:
    last_error: Exception | None = None
    for sql in (rich_sql, base_sql):
        try:
            cur.execute(sql)
            return {row["sensor_id"]: row for row in cur.fetchall()}
        except Exception as exc:
            last_error = exc
            conn.rollback()
    if last_error is not None:
        logger.warning("rate-of-rise aggregate is not readable yet: %s", last_error)
    return {}


def _rate_ft_per_hour(rate_row: dict[str, Any] | None) -> float | None:
    if not rate_row:
        return None
    stored = rate_row.get("rate_of_rise_ft_per_hour")
    if stored is not None:
        return float(stored)
    opened = rate_row.get("level_open_ft")
    closed = rate_row.get("level_close_ft")
    if opened is None or closed is None:
        return None
    return (float(closed) - float(opened)) / 0.25


def insert_flood_alert(
    *,
    alert_id: UUID,
    neighborhood: str,
    severity: str,
    gauge_reading: float,
    ai_guidance: str,
    created_at: datetime,
) -> None:
    sql = """
        INSERT INTO flood_alerts
            (alert_id, created_at, neighborhood, severity, gauge_reading, ai_guidance)
        VALUES (%s, %s, %s, %s, %s, %s)
    """
    with get_pool().connection() as conn:
        conn.execute(
            sql,
            (alert_id, created_at, neighborhood, severity, gauge_reading, ai_guidance),
        )


def alert_severity(temp_f: float, water_level_ft: float) -> str:
    if water_level_ft >= 7.0 or temp_f >= 100.0:
        return "warning"
    if water_level_ft >= 4.5 or temp_f >= 95.0:
        return "watch"
    return "info"
