"""SQLite persistence: AIS history, slicks, drift runs, suspects, scenes, events.

The system accumulates its own real track history from the live AIS feed from
first launch - attribution windows are answered from this store.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS ais_positions (
    mmsi INTEGER NOT NULL,
    ts REAL NOT NULL,
    lon REAL NOT NULL,
    lat REAL NOT NULL,
    sog REAL, cog REAL, navstat INTEGER,
    UNIQUE(mmsi, ts)
);
CREATE INDEX IF NOT EXISTS ix_ais_ts ON ais_positions(ts);
CREATE INDEX IF NOT EXISTS ix_ais_mmsi_ts ON ais_positions(mmsi, ts);

CREATE TABLE IF NOT EXISTS vessels (
    mmsi INTEGER PRIMARY KEY,
    name TEXT, ship_type INTEGER, dest TEXT, draught REAL,
    imo TEXT, call_sign TEXT, length INTEGER, width INTEGER,
    updated REAL
);

CREATE TABLE IF NOT EXISTS scenes (
    product_id TEXT PRIMARY KEY,
    name TEXT, sensed_start REAL, size_mb REAL,
    footprint TEXT, status TEXT DEFAULT 'catalogued',
    processed_at REAL, error TEXT
);

CREATE TABLE IF NOT EXISTS slicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id TEXT, scene_name TEXT,
    detected_at REAL,
    centroid_lon REAL, centroid_lat REAL,
    area_km2 REAL, major_axis_km REAL, minor_axis_km REAL,
    orientation_deg REAL,
    confidence REAL, oil_probability REAL,
    age_estimate_h REAL, age_sigma_h REAL,
    geometry TEXT,
    properties TEXT
);
CREATE INDEX IF NOT EXISTS ix_slicks_scene ON slicks(scene_id);

CREATE TABLE IF NOT EXISTS drift_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slick_id INTEGER NOT NULL REFERENCES slicks(id),
    direction TEXT,                       -- 'backward' | 'forward'
    started_at REAL,
    origin_lon REAL, origin_lat REAL,
    origin_sigma_km REAL,
    release_time REAL,                    -- estimated spill start (epoch s)
    spread_curve TEXT,                    -- [[t_offset_h, spread_km], ...]
    path TEXT,                            -- centroid trajectory GeoJSON LineString
    cone TEXT,                            -- forward uncertainty envelope polygons
    particles TEXT                        -- decimated particle endpoints/paths
);
CREATE INDEX IF NOT EXISTS ix_drift_slick ON drift_runs(slick_id);

CREATE TABLE IF NOT EXISTS suspects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slick_id INTEGER NOT NULL REFERENCES slicks(id),
    mmsi INTEGER NOT NULL,
    score REAL, rank INTEGER,
    factors TEXT,                         -- {name: {score 0..1, weight, evidence}}
    computed_at REAL,
    UNIQUE(slick_id, mmsi)
);
CREATE INDEX IF NOT EXISTS ix_suspects_slick ON suspects(slick_id);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, kind TEXT, severity TEXT DEFAULT 'info',
    message TEXT, payload TEXT
);

CREATE TABLE IF NOT EXISTS risk_grid (
    lon0 REAL, lat0 REAL, lon1 REAL, lat1 REAL,
    p REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_risk_p ON risk_grid(p);
"""


class Store:
    def __init__(self, db_path):
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False,
                                     timeout=30)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock, self._conn:
            self._conn.execute("PRAGMA busy_timeout = 30000")
            self._conn.execute("PRAGMA journal_mode = WAL")
            self._conn.execute("PRAGMA synchronous = NORMAL")
            self._conn.execute("PRAGMA cache_size = -64000")
            self._conn.executescript(SCHEMA)

    def exec(self, sql: str, params: Iterable = ()) -> None:
        with self._lock, self._conn:
            self._conn.execute(sql, tuple(params))

    def exec_many(self, sql: str, rows: list[tuple]) -> None:
        with self._lock, self._conn:
            self._conn.executemany(sql, rows)

    def query(self, sql: str, params: Iterable = ()) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(sql, tuple(params)).fetchall()
        return [dict(r) for r in rows]

    def one(self, sql: str, params: Iterable = ()) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    # ---- AIS ---------------------------------------------------------------
    def upsert_positions(self, rows: list[tuple]) -> int:
        """rows: (mmsi, ts, lon, lat, sog, cog, navstat)"""
        if not rows:
            return 0
        with self._lock, self._conn:
            before = self._conn.total_changes
            self._conn.executemany(
                "INSERT OR IGNORE INTO ais_positions(mmsi, ts, lon, lat, sog, cog, navstat)"
                " VALUES(?,?,?,?,?,?,?)",
                rows,
            )
            return self._conn.total_changes - before

    def upsert_vessels(self, metas: list[dict]) -> None:
        now = time.time()
        rows = [{
            "mmsi": int(m["mmsi"]), "name": m.get("name"),
            "shipType": m.get("shipType"), "destination": m.get("dest") or m.get("destination"),
            "draught": m.get("draught"), "imo": m.get("imo"),
            "callSign": m.get("callSign"), "length": m.get("length") or 0,
            "width": m.get("width") or 0, "updated": now,
        } for m in metas if m.get("mmsi")]
        with self._lock, self._conn:
            self._conn.executemany(
                """INSERT INTO vessels(mmsi,name,ship_type,dest,draught,imo,call_sign,length,width,updated)
                   VALUES(:mmsi,:name,:shipType,:destination,:draught,:imo,:callSign,:length,:width,:updated)
                   ON CONFLICT(mmsi) DO UPDATE SET
                     name=excluded.name, ship_type=excluded.ship_type, dest=excluded.dest,
                     draught=excluded.draught, imo=excluded.imo, call_sign=excluded.call_sign,
                     length=excluded.length, width=excluded.width, updated=excluded.updated""",
                rows,
            )

    def prune_positions(self, keep_seconds: float) -> None:
        cutoff = time.time() - keep_seconds
        self.exec("DELETE FROM ais_positions WHERE ts < ?", (cutoff,))

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ---- generic JSON helpers ----------------------------------------------
    @staticmethod
    def _j(v: Any) -> str | None:
        return None if v is None else json.dumps(v)

    @staticmethod
    def _unj(v):
        return None if v is None else json.loads(v)
