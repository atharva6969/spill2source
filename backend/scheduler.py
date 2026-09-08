"""Orchestration: WebSocket hub + background pipelines + slick analysis flow."""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
from pathlib import Path

from fastapi import WebSocket

from .config import settings
from .drift.fields import FieldSet
from .drift.lagrangian import DriftModel
from .providers.ais_digitraffic import AisProvider
from .providers.sentinel_cdse import CdseProvider
from .providers.sentinel_hub import SentinelHubProvider
from .providers.weather_openmeteo import MetProvider
from .attribution.score import score_vessels
from .detection.pipeline import DetectionPipeline

log = logging.getLogger("sched")


class Hub:
    """Fan-out of JSON events to all connected dashboard clients."""

    def __init__(self):
        self.clients: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.clients.append(ws)

    def disconnect(self, ws: WebSocket) -> None:
        if ws in self.clients:
            self.clients.remove(ws)

    async def broadcast(self, message: dict) -> None:
        dead = []
        payload = json.dumps(message)
        for ws in list(self.clients):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


class System:
    """Wires providers + models together and owns background loops."""

    def __init__(self, store):
        self.store = store
        self.hub = Hub()
        self.settings = settings
        self.ais = AisProvider(store, settings)
        self.met = MetProvider(settings)
        self.cdse = CdseProvider(store, settings)
        self.sh = SentinelHubProvider(settings)
        self.detector = DetectionPipeline(store, settings)
        self.fields: FieldSet | None = None
        self.started_at = time.time()
        self._tasks: list[asyncio.Task] = []
        # cached disk usage so /api/status & WS hello don't walk the tree on
        # every call; refreshed lazily after CACHE_TTL seconds
        self._disk_cache_mb: float | None = None
        self._disk_cached_at: float = 0.0

    # ---- events ------------------------------------------------------------
    async def emit(self, kind: str, severity: str, message: str,
                   payload: dict | None = None) -> None:
        self.store.exec(
            "INSERT INTO events(ts,kind,severity,message,payload) VALUES(?,?,?,?,?)",
            (time.time(), kind, severity, message,
             json.dumps(payload) if payload else None))
        await self.hub.broadcast({"type": "event", "event": {
            "ts": time.time(), "kind": kind, "severity": severity,
            "message": message, "payload": payload}})

    async def _broadcast(self, msg: dict) -> None:
        await self.hub.broadcast(msg)

    # ---- lifecycle -----------------------------------------------------------
    def start(self) -> None:
        # H7: crash recovery — reset scenes stuck in 'processing' from a prior crash
        self.store.exec(
            "UPDATE scenes SET status='catalogued' WHERE status='processing'")
        # Pre-warm shore lookup grid in thread pool so initial attribution runs without cold-start delay
        asyncio.create_task(asyncio.to_thread(lambda: __import__('backend.attribution.behavior', fromlist=['_shore_lookup'])._shore_lookup()))
        self._tasks = [
            asyncio.create_task(self._ais_loop(), name="ais"),
            asyncio.create_task(self._met_loop(), name="met"),
            asyncio.create_task(self._sat_loop(), name="sat"),
            asyncio.create_task(self._cleanup_loop(), name="cleanup"),
        ]

    async def shutdown(self) -> None:
        # Await the cancelled tasks so no background loop is still mid-write
        # when close() runs; otherwise the store's SQLite conn can be closed
        # under a live writer (ProgrammingError / aborted write).
        for t in self._tasks:
            t.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        await self.ais.close()
        await self.met.close()
        await self.cdse.close()
        self.sh.close()

    async def _ais_loop(self) -> None:
        while True:
            try:
                n = await self.ais.poll_once()
                if n > 0:
                    await self.hub.broadcast({
                        "type": "status", "component": "ais",
                        "last_poll": self.ais.last_poll})
                await self.ais.refresh_metadata()
                # keep rolling history bounded (7 days)
                self.store.prune_positions(keep_seconds=7 * 86400)
                # bound the event log too (30 days) so it cannot grow unbounded
                self.store.prune_events(keep_seconds=30 * 86400)
            except Exception as exc:
                self.ais.error = str(exc)
                log.error("AIS loop: %s", exc)
            await asyncio.sleep(self.settings.ais_poll_seconds)

    async def _met_loop(self) -> None:
        while True:
            try:
                ok = await self.met.refresh()
                if ok:
                    self.fields = FieldSet(self.met)
                    await self.hub.broadcast({
                        "type": "status", "component": "met",
                        "last_refresh": self.met.last_refresh})
            except Exception as exc:
                log.error("MET loop: %s", exc)
            await asyncio.sleep(self.settings.met_refresh_seconds)

    async def _sat_loop(self) -> None:
        while True:
            try:
                fresh = await self.cdse.poll_catalog()
                for s in fresh:
                    await self.hub.broadcast({"type": "scene", **s})
                # auto-process newest scene when credentials are configured
                if self.cdse.configured and fresh:
                    newest = max(fresh, key=lambda s: s["sensed_start"])
                    await self.process_scene(newest["product_id"])
            except Exception as exc:
                log.error("SAT loop: %s", exc)
            await asyncio.sleep(self.settings.sat_poll_seconds)

    async def _cleanup_loop(self) -> None:
        """Periodically prune old scene data to limit disk usage."""
        while True:
            try:
                await self._cleanup_old_scenes()
            except Exception as exc:
                log.error("cleanup loop: %s", exc)
            await asyncio.sleep(3600)  # check every hour

    # ---- scene processing ----------------------------------------------------
    # track product_ids currently being processed to avoid cleanup conflicts
    _processing: set[str] = set()

    async def process_scene(self, product_id: str) -> dict:
        if product_id in self._processing:
            return {"ok": False, "reason": "already_processing"}
        meta = self.store.one("SELECT * FROM scenes WHERE product_id=?",
                              (product_id,))
        if not meta:
            return {"ok": False, "reason": "unknown_product"}
        if not self.cdse.configured:
            return {"ok": False, "reason": "cdse_credentials_missing"}

        self._processing.add(product_id)
        try:

            async def progress_cb(pid, pct):
                await self.hub.broadcast({"type": "scene_status",
                                          "product_id": pid, "status": "downloading",
                                          "pct": pct})

            # Preferred path: Sentinel Hub fetches only the AOI window (a few MB)
            # instead of the full/partial product. Falls back to download.
            if self.sh.configured:
                try:
                    await self.hub.broadcast(
                        {"type": "scene_status", "product_id": product_id,
                         "status": "fetching", "name": meta["name"]})
                    footprint = json.loads(meta["footprint"]) if meta.get("footprint") else None
                    loop = asyncio.get_running_loop()
                    sigma_db, transform = await loop.run_in_executor(
                        None, self.sh.fetch_sigma0_db,
                        self.settings.aoi_bbox, meta["sensed_start"], "vv", footprint)
                    slick_ids = await self.detector.process_sh(
                        product_id, sigma_db, transform, "vv",
                        broadcast=self._broadcast)
                    return await self._post_detect(product_id, meta, slick_ids)
                except Exception as exc:
                    log.warning("Sentinel Hub fetch failed (%s); "
                                "falling back to download", exc)

            try:
                local_zip = await self.cdse.download(product_id,
                                                     progress_cb=progress_cb)
                await self.hub.broadcast({"type": "scene_status",
                                          "product_id": product_id,
                                          "status": "downloaded"})
            except Exception as exc:
                log.error("download failed: %s", exc)
                self.store.exec(
                    "UPDATE scenes SET status='error', error=? WHERE product_id=?",
                    (f"download: {exc}"[:400], product_id))
                await self.emit("scene", "error",
                                f"Download failed for {meta['name']}: {exc}")
                return {"ok": False, "reason": str(exc)}

            slick_ids = await self.detector.process_product(
                product_id, local_zip, broadcast=self._broadcast)
            return await self._post_detect(product_id, meta, slick_ids)
        finally:
            self._processing.discard(product_id)

    async def _post_detect(self, product_id: str, meta: dict,
                           slick_ids: list) -> dict:
        # A detection pipeline exception sets the scene to 'error' (not 'clear').
        # Distinguish that from a genuine all-clear so a crash never surfaces
        # as a false "sea clear" alert to responders.
        cur = self.store.one(
            "SELECT status FROM scenes WHERE product_id=?", (product_id,))
        if cur and cur["status"] == "error":
            await self.emit("scene", "error",
                            f"{meta['name']}: detection failed - see scene log")
            return {"ok": False, "reason": "detection_error",
                    "slick_ids": slick_ids}

        if not slick_ids:
            await self.emit("scene", "info",
                            f"{meta['name']}: scanned - no oil-like dark "
                            f"patches above threshold (sea clear)")
        else:
            await self.emit("slick", "alert",
                            f"{len(slick_ids)} oil-candidate patch(es) detected "
                            f"in {meta['name']}",
                            {"slick_ids": slick_ids})
        return {"ok": True, "slick_ids": slick_ids}

    # ---- slick analysis --------------------------------------------------------
    async def analyze_slick(self, slick_id: int) -> dict:
        """Drift hindcast/forecast + vessel attribution for one slick."""
        slick = self.store.one("SELECT * FROM slicks WHERE id=?", (slick_id,))
        if not slick:
            raise ValueError("unknown slick id")
        detect_ts = slick["detected_at"]
        drift_back_s = self.settings.drift_hours_back * 3600
        drift_fwd_s = self.settings.drift_hours_fwd * 3600

        # retrieve met fields covering the specific detection window [detect_ts - back, detect_ts + fwd]
        try:
            fields = await self.met.get_fields_for_window(detect_ts - drift_back_s, detect_ts + drift_fwd_s)
        except Exception as exc:
            log.warning("Could not get windowed met fields: %s, checking live fields", exc)
            if self.fields is None:
                await self.met.refresh()
                self.fields = FieldSet(self.met)
            fields = self.fields

        if fields is None:
            return {"ok": False, "reason": "met_fields_not_ready",
                    "error": self.met.error}

        from shapely.geometry import shape
        gj = json.loads(slick["geometry"])
        poly = shape(gj["geometry"])

        dm = DriftModel(fields, self.settings)
        loop = asyncio.get_running_loop()

        bw_task = loop.run_in_executor(None, lambda: dm.backward(poly, detect_ts, slick_props=slick))
        fw_task = loop.run_in_executor(None, lambda: dm.forward(poly, detect_ts, slick_props=slick))
        bw, fw = await asyncio.gather(bw_task, fw_task)

        # persist backward (origin estimate); convert local-metre paths to lon/lat
        frame = bw.pop("frame", None)

        def to_ll_path(path_m):
            out = []
            for x, y, t in path_m:
                lon, lat = frame.to_ll(x, y) if frame else (None, None)
                out.append([lon, lat, t])
            return out

        # attribution (compute before delete so score_vessels can read existing DB state)
        suspects = await loop.run_in_executor(
            None, lambda: score_vessels(self.store,
                                        {**slick, "age_estimate_h": bw["age_h"]},
                                        bw))
        top = suspects[:15]

        # H4: compute-then-swap — atomically replace the previous analysis so a
        # crash mid-swap can never leave a slick with a backward run but no
        # forward run, or mixed/missing suspects.
        cones_ll = []
        for c in fw["cones"]:
            lon, lat = frame.to_ll(*c["centroid"]) if frame else (None, None)
            cones_ll.append({"ts": c["ts"], "lon": lon, "lat": lat,
                             "radius_km": c["radius_km"]})
        fwd_path = to_ll_path(fw["centroid_path"])
        now = time.time()
        with self.store.transaction():
            self.store.exec("DELETE FROM drift_runs WHERE slick_id=?",
                            (slick_id,))
            self.store.exec("DELETE FROM suspects WHERE slick_id=?",
                            (slick_id,))

            self.store.exec(
                """INSERT INTO drift_runs(slick_id,direction,started_at,origin_lon,
                   origin_lat,origin_sigma_km,release_time,spread_curve,path,particles)
                   VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (slick_id, "backward", now, bw["origin_lon"],
                 bw["origin_lat"], bw["origin_sigma_km"], bw["release_ts"],
                 json.dumps(bw["spread_curve"]),
                 json.dumps({"centroid_path": to_ll_path(bw["centroid_path"])}),
                 json.dumps([])))
            # persist forward (forecast cone)
            self.store.exec(
                """INSERT INTO drift_runs(slick_id,direction,started_at,path,cone)
                   VALUES(?,?,?,?,?)""",
                (slick_id, "forward", now,
                 json.dumps({"centroid_path": fwd_path}),
                 json.dumps(cones_ll)))

            # update slick age estimate
            self.store.exec(
                "UPDATE slicks SET age_estimate_h=?, age_sigma_h=? WHERE id=?",
                (bw["age_h"], min(bw["origin_sigma_km"] / 3.0, 6.0), slick_id))

            for r in top:
                self.store.exec(
                    """INSERT INTO suspects(slick_id,mmsi,score,rank,factors,computed_at)
                       VALUES(?,?,?,?,?,?)
                       ON CONFLICT(slick_id,mmsi) DO UPDATE SET score=excluded.score,
                         rank=excluded.rank, factors=excluded.factors,
                         computed_at=excluded.computed_at""",
                    (slick_id, r["mmsi"], r["score"], r["rank"],
                     json.dumps(r["factors"]), now))

        origin_ll = (bw["origin_lon"], bw["origin_lat"])
        await self.emit("analysis", "alert" if suspects else "info",
                        f"Slick #{slick_id}: est. release at "
                        f"{_iso(bw['release_ts'])} "
                        f"(age ~{bw['age_h']:.1f} h), origin "
                        f"{origin_ll[0]:.2f}E {origin_ll[1]:.2f}N; "
                        f"{len(top)} suspect vessels ranked",
                        {"slick_id": slick_id,
                         "top_suspect": top[0]["mmsi"] if top else None})
        await self.hub.broadcast({"type": "analysis_complete",
                                  "slick_id": slick_id})
        return {"ok": True, "suspects": len(top)}

    # ---- status ------------------------------------------------------------------
    def status(self) -> dict:
        n_pos = self.store.one("SELECT COUNT(*) c FROM ais_positions")["c"]
        n_vessels_live = len(self.ais.latest)
        scenes = self.store.query(
            "SELECT status, COUNT(*) c FROM scenes GROUP BY status")
        slick_count = self.store.one("SELECT COUNT(*) c FROM slicks")["c"]
        scene_disk_mb = self._scene_disk_mb_cached()
        return {
            "uptime_s": round(time.time() - self.started_at),
            "cdse_configured": self.cdse.configured,
            "sh_configured": self.sh.configured,
            "ais": {"last_poll": self.ais.last_poll, "error": self.ais.error,
                    "positions_stored": n_pos, "live_vessels": n_vessels_live},
            "met": self.met.status(),
            "sat": {"last_poll": self.cdse.last_poll,
                    "error": self.cdse.error,
                    "downloads": self.cdse.download_progress,
                    "scenes_by_status": {r["status"]: r["c"] for r in scenes}},
            "slicks_detected": slick_count,
            "scene_disk_mb": scene_disk_mb,
            "aoi_bbox": self.settings.aoi_bbox,
        }

    def _scene_disk_mb_cached(self) -> float:
        """Layer on a 60 s TTL to keep the blocking directory walk off the
        hot `/api/status` and WebSocket-hello paths."""
        now = time.time()
        if self._disk_cache_mb is None or now - self._disk_cached_at > 60:
            self._disk_cache_mb = _scene_disk_usage_mb(settings.data_dir / "scenes")
            self._disk_cached_at = now
        return self._disk_cache_mb

    # ---- scene cleanup --------------------------------------------------------
    async def _cleanup_old_scenes(self) -> None:
        """Remove extracted SAFE dirs and old zips to reclaim disk.

        Strategy:
        1. Delete extracted SAFE directories for scenes with status in
           ('detected', 'clear', 'error') — detection results are in SQLite.
        2. If total scene disk usage exceeds SCENE_CACHE_MAX_GB, delete the
           oldest processed zips first.
        3. Delete any scenes older than SCENE_TTL_DAYS regardless of status.
        """
        scenes_dir = settings.data_dir / "scenes"
        if not scenes_dir.exists():
            return
        ttl_cutoff = time.time() - settings.scene_ttl_days * 86400
        deleted_mb = 0.0

        # 1. Remove extracted SAFE dirs for fully processed scenes
        #    SAFE dirs are named by scene name (e.g. S1C_IW_GRDH_...SAFE),
        #    NOT by product_id, so we match against the name column.
        for d in scenes_dir.iterdir():
            if not d.is_dir():
                continue
            dir_name = d.name
            # SAFE dirs are named by scene name (e.g. S1C_IW_GRDH_...SAFE);
            # _processing tracks product_ids, so compare against any processed
            # scene name suffix to avoid deleting an in-flight extraction.
            if any(dir_name.endswith(p) or dir_name.endswith(p + ".SAFE")
                   for p in self._processing):
                continue
            row = self.store.one(
                "SELECT status, sensed_start FROM scenes WHERE name=? OR product_id=?",
                (dir_name, dir_name))
            if row and row["status"] in ("detected", "clear", "error"):
                size_mb = _dir_size_mb(d)
                shutil.rmtree(d, ignore_errors=True)
                deleted_mb += size_mb
                log.info("cleanup: removed SAFE dir %s (%.0f MB)", dir_name, size_mb)

        # 2. Enforce max cache size by removing oldest processed zips
        max_bytes = int(settings.scene_cache_max_gb * 1024 * 1024 * 1024)
        total = _scene_disk_usage_bytes(scenes_dir)
        if total > max_bytes:
            zips = []
            for f in scenes_dir.glob("*.zip"):
                # zips are saved as <scene_name>.zip (see sentinel_cdse
                # _download_full), so match against the name column.
                row = self.store.one(
                    "SELECT status, sensed_start FROM scenes WHERE name=? OR product_id=?",
                    (f.stem, f.stem))
                if row and row["status"] in ("detected", "clear", "error"):
                    zips.append((f, row["sensed_start"] or 0))
            zips.sort(key=lambda x: x[1])  # oldest first
            for f, _ in zips:
                if total <= max_bytes:
                    break
                sz = f.stat().st_size
                f.unlink(missing_ok=True)
                total -= sz
                deleted_mb += sz / 1e6
                log.info("cleanup: removed old zip %s (%.0f MB)", f.name, sz / 1e6)

        # 3. Remove scenes older than TTL
        for d in list(scenes_dir.iterdir()):
            if not d.is_dir():
                continue
            if any(d.name.endswith(p) or d.name.endswith(p + ".SAFE")
                   for p in self._processing):
                continue  # H5: skip scenes currently being processed
            row = self.store.one(
                "SELECT sensed_start FROM scenes WHERE name=? OR product_id=?",
                (d.name, d.name))
            if row and row["sensed_start"] and row["sensed_start"] < ttl_cutoff:
                size_mb = _dir_size_mb(d)
                shutil.rmtree(d, ignore_errors=True)
                deleted_mb += size_mb
                log.info("cleanup: removed TTL-expired %s (%.0f MB)", d.name, size_mb)

        if deleted_mb > 0:
            log.info("cleanup: reclaimed %.0f MB of scene disk", deleted_mb)


def _iso(ts: float) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _scene_disk_usage_mb(scenes_dir: Path) -> float:
    if not scenes_dir.exists():
        return 0.0
    total = 0
    for item in scenes_dir.iterdir():
        if item.is_file():
            total += item.stat().st_size
        elif item.is_dir():
            total += sum(f.stat().st_size for f in item.rglob("*") if f.is_file())
    return total / 1e6


def _scene_disk_usage_bytes(scenes_dir: Path) -> int:
    if not scenes_dir.exists():
        return 0
    total = 0
    for item in scenes_dir.iterdir():
        if item.is_file():
            total += item.stat().st_size
        elif item.is_dir():
            total += sum(f.stat().st_size for f in item.rglob("*") if f.is_file())
    return total


def _dir_size_mb(d: Path) -> float:
    return sum(f.stat().st_size for f in d.rglob("*") if f.is_file()) / 1e6
