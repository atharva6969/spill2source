"""Candidate vessel selection around an estimated spill origin."""
from __future__ import annotations

import math

EARTH_R = 6371.0


def haversine_km(lon1, lat1, lon2, lat2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


def haversine_km_vec(lon1, lat1, lon2, lat2):
    """Vectorized haversine for numpy arrays of positions."""
    import numpy as np
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(lon2 - lon1)
    a = (np.sin(dp / 2) ** 2
         + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2)
    return 2 * EARTH_R * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def bearing_deg(lon1, lat1, lon2, lat2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(x, y)) % 360.0


def candidate_vessels(store, origin_lon: float, origin_lat: float,
                      release_ts: float, sigma_km: float,
                      window_before_h: float = 8.0,
                      window_after_h: float = 2.5):
    """Vessels with fixes near the origin within the release window.

    Returns {mmsi: {'fixes': [(ts, lon, lat, sog, cog)], 'min_d_km': ...}}
    """
    radius_km = max(3.0 * sigma_km + 10.0, 50.0)
    t0 = release_ts - window_before_h * 3600
    t1 = release_ts + window_after_h * 3600
    rows = store.query(
        "SELECT mmsi, ts, lon, lat, sog, cog FROM ais_positions "
        "WHERE ts BETWEEN ? AND ?", (t0, t1))
    out: dict[int, dict] = {}
    for r in rows:
        d = haversine_km(origin_lon, origin_lat, r["lon"], r["lat"])
        if d > radius_km:
            continue
        v = out.setdefault(int(r["mmsi"]), {"fixes": [], "min_d_km": 1e9})
        v["fixes"].append((r["ts"], r["lon"], r["lat"], r["sog"], r["cog"]))
        v["min_d_km"] = min(v["min_d_km"], d)
    for v in out.values():
        v["fixes"].sort(key=lambda q: q[0])
    return out, radius_km


def vessel_meta(store, mmsi: int) -> dict:
    row = store.one(
        "SELECT mmsi,name,ship_type,dest,draught,imo,length,width "
        "FROM vessels WHERE mmsi=?", (mmsi,))
    return row or {"mmsi": mmsi, "name": None, "ship_type": None}
