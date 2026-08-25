"""Vectorize detected patches -> GeoJSON polygons + geometric properties."""
from __future__ import annotations

import math

import numpy as np
import rasterio.features
from shapely.geometry import shape, mapping


def vectorize_patches(lab: np.ndarray, keep_ids: list[int],
                      transform, fwd=None) -> dict[int, dict]:
    """Returns {label_id: {'geometry': shapely Polygon (lon/lat), 'area_km2': ...}}

    `transform` is the exact georeferenced affine of the label grid
    (WarpedVRT-derived), so rasterio.features.shapes yields lon/lat
    polygons directly. `fwd` is accepted for API compatibility, unused.
    """
    out = {}
    for gid in keep_ids:
        mask = (lab == gid)
        geoms = [shape(g) for g, v in rasterio.features.shapes(
            mask.astype(np.uint8), mask=mask, transform=transform) if v == 1]
        if not geoms:
            continue
        geom = max(geoms, key=lambda g: g.area)
        lat = geom.centroid.y
        deg2_to_km2 = 111.32 ** 2 * math.cos(math.radians(lat))
        out[gid] = {"geometry": geom,
                    "area_km2": round(geom.area * deg2_to_km2, 3)}
    return out


def geometry_properties(geom) -> dict:
    """Major/minor axis (km) and orientation via second-moment ellipse."""
    c = geom.centroid
    # sample boundary points for covariance
    import math
    xs, ys = np.array(geom.exterior.coords.xy[0]), np.array(geom.exterior.coords.xy[1])
    kmx = xs * 111.32 * math.cos(math.radians(c.y))
    kmy = ys * 110.574
    cov = np.cov(np.stack([kmx - kmx.mean(), kmy - kmy.mean()]))
    evals, evecs = np.linalg.eigh(cov)
    major_km = 4.0 * float(np.sqrt(max(evals[1], 0)))   # ~full axis of ellipse
    minor_km = 4.0 * float(np.sqrt(max(evals[0], 0)))
    major_v = evecs[:, 1]
    orient = float(math.degrees(math.atan2(major_v[1], major_v[0])) % 180.0)
    return {
        "centroid_lon": round(float(c.x), 5),
        "centroid_lat": round(float(c.y), 5),
        "major_axis_km": round(major_km, 2),
        "minor_axis_km": round(minor_km, 2),
        "orientation_deg": round(orient, 1),
    }


def to_geojson(geom, props: dict | None = None) -> dict:
    fc = mapping(geom.simplify(0.001))
    return {"type": "Feature",
            "geometry": fc,
            "properties": props or {}}
