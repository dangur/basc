import type { AlertCard, LiveSensor, PhotoAssessment } from "@/lib/types";

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

/** Same pulse the API seeds, so the board still reads clearly when Tiger Data is down. */
export function demoSensors(): LiveSensor[] {
  const gaugeTime = ago(4);
  const heatTime = ago(2);
  return [
    {
      sensor_id: "wc-gauge-barwell",
      name: "Walnut Creek at Barwell Rd",
      neighborhood: "Walnut Creek",
      sensor_type: "stream_gauge",
      value: 7.5,
      unit: "ft",
      time: gaugeTime,
      lat: 35.7622,
      lng: -78.5924,
      status: "warning",
      rate_of_rise_ft_per_hour: 5.2,
      flash_flood_anomaly: true,
      avg_water_level_ft: 6.85,
    },
    {
      sensor_id: "heat-southpark",
      name: "South Park canopy",
      neighborhood: "South Park",
      sensor_type: "heat",
      value: 102.1,
      unit: "F",
      time: heatTime,
      lat: 35.7694,
      lng: -78.6432,
      status: "warning",
      rate_of_rise_ft_per_hour: null,
      flash_flood_anomaly: false,
    },
    {
      sensor_id: "wc-gauge-saunders",
      name: "Walnut Creek at S. Saunders",
      neighborhood: "Rochester Heights",
      sensor_type: "stream_gauge",
      value: 4.6,
      unit: "ft",
      time: gaugeTime,
      lat: 35.7572,
      lng: -78.6368,
      status: "watch",
      rate_of_rise_ft_per_hour: 4.0,
      flash_flood_anomaly: true,
      avg_water_level_ft: 4.1,
    },
    {
      sensor_id: "wc-gauge-greenway",
      name: "Walnut Creek Greenway at Peterson",
      neighborhood: "Walnut Creek",
      sensor_type: "stream_gauge",
      value: 2.9,
      unit: "ft",
      time: gaugeTime,
      lat: 35.7518,
      lng: -78.6195,
      status: "watch",
      rate_of_rise_ft_per_hour: 2.0,
      flash_flood_anomaly: true,
      avg_water_level_ft: 2.65,
    },
    {
      sensor_id: "heat-rochester",
      name: "Rochester Heights canopy",
      neighborhood: "Rochester Heights",
      sensor_type: "heat",
      value: 98.6,
      unit: "F",
      time: heatTime,
      lat: 35.7642,
      lng: -78.6268,
      status: "watch",
      rate_of_rise_ft_per_hour: null,
      flash_flood_anomaly: false,
    },
    {
      sensor_id: "heat-walnut",
      name: "Walnut Creek neighborhood",
      neighborhood: "Walnut Creek",
      sensor_type: "heat",
      value: 95.4,
      unit: "F",
      time: heatTime,
      lat: 35.7468,
      lng: -78.6145,
      status: "watch",
      rate_of_rise_ft_per_hour: null,
      flash_flood_anomaly: false,
    },
    {
      sensor_id: "heat-downtown",
      name: "Fayetteville Street",
      neighborhood: "Downtown Raleigh",
      sensor_type: "heat",
      value: 93.2,
      unit: "F",
      time: heatTime,
      lat: 35.7789,
      lng: -78.6391,
      status: "ok",
      rate_of_rise_ft_per_hour: null,
      flash_flood_anomaly: false,
    },
  ];
}

function severityFor(tempF: number, waterFt: number): AlertCard["severity"] {
  if (waterFt >= 7 || tempF >= 100) return "warning";
  if (waterFt >= 4.5 || tempF >= 95) return "watch";
  return "info";
}

/** Mirrors the API template used when Gemini is not configured. */
export function preparedAlert(
  neighborhood: string,
  tempF: number,
  waterFt: number,
  createdAt = new Date().toISOString(),
): AlertCard {
  const place = neighborhood.trim() || "Southeast Raleigh";
  const temp = tempF.toFixed(1);
  const stage = waterFt.toFixed(1);
  const hot = tempF >= 95;
  const highWater = waterFt >= 4.5;
  let english: string;
  let spanish: string;

  if (hot && highWater) {
    english = `${place} is at ${temp}°F and the Walnut Creek gauge is ${stage} ft, so stay off the greenway and do not drive through flooded streets. If you need to cool down, check AlertWake to see whether the City has opened a site at John Chavis Memorial Park (505 Martin Luther King Jr Blvd) before you go.`;
    spanish = `${place} está a ${temp}°F y el medidor de Walnut Creek marca ${stage} pies; no use el sendero ni cruce calles inundadas. Si necesita refrescarse, confirme en AlertWake si la Ciudad abrió un sitio en John Chavis Memorial Park (505 Martin Luther King Jr Blvd) antes de ir.`;
  } else if (hot) {
    english = `${place} is at ${temp}°F, hot enough to be dangerous in a low-canopy neighborhood, so limit time outside and drink water. Confirm on AlertWake whether a City cooling site is open at John Chavis Memorial Park, 505 Martin Luther King Jr Blvd, before you head over.`;
    spanish = `${place} está a ${temp}°F, un calor peligroso donde hay poca sombra, así que limite el tiempo afuera y tome agua. Confirme en AlertWake si hay un centro de enfriamiento abierto en John Chavis Memorial Park, 505 Martin Luther King Jr Blvd, antes de salir.`;
  } else if (highWater) {
    english = `Walnut Creek is at ${stage} ft near ${place}, so stay off the greenway and do not drive through water on low streets. Move toward higher ground north of the creek, around John Chavis Memorial Park, and follow any AlertWake message from the City.`;
    spanish = `Walnut Creek llegó a ${stage} pies cerca de ${place}; no entre al sendero ni maneje por agua en las calles bajas. Busque terreno más alto hacia el norte del arroyo, como la zona de John Chavis Memorial Park, y siga los avisos de la Ciudad en AlertWake.`;
  } else {
    english = `${place} is at ${temp}°F and the nearest Walnut Creek gauge reads ${stage} ft, below this demo's flash-flood flag. Keep afternoon greenway plans flexible and check AlertWake if storms build.`;
    spanish = `${place} está a ${temp}°F y el medidor cercano de Walnut Creek marca ${stage} pies, sin una subida que active esta demostración. Mantenga flexible cualquier plan de usar el sendero y revise AlertWake si se forman tormentas.`;
  }

  return {
    id: `prepared-${place}-${createdAt}`,
    neighborhood: place,
    severity: severityFor(tempF, waterFt),
    tempF,
    waterFt,
    english,
    spanish,
    source: "demo",
    createdAt,
  };
}

export function demoAlerts(): AlertCard[] {
  return [
    preparedAlert("Walnut Creek", 95.4, 7.5, ago(3)),
    preparedAlert("South Park", 102.1, 2.9, ago(11)),
  ];
}

export function demoPhoto(): PhotoAssessment {
  return {
    standing_water_detected: true,
    estimated_depth_inches: 6,
    depth_reference: "curb",
    confidence: "low",
    hazard_notes:
      "Demo sample only — this file was not measured. A typical Walnut Creek curb photo in this scenario shows about 6 inches of standing water. Stay out of it.",
    recommend_field_alert: false,
    source: "demo",
  };
}
