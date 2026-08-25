"""Unit tests for the drift engine and attribution scoring."""
import math
import sys
import time
from pathlib import Path

import numpy as np
import pytest
from shapely.geometry import Point

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.config import Settings  # noqa: E402
from backend.drift.fields import FieldSet  # noqa: E402
from backend.drift.lagrangian import DriftModel, LocalFrame  # noqa: E402


class FakeMet:
    """Code fixture: uniform 1 m/s eastward current + 5 m/s wind, hourly."""

    def __init__(self, hours=72):
        self.times = np.arange(hours, dtype=np.float64) * 3600.0
        self.grid_lons = np.array([21.0, 22.0])
        self.grid_lats = np.array([59.0, 60.0])
        shape = (2, 2, hours)
        self.wind_u = np.full(shape, 5.0)
        self.wind_v = np.zeros(shape)
        self.cur_u = np.ones(shape)
        self.cur_v = np.zeros(shape)


def test_fieldset_uniform_interior():
    f = FieldSet(FakeMet())
    s = f.sample(59.5, 21.5, 3600)
    assert abs(s["current"][0] - 1.0) < 1e-6
    assert abs(s["wind"][0] - 5.0) < 1e-6


def test_local_frame_roundtrip():
    fr = LocalFrame(25.0, 59.9)
    x, y = fr.to_m(25.05, 59.95)
    lon, lat = fr.to_ll(x, y)
    assert abs(lon - 25.05) < 1e-9
    assert abs(lat - 59.95) < 1e-9


def test_forward_run_transports_and_spreads():
    f = FieldSet(FakeMet())
    s = Settings()
    s.timestep_s = 300
    dm = DriftModel(f, s)
    slick = Point(21.5, 59.5).buffer(0.02)
    t0 = float(f.times[24])
    out = dm.forward(slick, t0, hours=6, n_particles=200)
    # centroid_path is [x_m, y_m, t] in the local frame
    c_start = out["centroid_path"][0]
    c_end = out["centroid_path"][-1]
    dx_km = (c_end[0] - c_start[0]) / 1000.0
    elapsed_h = (c_end[2] - c_start[2]) / 3600.0
    speed_kmh = dx_km / elapsed_h
    # 1 m/s = 3.6 km/h; windage+stokes add ~0.25 m/s => between 3.4 and 4.8 km/h
    assert 3.2 < speed_kmh < 5.2, speed_kmh


def test_backward_origin_near_seed():
    f = FieldSet(FakeMet())
    s = Settings()
    dm = DriftModel(f, s)
    now = time.time()
    slick = Point(21.5, 59.5).buffer(0.03)
    bw = dm.backward(slick, now, hours=10, n_particles=300)
    d_deg = math.hypot(bw["origin_lon"] - 21.5, bw["origin_lat"] - 59.5)
    assert d_deg < 1.0
    assert bw["spread_curve"] and bw["age_h"] >= 0
