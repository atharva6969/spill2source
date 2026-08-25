"""Live AIS provider - Digitraffic (Finnish Transport Infrastructure Agency).

Free, no-auth, real-time AIS for the Gulf of Finland / Baltic.
  REST snapshot: https://meri.digitraffic.fi/api/ais/v1/locations   (GeoJSON)
  Vessel metadata: https://meri.digitraffic.fi/api/ais/v1/vessels
"""
from __future__ import annotations

import asyncio
import logging
import time

import httpx

log = logging.getLogger("ais")

BASE = "https://meri.digitraffic.fi/api/ais/v1"
UA = "OilSpillAttribution/1.0 (real-time spill attribution research)"


class AisProvider:
    def __init__(self, store, settings):
        self.store = store
        self.settings = settings
        self.last_poll: float | None = None
        self.last_count = 0
        self.total_inserted = 0
        self.error: str | None = None
        self._client = httpx.AsyncClient(
            headers={"User-Agent": UA, "Digitraffic-User": UA},
            timeout=httpx.Timeout(20),
        )
        self._meta_fetched_at = 0.0
        # mmsi -> latest position dict (fast UI snapshots)
        self.latest: dict[int, dict] = {}

    async def close(self) -> None:
        await self._client.aclose()

    def _in_aoi(self, lon: float, lat: float) -> bool:
        x0, y0, x1, y1 = self.settings.aoi_bbox
        return x0 <= lon <= x1 and y0 <= lat <= y1

    async def poll_once(self) -> int:
        r = await self._client.get(f"{BASE}/locations")
        r.raise_for_status()
        fc = r.json()
        rows, now_ts = [], time.time()
        fresh = 0
        for f in fc.get("features", []):
            props = f.get("properties", {})
            geom = f.get("geometry") or {}
            coords = geom.get("coordinates")
            mmsi = props.get("mmsi")
            if not mmsi or not coords:
                continue
            ts_ext = props.get("timestampExternal")
            # timestampExternal is ms since epoch (UTC)
            ts = (ts_ext / 1000.0) if ts_ext else now_ts
            if ts > now_ts + 60:
                ts = now_ts
            lon, lat = coords[0], coords[1]
            if not self._in_aoi(lon, lat):
                continue
            rows.append((int(mmsi), ts, lon, lat,
                         props.get("sog"), props.get("cog"), props.get("navStat")))
            prev = self.latest.get(mmsi)
            if prev is None or ts >= prev["ts"]:
                self.latest[mmsi] = {
                    "mmsi": int(mmsi), "ts": ts, "lon": lon, "lat": lat,
                    "sog": props.get("sog"), "cog": props.get("cog"),
                    "navStat": props.get("navStat"),
                }
                if prev is None or ts > prev["ts"]:
                    fresh += 1
        inserted = self.store.upsert_positions(rows)
        self.last_poll = time.time()
        self.last_count = len(rows)
        self.total_inserted += max(inserted, 0)
        self.error = None
        log.info("AIS poll: %d in-AOI positions, %d new rows", len(rows), inserted)
        return inserted

    async def refresh_metadata(self, force: bool = False) -> None:
        if not force and time.time() - self._meta_fetched_at < 600:
            return
        try:
            r = await self._client.get(f"{BASE}/vessels")
            r.raise_for_status()
            norm = [{
                "mmsi": v["mmsi"],
                "name": v.get("name"),
                "shipType": v.get("shipType"),
                "destination": v.get("destination"),
                "draught": v.get("draught"),
                "imo": v.get("imo"),
                "callSign": v.get("callSign"),
                "length": v.get("length") or 0,
                "width": v.get("width") or 0,
            } for v in r.json() if v.get("mmsi")]
            self.store.upsert_vessels(norm)
            self._meta_fetched_at = time.time()
            log.info("AIS metadata refreshed: %d vessels", len(norm))
        except Exception as exc:  # keep polling positions even if metadata fails
            log.warning("vessel metadata refresh failed: %s", exc)

    async def run(self, broadcast=None) -> None:
        """Continuous poll loop."""
        while True:
            try:
                n = await self.poll_once()
                if broadcast and n:
                    await broadcast({"type": "ais_tick", "inserted": n,
                                     "live_vessels": len(self.latest)})
                await self.refresh_metadata()
            except Exception as exc:
                self.error = str(exc)
                log.error("poll failed: %s", exc)
            await asyncio.sleep(self.settings.ais_poll_seconds)
