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

    # ---- seeding -------------------------------------------------------------
    @staticmethod
    def _seed(poly, frame: LocalFrame, n: int) -> np.ndarray:
        """Uniform random points inside polygon, in metres."""
        minx, miny, maxx, maxy = poly.bounds
        pts = []
        max_attempts = n * 20  # prevent infinite loop on degenerate polygons
        attempts = 0
        while len(pts) < n and attempts < max_attempts:
            xs = np.random.uniform(minx, maxx, size=n * 2)
            ys = np.random.uniform(miny, maxy, size=n * 2)
            for x, y in zip(xs, ys):
                if poly.contains(Point(x, y)):
                    pts.append((x, y))
                    if len(pts) >= n:
                        break
                attempts += 1
                if attempts >= max_attempts:
                    break
        if len(pts) < n:
            # Fallback: use centroid for degenerate polygons
            cx, cy = poly.centroid.x, poly.centroid.y
            pts.extend([(cx, cy)] * (n - len(pts)))
        return np.asarray(pts[:n], dtype=float)

    # ---- dynamics ------------------------------------------------------------
    def _velocity(self, xy: np.ndarray, t: float, frame: LocalFrame, poly_m=None) -> np.ndarray:
        """Deterministic + diffusive velocity [m/s] for all particles (vectorized).
        Incorporate slick shape, aspect ratio & orientation-dependent aerodynamic drag.
        """
        lons = frame.lon0 + xy[:, 0] / frame.mx
        lats = frame.lat0 + xy[:, 1] / frame.my

        cu, cv, wu, wv = self.f.sample_batch(lats, lons, t)

        w_factor = self.s.windage_factor
        th_deg = self.s.windage_deflection_deg

        if poly_m is not None:
            try:
                orient_rad, aspect_ratio = _slick_shape_physics(poly_m)
                wind_rad = np.arctan2(wv, wu)
                d_th = np.abs(wind_rad - orient_rad) % np.pi
                cross_factor = np.sin(d_th)
                w_factor = w_factor * (1.0 + 0.22 * (aspect_ratio - 1.0) * cross_factor)
                th_deg = th_deg + 7.5 * (cross_factor - 0.5)
            except Exception:
                pass

        det = np.empty_like(xy)
        th = np.radians(th_deg)
        cos_th = np.cos(th)
        sin_th = np.sin(th)

        uw = w_factor * wu
        vw = w_factor * wv

        det[:, 0] = cu + (uw * cos_th + vw * sin_th) + (self.s.stokes_factor * wu)
        det[:, 1] = cv + (-uw * sin_th + vw * cos_th) + (self.s.stokes_factor * wv)
        return det

    def _integrate(self, xy0: np.ndarray, t0: float, hours: float,
                   frame: LocalFrame, poly_m=None) -> dict:
        """Integrate particles. hours<0 → backward."""
        dt = self.s.timestep_s if hours > 0 else -self.s.timestep_s
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
            prev_xy = xy.copy()
            k1 = self._velocity(xy, t, frame, poly_m=poly_m)
            mid = xy + 0.5 * dt * k1
            k2 = self._velocity(mid, t + 0.5 * dt, frame, poly_m=poly_m)
            xy = xy + dt * k2
            xy = xy + np.random.normal(0.0, pos_sig, size=xy.shape)

            # Prevent particles from drifting across land (evaluated hourly for speed)
            if out_every and step % out_every == 0:
                try:
                    from ..attribution.behavior import _shore_km
                    lons = frame.lon0 + xy[:, 0] / frame.mx
                    lats = frame.lat0 + xy[:, 1] / frame.my
                    on_land = _shore_km(lons, lats) < 0.1
                    if on_land.any():
                        xy[on_land] = prev_xy[on_land]
                except Exception:
                    pass

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
                 n_particles: int | None = None, slick_props: dict | None = None) -> dict:
        """Hindcast: seed particles at the detected slick and integrate
        backwards through the flow (current + windage + Stokes + diffusion +
        land masking) so every slick yields a genuinely physics-driven origin,
        age and path rather than a fixed straight line.

        The release time is the morphological streak-age estimate (elastic
        slick physics: a longer, leaner streak implies more time on the water),
        clamped to the integration window; the origin is the ensemble centroid
        at that snapshot. min-spread is NOT used as the sole selector because
        backward diffusion makes ensemble spread increase monotonically, so its
        argmin is always pinned to the detection moment.
        """
        hours = hours or self.s.drift_hours_back
        n = n_particles or self.s.particles
        c0 = slick_poly_ll.centroid
        frame = LocalFrame(c0.x, c0.y)
        poly_m = _poly_to_frame(slick_poly_ll, frame)
        xy0 = self._seed(poly_m, frame, n)

        res = self._integrate(xy0, detect_ts, -float(hours), frame, poly_m=poly_m)
        snap_c = res["snap_c"]          # [steps, 2] in metres
        snap_t = res["snap_t"]          # [steps] epoch seconds
        snap_spread = res["snap_spread"]  # [steps] metres

        # morphological sidewalk-age prior (streak length + areal growth)
        props = slick_props or {}
        major_km = props.get("major_axis_km")
        area_km2 = props.get("area_km2")
        if major_km is None or area_km2 is None:
            minx, miny, maxx, maxy = slick_poly_ll.bounds
            dx_km = (maxx - minx) * frame.mx / 1000.0
            dy_km = (maxy - miny) * frame.my / 1000.0
            major_km = max(dx_km, dy_km, 0.2)
            area_km2 = max(slick_poly_ll.area * (frame.mx * frame.my) / 1e6, 0.05)
        target_age_h = float(np.clip(
            0.8 + 0.4 * major_km + 0.5 * math.sqrt(area_km2),
            1.0, max(float(hours) - 1.0, 1.0)))

        # snapshot nearest the morphological age (closest hour)
        i_sel = int(np.argmin(np.abs(snap_t - (detect_ts - target_age_h * 3600.0))))
        ox, oy = snap_c[i_sel]
        release_ts = float(snap_t[i_sel])
        origin_lon, origin_lat = frame.to_ll(float(ox), float(oy))
        # ensemble spread near release + slick-size floor
        sigma_m = float(snap_spread[i_sel])
        sigma_km = float(max(sigma_m / 1000.0, 0.3 + major_km * 0.1, 0.5))

        return {
            "direction": "backward",
            "origin_lon": origin_lon, "origin_lat": origin_lat,
            "origin_sigma_km": round(sigma_km, 2),
            "release_ts": release_ts,
            "age_h": round((detect_ts - release_ts) / 3600.0, 2),
            "spread_curve": [
                [round((detect_ts - float(t)) / 3600.0, 2),
                 round(float(s) / 1000.0, 2)]
                for t, s in zip(snap_t, snap_spread)
            ],
            "centroid_path": [
                [0.0, 0.0, detect_ts]
            ] + [
                [float(v[0]), float(v[1]), float(t)]
                for v, t in zip(snap_c[:i_sel + 1], snap_t[:i_sel + 1])
            ],
            "frame": frame,
            "_res": {"snap_c": snap_c, "snap_t": snap_t},
        }

    def forward(self, slick_poly_ll, start_ts: float, hours: float | None = None,
                n_particles: int | None = None, slick_props: dict | None = None) -> dict:
        """Forecast: where the slick goes next; returns cone envelopes."""
        hours = hours or self.s.drift_hours_fwd
        n = n_particles or self.s.particles
        c0 = slick_poly_ll.centroid
        frame = LocalFrame(c0.x, c0.y)
        poly_m = _poly_to_frame(slick_poly_ll, frame)
        xy0 = self._seed(poly_m, frame, n)
        res = self._integrate(xy0, start_ts, float(hours), frame, poly_m=poly_m)

        props = slick_props or {}
        major_km = props.get("major_axis_km", 0.3)
        base_radius_km = max(major_km * 0.1, 0.1)

        ts, cs, sp = res["snap_t"], res["snap_c"], res["snap_spread"]
        cones = []
        for t, c, s in zip(ts, cs, sp):
            # Scale spread dynamically based on slick particle dispersion
            r_km = (float(s) * 0.6) / 1000.0 + base_radius_km
            cones.append({
                "ts": float(t),
                "centroid": [float(c[0]), float(c[1])],
                "radius_km": round(float(r_km), 3),
            })
        return {
            "direction": "forward",
            "cones": cones,
            "centroid_path": [
                [0.0, 0.0, start_ts]
            ] + [
                [float(v[0]), float(v[1]), float(tt)]
                for v, tt in zip(cs, ts)
            ],
            "end_xy": res["xy"],
        }


def _poly_to_frame(poly_ll, frame: LocalFrame):
    from shapely.ops import transform
    return transform(lambda x, y: frame.to_m(x, y), poly_ll)


def _slick_shape_physics(poly_m):
    """Compute slick orientation angle (rad) and aspect ratio from polygon in metres."""
    try:
        ext = np.asarray(poly_m.exterior.coords)
        if len(ext) > 3:
            pts = ext[:-1]
            c = pts.mean(axis=0)
            d = pts - c
            cov = np.cov(d.T)
            evals, evecs = np.linalg.eigh(cov)
            idx = int(np.argmax(evals))
            orient_rad = float(math.atan2(evecs[1, idx], evecs[0, idx]))
            aspect_ratio = float(math.sqrt(max(evals[idx], 1e-6) / max(evals[1 - idx], 1e-6)))
            aspect_ratio = float(np.clip(aspect_ratio, 1.0, 5.0))
        else:
            orient_rad, aspect_ratio = 0.0, 1.0
    except Exception:
        orient_rad, aspect_ratio = 0.0, 1.0
    return orient_rad, aspect_ratio
