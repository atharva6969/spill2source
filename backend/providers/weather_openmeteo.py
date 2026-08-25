"""Met-ocean provider - Open-Meteo forecast + marine APIs (free, no key).

Builds a time-indexed vector field over the AOI from a coarse point grid:
  - 10 m wind (u, v)                     api.open-meteo.com/v1/forecast
  - ocean current (u, v), waves          marine-api.open-meteo.com/v1/marine
past_days + forecast_days give us hindcast AND forecast forcing.
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import datetime, timezone

import httpx
import numpy as np

log = logging.getLogger("met")

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
MARINE_URL = "https://marine-api.open-meteo.com/v1/marine"


def _uv(speed, direction_deg):
    """Meteorological 'direction FROM which' -> oceanographic u,v (eastward, northward)."""
    s = np.asarray(speed, dtype=float)
    d = np.asarray(direction_deg, dtype=float)
    rad = np.deg2rad(d)
    u = -s * np.sin(rad)
    v = -s * np.cos(rad)
    return u, v


class MetProvider:
    """Gridded hourly fields over the AOI."""

    GRID_NX = 6   # points across lon
    GRID_NY = 5   # points across lat

    def __init__(self, settings):
        self.settings = settings
        self.last_refresh: float | None = None
        self.error: str | None = None
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(30))
        # grid arrays
        self.grid_lons: np.ndarray | None = None
        self.grid_lats: np.ndarray | None = None
        self.times: np.ndarray | None = None        # epoch seconds per hour step [T]
        self.wind_u = self.wind_v = None            # [ny, nx, T] m/s
        self.cur_u = self.cur_v = None              # [ny, nx, T] m/s
        self.wave_h = None                          # [ny, nx, T] m

    async def close(self) -> None:
        await self._client.aclose()

    def _grid(self):
        x0, y0, x1, y1 = self.settings.aoi_bbox
        lons = np.linspace(x0, x1, self.GRID_NX)
        lats = np.linspace(y0, y1, self.GRID_NY)
        return lons, lats

    @staticmethod
    async def _fetch_point(client: httpx.AsyncClient, lat: float, lon: float,
                           past_days: int, forecast_days: int) -> dict:
        async def one(url: str, params: dict) -> dict:
            r = await client.get(url, params=params)
            r.raise_for_status()
            return r.json()

        wf, mf = await asyncio.gather(
            one(FORECAST_URL, {
                "latitude": lat, "longitude": lon,
                "hourly": "wind_speed_10m,wind_direction_10m",
                "wind_speed_unit": "ms", "past_days": past_days,
                "forecast_days": forecast_days, "timeformat": "unixtime",
            }),
            one(MARINE_URL, {
                "latitude": lat, "longitude": lon,
                "hourly": ("wave_height,wave_direction,wave_period,"
                           "ocean_current_velocity,ocean_current_direction"),
                "past_days": past_days, "forecast_days": forecast_days,
                "timeformat": "unixtime",
            }),
        )
        return {"wind": wf["hourly"], "marine": mf.get("hourly", {})}

    async def refresh(self) -> bool:
        """Fetch all grid points concurrently and assemble field arrays."""
        lons, lats = self._grid()
        past, fwd = 4, 3
        try:
            results = []
            for lat_row in lats:
                row = await asyncio.gather(
                    *[self._fetch_point(self._client, float(la), float(lo), past, fwd)
                      for la, lo in [(lat_row, lo) for lo in lons]]
                )
                results.append(row)
        except Exception as exc:
            self.error = str(exc)
            log.error("met refresh failed: %s", exc)
            return False

        wind_ref = results[0][0]["wind"]
        times = np.asarray(wind_ref["time"], dtype=np.int64)  # unixtime utc
        nt = len(times)

        def stack(extract) -> np.ndarray:
            out = np.full((len(lats), len(lons), nt), np.nan)
            for iy, row in enumerate(results):
                for ix, pt in enumerate(row):
                    arr = np.asarray(extract(pt), dtype=float)
                    n = min(len(arr), nt)
                    out[iy, ix, :n] = arr[:n]
            return out

        wsp = stack(lambda p: p["wind"].get("wind_speed_10m", []))
        wdr = stack(lambda p: p["wind"].get("wind_direction_10m", []))
        wu, wv = _uv(wsp, wdr)

        cv = stack(lambda p: p["marine"].get("ocean_current_velocity", []))
        cd = stack(lambda p: p["marine"].get("ocean_current_direction", []))
        wh = stack(lambda p: p["marine"].get("wave_height", []))
        cu, cvv = _uv(cv / 3.6, cd)  # km/h -> m/s

        self.grid_lons, self.grid_lats = lons, lats
        self.times = times
        self.wind_u, self.wind_v = wu, wv
        self.cur_u, self.cur_v = cu, cvv
        self.wave_h = wh
        self.last_refresh = time.time()
        self.error = None
        log.info("met fields refreshed: %dx%d grid x %d hours (%s .. %s)",
                 len(lats), len(lons), nt,
                 datetime.fromtimestamp(times[0], timezone.utc).isoformat(),
                 datetime.fromtimestamp(times[-1], timezone.utc).isoformat())
        return True

    async def run(self) -> None:
        while True:
            ok = await self.refresh()
            if ok:
                await asyncio.sleep(self.settings.met_refresh_seconds)
            else:
                # transient failure (rate limit / timeout): retry soon instead
                # of leaving the dashboard without fields for a full hour
                await asyncio.sleep(60)

    # -- status ---------------------------------------------------------------
    def status(self) -> dict:
        if self.times is None:
            return {"ready": False, "error": self.error}
        return {
            "ready": True,
            "error": self.error,
            "last_refresh": self.last_refresh,
            "hours": int(len(self.times)),
            "from": datetime.fromtimestamp(self.times[0], timezone.utc).isoformat(),
            "to": datetime.fromtimestamp(self.times[-1], timezone.utc).isoformat(),
        }
