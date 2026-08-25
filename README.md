# SlickTrace — Real-Time Oil-Spill Detection & Vessel Attribution

An automated pipeline that watches a sea area **live**: ingests real-time AIS
traffic, real wind/wave/ocean-current fields, and Sentinel-1 SAR imagery;
detects oil slicks in the imagery; **hindcasts each slick backward to its
release point and time** (and forecasts its drift forward); then ranks the
**suspect vessels** that were around the release point at the release moment,
with per-factor evidence.

 Every number in the UI comes from a live feed at the moment you look at it.

```
┌─────────────────────────────────────────────────────────────────────┐
│  LIVE FEEDS                                                          │
│  • Digitraffic AIS (no key)      → vessel tracks, 30 s refresh       │
│  • Open-Meteo wind/marine (no key) → hourly wind + current fields    │
│  • Copernicus Data Space (free account) → Sentinel-1 GRD scenes      │
└──────────────┬──────────────────────┬─────────────────┬──────────────┘
               ▼                      ▼                 ▼
      ┌────────────────┐    ┌────────────────┐  ┌───────────────┐
      │ SAR DETECTION  │    │ DRIFT MODEL    │  │ ATTRIBUTION   │
      │ sigma0 calib → │    │ Lagrangian     │  │ 6-factor      │
      │ dark-spot seg  │    │ particles,     │  │ weighted      │
      │ → features →   │    │ backward to    │  │ scoring of    │
      │ oil classifier │    │ release point  │  │ AIS traffic   │
      └───────┬────────┘    └───────┬────────┘  └──────┬────────┘
              ▼                     ▼                  ▼
        ┌───────────────────────────────────────────────────┐
        │  FastAPI + WebSocket  →  dark ops-room dashboard  │
        └───────────────────────────────────────────────────┘
```

## Quick start

```bash
# 1. Python deps (Python 3.11+)
pip install -r requirements.txt

# 2. Configure — copy the template and add your free CDSE account
copy .env.example .env
#    register at https://dataspace.copernicus.eu (2 min, free)
#    then set CDSE_USER / CDSE_PASS in .env

# 3. Build the dashboard (first run only)
cd frontend && npm install && npm run build && cd ..

# 4. Run
run.bat            # or: python -m uvicorn backend.main:app --port 8000
```

Open **http://localhost:8000**. Within seconds the AIS feed LED goes green
(hundreds of live vessels in the Gulf of Finland), met-ocean fields cache,
and the Sentinel-1 catalogue fills. Click any scene under **SCENES → scan** to
download it and run detection; a detected slick is analysed automatically
(hindcast → origin → suspect ranking) and appears under **SLICKS**.

## How it works

### 1. Detection (Sentinel-1 SAR)
Oil damps capillary/short gravity waves, so slicks appear as dark patches in
SAR backscatter. Pipeline: SAFE unpack → DN→σ⁰ calibration with the product
calibration LUT → Lee speckle filter → land masking (Natural Earth 10 m) →
**segmentation** → candidate patches → physics-meaningful features (contrast,
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
a leeway model: 3 % windage deflected 20° (Ekman), 2 % Stokes drift, random-walk
diffusion, RK2 integration. Integrating **backward** in time converges the
ensemble toward the release area; the spread-vs-time minimum gives the
**estimated release point and time** (the slick's age). Forward integration
gives the predicted drift path and uncertainty cone for responders.

### 3. Vessel attribution
The system accumulates its own AIS history from first launch. For each origin
estimate it queries every vessel within radius in the release window and scores
six weighted evidence factors:

| factor | weight | what it measures |
|---|---|---|
| proximity | 0.35 | closest approach to the release point at release time |
| crossing | 0.15 | track intersects the slick footprint / origin cell |
| speed anomaly | 0.15 | drifting / <2 kn loitering inside the window |
| AIS gap | 0.15 | AIS silence ("dark event") overlapping the release |
| vessel class | 0.10 | tanker/bunker/cargo prior |
| course align | 0.10 | movement aligned with the slick elongation axis |

The dashboard shows the ranked leaderboard with each factor's evidence string;
click a suspect to draw its 18 h track.

### 4. The dashboard
Dark hydrographic ops-room console: live chart with all AIS traffic, slick
polygons, the amber hindcast path to the pulsing origin crosshair, the cyan
forecast cone, event feed, scene queue with download/detect status, and the
suspect leaderboard with per-factor evidence bars. WebSocket pushes every
update live.

### 5. Spill-risk prediction layer (AI)
A trained model predicts which sea areas are most likely to accumulate
oil slicks — *before* a slick exists:

- **Training corpus**: 40,000+ historical slick detections (2020–2026) from
  SkyTruth Cerulean's operational Sentinel-1 ML pipeline (`public.slick_plus`
  OGC API, anthropogenic classes), of which ~2,500 fall inside the Gulf of
  Finland AOI across 865 satellite scene-visits.
- **Features per ~5 km cell**: distance to shore (Natural Earth), distance to
  the nearest major oil terminal, distance to live AIS traffic lanes, live AIS
  density, position.
- **Model**: RandomForest classifier; validated with *spatially grouped*
  5-fold CV (longitude bands) — **mean AUC 0.75** at predicting held-out sea
  areas with historical slick occurrence.
- **Serving**: `/api/risk/grid` returns the probability grid; the map's
  **RISK LAYER** toggle renders it as a sequential amber heatmap with a
  legend; the **RISK** tab shows the model card and highest-risk cells.
- **Vessel-behaviour prior**: per-vessel anomaly score from the accumulated
  AIS history (open-sea drifting, night-time slow periods, AIS silence) feeds
  suspect ranking as an extra evidence factor.

Rebuild the risk layer any time:
```bash
python scripts/fetch_cerulean_slicks.py   # refresh historical corpus
python scripts/train_risk_model.py        # retrain + repopulate the grid
```
Data credit: slick detections © SkyTruth Cerulean (Sentinel-1 ML detections).

## API

| endpoint | what |
|---|---|
| `GET /api/status` | pipeline health, feed ages, scene counts |
| `GET /api/vessels/live` | GeoJSON of current AIS positions in the AOI |
| `GET /api/vessels/{mmsi}/track?hours=18` | one vessel's track history |
| `GET /api/vessels/{mmsi}/details` | VesselFinder-style card: type, flag (MMSI MID), IMO/callsign/dims/draught/destination + computed history (distance, speeds, stops, dark gaps) |
| `GET /api/scenes` | Sentinel-1 catalogue cache (48 h) |
| `POST /api/scenes/{id}/scan` | download + run detection on a scene |
| `GET /api/slicks` · `GET /api/slicks/{id}` | detections + full analysis |
| `POST /api/slicks/{id}/analyze` | re-run hindcast + attribution |
| `GET /api/events` | alert/event log |
| `GET /api/risk/status` | risk-model card (AUC, importances, corpus size) |
| `GET /api/risk/grid?min_p=` | spill-risk probability grid as GeoJSON |
| `WS /ws` | live push: events, scene status, analysis completions |

## Tests

```bash
python -m pytest tests/ -q
```
Covers drift-model transport physics (uniform-current advection speed), local
frame round-trip, backward-origin sanity, scorer monotonicity (closer/stationary
tanker outranks distant transiting cargo), dark-gap evidence, score bounds.



## Data source credits
Copernicus Data Space Ecosystem (Sentinel-1), Finnish Transport Infrastructure
Agency Digitraffic (AIS, CC-BY 4.0), Open-Meteo (ECMWF/CMEMS-derived fields),
Natural Earth (coastlines).
