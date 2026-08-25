"""Rich vessel information: metadata + flag from MMSI + computed history.

Combines three real sources:
  1. Digitraffic vessel metadata (name, type, IMO, callsign, dimensions...)
  2. ITU MMSI MID table (first 3 digits = country code)
  3. The watch's own accumulated AIS history (speeds, stops, dark gaps...)
"""
from __future__ import annotations

import math
import time

import numpy as np

from .attribution.candidates import haversine_km_vec

# ITU Maritime Identification Digits -> country (curated common subset)
MID = {
    "201": "Albania", "203": "Austria", "205": "Belgium", "206": "Belarus",
    "209": "Cyprus", "211": "Germany", "212": "Cyprus", "215": "Malta",
    "216": "Hungary", "219": "Moldova", "224": "Spain", "226": "France",
    "227": "France", "228": "France", "229": "Malta", "230": "Finland",
    "231": "Faroe Islands", "232": "United Kingdom", "233": "United Kingdom",
    "234": "United Kingdom", "235": "United Kingdom", "236": "Gibraltar",
    "237": "Greece", "238": "Croatia", "239": "Greece", "240": "Greece",
    "241": "Greece", "242": "Morocco", "244": "Netherlands",
    "245": "Netherlands", "246": "Netherlands", "247": "Italy",
    "248": "Malta", "249": "Malta", "250": "Ireland", "251": "Iceland",
    "253": "Luxembourg", "254": "Portugal", "255": "Portugal",
    "257": "Norway", "258": "Norway", "259": "France", "261": "Poland",
    "263": "Portugal", "264": "Romania", "265": "Sweden", "266": "Sweden",
    "267": "Slovakia", "269": "Switzerland", "270": "Czechia",
    "271": "Türkiye", "272": "Ukraine", "273": "Russia", "274": "North Macedonia",
    "275": "Latvia", "276": "Estonia", "277": "Lithuania", "278": "Slovenia",
    "279": "Serbia", "280": "Montenegro",
    "305": "Antigua & Barbuda", "306": "Antigua & Barbuda",
    "308": "Bahamas", "309": "Bahamas", "310": "Bermuda",
    "311": "Bahamas", "312": "Belize", "314": "Barbados", "316": "Canada",
    "319": "Cayman Islands", "325": "Cuba", "327": "Dominica",
    "329": "Dominican Republic", "331": "Greenland", "334": "Honduras",
    "338": "United States", "339": "United States", "341": "St Kitts & Nevis",
    "343": "St Lucia", "345": "Mexico", "350": "Nicaragua", "351": "Panama",
    "352": "Panama", "353": "Panama", "354": "Panama", "355": "Panama",
    "356": "Panama", "357": "Panama", "358": "Puerto Rico",
    "359": "El Salvador", "362": "Trinidad & Tobago",
    "364": "St Vincent & Grenadines", "366": "United States",
    "367": "United States", "368": "United States", "369": "United States",
    "370": "Panama", "371": "Panama", "372": "Argentina", "373": "Brazil",
    "374": "Brazil", "375": "Brazil", "376": "Brazil", "377": "Brazil",
    "378": "Chile", "380": "Colombia", "384": "Peru", "386": "Ecuador",
    "403": "Saudi Arabia", "405": "Bangladesh", "408": "Bahrain",
    "412": "China", "413": "China", "414": "China", "416": "Taiwan",
    "417": "Sri Lanka", "419": "India", "422": "Iran", "423": "Azerbaijan",
    "425": "Iraq", "428": "Israel", "431": "Japan", "432": "Japan",
    "433": "Japan", "436": "Kazakhstan", "438": "Jordan", "440": "South Korea",
    "441": "South Korea", "445": "North Korea", "447": "Kuwait",
    "448": "Lebanon", "453": "Macao", "454": "Malaysia", "455": "Malaysia",
    "457": "Mongolia", "459": "Oman", "461": "Pakistan",
    "463": "Philippines", "466": "Qatar", "468": "Syria",
    "470": "UAE", "471": "UAE", "473": "Yemen", "477": "Hong Kong",
    "503": "Australia", "506": "Myanmar", "508": "Brunei", "511": "Guam",
    "512": "New Zealand", "513": "New Zealand", "518": "Cook Islands",
    "520": "Fiji", "525": "Indonesia", "527": "Indonesia", "533": "Malaysia",
    "538": "Marshall Islands", "540": "New Caledonia", "544": "Nauru",
    "546": "French Polynesia", "548": "Philippines", "553": "Papua New Guinea",
    "557": "Palau", "559": "Solomon Islands", "561": "Samoa",
    "563": "Singapore", "564": "Singapore", "565": "Singapore",
    "570": "Tonga", "572": "Tuvalu", "574": "Vietnam", "576": "Vanuatu",
    "577": "Vanuatu", "580": "Australia",
    "601": "South Africa", "603": "Angola", "605": "Algeria",
    "607": "Cameroon", "609": "Cape Verde", "613": "Benin", "617": "Guinea",
    "619": "Kenya", "621": "Tanzania", "624": "Liberia",
    "626": "Mauritania", "627": "Sierra Leone", "629": "Senegal",
    "630": "Gabon", "633": "Nigeria", "635": "Namibia", "637": "Sudan",
    "642": "Seychelles", "645": "Mauritius", "647": "Réunion",
    "651": "Eritrea", "654": "Somalia", "655": "South Africa",
    "659": "Togo", "664": "Tunisia", "667": "Morocco", "668": "Morocco",
    "669": "Libya", "671": "Ghana", "674": "Côte d'Ivoire",
    "675": "Djibouti", "678": "Guinea-Bissau",
}

SHIP_TYPES = {
    0: ("Not available", "·"),
    20: ("Wing in ground", "◂▸"),
    30: ("Fishing", "⚓"),
    31: ("Towing", "⚓"), 32: ("Towing (large)", "⚓"),
    33: ("Dredging", "⚓"), 34: ("Diving ops", "⚓"),
    35: ("Military", "★"), 36: ("Sailing", "⛵"), 37: ("Pleasure craft", "⛵"),
    40: ("High-speed craft", "⏩"), 50: ("Pilot", "⚓"), 51: ("Search & rescue", "⚓"),
    52: ("Tug", "⚓"), 53: ("Port tender", "⚓"), 54: ("Anti-pollution", "⚓"),
    55: ("Law enforcement", "⚓"), 58: ("Medical", "✚"), 59: ("Special", "⚓"),
    60: ("Passenger", "⛴"), 61: ("Passenger", "⛴"), 62: ("Passenger", "⛴"),
    63: ("Passenger", "⛴"), 64: ("Passenger", "⛴"), 65: ("Passenger", "⛴"),
    66: ("Passenger", "⛴"), 67: ("Passenger", "⛴"), 68: ("Passenger", "⛴"),
    69: ("Passenger", "⛴"),
    70: ("Cargo", "▣"), 71: ("Cargo (haz A)", "▣"), 72: ("Cargo (haz B)", "▣"),
    73: ("Cargo (haz C)", "▣"), 74: ("Cargo (haz D)", "▣"),
    75: ("Cargo", "▣"), 76: ("Cargo", "▣"), 77: ("Cargo", "▣"),
    78: ("Cargo", "▣"), 79: ("Cargo", "▣"),
    80: ("Tanker", "◍"), 81: ("Tanker (haz A)", "◍"), 82: ("Tanker (haz B)", "◍"),
    83: ("Tanker (haz C)", "◍"), 84: ("Tanker (haz D)", "◍"),
    85: ("Tanker", "◍"), 86: ("Tanker", "◍"), 87: ("Tanker", "◍"),
    88: ("Tanker", "◍"), 89: ("Tanker", "◍"),
    90: ("Other", "◆"),
}

NAV_STATUS = {
    0: "Under way (engine)", 1: "At anchor", 2: "Not under command",
    3: "Restricted manoeuvre", 4: "Constrained by draught",
    5: "Moored", 6: "Aground", 7: "Engaged in fishing",
    8: "Under way (sailing)", 15: "Undefined",
}


def flag_from_mmsi(mmsi: int) -> str:
    mid = str(int(mmsi)).zfill(9)[:3]
    return MID.get(mid, f"Unknown (MID {mid})")


def type_label(code) -> tuple[str, str]:
    try:
        return SHIP_TYPES.get(int(code), ("Unknown", "?"))
    except (TypeError, ValueError):
        return ("Unknown", "?")


def history_stats(store, mmsi: int) -> dict:
    """Computed vessel history from the watch's own AIS store."""
    rows = store.query(
        "SELECT ts,lon,lat,sog,cog FROM ais_positions WHERE mmsi=? ORDER BY ts",
        (mmsi,))
    if not rows:
        return {}
    ts = np.array([r["ts"] for r in rows])
    lon = np.array([r["lon"] for r in rows])
    lat = np.array([r["lat"] for r in rows])
    sog = np.array([r["sog"] if r["sog"] is not None else np.nan
                    for r in rows])

    # distance sailed (sum of leg lengths)
    d = haversine_km_vec(lon[:-1], lat[:-1], lon[1:], lat[1:])
    total_km = float(np.nansum(d))

    now = time.time()
    day = ts >= now - 86400
    km24 = float(np.nansum(d[day[:-1]])) if day.sum() > 1 else 0.0

    # stops: runs of >=15 min with sog < 1 kn
    stops, run_start = [], None
    for i in range(len(rows)):
        moving = not (sog[i] < 1.0)
        if moving and run_start is not None:
            dur = ts[i] - ts[run_start]
            if dur >= 900:
                stops.append({
                    "lon": float(np.nanmean(lon[run_start:i])),
                    "lat": float(np.nanmean(lat[run_start:i])),
                    "minutes": round(dur / 60.0),
                    "start": float(ts[run_start]),
                })
            run_start = None
        elif not moving and run_start is None:
            run_start = i
    stops = sorted(stops, key=lambda s: -s["minutes"])[:8]

    gaps = np.diff(ts)
    dark = int((gaps > 1800).sum())

    valid = sog[np.isfinite(sog)]
    return {
        "first_seen": float(ts[0]),
        "last_seen": float(ts[-1]),
        "positions": len(rows),
        "distance_km": round(total_km, 1),
        "distance_24h_km": round(km24, 1),
        "avg_speed": round(float(np.nanmean(valid)), 1) if len(valid) else None,
        "max_speed": round(float(np.nanmax(valid)), 1) if len(valid) else None,
        "stops": stops,
        "dark_gaps": dark,
        "speed_series": [
            [float(t), round(float(s), 1)]
            for t, s in zip(ts, sog)
            if np.isfinite(s)
        ][-240:],
    }


def vessel_details(store, mmsi: int, latest: dict | None) -> dict:
    meta = store.one(
        "SELECT mmsi,name,ship_type,dest,draught,imo,call_sign,length,width "
        "FROM vessels WHERE mmsi=?", (mmsi,)) or {"mmsi": mmsi}
    label, icon = type_label(meta.get("ship_type"))
    out = {
        "mmsi": mmsi,
        "name": meta.get("name"),
        "type_code": meta.get("ship_type"),
        "type_label": label,
        "type_icon": icon,
        "flag": flag_from_mmsi(mmsi),
        "imo": (str(meta["imo"]) if meta.get("imo") not in (None, "", "0")
                else None),
        "call_sign": meta.get("call_sign"),
        "length": meta.get("length") or None,
        "width": meta.get("width") or None,
        "draught": round(meta["draught"] / 10.0, 1) if meta.get("draught") else None,
        "destination": (meta.get("dest") or "").strip() or None,
    }
    if latest:
        out["live"] = {
            "lon": latest["lon"], "lat": latest["lat"],
            "sog": latest["sog"], "cog": latest["cog"],
            "nav_status": NAV_STATUS.get(latest.get("navStat"), "Unknown"),
            "ts": latest["ts"],
        }
    out["history"] = history_stats(store, mmsi)
    return out
