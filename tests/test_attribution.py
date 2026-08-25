"""Attribution scorer tests: monotonicity + gap detection on a fixture store."""
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.store import Store  # noqa: E402
from backend.attribution.score import score_vessels  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    st = Store(tmp_path / "t.db")
    now = time.time()
    origin = (24.9, 59.6)  # est. release point
    release = now - 3600

    # vessel A: sat at the origin at release time, tanker
    fixes_a = []
    for i in range(20):
        fixes_a.append((release - 900 * i, 24.902, 59.601, 0.5, 180))
        fixes_a.append((release - 900 * i + 30, 24.904, 59.604, 0.8, 190))
    rows = [(9500001, ts, lon, lat, sog, cog, 0)
            for (ts, lon, lat, sog, cog) in fixes_a]

    # vessel B: same era but ~5+ km off and transiting fast
    for i in range(40):
        rows.append((9500002, release - 900 * i,
                     24.90 + 0.02 * i, 59.55 + 0.001 * i, 12.0, 80, 0))

    # vessel C: passes near origin but goes dark for 3 h over release
    for i in range(10):
        rows.append((9500003, release - 7200 - 600 * i,
                     24.95 - 0.01 * i, 59.62, 9.0, 250, 0))
    for i in range(10):
        rows.append((9500003, release + 5400 + 600 * i,
                     24.88 - 0.01 * i, 59.58, 9.0, 100, 0))

    st.upsert_positions(rows)
    st.upsert_vessels([
        {"mmsi": 9500001, "name": "TEST TANKER", "shipType": 80},
        {"mmsi": 9500002, "name": "THROUGH TRAFFIC", "shipType": 70},
        {"mmsi": 9500003, "name": "DARK RUNNER", "shipType": 70},
    ])
    return st


SLICK = {
    "id": 1, "orientation_deg": 45.0,
    "geometry": None,
}


def test_closer_stationary_tanker_outscores_far_transit(store):
    drift = {"origin_lon": 24.90, "origin_lat": 59.60,
             "release_ts": time.time() - 3600, "origin_sigma_km": 3.0}
    res = score_vessels(store, SLICK, drift)
    by_mmsi = {r["mmsi"]: r for r in res}
    assert by_mmsi[9500001]["score"] > by_mmsi[9500002]["score"]
    assert res[0]["mmsi"] == 9500001
    assert res[0]["factors"]["proximity"]["score"] > \
        res[0]["factors"]["proximity"]["score"] - 1e9  # present


def test_dark_gap_beats_clean_track(store):
    drift = {"origin_lon": 24.92, "origin_lat": 59.60,
             "release_ts": time.time() - 3600, "origin_sigma_km": 3.0}
    res = score_vessels(store, SLICK, drift)
    by_mmsi = {r["mmsi"]: r for r in res}
    assert by_mmsi[9500003]["score"] > by_mmsi[9500002]["score"]
    assert by_mmsi[9500003]["factors"]["ais_gap"]["score"] > 0


def test_scores_bounded(store):
    drift = {"origin_lon": 24.90, "origin_lat": 59.60,
             "release_ts": time.time() - 3600, "origin_sigma_km": 3.0}
    res = score_vessels(store, SLICK, drift)
    for r in res:
        assert 0 <= r["score"] <= 100
