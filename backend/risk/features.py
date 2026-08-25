"""Feature engineering for the spill-risk grid.

Grid cells over the AOI; features per cell:
  dist_shore_km    distance to nearest land (Natural Earth 10 m)
  ais_density_log  log1p AIS fixes accumulated by the live watch
  dist_lane_km     distance to high-density AIS traffic (lane proxy)
  dist_terminal_km distance to nearest major oil terminal (public locations)
  lat, lon         spatial pattern

Target: cell contains >=1 anthropogenic slick in Cerulean's historical
Sentinel-1 database (classes vessel/infrastructure/anthropogenic).
"""
from __future__ import annotations

import math

import numpy as np
from scipy import ndimage

# major Baltic oil terminals (public knowledge, coordinates approximate)
TERMINALS = [
    (60.337, 28.750),   # Primorsk (RU)
    (59.665, 28.290),   # Ust-Luga (RU)
    (60.627, 28.550),   # Vysotsk (RU)
    (59.852, 29.750),   # Saint Petersburg (RU)
    (59.405, 27.900),   # Sillamäe (EE)
    (59.480, 24.900),   # Tallinn-Muuga (EE)
    (60.280, 25.600),   # Kilpilahti / Porvoo (FI)
    (60.210, 25.150),   # Helsinki Vuosaari (FI)
    (60.470, 21.950),   # Naantali (FI)
    (55.700, 21.130),   # Klaipėda (LT)
    (54.400, 18.660),   # Gdańsk (PL)
    (57.050, 24.100),   # Riga (LV)
    (58.900, 17.950),   # Nynäshamn (SE)
]

FEATURES = ["dist_shore_km", "ais_density_log", "dist_lane_km",
            "dist_terminal_km", "lat", "lon"]


def make_grid(bbox, cell_deg=0.05, margin=0.3):
    x0, y0, x1, y1 = bbox
    x0, y0 = x0 - margin, y0 - margin
    x1, y1 = x1 + margin, y1 + margin
    lons = np.arange(x0, x1, cell_deg)
    lats = np.arange(y1, y0, -cell_deg)   # row 0 = northernmost (raster order)
    return lons, lats, cell_deg


def _haversine_km_matrix(lats, lons, plat, plon):
    p1 = np.radians(lats)
    p2 = np.radians(plat)
    dp = p2 - p1[:, None]
    dl = np.radians(plon - lons[None, :])
    a = (np.sin(dp / 2) ** 2
         + np.cos(p1)[:, None] * np.cos(p2) * np.sin(dl / 2) ** 2)
    return 2 * 6371.0 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def distance_to_shore_km(lons, lats, cell_deg, land_polys):
    """Rasterize land at grid resolution, then Euclidean distance transform."""
    from rasterio import features
    from shapely.geometry import Polygon
    polys = []
    for p in land_polys:
        if isinstance(p, Polygon):
            polys.append(p)
        else:
            polys.extend(list(p.geoms))
    nx, ny = len(lons), len(lats)
    transform = _grid_transform(lons, lats, cell_deg)
    land = features.rasterize([(g, 1) for g in polys],
                              out_shape=(ny, nx), transform=transform,
                              fill=0, dtype="uint8").astype(bool)
    # distance from each sea cell to nearest land cell (px -> km)
    dist_px = ndimage.distance_transform_edt(~land)
    km_per_px_y = cell_deg * 110.574
    km_per_px_x = cell_deg * 111.32 * math.cos(math.radians(float(np.mean(lats))))
    # anisotropic pixels: approximate with mean scale
    return dist_px * (km_per_px_x + km_per_px_y) / 2, land


def _grid_transform(lons, lats, cell_deg):
    from rasterio.transform import from_origin
    return from_origin(lons[0] - cell_deg / 2, lats[0] + cell_deg / 2,
                       cell_deg, cell_deg)


def ais_density_grids(lons, lats, cell_deg, positions):
    """positions: iterable of (lon, lat). Returns (density_log, dist_lane_km)."""
    nx, ny = len(lons), len(lats)
    density = np.zeros((ny, nx))
    if not positions:
        return density, np.full((ny, nx), 50.0)
    plon = np.array([p[0] for p in positions])
    plat = np.array([p[1] for p in positions])
    ix = np.clip(((plon - (lons[0] - cell_deg / 2)) / cell_deg).astype(int),
                 0, nx - 1)
    iy = np.clip(((lats[0] - plat) / cell_deg).astype(int), 0, ny - 1)
    np.add.at(density, (iy, ix), 1)
    density_log = np.log1p(density)
    # lane mask = top-density cells, then distance transform (km)
    thresh = np.percentile(density[density > 0], 90) if (density > 0).any() else np.inf
    lanes = density >= thresh
    dist_px = ndimage.distance_transform_edt(~lanes)
    km_per_px = cell_deg * 111.0
    return density_log, dist_px * km_per_px


def distance_to_terminal_km(lons, lats):
    d = np.full((len(lats), len(lons)), np.inf)
    for plat, plon in TERMINALS:
        d = np.minimum(d, _haversine_km_matrix(lats, lons, plat, plon))
    return d


def build_feature_matrix(lons, lats, cell_deg, land_polys, positions):
    shore_km, land = distance_to_shore_km(lons, lats, cell_deg, land_polys)
    density_log, lane_km = ais_density_grids(lons, lats, cell_deg, positions)
    term_km = distance_to_terminal_km(lons, lats)

    lon_g, lat_g = np.meshgrid(lons, lats)
    sea = ~land
    X = np.stack([
        shore_km[sea],
        density_log[sea],
        lane_km[sea],
        term_km[sea],
        lat_g[sea],
        lon_g[sea],
    ], axis=1)
    return X, sea, {
        "dist_shore_km": shore_km,
        "ais_density_log": density_log,
        "dist_lane_km": lane_km,
        "dist_terminal_km": term_km,
        "land": land,
    }


def target_grid(lons, lats, cell_deg, slick_rows):
    """slick_rows: iterable of (lon, lat). Returns binary presence grid."""
    ny, nx = len(lats), len(lons)
    g = np.zeros((ny, nx), dtype=bool)
    for lon, lat in slick_rows:
        ix = int((lon - (lons[0] - cell_deg / 2)) / cell_deg)
        iy = int((lats[0] - lat) / cell_deg)
        if 0 <= ix < nx and 0 <= iy < ny:
            g[iy, ix] = True
    return g
