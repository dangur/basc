export type SensorStatus = "ok" | "watch" | "warning";

export type LiveSensor = {
  sensor_id: string;
  name: string;
  neighborhood: string;
  sensor_type: "stream_gauge" | "heat";
  value: number;
  unit: string;
  time: string;
  lat: number;
  lng: number;
  status: SensorStatus;
  rate_of_rise_ft_per_hour: number | null;
  flash_flood_anomaly: boolean;
  avg_water_level_ft?: number | null;
};

export type AlertCard = {
  id: string;
  neighborhood: string;
  severity: "info" | "watch" | "warning";
  tempF: number;
  waterFt: number;
  english: string;
  spanish: string;
  source: "gemini" | "fallback" | "demo";
  createdAt: string;
};

export type PhotoAssessment = {
  standing_water_detected: boolean;
  estimated_depth_inches: number | null;
  depth_reference: string;
  confidence: "low" | "medium" | "high";
  hazard_notes: string;
  recommend_field_alert: boolean;
  source: "gemini" | "fallback" | "demo";
};
