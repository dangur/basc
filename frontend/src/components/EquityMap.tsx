"use client";

import { useEffect } from "react";
import { MapContainer, Marker, Polygon, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LiveSensor } from "@/lib/types";

const CENTER: [number, number] = [35.755, -78.625];

const WALNUT_CREEK_CORRIDOR: [number, number][] = [
  [35.7695, -78.682],
  [35.7662, -78.655],
  [35.7634, -78.638],
  [35.7612, -78.616],
  [35.7636, -78.594],
  [35.7664, -78.582],
  [35.7592, -78.58],
  [35.7542, -78.598],
  [35.7534, -78.62],
  [35.7516, -78.642],
  [35.7552, -78.668],
  [35.7608, -78.684],
];

const SOUTHEAST_HEAT: [number, number][] = [
  [35.7742, -78.652],
  [35.7742, -78.608],
  [35.7595, -78.598],
  [35.7438, -78.61],
  [35.7424, -78.642],
  [35.7564, -78.656],
];

const DOWNTOWN_HEAT: [number, number][] = [
  [35.7868, -78.655],
  [35.7868, -78.628],
  [35.7708, -78.628],
  [35.7708, -78.655],
];

function MapReady() {
  const map = useMap();
  useEffect(() => {
    const id = window.setTimeout(() => map.invalidateSize(), 80);
    return () => window.clearTimeout(id);
  }, [map]);
  return null;
}

function pinIcon(sensor: LiveSensor): L.DivIcon {
  const tone = sensor.status === "warning" ? "warning" : sensor.status === "watch" ? "watch" : "ok";
  const flash = sensor.sensor_type === "stream_gauge" && sensor.status !== "ok";
  return L.divIcon({
    className: "leaflet-div-icon rr-pin-icon",
    html: `<span class="rr-pin rr-pin-${tone}${flash ? " rr-pin-flash" : ""}"></span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -10],
  });
}

function clock(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(new Date(iso));
}

function rateLabel(rate: number | null): string | null {
  if (rate == null) return null;
  const sign = rate > 0 ? "+" : "";
  return `${sign}${rate.toFixed(1)} ft/hr over 15 min`;
}

export default function EquityMap({ sensors }: { sensors: LiveSensor[] }) {
  const pins = sensors.filter((sensor) => Number.isFinite(sensor.lat) && Number.isFinite(sensor.lng));

  return (
    <MapContainer
      center={CENTER}
      zoom={13}
      scrollWheelZoom
      className="h-full w-full"
      aria-label="Southeast Raleigh flood and heat map"
    >
      <MapReady />
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <Polygon
        positions={WALNUT_CREEK_CORRIDOR}
        pathOptions={{ color: "#1f5f86", weight: 1.5, fillColor: "#2f6f9f", fillOpacity: 0.28 }}
      >
        <Tooltip className="rr-zone-tip" sticky>
          Walnut Creek flood corridor — illustrative screening zone, not a FEMA map
        </Tooltip>
      </Polygon>
      <Polygon
        positions={SOUTHEAST_HEAT}
        pathOptions={{ color: "#b6402c", weight: 1.25, fillColor: "#e07a5f", fillOpacity: 0.2 }}
      >
        <Tooltip className="rr-zone-tip" sticky>
          Southeast heat vulnerability — Rochester Heights, South Park, and Walnut Creek
        </Tooltip>
      </Polygon>
      <Polygon
        positions={DOWNTOWN_HEAT}
        pathOptions={{ color: "#b6402c", weight: 1.25, fillColor: "#e07a5f", fillOpacity: 0.18 }}
      >
        <Tooltip className="rr-zone-tip" sticky>
          Downtown Raleigh heat island — high impervious cover
        </Tooltip>
      </Polygon>
      {pins.map((sensor) => {
        const rise = rateLabel(sensor.rate_of_rise_ft_per_hour);
        const reading =
          sensor.sensor_type === "heat" ? `${sensor.value.toFixed(1)}°F` : `${sensor.value.toFixed(1)} ft`;
        return (
          <Marker
            key={sensor.sensor_id}
            position={[sensor.lat, sensor.lng]}
            icon={pinIcon(sensor)}
            zIndexOffset={sensor.status === "warning" ? 400 : sensor.status === "watch" ? 200 : 0}
          >
            <Popup>
              <div className="text-sm leading-snug">
                <p className="font-semibold">{sensor.name}</p>
                <p>
                  {sensor.neighborhood} · {sensor.sensor_type === "heat" ? "Heat" : "Stream gauge"}
                </p>
                <p className="mt-1">
                  {reading}
                  {rise ? ` · ${rise}` : ""}
                </p>
                {sensor.flash_flood_anomaly ? (
                  <p>15-min rise is at or above the 1 ft/hr demo flag.</p>
                ) : null}
                <p className="text-xs opacity-70">{clock(sensor.time)}</p>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}
