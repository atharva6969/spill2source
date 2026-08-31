"""Vessel-behavior anomaly scoring from the accumulated AIS history.

Computes, per MMSI, behavioural indicators associated with illegal
discharges in the research literature: slow/drifting periods in open sea,
slow periods at night, and long AIS silences. Combined into an anomaly
score in [0,1] used as a prior factor in suspect ranking.

This is a *risk prior*, not an accusation: fishing, pilotage and port work
all produce low speeds, which is why the factor weight is small.
"""
from __future__ import annotations

import math
import time

import numpy as np

from .candidates import haversine_km

_CACHE: dict[int, tuple[float, dict]] = {}
_CACHE_TTL = 600.0
_CACHE_MAX = 500


def _cache_put(mmsi: int, out: dict) -> None:
    now = time.time()
    if len(_CACHE) >= _CACHE_MAX:
        expired = [k for k, (t, _) in _CACHE.items() if now - t >= _CACHE_TTL]
        if not expired:
            expired = sorted(_CACHE, key=lambda k: _CACHE[k][0])[:_CACHE_MAX // 4]
        for k in expired:
            _CACHE.pop(k, None)
    _CACHE[mmsi] = (now, out)

# shore-distance lookup grid (lazy, coarse)
_shore_ctx = None


def _shore_lookup():
    """Coarse shore-distance grid (km) over the AOI for fast per-fix queries."""
    global _shore_ctx
    if _shore_ctx is not None:
        return _shore_ctx
    from ..config import settings
    from ..detection.sar_preprocess import LandMask
    from ..risk import features as F
    import numpy as np
    from scipy import ndimage
    from rasterio import features as rio_features

    lons, lats, cell = F.make_grid(settings.aoi_bbox, cell_deg=0.05)
    lm = LandMask(settings.data_dir / "landmask")
    from shapely.geometry import Polygon
    polys = []
    for p in lm.polys:
        polys.append(p if isinstance(p, Polygon) else list(p.geoms))
    transform = F._grid_transform(lons, lats, cell)
    nx, ny = len(lons), len(lats)
    land = rio_features.rasterize([(g, 1) for g in polys],
                                  out_shape=(ny, nx), transform=transform,
                                  fill=0, dtype="uint8").astype(bool)
    dist_px = ndimage.distance_transform_edt(~land)
    km_per_px = cell * 111.0
    _shore_ctx = (lons, lats, cell, dist_px * km_per_px)
    return _shore_ctx


def _shore_km(lons_a, lats_a):
    lons, lats, cell, grid = _shore_lookup()
    nx, ny = len(lons), len(lats)
    ix = np.clip(((np.asarray(lons_a) - (lons[0] - cell / 2)) / cell)
                 .astype(int), 0, nx - 1)
    iy = np.clip(((lats[0] - np.asarray(lats_a)) / cell).astype(int), 0, ny - 1)
    return grid[iy, ix]


def vessel_behavior_stats(store, mmsi: int) -> dict:
    """Behavioural anomaly in [0,1] plus the raw indicators."""
    now = time.time()
    hit = _CACHE.get(mmsi)
    if hit and now - hit[0] < _CACHE_TTL:
        return hit[1]

    rows = store.query(
        "SELECT ts,lon,lat,sog FROM ais_positions WHERE mmsi=? ORDER BY ts",
        (mmsi,))
    out = {"n_fixes": len(rows), "anomaly": 0.0,
           "slow_open_sea": 0.0, "night_slow": 0.0, "gap_max_min": 0.0}
    if len(rows) < 20:
        _cache_put(mmsi, out)
        return out

    ts = np.array([r["ts"] for r in rows])
    lon = np.array([r["lon"] for r in rows])
    lat = np.array([r["lat"] for r in rows])
    sog = np.array([r["sog"] if r["sog"] is not None else 6.0 for r in rows])

    shore = _shore_km(lon, lat)
    open_sea = shore > 3.0

    # AIS silence
    gaps = np.diff(ts)
    gap_max_min = float(gaps.max() / 60.0) if len(gaps) else 0.0

    # slow / drifting in open sea
    slow_open = open_sea & (sog < 1.5)
    slow_frac = float(slow_open.sum() / max(open_sea.sum(), 1))

    # slow at night (22:00-05:00 UTC) in open sea
    hours = ((ts % 86400) // 3600)
    night = (hours >= 22) | (hours < 5)
    night_open = night & open_sea
    night_slow_frac = float((night_open & (sog < 1.5)).sum()
                            / max(night_open.sum(), 1))

    anomaly = (0.45 * slow_frac
               + 0.30 * min(night_slow_frac * 2.0, 1.0)
               + 0.25 * min(gap_max_min / 240.0, 1.0))
    out.update({
        "anomaly": round(min(anomaly, 1.0), 3),
        "slow_open_sea": round(slow_frac, 3),
        "night_slow": round(night_slow_frac, 3),
        "gap_max_min": round(gap_max_min, 1),
    })
    _cache_put(mmsi, out)
    return out
