"use client";

import dynamic from "next/dynamic";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { demoAlerts, demoPhoto, demoSensors, preparedAlert } from "@/lib/demo-data";
import type { AlertCard, LiveSensor, PhotoAssessment, SensorStatus } from "@/lib/types";

const EquityMap = dynamic(() => import("@/components/EquityMap"), {
  ssr: false,
  loading: () => <div className="h-full min-h-[520px] animate-pulse bg-[#d7e0d8]" />,
});

type Connection = "loading" | "live" | "offline";

const NEIGHBORHOODS = ["Walnut Creek", "Rochester Heights", "South Park", "Downtown Raleigh"];

const STATUS_LABEL: Record<SensorStatus | AlertCard["severity"], string> = {
  ok: "Steady",
  info: "Update",
  watch: "Watch",
  warning: "Warning",
};

async function apiFetch(path: string, init?: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(path, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    window.clearTimeout(timer);
  }
}

function clock(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(new Date(iso));
}

function formatReading(sensor: LiveSensor): string {
  if (sensor.sensor_type === "heat") return `${sensor.value.toFixed(1)}°F`;
  const rise = sensor.rate_of_rise_ft_per_hour;
  const riseText =
    rise == null ? "" : ` · ${rise > 0 ? "+" : ""}${rise.toFixed(1)} ft/hr`;
  return `${sensor.value.toFixed(1)} ft${riseText}`;
}

function readingsFor(neighborhood: string, source: LiveSensor[]) {
  const gauges = source.filter((sensor) => sensor.sensor_type === "stream_gauge");
  const heats = source.filter((sensor) => sensor.sensor_type === "heat");
  const gauge = gauges.find((sensor) => sensor.neighborhood === neighborhood) ?? gauges[0];
  const heat = heats.find((sensor) => sensor.neighborhood === neighborhood) ?? heats[0];
  return {
    water: gauge?.value ?? 7.5,
    temp: heat?.value ?? 98.6,
    waterIsLocal: gauge?.neighborhood === neighborhood,
  };
}

function toCard(payload: {
  neighborhood: string;
  severity: AlertCard["severity"];
  temp_f: number;
  water_level_ft: number;
  english: string;
  spanish: string;
  source: "gemini" | "fallback";
  created_at: string;
}): AlertCard {
  return {
    id: `${payload.created_at}-${payload.neighborhood}`,
    neighborhood: payload.neighborhood,
    severity: payload.severity,
    tempF: payload.temp_f,
    waterFt: payload.water_level_ft,
    english: payload.english,
    spanish: payload.spanish,
    source: payload.source,
    createdAt: payload.created_at,
  };
}

export default function HomePage() {
  const [sensors, setSensors] = useState<LiveSensor[]>([]);
  const [alerts, setAlerts] = useState<AlertCard[]>([]);
  const [connection, setConnection] = useState<Connection>("loading");
  const [neighborhood, setNeighborhood] = useState("Walnut Creek");
  const [tempF, setTempF] = useState("95.4");
  const [waterFt, setWaterFt] = useState("7.5");
  const [generating, setGenerating] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoResult, setPhotoResult] = useState<PhotoAssessment | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  const waterHint = useMemo(() => {
    const localGauge = sensors.some(
      (sensor) => sensor.sensor_type === "stream_gauge" && sensor.neighborhood === neighborhood,
    );
    return localGauge
      ? "Gauge in this neighborhood"
      : "No gauge here — this reading is the Walnut Creek corridor";
  }, [neighborhood, sensors]);

  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      setSensors(demoSensors());
      setAlerts(demoAlerts());
      try {
        const response = await apiFetch("/backend/api/sensors/live");
        if (!response.ok) throw new Error("live sensors unavailable");
        const body = (await response.json()) as { sensors?: LiveSensor[] };
        if (cancelled) return;
        setConnection("live");
        if (body.sensors?.length) {
          setSensors(body.sensors);
        } else {
          setSensors(demoSensors());
          setActionNote("No telemetry stored yet. Seed a storm pulse, or keep these demo pins.");
        }
      } catch {
        if (cancelled) return;
        setSensors(demoSensors());
        setConnection("offline");
      }

      try {
        const response = await apiFetch(
          "/backend/api/alerts/generate",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              neighborhood: "Walnut Creek",
              temp_f: 95.4,
              water_level_ft: 7.5,
            }),
          },
          20000,
        );
        if (!response.ok) throw new Error("alert generator unavailable");
        const body = await response.json();
        if (cancelled || body.source !== "gemini") return;
        setAlerts([toCard(body)]);
      } catch {
        if (!cancelled) setAlerts(demoAlerts());
      }
    }

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  function onNeighborhoodChange(next: string) {
    setNeighborhood(next);
    const readings = readingsFor(next, sensors);
    setTempF(readings.temp.toFixed(1));
    setWaterFt(readings.water.toFixed(1));
  }

  async function onGenerate(event: FormEvent) {
    event.preventDefault();
    const temp = Number(tempF);
    const water = Number(waterFt);
    if (!Number.isFinite(temp) || !Number.isFinite(water)) {
      setActionNote("Enter a temperature and a creek stage.");
      return;
    }
    setGenerating(true);
    setActionNote(null);
    try {
      const response = await apiFetch(
        "/backend/api/alerts/generate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            neighborhood,
            temp_f: temp,
            water_level_ft: water,
          }),
        },
        25000,
      );
      if (response.status === 422) {
        setActionNote("Those readings are outside the range this demo accepts.");
        return;
      }
      if (!response.ok) throw new Error("generate failed");
      const body = await response.json();
      const card = toCard(body);
      setAlerts((current) => [card, ...current.filter((item) => item.source !== "demo")].slice(0, 4));
    } catch {
      setAlerts((current) =>
        [preparedAlert(neighborhood, temp, water), ...current.filter((item) => item.source !== "demo")].slice(0, 4),
      );
      setConnection("offline");
      setActionNote("Alert service is offline. Showing prepared Southeast Raleigh copy.");
    } finally {
      setGenerating(false);
    }
  }

  async function seedPulse() {
    setSeeding(true);
    setActionNote(null);
    try {
      const response = await apiFetch("/backend/api/telemetry/simulate", { method: "POST" });
      if (!response.ok) throw new Error("simulate failed");
      const live = await apiFetch("/backend/api/sensors/live");
      if (!live.ok) throw new Error("live refresh failed");
      const body = (await live.json()) as { sensors?: LiveSensor[] };
      if (!body.sensors?.length) throw new Error("empty live feed");
      setSensors(body.sensors);
      setConnection("live");
      setActionNote("Seeded 10 Walnut Creek and Downtown Raleigh readings.");
    } catch {
      setSensors(demoSensors());
      setConnection("offline");
      setActionNote("Telemetry store is offline. Map is showing the demo pulse.");
    } finally {
      setSeeding(false);
    }
  }

  async function onPhoto(file: File | null) {
    if (!file) return;
    setPhotoBusy(true);
    setPhotoResult(null);
    const preview = URL.createObjectURL(file);
    setPhotoPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return preview;
    });
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await apiFetch("/backend/api/alerts/analyze-photo", { method: "POST", body: form }, 25000);
      if (response.status === 400) {
        const body = (await response.json().catch(() => null)) as { detail?: string } | null;
        setPhotoResult({
          ...demoPhoto(),
          standing_water_detected: false,
          estimated_depth_inches: null,
          confidence: "low",
          recommend_field_alert: false,
          hazard_notes: body?.detail || "That file could not be read as an image.",
          source: "fallback",
        });
        return;
      }
      if (!response.ok) throw new Error("photo analysis failed");
      const body = (await response.json()) as PhotoAssessment;
      setPhotoResult(body);
    } catch {
      setPhotoResult(demoPhoto());
    } finally {
      setPhotoBusy(false);
    }
  }

  return (
    <div className="flex h-screen min-h-[640px] flex-col bg-paper text-ink">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[#e2d8c6] bg-[#fffaf2] px-5 py-3">
        <div>
          <p className="font-display text-2xl leading-none tracking-tight text-pine">ResilientRaleigh</p>
          <p className="mt-1 text-sm text-[#4d5c56]">
            Southeast Raleigh early warning · City of Raleigh
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ConnectionPill connection={connection} />
          <span className="inline-flex items-center gap-2 rounded-full bg-pine px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#f3efe4]">
            <CanopyMark />
            BASC Climate Equity
          </span>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1.7fr)_minmax(360px,0.95fr)]">
        <section className="relative min-h-[520px] lg:min-h-0">
          <EquityMap sensors={sensors} />
          <div className="pointer-events-none absolute bottom-3 left-3 right-3 z-[500] flex flex-wrap gap-2 text-xs">
            <LegendChip swatch="bg-[#2f6f9f]/70" label="Flood corridor" />
            <LegendChip swatch="bg-[#e07a5f]/80" label="Heat vulnerability" />
            <LegendChip swatch="bg-[#d0891f]" label="Flood watch" pulse />
            <LegendChip swatch="bg-[#c23b2e]" label="Flood warning" pulse />
          </div>
        </section>

        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-t border-[#e2d8c6] bg-[#f7f3ea] px-4 py-4 lg:border-l lg:border-t-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="font-display text-xl leading-tight">Citizen alert feed</h1>
              <p className="mt-1 text-sm text-[#4d5c56]">
                English and Spanish guidance for neighbors along Walnut Creek.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void seedPulse()}
              disabled={seeding}
              className="shrink-0 rounded-full border border-[#c8b89a] bg-card px-3 py-1.5 text-sm font-semibold text-pine disabled:opacity-60"
            >
              {seeding ? "Seeding…" : "Seed storm pulse"}
            </button>
          </div>

          {connection === "offline" ? (
            <p className="rounded-lg border border-[#e2d8c6] bg-[#fff6e8] px-3 py-2 text-sm" role="status">
              The sensor service is offline, so this board is showing a Southeast Raleigh demo pulse.
            </p>
          ) : null}
          {actionNote ? (
            <p className="text-sm text-[#4d5c56]" role="status">
              {actionNote}
            </p>
          ) : null}

          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {sensors.map((sensor) => (
              <li key={sensor.sensor_id} className="rounded-lg border border-[#e2d8c6] bg-card px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-semibold">{sensor.name}</p>
                  <StatusDot status={sensor.status} />
                </div>
                <p className="text-xs text-[#4d5c56]">{sensor.neighborhood}</p>
                <p className="mt-1 text-sm">{formatReading(sensor)}</p>
              </li>
            ))}
          </ul>

          <form onSubmit={onGenerate} className="rounded-xl border border-[#e2d8c6] bg-card p-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="text-sm sm:col-span-3">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[#5c6b64]">
                  Neighborhood
                </span>
                <select
                  value={neighborhood}
                  onChange={(event) => onNeighborhoodChange(event.target.value)}
                  className="w-full rounded-md border border-[#d9cdb8] bg-white px-2 py-1.5"
                >
                  {NEIGHBORHOODS.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[#5c6b64]">
                  Temp °F
                </span>
                <input
                  inputMode="decimal"
                  value={tempF}
                  onChange={(event) => setTempF(event.target.value)}
                  className="w-full rounded-md border border-[#d9cdb8] bg-white px-2 py-1.5"
                />
              </label>
              <label className="text-sm sm:col-span-2">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[#5c6b64]">
                  Creek stage, ft
                </span>
                <input
                  inputMode="decimal"
                  value={waterFt}
                  onChange={(event) => setWaterFt(event.target.value)}
                  className="w-full rounded-md border border-[#d9cdb8] bg-white px-2 py-1.5"
                />
                <span className="mt-1 block text-xs text-[#5c6b64]">{waterHint}</span>
              </label>
            </div>
            <button
              type="submit"
              disabled={generating}
              className="mt-3 w-full rounded-full bg-pine px-4 py-2 text-sm font-semibold text-[#f3efe4] disabled:opacity-60"
            >
              {generating ? "Writing guidance…" : "Generate bilingual guidance"}
            </button>
          </form>

          <div className="space-y-3" aria-live="polite">
            {alerts.map((alert) => (
              <article key={alert.id} className="rounded-xl border border-[#e2d8c6] bg-card p-3 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-display text-lg leading-tight">{alert.neighborhood}</h2>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="rounded-full bg-[#f3efe4] px-2 py-0.5 font-semibold uppercase tracking-wide">
                      {STATUS_LABEL[alert.severity]}
                    </span>
                    <time dateTime={alert.createdAt}>{clock(alert.createdAt)}</time>
                  </div>
                </div>
                <p className="mt-1 text-xs text-[#5c6b64]">
                  {alert.tempF.toFixed(1)}°F · creek {alert.waterFt.toFixed(1)} ft · {sourceLabel(alert.source)}
                </p>
                <Message lang="en" label="English" text={alert.english} />
                <Message lang="es" label="Español" text={alert.spanish} />
              </article>
            ))}
          </div>

          <section className="rounded-xl border border-dashed border-[#c8b89a] bg-card p-3">
            <h2 className="font-display text-lg">Resident flood photo</h2>
            <p className="mt-1 text-sm text-[#4d5c56]">
              Upload a street photo to ask Gemini Vision for a standing-water check.
            </p>
            <label className="mt-3 inline-flex cursor-pointer rounded-full border border-[#c8b89a] px-3 py-1.5 text-sm font-semibold text-pine">
              {photoBusy ? "Reading photo…" : "Verify flood photo"}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                onChange={(event) => void onPhoto(event.target.files?.[0] ?? null)}
              />
            </label>
            {photoPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photoPreview} alt="Resident upload preview" className="mt-3 max-h-40 rounded-md object-cover" />
            ) : null}
            {photoResult ? <PhotoResult result={photoResult} /> : null}
          </section>

          <p className="pb-2 text-xs leading-relaxed text-[#5c6b64]">
            Zones are illustrative equity layers for this BASC demo, not FEMA flood maps. Guidance
            does not issue an evacuation order — confirm cooling sites and emergencies with the City
            of Raleigh and AlertWake. Flash-flood pins use a demo threshold of 1 ft/hour over 15 minutes.
          </p>
        </aside>
      </main>
    </div>
  );
}

function sourceLabel(source: AlertCard["source"]): string {
  if (source === "gemini") return "Gemini 1.5 Flash";
  if (source === "fallback") return "Prepared copy · Gemini unavailable";
  return "Demo copy";
}

function ConnectionPill({ connection }: { connection: Connection }) {
  const label =
    connection === "live" ? "Live sensors" : connection === "offline" ? "Demo pulse" : "Checking link";
  const tone = connection === "live" ? "bg-[#2c6b4a]" : connection === "offline" ? "bg-brass" : "bg-[#8aa099]";
  return (
    <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[#4d5c56]">
      <span className={`h-2 w-2 rounded-full ${tone}`} />
      {label}
    </span>
  );
}

function CanopyMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M2 10.5c2.2-.4 3.4-3.4 4.5-8 1.1 4.6 2.3 7.6 4.5 8" fill="none" stroke="#f3efe4" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M1.5 12h11" stroke="#8ec3db" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function LegendChip({ swatch, label, pulse = false }: { swatch: string; label: string; pulse?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[#fffaf2]/95 px-2 py-1 shadow-sm">
      <span className={`h-2.5 w-2.5 rounded-full ${swatch} ${pulse ? "animate-pulse" : ""}`} />
      {label}
    </span>
  );
}

function StatusDot({ status }: { status: SensorStatus }) {
  const tone = status === "warning" ? "bg-[#c23b2e]" : status === "watch" ? "bg-[#d0891f]" : "bg-[#2c6b4a]";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${tone}`} title={STATUS_LABEL[status]} />;
}

function Message({ lang, label, text }: { lang: "en" | "es"; label: string; text: string }) {
  return (
    <p lang={lang} className="mt-3 rounded-lg bg-[#f6f1e6] px-3 py-2 text-sm leading-relaxed">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-brass">{label}</span>
      {text}
    </p>
  );
}

function PhotoResult({ result }: { result: PhotoAssessment }) {
  const depth =
    result.estimated_depth_inches == null
      ? "not measured"
      : `${result.estimated_depth_inches} in (${result.depth_reference})`;
  return (
    <div className="mt-3 text-sm leading-relaxed">
      <p>
        Standing water: {result.standing_water_detected ? "visible" : "not confirmed"} · depth {depth}
      </p>
      <p>Confidence: {result.confidence}</p>
      <p>{result.hazard_notes}</p>
      <p className="text-xs text-[#5c6b64]">
        {result.source === "gemini"
          ? "Read by Gemini 1.5 Flash"
          : result.source === "fallback"
            ? "Gemini did not measure this photo"
            : "Demo sample — this upload was not measured"}
      </p>
    </div>
  );
}
