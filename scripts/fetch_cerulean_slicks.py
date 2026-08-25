"""Fetch SkyTruth Cerulean historical slick detections (OGC API, public
slick_plus collection) for a bbox and store them in the local SQLite store.

Cerulean: ML detections of ocean slicks in global Sentinel-1 imagery since
2015, with per-slick class (vessel / infrastructure / natural / not-oil),
confidence, geometry. This is the historical occurrence corpus for the
spill-risk model. CC-style attribution: data (c) SkyTruth Cerulean.
"""
from __future__ import annotations

import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

API = "https://api.cerulean.skytruth.org/collections/public.slick_plus/items"
# Baltic Sea + Gulf of Finland approach
BBOX = "9,53,31,66"
PAGE = 1000

# classes treated as anthropogenic oil (target signal for the risk model)
ANTHRO_CLS = {2, 4, 5, 6, 7, 8}


def ensure_table(store) -> None:
    store.exec("""
        CREATE TABLE IF NOT EXISTS hist_slicks (
            id INTEGER PRIMARY KEY,
            ts REAL,
            cls INTEGER,
            confidence REAL,
            area_m2 REAL,
            length_m REAL,
            centroid_lon REAL,
            centroid_lat REAL,
            s1_scene TEXT
        )""")
    store.exec(
        "CREATE INDEX IF NOT EXISTS ix_hist_ts ON hist_slicks(ts)")
    store.exec(
        "CREATE INDEX IF NOT EXISTS ix_hist_pos "
        "ON hist_slicks(centroid_lon, centroid_lat)")


def fetch_all(store, max_pages: int = 100) -> int:
    ensure_table(store)
    total = 0
    offset = 0
    with httpx.Client(timeout=httpx.Timeout(90)) as client:
        while offset < max_pages * PAGE:
            r = client.get(API, params={
                "bbox": BBOX, "limit": PAGE, "offset": offset})
            r.raise_for_status()
            d = r.json()
            feats = d.get("features", [])
            if not feats:
                break
            rows = []
            for f in feats:
                p = f.get("properties", {}) or {}
                geom = f.get("geometry") or {}
                if not geom.get("coordinates"):
                    continue
                from shapely.geometry import shape
                try:
                    c = shape(geom).centroid
                except Exception:
                    continue
                lon, lat = c.x, c.y
                ts = p.get("slick_timestamp")
                ts_epoch = datetime.fromisoformat(ts).replace(
                    tzinfo=timezone.utc).timestamp() if ts else None
                rows.append((
                    p.get("id"), ts_epoch, p.get("cls"),
                    p.get("machine_confidence"), p.get("area"),
                    p.get("length"), round(lon, 5), round(lat, 5),
                    p.get("s1_scene_id"),
                ))
            store.exec_many(
                "INSERT OR IGNORE INTO hist_slicks(id,ts,cls,confidence,area_m2,"
                "length_m,centroid_lon,centroid_lat,s1_scene) "
                "VALUES(?,?,?,?,?,?,?,?,?)", rows)
            total += len(rows)
            print(f"  page offset={offset}: +{len(rows)} (total {total})")
            offset += PAGE
            if len(feats) < PAGE:
                break
            time.sleep(0.4)
    return total


def main() -> None:
    from backend.config import settings
    from backend.store import Store

    def exec_many(self, sql, rows):
        with self._lock, self._conn:
            self._conn.executemany(sql, rows)

    Store.exec_many = exec_many  # small helper, avoids touching store.py API

    store = Store(settings.db_path)
    n = fetch_all(store)
    anthro = store.one(
        f"SELECT COUNT(*) c FROM hist_slicks WHERE cls IN "
        f"({','.join(str(c) for c in sorted(ANTHRO_CLS))})")["c"]
    if n:
        rng = store.one("SELECT MIN(ts) a, MAX(ts) b FROM hist_slicks")
        fmt = lambda t: datetime.fromtimestamp(t, timezone.utc).date().isoformat() if t else "?"
        print(f"stored {n} slicks ({anthro} anthropogenic), "
              f"{fmt(rng['a'])} .. {fmt(rng['b'])}")


if __name__ == "__main__":
    main()
