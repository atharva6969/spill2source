"""FastAPI application: REST + WebSocket hub + static dashboard serving."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from .config import settings
from .store import Store
from .scheduler import System

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(name)s %(levelname)s %(message)s")

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "frontend" / "dist"

store = Store(settings.db_path)
system: System | None = None
app = FastAPI(title="SPILL2SOURCE - Oil Spill Detection & Vessel Attribution",
              version="1.0")

# ---- simple API-key auth ---------------------------------------------------
API_KEY = settings.api_key

if API_KEY:
    class _AuthMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next):
            if request.url.path.startswith("/api/"):
                key = request.headers.get("X-API-Key") or request.query_params.get("api_key")
                if key != API_KEY:
                    from fastapi.responses import JSONResponse
                    return JSONResponse({"detail": "unauthorized"}, status_code=401)
            return await call_next(request)

    app.add_middleware(_AuthMiddleware)


@app.on_event("startup")
async def _startup() -> None:
    global system
    system = System(store)
    system.start()


@app.on_event("shutdown")
async def _shutdown() -> None:
    if system:
        await system.shutdown()
    store.close()


# ---- status ------------------------------------------------------------------
@app.get("/api/status")
async def status():
    return system.status()


# ---- live AIS ------------------------------------------------------------------
@app.get("/api/vessels/live")
async def vessels_live():
    feats = []
    metas = {r["mmsi"]: r for r in store.query(
        "SELECT mmsi,name,ship_type FROM vessels")}
    for mmsi, p in system.ais.latest.items():
        m = metas.get(mmsi, {})
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
            "properties": {"mmsi": mmsi, "ts": p["ts"], "sog": p["sog"],
                           "cog": p["cog"], "navStat": p["navStat"],
                           "name": m.get("name"),
                           "shipType": m.get("ship_type")},
        })
    return {"type": "FeatureCollection", "features": feats}


@app.get("/api/vessels/{mmsi}/track")
async def vessel_track(mmsi: int, hours: float = 12,
                       from_ts: float | None = None, to_ts: float | None = None):
    if from_ts is not None and to_ts is not None:
        rows = store.query(
            "SELECT ts,lon,lat,sog,cog FROM ais_positions "
            "WHERE mmsi=? AND ts BETWEEN ? AND ? ORDER BY ts",
            (mmsi, from_ts, to_ts))
    else:
        rows = store.query(
            "SELECT ts,lon,lat,sog,cog FROM ais_positions WHERE mmsi=? AND ts>? "
            "ORDER BY ts", (mmsi, time.time() - hours * 3600))
    return {"mmsi": mmsi, "points": [
        [r["lon"], r["lat"], r["ts"], r["sog"], r["cog"]] for r in rows]}


@app.get("/api/vessels/{mmsi}/details")
async def vessel_details(mmsi: int):
    from .vessel_info import vessel_details as details
    return details(store, mmsi, system.ais.latest.get(mmsi))


# ---- scenes ---------------------------------------------------------------------
@app.get("/api/scenes")
async def scenes(limit: int = 40):
    rows = store.query(
        "SELECT * FROM scenes ORDER BY sensed_start DESC LIMIT ?", (limit,))
    for r in rows:
        r["footprint"] = json.loads(r["footprint"]) if r["footprint"] else None
    return rows


@app.post("/api/scenes/{product_id}/scan")
async def scan_scene(product_id: str):
    res = await system.process_scene(product_id)
    if not res.get("ok"):
        raise HTTPException(400, res.get("reason", "scan failed"))
    return res


# ---- slicks + analysis -------------------------------------------------------------
def _slick_row(r: dict) -> dict:
    r = dict(r)
    r["geometry"] = json.loads(r["geometry"]) if r["geometry"] else None
    r["properties"] = json.loads(r["properties"]) if r["properties"] else {}
    return r


@app.get("/api/slicks")
async def slicks():
    rows = store.query("SELECT * FROM slicks ORDER BY detected_at DESC")
    return [_slick_row(r) for r in rows]


@app.get("/api/slicks/{slick_id}")
async def slick_detail(slick_id: int):
    row = store.one("SELECT * FROM slicks WHERE id=?", (slick_id,))
    if not row:
        raise HTTPException(404, "unknown slick")
    out = _slick_row(row)
    bw = store.one("SELECT * FROM drift_runs WHERE slick_id=? AND "
                   "direction='backward' ORDER BY id DESC LIMIT 1", (slick_id,))
    fw = store.one("SELECT * FROM drift_runs WHERE slick_id=? AND "
                   "direction='forward' ORDER BY id DESC LIMIT 1", (slick_id,))
    for tag, run in (("backward", bw), ("forward", fw)):
        if run:
            run["spread_curve"] = json.loads(run["spread_curve"]) \
                if run["spread_curve"] else []
            run["path"] = json.loads(run["path"]) if run["path"] else {}
            run["cone"] = json.loads(run["cone"]) if run["cone"] else []
            run["particles"] = json.loads(run["particles"]) \
                if run["particles"] else []
        out[tag] = run
    sus = store.query("SELECT mmsi,score,rank,factors,computed_at FROM suspects "
                      "WHERE slick_id=? ORDER BY rank LIMIT 15", (slick_id,))
    names = {v["mmsi"]: v for v in store.query("SELECT mmsi,name,ship_type,length,width,imo,dest,draught FROM vessels")}
    for s in sus:
        s["factors"] = json.loads(s["factors"])
        meta = names.get(s["mmsi"], {})
        s["name"] = s.get("name") or meta.get("name")
        s["ship_type"] = meta.get("ship_type")
        s["length"] = meta.get("length"); s["width"] = meta.get("width")
        s["imo"] = meta.get("imo"); s["dest"] = meta.get("dest")
        s["draught"] = meta.get("draught")
    out["suspects"] = sus
    return out


@app.post("/api/slicks/{slick_id}/analyze")
async def reanalyze_slick(slick_id: int):
    row = store.one("SELECT id FROM slicks WHERE id=?", (slick_id,))
    if not row:
        raise HTTPException(404, "unknown slick")
    res = await system.analyze_slick(slick_id)
    if not res.get("ok"):
        reason = res.get("reason", "unknown")
        detail = {"met_fields_not_ready":
                  "met-ocean fields are still loading - try again in a minute"
                  }.get(reason, reason)
        raise HTTPException(503, detail)
    return res


# ---- spill-risk model ----------------------------------------------------------------
_risk_meta: dict | None = None


def _risk_metadata() -> dict | None:
    global _risk_meta
    if _risk_meta is None and (settings.data_dir / "risk_model.joblib").exists():
        import joblib
        m = joblib.load(settings.data_dir / "risk_model.joblib")
        _risk_meta = {k: m[k] for k in
                      ("features", "importances", "auc_mean", "auc_folds",
                       "trained_at", "n_cells", "n_positive", "history")}
    return _risk_meta


@app.get("/api/risk/status")
async def risk_status():
    meta = _risk_metadata()
    if not meta:
        return {"trained": False,
                "hint": "run scripts/train_risk_model.py (needs "
                        "scripts/fetch_cerulean_slicks.py first)"}
    return {"trained": True, **meta}


@app.get("/api/risk/grid")
async def risk_grid(min_p: float = 0.0, limit: int = 4000):
    """Risk-probability cells as a GeoJSON FeatureCollection."""
    if not (settings.data_dir / "risk_model.joblib").exists():
        raise HTTPException(404, "risk model not trained yet")
    rows = store.query(
        "SELECT lon0,lat0,lon1,lat1,p FROM risk_grid WHERE p>=? "
        "ORDER BY p DESC LIMIT ?", (min_p, limit))
    return {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [[
                [r["lon0"], r["lat0"]], [r["lon1"], r["lat0"]],
                [r["lon1"], r["lat1"]], [r["lon0"], r["lat1"]],
                [r["lon0"], r["lat0"]]]]},
            "properties": {"p": r["p"]},
        } for r in rows],
    }


# ---- events ------------------------------------------------------------------------
@app.get("/api/events")
async def events(limit: int = 50):
    rows = store.query("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,))
    for r in rows:
        r["payload"] = json.loads(r["payload"]) if r["payload"] else None
    return rows


# ---- WebSocket ------------------------------------------------------------------------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await system.hub.connect(ws)
    try:
        await ws.send_text(json.dumps({"type": "hello", "status": system.status()}))
        while True:
            # keep alive; client messages ignored (could add commands later)
            try:
                await asyncio.wait_for(ws.receive_text(), timeout=30)
            except asyncio.TimeoutError:
                # idle client: send a ping frame rather than dropping it
                await ws.send_text(json.dumps({"type": "ping"}))
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        system.hub.disconnect(ws)


# ---- static frontend ---------------------------------------------------------------
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    async def spa(path: str):
        candidate = (DIST / path).resolve()
        if path and candidate.is_file() and str(candidate).startswith(str(DIST.resolve())):
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")
else:
    @app.get("/")
    async def no_frontend():
        return {"hint": "frontend not built yet - see frontend/README"}
