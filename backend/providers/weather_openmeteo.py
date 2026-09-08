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
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(15))
        # grid arrays
        self.grid_lons: np.ndarray | None = None
        self.grid_lats: np.ndarray | None = None
        self.times: np.ndarray | None = None        # epoch seconds per hour step [T]
        self.wind_u = self.wind_v = None            # [ny, nx, T] m/s
        self.cur_u = self.cur_v = None              # [ny, nx, T] m/s
        self.wave_h = None                          # [ny, nx, T] m
        self._window_cache: dict[str, FieldSet] = {}
        self._window_cache_max = 12  # ~12 day-windows ≈ 2 weeks of scenes

    async def close(self) -> None:
        await self._client.aclose()

    def _grid(self):
        x0, y0, x1, y1 = self.settings.aoi_bbox
        lons = np.linspace(x0, x1, self.GRID_NX)
        lats = np.linspace(y0, y1, self.GRID_NY)
        return lons, lats

    async def _fetch_grid_data(self, lons: np.ndarray, lats: np.ndarray,
                                past_days: int | None = None, forecast_days: int | None = None,
                                start_date: str | None = None, end_date: str | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        all_lats, all_lons = [], []
        for la in lats:
            for lo in lons:
                all_lats.append(f"{la:.4f}")
                all_lons.append(f"{lo:.4f}")

        lat_str = ",".join(all_lats)
        lon_str = ",".join(all_lons)

        w_params = {
            "latitude": lat_str, "longitude": lon_str,
            "hourly": "wind_speed_10m,wind_direction_10m",
            "wind_speed_unit": "ms", "timeformat": "unixtime",
        }
        m_params = {
            "latitude": lat_str, "longitude": lon_str,
            "hourly": ("wave_height,wave_direction,wave_period,"
                       "ocean_current_velocity,ocean_current_direction"),
            "timeformat": "unixtime",
        }

        if start_date and end_date:
            w_params["start_date"] = start_date
            w_params["end_date"] = end_date
            m_params["start_date"] = start_date
            m_params["end_date"] = end_date
        else:
            w_params["past_days"] = past_days if past_days is not None else 14
            w_params["forecast_days"] = forecast_days if forecast_days is not None else 3
            m_params["past_days"] = past_days if past_days is not None else 14
            m_params["forecast_days"] = forecast_days if forecast_days is not None else 3

        async def get_json(url: str, params: dict):
            r = await self._client.get(url, params=params)
            r.raise_for_status()
            d = r.json()
            return d if isinstance(d, list) else [d]

        wf_list, mf_list = await asyncio.gather(
            get_json(FORECAST_URL, w_params),
            get_json(MARINE_URL, m_params),
        )

        times = np.asarray(wf_list[0]["hourly"]["time"], dtype=np.int64)
        nt = len(times)
        ny, nx = len(lats), len(lons)

        wsp = np.full((ny, nx, nt), np.nan)
        wdr = np.full((ny, nx, nt), np.nan)
        cv = np.full((ny, nx, nt), np.nan)
        cd = np.full((ny, nx, nt), np.nan)

        idx = 0
        for iy in range(ny):
            for ix in range(nx):
                if idx < len(wf_list):
                    h_w = wf_list[idx].get("hourly", {})
                    w_s = np.asarray(h_w.get("wind_speed_10m", []), dtype=float)
                    w_d = np.asarray(h_w.get("wind_direction_10m", []), dtype=float)
                    n_w = min(len(w_s), nt)
                    wsp[iy, ix, :n_w] = w_s[:n_w]
                    wdr[iy, ix, :n_w] = w_d[:n_w]

                if idx < len(mf_list):
                    h_m = mf_list[idx].get("hourly", {})
                    c_v = np.asarray(h_m.get("ocean_current_velocity", []), dtype=float)
                    c_d = np.asarray(h_m.get("ocean_current_direction", []), dtype=float)
                    n_m = min(len(c_v), nt)
                    cv[iy, ix, :n_m] = c_v[:n_m]
                    cd[iy, ix, :n_m] = c_d[:n_m]

                idx += 1

        wu, wv = _uv(wsp, wdr)
        cu, cvv = _uv(cv / 3.6, cd)
        return times, wu, wv, cu, cvv

    async def refresh(self) -> bool:
        """Fetch all grid points in batch and assemble field arrays."""
        lons, lats = self._grid()
        try:
            times, wu, wv, cu, cvv = await self._fetch_grid_data(lons, lats, past_days=14, forecast_days=3)
        except Exception as exc:
            self.error = str(exc)
            log.error("met refresh failed: %s", exc)
            return False

        self.grid_lons, self.grid_lats = lons, lats
        self.times = times
        self.wind_u, self.wind_v = wu, wv
        self.cur_u, self.cur_v = cu, cvv
        self.last_refresh = time.time()
        self.error = None
        log.info("met fields refreshed: %dx%d grid x %d hours (%s .. %s)",
                 len(lats), len(lons), len(times),
                 datetime.fromtimestamp(times[0], timezone.utc).isoformat(),
                 datetime.fromtimestamp(times[-1], timezone.utc).isoformat())
        return True

    async def get_fields_for_window(self, t_start: float, t_end: float):
        """Return a FieldSet covering [t_start, t_end], fetching on-demand if not covered."""
        from ..drift.fields import FieldSet

        # Check if live fields already cover this window
        if self.times is not None and len(self.times) > 0:
            if float(self.times[0]) <= t_start and float(self.times[-1]) >= t_end:
                return FieldSet(self)

        d0 = datetime.fromtimestamp(t_start, timezone.utc).strftime("%Y-%m-%d")
        d1 = datetime.fromtimestamp(t_end + 86400, timezone.utc).strftime("%Y-%m-%d")
        cache_key = f"{d0}_{d1}"
        if cache_key in self._window_cache:
            return self._window_cache[cache_key]

        log.info("Fetching on-demand met fields for date window [%s, %s]", d0, d1)
        lons, lats = self._grid()
        try:
            times, wu, wv, cu, cvv = await self._fetch_grid_data(lons, lats, start_date=d0, end_date=d1)

            class _MockMet:
                pass
            m = _MockMet()
            m.grid_lons, m.grid_lats = lons, lats
            m.times = times
            m.wind_u, m.wind_v = wu, wv
            m.cur_u, m.cur_v = cu, cvv

            fs = FieldSet(m)
            self._window_cache[cache_key] = fs
            # bound the cache: evict oldest window first (insertion order
            # keeps dict ordered in py3.7+) so old DETECTION dates can't
            # accumulate without limit
            while len(self._window_cache) > self._window_cache_max:
                self._window_cache.pop(next(iter(self._window_cache)))
            return fs
        except Exception as exc:
            log.warning("Failed on-demand met fetch for window [%s, %s]: %s; using fallback", d0, d1, exc)
            if self.times is not None:
                return FieldSet(self)
            # Create synthetic fallback fieldset so simulation never hangs or crashes
            nt = int((t_end - t_start) / 3600.0) + 4
            times = np.linspace(t_start - 3600, t_end + 3600, nt, dtype=np.int64)
            ny, nx = len(lats), len(lons)
            wu = np.full((ny, nx, nt), 5.0)
            wv = np.full((ny, nx, nt), -3.0)
            cu = np.full((ny, nx, nt), 0.1)
            cvv = np.full((ny, nx, nt), -0.05)
            class _MockMet:
                pass
            m = _MockMet()
            m.grid_lons, m.grid_lats = lons, lats
            m.times = times
            m.wind_u, m.wind_v = wu, wv
            m.cur_u, m.cur_v = cu, cvv
            return FieldSet(m)

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
