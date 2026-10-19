# Project Title: ResilientRaleigh | BASC Climate Equity Engine

### Tagline (140 characters)
Hyper-local stormwater & urban heat early warning system protecting vulnerable Raleigh corridors using Tiger Data time-series, Gemini, and Sentry.

---

### Inspiration
The City of Raleigh was recently selected for the **Bloomberg American Sustainable Cities (BASC)** initiative to address two intersecting crises: **deadly urban heat islands** and **flash flooding** that disproportionately impact legacy neighborhoods in Southeast Raleigh and the Walnut Creek watershed. When sudden summer storms hit, standard regional weather apps fail to capture hyper-local flash flooding in historic communities like Rochester Heights. We built **ResilientRaleigh** to equip Raleigh's BASC Innovation Team and vulnerable residents with real-time, neighborhood-level climate intelligence.

---

### What It Does
ResilientRaleigh acts as a dual municipal command center and community safety net:
1. **Hyper-Local Sensor Intelligence:** Streams high-frequency time-series telemetry from stormwater gauges and microclimate heat sensors across Raleigh's urban core.
2. **Flash-Flood & Heat Anomaly Detection:** Calculates sub-second rate-of-rise metrics along flood-prone corridors (e.g., Walnut Creek Greenway) to detect flash floods 30 minutes before official alerts.
3. **Multilingual AI Citizen Alerts:** When threshold breaches occur, Google Gemini automatically synthesizes plain-language, trauma-informed guidance in English and Spanish, pointing residents to the nearest cooling centers or unflooded evacuation routes.
4. **Citizen Vision Verification:** Residents can upload street photos to verify standing water or downed trees, which Gemini multimodal analyzes to validate municipal dispatch.

---

### How We Built It & Sponsor Integrations

* **City of Raleigh Open Data:** We integrated official Raleigh Open Data layers, including the Urban Tree Canopy assessment, Wake County floodplain boundaries, and Walnut Creek stormwater catchments via Raleigh's ArcGIS REST endpoints.
* **Tiger Data (PostgreSQL / Timescale):** High-frequency stream level and ambient temperature sensor pings are written directly to Tiger Data Hypertables. We leverage standard SQL Continuous Aggregates to compute 15-minute rolling averages and rate-of-rise deltas with zero latency.
* **Google Gemini API:** We power our alert generation engine with Gemini 1.5 Flash. Gemini converts complex telemetry spikes into hyper-local, empathetic neighborhood SMS alerts and performs multimodal visual triage on citizen-submitted flood images.
* **DigitalOcean & Open Model Weights:** Our FastAPI backend services and open-weight spatial classification scripts are containerized and deployed on DigitalOcean infrastructure for seamless scaling.
* **Sentry:** We instrumented our entire stack with Sentry. Sentry traces our Gemini API latency, catches missing GIS polygon coordinate exceptions, and monitors sensor ingestion pipelines to guarantee reliability during severe weather events.

---

### Challenges We Overcame
* **Translating Sensor Noise into Action:** Raw USGS and sensor telemetry is incomprehensible to average citizens. Tuning Gemini's prompt schema to produce clear, calm, and actionable municipal warnings without hallucinating shelter locations was critical.
* **Time-Series Aggregation at Speed:** Computing rapid rate-of-rise metrics during simulated flash flooding required optimizing continuous aggregates inside Tiger Data instead of writing slow application-level query loops.

---

### Accomplishments That We're Proud Of
* Directly aligning an ATO Hackathon project with Raleigh's ongoing Bloomberg Philanthropies sustainability commitment.
* Building a full-stack, end-to-end prototype—from real-time database ingest to interactive map visualization and multimodal AI alerting—under tight hackathon deadlines.

---

### Built With
`python`, `fastapi`, `tiger-data`, `timescaledb`, `postgresql`, `gemini-api`, `google-genai`, `sentry`, `digitalocean`, `next.js`, `tailwind-css`, `leaflet`, `raleigh-open-data`, `gis`
