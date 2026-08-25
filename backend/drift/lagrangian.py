"""Lagrangian particle drift model - backward hindcasting & forward forecast.

Oil film transport ≈ surface current + windage (leeway) + Stokes drift +
random-walk diffusion, integrated with RK2 in a local tangent-plane frame
(meters, origin at slick centroid). Backward integration converges the
particle ensemble towards the release point; the spread-vs-time minimum gives
the estimated release time (= slick age).
"""
from __future__ import annotations

import math

import numpy as np
from shapely.geometry import Point

M_PER_DEG_LAT = 111_320.0


class LocalFrame:
    def __init__(self, lon0: float, lat0: float):
        self.lon0, self.lat0 = lon0, lat0
        self.mx = M_PER_DEG_LAT * math.cos(math.radians(lat0))
        self.my = M_PER_DEG_LAT

    def to_m(self, lon: float, lat: float) -> tuple[float, float]:
        return ((lon - self.lon0) * self.mx, (lat - self.lat0) * self.my)

    def to_ll(self, x: float, y: float) -> tuple[float, float]:
        return (self.lon0 + x / self.mx, self.lat0 + y / self.my)


class DriftModel:
    def __init__(self, fields, settings):
        self.f = fields
        self.s = settings
        self._backward = False  # set during reversed-time integration

    # ---- seeding -------------------------------------------------------------
    @staticmethod
    def _seed(poly, frame: LocalFrame, n: int) -> np.ndarray:
        """Uniform random points inside polygon, in metres."""
        minx, miny, maxx, maxy = poly.bounds
        pts = []
        while len(pts) < n:
            xs = np.random.uniform(minx, maxx, size=n * 2)
            ys = np.random.uniform(miny, maxy, size=n * 2)
            for x, y in zip(xs, ys):
                if poly.contains(Point(x, y)):
                    pts.append((x, y))
                    if len(pts) >= n:
                        break
        return np.asarray(pts[:n], dtype=float)

    # ---- dynamics ------------------------------------------------------------
    def _velocity(self, xy: np.ndarray, t: float, frame: LocalFrame) -> np.ndarray:
        """Deterministic + diffusive velocity [m/s] for all particles."""
        n = len(xy)
        det = np.zeros((n, 2))
        cu = wu = 0.0
        for i, (x, y) in enumerate(xy):
            lon, lat = frame.to_ll(x, y)
            smp = self.f.sample(lat, lon, t)
            cu_, cv_ = smp["current"]
            wu_, wv_ = smp["wind"]
            cu += cu_; wu += wu_
            det[i, 0] = cu_
            det[i, 1] = cv_
            # windage: fraction of wind speed, deflected right (NH Ekman/leeway)
            th = math.radians(self.s.windage_deflection_deg)
            uw = self.s.windage_factor * wu_
            vw = self.s.windage_factor * wv_
            det[i, 0] += uw * math.cos(th) + vw * math.sin(th)
            det[i, 1] += -uw * math.sin(th) + vw * math.cos(th)
            # Stokes drift approximation: aligned with wind
            det[i, 0] += self.s.stokes_factor * wu_
            det[i, 1] += self.s.stokes_factor * wv_
        # NOTE: stochastic diffusion is applied to positions in _integrate
        # (Euler-Maruyama), not to velocities.
        _ = cu, wu
        return det

    def _integrate(self, xy0: np.ndarray, t0: float, hours: float,
                   frame: LocalFrame) -> dict:
        """Integrate particles. hours<0 → backward."""
        dt = self.s.timestep_s if hours > 0 else -self.s.timestep_s
        self._backward = hours < 0
        # damped diffusivity in reversed time to limit artificial ensemble
        # inflation during backtracking
        k_diff = self.s.diffusion_m2_s * (0.35 if hours < 0 else 1.0)
        pos_sig = math.sqrt(2.0 * k_diff * abs(self.s.timestep_s))
        total = int(abs(hours) * 3600 / self.s.timestep_s)
        out_every = max(int(3600 / abs(self.s.timestep_s)), 1)  # hourly snapshots
        xy = xy0.copy()
        t = t0
        snaps_t, snaps_c, snaps_spread = [], [], []
        paths = []          # decimated individual trajectories [n_kept, steps, 2]
        keep_mask = None
        step = 0
        while step < total:
            k1 = self._velocity(xy, t, frame)
            mid = xy + 0.5 * dt * k1
            k2 = self._velocity(mid, t + 0.5 * dt, frame)
            xy = xy + dt * k2
            xy = xy + np.random.normal(0.0, pos_sig, size=xy.shape)
            t += dt
            step += 1
            if out_every and step % out_every == 0:
                c = xy.mean(axis=0)
                spread = float(np.sqrt(((xy - c) ** 2).sum(axis=1).mean()))
                snaps_t.append(t)
                snaps_c.append(c.copy())
                snaps_spread.append(spread)
                if len(paths) == 0:
                    keep_idx = np.linspace(0, len(xy) - 1, min(120, len(xy))) \
                        .astype(int)
                    paths = [[] for _ in keep_idx]
                    keep_mask = keep_idx
                for j, idx in enumerate(keep_mask):
                    paths[j].append(xy[idx].copy())
        return {"xy": xy, "t_end": t,
                "snap_t": np.array(snaps_t), "snap_c": np.array(snaps_c),
                "snap_spread": np.array(snaps_spread),
                "paths": np.array(paths) if len(paths) else None}

    # ---- public API ----------------------------------------------------------
    def backward(self, slick_poly_ll, detect_ts: float, hours: float | None = None,
                 n_particles: int | None = None) -> dict:
        """Hindcast: seed at detected slick, integrate backwards, estimate origin.

        Returns origin estimate, release time, age, spread curve, paths.
        """
        hours = hours or self.s.drift_hours_back
        n = n_particles or self.s.particles
        c0 = slick_poly_ll.centroid
        frame = LocalFrame(c0.x, c0.y)
        poly_m = _poly_to_frame(slick_poly_ll, frame)
        xy0 = self._seed(poly_m, frame, n)
        res = self._integrate(xy0, detect_ts, -float(hours), frame)

        sp = res["snap_spread"] / 1000.0  # km
        ts = res["snap_t"]
        if len(sp) < 3:
            raise RuntimeError("drift run too short")
        # first sample within 15 % of global min → conservative (younger) age
        target = sp.min() * 1.15
        idx = int(np.argmax(sp <= target)) if (sp <= target).any() else int(np.argmin(sp))
        ox, oy = res["snap_c"][idx]
        origin_lon, origin_lat = frame.to_ll(float(ox), float(oy))
        release_ts = float(ts[idx])
        # uncertainty: spread at chosen horizon
        sigma_km = float(max(sp[idx], 0.5))
        return {
            "direction": "backward",
            "origin_lon": origin_lon, "origin_lat": origin_lat,
            "origin_sigma_km": sigma_km,
            "release_ts": release_ts,
            "age_h": round((detect_ts - release_ts) / 3600.0, 2),
            "spread_curve": [
                [round((detect_ts - float(t)) / 3600.0, 2), round(float(s), 2)]
                for t, s in zip(ts, sp)
            ],
            "centroid_path": [
                [float(v[0]), float(v[1]), float(tt)]
                for v, tt in zip(res["snap_c"], ts)
            ],
            "frame": frame,
            "_res": res,
        }

    def forward(self, slick_poly_ll, start_ts: float, hours: float | None = None,
                n_particles: int | None = None) -> dict:
        """Forecast: where the slick goes next; returns cone envelopes."""
        hours = hours or self.s.drift_hours_fwd
        n = n_particles or self.s.particles
        c0 = slick_poly_ll.centroid
        frame = LocalFrame(c0.x, c0.y)
        poly_m = _poly_to_frame(slick_poly_ll, frame)
        xy0 = self._seed(poly_m, frame, n)
        res = self._integrate(xy0, start_ts, float(hours), frame)

        ts, cs, sp = res["snap_t"], res["snap_c"], res["snap_spread"]
        cones = []
        for t, c, s in zip(ts, cs, sp):
            cones.append({
                "ts": float(t),
                "centroid": [float(c[0]), float(c[1])],
                "radius_km": round(float(s) / 1000.0, 2),
            })
        return {
            "direction": "forward",
            "cones": cones,
            "centroid_path": [
                [float(v[0]), float(v[1]), float(tt)]
                for v, tt in zip(cs, ts)
            ],
            "end_xy": res["xy"],
        }


def _poly_to_frame(poly_ll, frame: LocalFrame):
    from shapely.ops import transform
    return transform(lambda x, y: frame.to_m(x, y), poly_ll)
