"""Suspect scoring: rank vessels by spatio-temporal correlation with a slick.

Weighted evidence ensemble (weights sum to 1):
  proximity      0.33  closest approach to the estimated release point/time
  crossing       0.13  track segment intersects slick polygon or origin cell
  speed_anomaly  0.13  drifting / low-speed loitering inside the window
  ais_gap        0.13  AIS silence ("dark event") overlapping the release time
  type_prior     0.09  vessel-class likelihood of discharging oil
  course_align   0.11  heading consistent with the slick elongation axis
  behavior_prior 0.08  learned risk prior: open-sea drifting, night
                       loitering, AIS silence history (behaviour model)
"""
from __future__ import annotations

import math

import numpy as np
from shapely.geometry import Point, LineString

from .candidates import bearing_deg, candidate_vessels, haversine_km
from .behavior import vessel_behavior_stats

WEIGHTS = {
    "proximity": 0.33,
    "crossing": 0.13,
    "speed_anomaly": 0.13,
    "ais_gap": 0.13,
    "type_prior": 0.09,
    "course_align": 0.11,
    "behavior_prior": 0.08,
}

# AIS ship-type code -> (likelihood of being an oily-discharge source, label)
# Codes 80-84 are liquid cargo; 85-89 are the general tanker classes (crude/
# product/liquefied gas) — both are tankers for oil-discharge prior purposes.
TYPE_PRIOR = {
    **{t: (1.00, "tanker") for t in range(80, 90)},
    **{t: (0.75, "cargo") for t in range(70, 80)},
    30: (0.25, "fishing"), 31: (0.45, "towing"), 32: (0.45, "towing"),
    50: (0.30, "pilot"), 51: (0.55, "tug"), 52: (0.40, "reserve"),
    53: (0.45, "port tender"), 55: (0.35, "law enforce"),
    **{t: (0.20, "passenger") for t in range(60, 70)},
}
DEFAULT_PRIOR = (0.35, "unknown")


def score_vessels(store, slick: dict, drift: dict) -> list[dict]:
    """slick: row from slicks; drift: backward run result with origin estimate.

    Returns ranked suspect dicts with per-factor evidence.
    """
    origin_lon = drift["origin_lon"]
    origin_lat = drift["origin_lat"]
    release_ts = drift["release_ts"]
    sigma_km = max(drift["origin_sigma_km"], 1.0)

    cands, radius_km = candidate_vessels(
        store, origin_lon, origin_lat, release_ts, sigma_km)

    slick_geom = None
    try:
        import json
        gj = json.loads(slick["geometry"]) if isinstance(slick["geometry"], str) \
            else slick["geometry"]
        from shapely.geometry import shape
        slick_geom = shape(gj["geometry"]).buffer(0.01)  # ~1 km
    except Exception:
        pass
    slick_axis = slick.get("orientation_deg")
    mmsis = list(cands.keys())
    meta_map = {}
    if mmsis:
        placeholders = ",".join("?" for _ in mmsis)
        rows = store.query(
            f"SELECT mmsi,name,ship_type,dest,draught,imo,length,width "
            f"FROM vessels WHERE mmsi IN ({placeholders})", tuple(mmsis))
        meta_map = {r["mmsi"]: r for r in rows}

    results = []
    # Bulk-prefetch all candidate behaviour histories in one query instead of
    # issuing a full-track SELECT per candidate (N+1).
    if mmsis:
        rows = store.query(
            "SELECT mmsi,ts,lon,lat,sog FROM ais_positions "
            f"WHERE mmsi IN ({placeholders}) ORDER BY ts", tuple(mmsis))
        beh_rows: dict[int, list[dict]] = {}
        for r in rows:
            beh_rows.setdefault(int(r["mmsi"]), []).append(r)
    else:
        beh_rows = {}
    for mmsi, cd in cands.items():
        fixes = cd["fixes"]
        if len(fixes) < 1:
            continue
        f_prox, ev_prox = _proximity(fixes, origin_lon, origin_lat, release_ts)
        f_cross, ev_cross = _crossing(fixes, slick_geom, origin_lon, origin_lat)
        f_speed, ev_speed = _speed_anomaly(fixes)
        f_gap, ev_gap = _ais_gap(fixes, release_ts)
        meta = meta_map.get(mmsi, {"mmsi": mmsi, "name": None, "ship_type": None})
        f_type, ev_type = _type_prior(meta.get("ship_type"))
        f_align, ev_align = _course_align(fixes, slick_axis)
        beh = vessel_behavior_stats(store, mmsi,
                                    prefetched=beh_rows.get(mmsi))
        f_beh = beh["anomaly"]
        ev_beh = (f"behaviour: {beh['slow_open_sea'] * 100:.0f}% slow in open "
                  f"sea, max AIS gap {beh['gap_max_min']:.0f} min "
                  f"({beh['n_fixes']} fixes on record)")

        factors = {
            "proximity": {"score": round(f_prox, 3), "weight": WEIGHTS["proximity"],
                          "evidence": ev_prox},
            "crossing": {"score": round(f_cross, 3), "weight": WEIGHTS["crossing"],
                         "evidence": ev_cross},
            "speed_anomaly": {"score": round(f_speed, 3),
                              "weight": WEIGHTS["speed_anomaly"],
                              "evidence": ev_speed},
            "ais_gap": {"score": round(f_gap, 3), "weight": WEIGHTS["ais_gap"],
                        "evidence": ev_gap},
            "type_prior": {"score": round(f_type, 3), "weight": WEIGHTS["type_prior"],
                           "evidence": ev_type},
            "course_align": {"score": round(f_align, 3),
                             "weight": WEIGHTS["course_align"],
                             "evidence": ev_align},
            "behavior_prior": {"score": round(f_beh, 3),
                               "weight": WEIGHTS["behavior_prior"],
                               "evidence": ev_beh},
        }
        total = sum(factors[k]["score"] * factors[k]["weight"] for k in WEIGHTS)
        results.append({
            "mmsi": mmsi,
            "name": meta.get("name"),
            "ship_type": meta.get("ship_type"),
            "type_label": ev_type.split(":")[0] if ev_type else "?",
            "min_dist_km": round(cd["min_d_km"], 2),
            "n_fixes": len(fixes),
            "score": round(total * 100, 1),
            "factors": factors,
        })
    results.sort(key=lambda r: -r["score"])
    for i, r in enumerate(results):
        r["rank"] = i + 1
    return results


# ---- individual factors ------------------------------------------------------
def _proximity(fixes, olon, olat, release_ts, tol_s=10800, scale_km=18.0):
    near = [f for f in fixes if abs(f[0] - release_ts) <= tol_s]
    if not near:
        # fall back to closest fix in the whole window
        near = fixes
    d = min(haversine_km(olon, olat, f[1], f[2]) for f in near)
    dt_min = min(abs(f[0] - release_ts) for f in near) / 60.0
    val = math.exp(-d / scale_km)
    return val, f"closest approach {d:.1f} km ({dt_min:.0f} min from est. release)"


def _crossing(fixes, slick_geom, olon, olat):
    pts = [(f[1], f[2]) for f in fixes]
    line = LineString(pts) if len(pts) > 1 else Point(pts[0])
    hit_slick = False
    hit_origin = False
    if slick_geom is not None and line.intersects(slick_geom):
        hit_slick = True
    min_orig_d = min(haversine_km(p[0], p[1], olon, olat) for p in pts)
    if min_orig_d < 5.0:
        hit_origin = True

    if hit_origin:
        val = 1.0
    elif hit_slick:
        val = 0.8
    elif min_orig_d < 15.0:
        val = max(0.2, 0.7 * (1.0 - min_orig_d / 15.0))
    else:
        val = 0.0

    ev = []
    if hit_origin:
        ev.append(f"track passes within {min_orig_d:.1f} km of origin point")
    elif hit_slick:
        ev.append("track crosses slick footprint")
    else:
        ev.append(f"track stays {min_orig_d:.1f} km from release origin")
    return val, "; ".join(ev)


def _speed_anomaly(fixes):
    sogs = [f[3] for f in fixes if f[3] is not None]
    if not sogs:
        return 0.35, "no speed data recorded"
    slow_frac = float(np.mean([s < 3.0 for s in sogs]))
    med = float(np.median(sogs))
    val = slow_frac * (0.6 + 0.4 * (med < 6.0))
    return min(max(val, 0.25), 1.0), (f"{slow_frac * 100:.0f}% of fixes < 3 kn "
                                      f"(median SOG {med:.1f} kn)")


def _ais_gap(fixes, release_ts, min_gap_s=900):
    ts = [f[0] for f in fixes]
    if len(ts) < 2:
        return 0.35, "single fix (limited temporal tracking)"
    gaps = np.diff(ts)
    best_val, best_ev = 0.0, "no suspicious AIS gaps"
    for g, t_start in zip(gaps, ts[:-1]):
        t_end = t_start + g
        if g <= min_gap_s:
            continue
        overlap = min(t_end, release_ts + 3600) - max(t_start, release_ts - 3600)
        if overlap <= 0:
            continue
        val = min(g / 5400.0, 1.0)          # saturate at 1.5 h silence
        if val > best_val:
            best_val = val
            best_ev = (f"AIS silent {g / 60:.0f} min overlapping release window")
    return max(best_val, 0.1), best_ev


def _type_prior(code):
    prior, label = TYPE_PRIOR.get(int(code) if code is not None else -1,
                                  DEFAULT_PRIOR)
    return prior, f"{label}: prior {prior:.2f}"


def _course_align(fixes, slick_axis_deg, tol=45.0):
    if slick_axis_deg is None or len(fixes) < 2:
        return 0.45, "no axis/heading reference"
    p0, p1 = fixes[0], fixes[-1]
    brg = bearing_deg(p0[1], p0[2], p1[1], p1[2])
    d = abs((brg - float(slick_axis_deg) + 90) % 180 - 90)  # angular distance
    val = max(0.1, 1.0 - d / tol) if d <= tol else 0.1
    return val, f"movement {brg:.0f}° aligns with slick axis ±{tol:.0f}°"
