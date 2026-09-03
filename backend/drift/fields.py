"""Spatio-temporal interpolation of met-ocean forcing fields.

MetProvider holds hourly grids [ny, nx, T]. This module converts a
(lat, lon, epoch_s) query into (u, v) wind and current vectors via bilinear
spatial + linear temporal interpolation.
"""
from __future__ import annotations

import math

import numpy as np


class FieldSet:
    def __init__(self, met):
        if met.times is None:
            raise RuntimeError("met fields not refreshed yet")
        self.lons = met.grid_lons
        self.lats = met.grid_lats
        self.times = met.times.astype(np.float64)
        self.wind_u, self.wind_v = met.wind_u, met.wind_v
        self.cur_u, self.cur_v = met.cur_u, met.cur_v

    # -- helpers ---------------------------------------------------------------
    def _ix(self, x: float) -> tuple[int, float]:
        i = np.searchsorted(self.lons, x) - 1
        i = int(np.clip(i, 0, len(self.lons) - 2))
        f = (x - self.lons[i]) / (self.lons[i + 1] - self.lons[i])
        return i, min(max(f, 0.0), 1.0)

    def _iy(self, y: float) -> tuple[int, float]:
        j = np.searchsorted(self.lats, y) - 1
        j = int(np.clip(j, 0, len(self.lats) - 2))
        f = (y - self.lats[j]) / (self.lats[j + 1] - self.lats[j])
        return j, min(max(f, 0.0), 1.0)

    def _it(self, t: float) -> tuple[int, float]:
        k = np.searchsorted(self.times, t) - 1
        if k < 0:
            return 0, 0.0
        if k >= len(self.times) - 1:
            return len(self.times) - 2, 1.0
        f = (t - self.times[k]) / (self.times[k + 1] - self.times[k])
        return int(k), min(max(f, 0.0), 1.0)

    @staticmethod
    def _bilinear(field: np.ndarray, iy, fy, ix, fx, it, ft) -> float:
        c00 = field[iy, ix, it] * (1 - fx) + field[iy, ix + 1, it] * fx
        c10 = field[iy + 1, ix, it] * (1 - fx) + field[iy + 1, ix + 1, it] * fx
        c0 = c00 * (1 - fy) + c10 * fy
        c01 = field[iy, ix, it + 1] * (1 - fx) + field[iy, ix + 1, it + 1] * fx
        c11 = field[iy + 1, ix, it + 1] * (1 - fx) + field[iy + 1, ix + 1, it + 1] * fx
        c1 = c01 * (1 - fy) + c11 * fy
        return float(c0 * (1 - ft) + c1 * ft)

    def sample_batch(self, lats: np.ndarray, lons: np.ndarray, t: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """Vectorized sample for arrays of (lats, lons) at epoch time t.

        Returns (cur_u, cur_v, wind_u, wind_v) arrays of shape (N,).
        """
        ix = np.clip(np.searchsorted(self.lons, lons) - 1, 0, len(self.lons) - 2)
        fx = np.clip((lons - self.lons[ix]) / (self.lons[ix + 1] - self.lons[ix]), 0.0, 1.0)
        iy = np.clip(np.searchsorted(self.lats, lats) - 1, 0, len(self.lats) - 2)
        fy = np.clip((lats - self.lats[iy]) / (self.lats[iy + 1] - self.lats[iy]), 0.0, 1.0)
        it, ft = self._it(t)

        wu = self._bilinear_batch(self.wind_u, iy, fy, ix, fx, it, ft)
        wv = self._bilinear_batch(self.wind_v, iy, fy, ix, fx, it, ft)
        cu = self._bilinear_batch(self.cur_u, iy, fy, ix, fx, it, ft)
        cv = self._bilinear_batch(self.cur_v, iy, fy, ix, fx, it, ft)
        return cu, cv, wu, wv

    @staticmethod
    def _bilinear_batch(field: np.ndarray, iy, fy, ix, fx, it, ft) -> np.ndarray:
        c00 = field[iy, ix, it] * (1.0 - fx) + field[iy, ix + 1, it] * fx
        c10 = field[iy + 1, ix, it] * (1.0 - fx) + field[iy + 1, ix + 1, it] * fx
        c0 = c00 * (1.0 - fy) + c10 * fy
        c01 = field[iy, ix, it + 1] * (1.0 - fx) + field[iy, ix + 1, it + 1] * fx
        c11 = field[iy + 1, ix, it + 1] * (1.0 - fx) + field[iy + 1, ix + 1, it + 1] * fx
        c1 = c01 * (1.0 - fy) + c11 * fy
        res = c0 * (1.0 - ft) + c1 * ft
        return np.nan_to_num(res, nan=0.0)

    def sample(self, lat: float, lon: float, t: float) -> dict:
        """Returns {'wind': (u,v), 'current': (u,v)} in m/s at time t (epoch s)."""
        cu, cv, wu, wv = self.sample_batch(np.array([lat]), np.array([lon]), t)
        return {
            "wind": (float(wu[0]), float(wv[0])),
            "current": (float(cu[0]), float(cv[0])),
        }

    def covers(self, t0: float, t1: float) -> bool:
        return self.times[0] <= t0 <= t1 <= self.times[-1]

