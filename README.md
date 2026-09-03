# SPILL2SOURCE — Real-Time Oil-Spill Detection & Vessel Attribution

An automated pipeline that watches a sea area **live**: ingests real-time AIS
traffic, real wind/wave/ocean-current fields, and Sentinel-1 SAR imagery;
detects oil slicks in the imagery; **hindcasts each slick backward to its
release point and time** (and forecasts its drift forward); then ranks the
**suspect vessels** that were around the release point at the release moment,
with per-factor evidence.

Every number in the UI comes from a live feed at the moment you look at it.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  LIVE FEEDS                                                              │
│  • Digitraffic AIS (no key)            → vessel tracks, polled 30 s      │
│  • Open-Meteo wind/marine (no key)     → hourly wind + current fields    │
│  • Copernicus Data Space (free acct)   → Sentinel-1 GRD catalogue        │
│  • Sentinel Hub Process API (free)     → AOI-window SAR rasters only     │
└──────────────┬──────────────────────┬──────────────────────┬─────────────┘
               ▼                      ▼                      ▼
      ┌───────────────┐      ┌──────────────┐      ┌────────────────┐
      │ SAR DETECTION │      │ DRIFT MODEL  │      │  ATTRIBUTION   │
      │ σ⁰ calib →    │      │ Lagrangian   │      │ 7-factor       │
      │ Lee filter →  │      │ particles,   │      │ weighted score │
      │ dark-spot seg │      │ backward to  │      │ of AIS traffic │
      │ → features →  │      │ release pt → │      │ + behaviour    │
      │ oil classifier│      │ forward cone │      │ prior          │
      └───────┬────────┘      └──────┬─────────┘      └───────┬────────┘
              ▼                      ▼                        ▼
        ┌────────────────────────────────────────────────────────────┐
        │  FastAPI + WebSocket  →  dark HUD ops-room dashboard       │
        └────────────────────────────────────────────────────────────┘
```

## Quick start

Prereqs: **Python 3.11+**, **Node.js** (for the one-time dashboard build).

```bash
# 1. Python deps
pip install -r requirements.txt

# 2. Configure — copy the template and add your free accounts
copy .env.example .env
#    CDSE (catalogue + full-products):  https://dataspace.copernicus.eu (2 min, free)
#      set CDSE_USER / CDSE_PASS
#    Sentinel Hub Process API (AOI fast-path, optional but recommended):
#      create an OAuth client under the same CDSE account, set
#      SH_CLIENT_ID / SH_CLIENT_SECRET
#    Optional: API_KEY to require an X-API-Key header on /api/* routes

# 3. Build the dashboard (first run only)
cd frontend && npm install && npm run build && cd ..

# 4. Run
run.bat            # or: python -m uvicorn backend.main:app --port 8000
```

Open **http://localhost:8000**. Within seconds the AIS feed LED goes green
(hundreds of live vessels in the Gulf of Finland), met-ocean fields cache, and
the Sentinel-1 catalogue fills. The newest scene is auto-scanned; click any
scene under **SCENES → scan** to run detection. A detected slick is analysed
automatically (hindcast → origin → suspect ranking) and appears under
**SLICKS**.

When Sentinel-Hub credentials are set, scanning fetches **only the AOI window**
(a few MB) via the Process API instead of downloading the whole multi-GB
product; the full-download path (CDSE) is used automatically as a fallback.

### Configuration (`.env`)

| variable | default | meaning |
|---|---|---|
| `CDSE_USER` / `CDSE_PASS` | — | Copernicus Data Space account (catalogue + full products) |
| `SH_CLIENT_ID` / `SH_CLIENT_SECRET` | — | Sentinel Hub OAuth client (AOI fast-path) |
| `SH_RESOLUTION_M` | `40` | SAR raster resolution fetched via Sentinel Hub |
| `AOI_BBOX` | `21.8,58.9,30.6,60.7` | surveillance rectangle `lon0,lat0,lon1,lat1` |
| `AIS_POLL_SECONDS` | `30` | AIS poll interval |
| `MET_REFRESH_SECONDS` | `3600` | met-ocean refresh interval |
| `SAT_POLL_SECONDS` | `600` | Sentinel-1 catalogue poll interval |
| `DRIFT_HOURS_BACK` / `DRIFT_HOURS_FWD` | `18` / `24` | hindcast / forecast window |
| `PARTICLES` | `600` | Lagrangian particle count |
| `DETECTOR` | `auto` | `auto` (U-Net if `data/unet_model.pt`), `unet`, or `heuristic` |
| `API_KEY` | — | require this on `X-API-Key` (or `?api_key=`) for `/api/*` |
| `SCENE_CACHE_MAX_GB` | `10` | max on-disk scene cache before auto-prune |
| `SCENE_TTL_DAYS` | `7` | delete scenes older than this regardless of status |
| `DB_PATH` / `DATA_DIR` | `data/app.db` / `data` | storage locations |

## How it works

### 1. Detection (Sentinel-1 SAR)

Oil damps capillary/short gravity waves, so slicks appear as dark patches in
SAR backscatter. The pipeline takes `σ⁰`-calibrated backscatter either from a
**Sentinel Hub AOI raster** (VV band preferred, resampled to `SH_RESOLUTION_M`)
or from a **downloaded SAFE product** (`DN→σ⁰` calibration with the product LUT
and warp to the AOI), then: Lee speckle filter → land masking (Natural Earth 10 m)
→ **segmentation** → candidate patches → physics-meaningful features (contrast,
edge sharpness, GLCM homogeneity, shape, isolation) → oil-vs-look-alike scoring.

**Two segmenters, honestly benchmarked** (1,072 held-out tiles from scenes
never seen in training, against Cerulean's masks):

| segmenter | pixel IoU | detection recall | false alarms |
|---|---|---|---|
| **U-Net (trained)** | **0.106** | 0.991 | **398** |
| heuristic threshold | 0.076 | 0.998 | 620 |

On a full scene with a known reference count (Cerulean: 35 slicks), the U-Net
proposed 25 candidates where the heuristic proposed 331. With `DETECTOR=auto`
(default) the U-Net is used when `data/unet_model.pt` exists; delete that file
(or set `DETECTOR=heuristic`) to fall back. Known gap: the downstream
oil-probability classifier was calibrated on heuristic-shaped patches and
under-rates U-Net masks — recalibration is future work.

Training data pipeline: `scripts/build_unet_dataset.py` (selects the Baltic
scenes with the most Cerulean slicks, downloads them via CDSE, extracts
256-px VH σ⁰ tiles + rasterized Cerulean masks, deletes the ~1 GB scenes
afterwards) → `scripts/train_unet.py` (compact 0.48 M-param U-Net, BCE with
positive weighting + Dice loss, best-checkpoint-by-val-Dice) →
`scripts/benchmark_segmenters.py`.

### 2. Drift hindcast / forecast

A Lagrangian particle ensemble is seeded inside the detected slick and advected
by **real hourly fields** (Open-Meteo ocean currents + waves + 10 m wind) with
a leeway model: 3 % windage deflected right 20° (Ekman), 2 % Stokes drift,
random-walk diffusion, RK2 integration in a local tangent-plane (metres) frame.
Integrating **backward** in time converges the ensemble toward the release
area; the spread-vs-time minimum gives the **estimated release point and time**
(the slick's age) with an uncertainty radius. Forward integration gives the
predicted centroid path and a growing **uncertainty cone** for responders.

### 3. Vessel attribution

The system accumulates its own AIS history from first launch. For each origin
estimate it queries every vessel within radius in the release window and scores
**seven weighted evidence factors** (weights sum to 1):

| factor | weight | what it measures |
|---|---|---|
| proximity | 0.33 | closest approach to the estimated release point/time |
| crossing | 0.13 | track intersects the slick footprint or origin cell |
| speed anomaly | 0.13 | drifting / low-speed loitering inside the window |
| AIS gap | 0.13 | AIS silence ("dark event") overlapping the release time |
| course align | 0.11 | heading consistent with the slick elongation axis |
| type prior | 0.09 | vessel-class likelihood of discharging oil |
| behaviour prior | 0.08 | learned prior: open-sea drifting, night loitering, AIS-silence history |

The dashboard shows the ranked leaderboard with each factor's score, weight and
evidence string; click a suspect to draw its track and open a full vessel card.

### 4. Vessel intelligence

Beyond live position, each vessel can be inspected with a rich card built from
three real sources:

- **Metadata** from Digitraffic (name, type, IMO, callsign, dimensions, draught, destination);
- **Flag of registry** decoded from the ITU **MMSI MID** table;
- **Computed history** from the watch's own AIS store: distance sailed (total + 24 h),
  average/max speed, recorded **drift/stop events** (≥15 min under 1 kn), and
  **dark gaps** (AIS silence > 30 min).

(`GET /api/vessels/{mmsi}/details`)

### 5. The dashboard

A dark, glassy **HUD ops-room console**:

- **Full-screen map** with all live AIS traffic, slick polygons, the amber
  hindcast centroid path to the pulsing origin crosshair, and the cyan forward
  forecast cone; over which an optional **RISK LAYER** toggle renders the
  spill-risk probability grid as an amber heatmap (with legend). Basemap
  switcher (dark/Light/OSM) and a VESSELS show/hide toggle are in the top bar.
- **Left dock** with four tabs — **SLICKS** (list + per-slick analysis),
  **SCENES** (catalogue with download/detect status and progress),
  **ALERTS** (event/alert stream), **RISK** (model card + highest-risk cells).
- **Right inspector** auto-switches between a **slick analysis card** (origin,
  age, hindcast path, forecast cone, suspect leaderboard with per-factor
  evidence bars) and a **vessel card** (flag, type, live state, history, stops).
- **Top bar** with per-feed status LEDs (AIS / met / SAR) and system state.
- **Bottom telemetry ticker** (AOI, live vessel count, slick count, scenes).
- Live toast notifications and a **WebSocket** feed (`/ws`) that pushes events,
  scene status, and analysis completions to every connected client.

### 6. Spill-risk prediction layer (AI)

A trained model predicts which sea areas are most likely to accumulate
oil slicks — *before* a slick exists:

- **Training corpus**: 40,000+ historical slick detections (2020–2026) from
  SkyTruth Cerulean's operational Sentinel-1 ML pipeline (`public.slick_plus`
  OGC API, anthropogenic classes), of which ~2,500 fall inside the Gulf of
  Finland AOI across 865 satellite scene-visits.
- **Features per ~5 km cell**: distance to shore (Natural Earth), distance to
  the nearest major oil terminal, distance to high-density AIS traffic lanes,
  live AIS density (`log1p`), plus cell latitude/longitude.
- **Model**: RandomForest classifier; validated with *spatially grouped*
  5-fold CV (longitude bands) — **mean AUC 0.75** at predicting held-out sea
  areas with historical slick occurrence.
- **Serving**: `/api/risk/grid` returns the probability grid; the map's
  **RISK LAYER** toggle renders it as a sequential amber heatmap with a legend;
  the **RISK** tab shows the model card (AUC, feature importances, corpus size)
  and highest-risk cells.

Rebuild the risk layer any time:
```bash
python scripts/fetch_cerulean_slicks.py   # refresh historical corpus
python scripts/train_risk_model.py        # retrain + repopulate the grid
```

Data credit: slick detections © SkyTruth Cerulean (Sentinel-1 ML detections).

### 7. Reliability & housekeeping

- **Crash recovery**: on startup, scenes stuck in `processing` from a prior
  crash are reset to `catalogued`.
- **Compute-then-swap**: a slick's old drift runs/suspects are only deleted
  after the new results are ready.
- **Disk management**: an hourly cleanup loop prunes extracted SAFE dirs after
  processing, enforces `SCENE_CACHE_MAX_GB`, and deletes TTL-expired scenes —
  detection results always live on in SQLite.
- **Optional API auth**: set `API_KEY` to gate `/api/*` routes.

## API

| endpoint | what |
|---|---|
| `GET /api/status` | pipeline health, feed ages, scene & slick counts, disk usage |
| `GET /api/vessels/live` | GeoJSON of current AIS positions in the AOI |
| `GET /api/vessels/{mmsi}/track?hours=18` | one vessel's track history |
| `GET /api/vessels/{mmsi}/details` | rich card: type, flag (MMSI MID), IMO/callsign/dims/draught/destination + computed history (distance, speeds, stop events, dark gaps) |
| `GET /api/scenes` | Sentinel-1 catalogue cache |
| `POST /api/scenes/{product_id}/scan` | run detection (Sentinel-Hub AOI path, else CDSE download) |
| `GET /api/slicks` · `GET /api/slicks/{id}` | detections + full analysis (drift runs + suspects) |
| `POST /api/slicks/{id}/analyze` | re-run hindcast + attribution |
| `GET /api/events` | alert/event log |
| `GET /api/risk/status` | risk-model card (AUC, importances, corpus size) |
| `GET /api/risk/grid?min_p=` | spill-risk probability grid as GeoJSON |
| `WS /ws` | live push: events, scene status, analysis completions |

If `API_KEY` is set, every `/api/*` route requires `X-API-Key: <key>` (or
`?api_key=<key>`).

## Tests

```bash
python -m pytest tests/ -q
```

Covers the drift model's transport physics (uniform-current advection speed),
local-frame round-trip, backward-origin sanity, JSON posture of the API, the
attribution scorer's monotonicity (closer/stationary tanker outranks distant
transiting cargo), dark-gap evidence, and score bounds.

## Data source credits

Copernicus Data Space Ecosystem (Sentinel-1 catalogue & downloads), Sentinel Hub
Process API (AOI rasters), Finnish Transport Infrastructure Agency Digitraffic
(AIS, CC-BY 4.0), Open-Meteo (ECMWF/CMEMS-derived fields), Natural Earth
(coastlines), SkyTruth Cerulean (historical slick detections).