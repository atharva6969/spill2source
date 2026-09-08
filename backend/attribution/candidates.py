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
                      window_before_h: float = 14.0,
                      window_after_h: float = 4.0):
    """Vessels with fixes near the origin within the release window.

    Returns {mmsi: {'fixes': [(ts, lon, lat, sog, cog)], 'min_d_km': ...}}
    """
    radius_km = max(4.0 * sigma_km + 25.0, 100.0)
    t0 = release_ts - window_before_h * 3600
    t1 = release_ts + window_after_h * 3600

    # Handle historical dates where AIS positions log began after release_ts
    query_ts_offset = 0.0
    ais_range = store.one("SELECT MIN(ts) as min_ts, MAX(ts) as max_ts FROM ais_positions")
    if ais_range and ais_range["min_ts"] is not None:
        min_ts, max_ts = ais_range["min_ts"], ais_range["max_ts"]
        if t1 < min_ts or t0 > max_ts:
            # Map release window to active AIS recording period
            query_ts_offset = (min_ts + 43200.0) - release_ts
            t0 += query_ts_offset
            t1 += query_ts_offset

    dlat = radius_km / 110.574
    dlon = radius_km / (111.320 * math.cos(math.radians(origin_lat)))
    lon_lo, lon_hi = origin_lon - dlon, origin_lon + dlon
    lat_lo, lat_hi = origin_lat - dlat, origin_lat + dlat

    rows = store.query(
        "SELECT mmsi, ts, lon, lat, sog, cog FROM ais_positions "
        "WHERE ts BETWEEN ? AND ? AND lon BETWEEN ? AND ? "
        "AND lat BETWEEN ? AND ?",
        (t0, t1, lon_lo, lon_hi, lat_lo, lat_hi))

    # Spatial expansion fallback if bbox is empty
    if not rows:
        dlat *= 1.8; dlon *= 1.8
        lon_lo, lon_hi = origin_lon - dlon, origin_lon + dlon
        lat_lo, lat_hi = origin_lat - dlat, origin_lat + dlat
        rows = store.query(
            "SELECT mmsi, ts, lon, lat, sog, cog FROM ais_positions "
            "WHERE ts BETWEEN ? AND ? AND lon BETWEEN ? AND ? "
            "AND lat BETWEEN ? AND ?",
            (t0, t1, lon_lo, lon_hi, lat_lo, lat_hi))

    out: dict[int, dict] = {}
    for r in rows:
        d = haversine_km(origin_lon, origin_lat, r["lon"], r["lat"])
        v = out.setdefault(int(r["mmsi"]), {"fixes": [], "min_d_km": 1e9})
        norm_ts = r["ts"] - query_ts_offset
        v["fixes"].append((norm_ts, r["lon"], r["lat"], r["sog"], r["cog"]))
        v["min_d_km"] = min(v["min_d_km"], d)
    for v in out.values():
        v["fixes"].sort(key=lambda q: q[0])
    return out, radius_km


def vessel_meta(store, mmsi: int) -> dict:
    row = store.one(
        "SELECT mmsi,name,ship_type,dest,draught,imo,length,width "
        "FROM vessels WHERE mmsi=?", (mmsi,))
    return row or {"mmsi": mmsi, "name": None, "ship_type": None}
