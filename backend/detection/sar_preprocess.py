"""Sentinel-1 GRD preprocessing: SAFE unpack -> sigma0 dB -> despeckle -> land mask."""
from __future__ import annotations

import logging
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import rasterio
from rasterio import features
from rasterio.vrt import WarpedVRT
from rasterio.windows import from_bounds, Window

log = logging.getLogger("sar")

NS = {"s1": "http://www.opengis.net/sar/2.0"}


def unpack_safe(zip_path: str | Path, dest_dir: Path) -> Path:
    """Extract SAFE archive; returns the .SAFE directory."""
    zip_path = Path(zip_path)
    safe_dir = dest_dir / zip_path.stem.replace("_COG", "")
    if not safe_dir.exists():
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(dest_dir)
    matches = list(dest_dir.glob(zip_path.stem.replace("_COG", "") + "*.SAFE"))
    return matches[0] if matches else safe_dir


def find_measurement(safe_dir: Path) -> tuple[Path, str]:
    """Return (tiff_path, polarization) - prefers VV (oil contrast is
    stronger and less wind-saturated than VH at Baltic wind speeds)."""
    tiffs = sorted((safe_dir / "measurement").glob("*.tiff")) or \
        sorted((safe_dir / "measurement").glob("*.tif"))
    if not tiffs:
        raise FileNotFoundError(f"no measurement tiff in {safe_dir}")
    vv = [t for t in tiffs if "vv" in t.name.lower()]
    if vv:
        return vv[0], "vv"
    return tiffs[0], ("vh" if "vh" in tiffs[0].name.lower() else "vv")


def _calibration_lut(safe_dir: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Parse annotation CAL xml -> (lines[], pixels[], sigmaNought LUT rows)."""
    cals = list(safe_dir.rglob("*CAL*.xml"))
    if not cals:
        raise FileNotFoundError("calibration xml missing")
    root = ET.parse(cals[0]).getroot()
    lines, pix, lut = [], [], []
    for vec in root.iter("calibrationVector"):
        lines.append(int(vec.findtext("line")))
        p = np.array([float(v) for v in vec.findtext("pixel").split()])
        s = np.array([float(v) for v in vec.findtext("sigmaNought").split()])
        pix.append(p)
        lut.append(s)
    return np.array(lines), pix[0], np.vstack(lut)


def _gcp_polynomial(src):
    """Fit 2nd-order col/row -> lon/lat polynomials from dataset GCPs.

    GRD measurement tiffs carry no affine geotransform - they are geocoded
    via a GCP grid, and the slice is rotated, so a global first-order fit is
    poor. A 2nd-order polynomial captures rotation + curvature.
    Returns (fwd(col,row)->(lon,lat), scene_bounds).
    """
    gcps, crs = src.gcps
    cols = np.array([g.col for g in gcps], float)
    rows = np.array([g.row for g in gcps], float)
    xs = np.array([g.x for g in gcps], float)
    ys = np.array([g.y for g in gcps], float)

    def design(c, r):
        return np.stack([np.ones_like(c), c, r, c * r, c * c, r * r], axis=-1)

    A = design(cols, rows)
    cx, *_ = np.linalg.lstsq(A, xs, rcond=None)
    cy, *_ = np.linalg.lstsq(A, ys, rcond=None)

    def fwd(c, r):
        v = design(np.asarray(c, float), np.asarray(r, float))
        return v @ cx, v @ cy

    # dense edge sampling for accurate scene bounds
    t = np.linspace(0, src.width, 200)
    u = np.linspace(0, src.height, 200)
    edge_c = np.concatenate([t, t, np.full(200, src.width), np.zeros(200)])
    edge_r = np.concatenate([np.zeros(200), np.full(200, src.height), u, u])
    ex, ey = fwd(edge_c, edge_r)
    bounds = (float(ex.min()), float(ey.min()), float(ex.max()), float(ey.max()))
    return fwd, bounds


def _window_for_bbox(fwd, bounds, bbox, width, height):
    """Pixel window covering bbox, found by inverting the GCP polynomial."""
    if (bbox[2] < bounds[0] or bbox[0] > bounds[2]
            or bbox[3] < bounds[1] or bbox[1] > bounds[3]):
        raise RuntimeError("AOI does not intersect this scene")
    n = 500
    cc, rr = np.meshgrid(np.linspace(0, width, n), np.linspace(0, height, n))
    lon, lat = fwd(cc.ravel(), rr.ravel())
    m = ((lon >= bbox[0]) & (lon <= bbox[2])
         & (lat >= bbox[1]) & (lat <= bbox[3]))
    if not m.any():
        raise RuntimeError("AOI does not intersect this scene")
    col0, col1 = float(cc.ravel()[m].min()), float(cc.ravel()[m].max())
    row0, row1 = float(rr.ravel()[m].min()), float(rr.ravel()[m].max())
    col1 = min(col1 + 1, width)
    row1 = min(row1 + 1, height)
    return Window(col0, row0, col1 - col0, row1 - row0)


def make_poly_inverse(fwd, eps=1.0, iters=16, init=None):
    """Gauss-Newton inverse of the GCP polynomial: (lon,lat) -> (col,row).

    `init` is an optional rasterio-style affine (or its inverse callable)
    used to seed the iteration - seed from the window affine so the solve
    starts inside its convergence basin.
    """
    import numpy as np

    def inv(lon, lat):
        lon = np.asarray(lon, float)
        lat = np.asarray(lat, float)
        if init is not None:
            itr = ~init   # inverse affine: (lon,lat) -> approx (col,row)
            c = itr.a * lon + itr.b * lat + itr.c
            r = itr.d * lon + itr.e * lat + itr.f
        else:
            c = np.full_like(lon, 13000.0)
            r = np.full_like(lon, 8000.0)
        for _ in range(iters):
            x0, y0 = fwd(c, r)
            xc1, yc1 = fwd(c + eps, r)
            xr1, yr1 = fwd(c, r + eps)
            a = (xc1 - x0) / eps
            b = (yc1 - y0) / eps
            cc = (xr1 - x0) / eps
            e = (yr1 - y0) / eps
            det = a * e - b * cc
            det = np.where(np.abs(det) < 1e-12, 1e-12, det)
            dc = ((lon - x0) * e - (lat - y0) * b) / det
            dr = ((lat - y0) * a - (lon - x0) * cc) / det
            c = c + dc
            r = r + dr
            if np.max(np.abs(dc)) < 0.05 and np.max(np.abs(dr)) < 0.05:
                break
        return c, r

    return inv


def _local_affine(fwd, window):
    """Least-squares first-order affine over the processing window.

    Used only for land masking (coastline tolerance ~hundreds of metres).
    Exact geolocation goes through make_poly_inverse instead - a tangent
    affine is kilometres off near the edges of large windows.
    """
    import numpy as np
    w, h = window.width, window.height
    off_x, off_y = window.col_off, window.row_off
    # 5x5 sample grid across the window
    sx = np.linspace(0, w, 5)
    sy = np.linspace(0, h, 5)
    gx, gy = np.meshgrid(sx, sy)
    gx_f, gy_f = (gx + off_x).ravel(), (gy + off_y).ravel()
    lon, lat = fwd(gx_f, gy_f)
    # fit lon = a*col + b*row + c ; lat = d*col + e*row + f
    A = np.stack([gx.ravel(), gy.ravel(), np.ones(gx.size)], axis=1)
    coef_lon, *_ = np.linalg.lstsq(A, lon, rcond=None)
    coef_lat, *_ = np.linalg.lstsq(A, lat, rcond=None)
    return rasterio.Affine(coef_lon[0], coef_lon[1], coef_lon[2],
                           coef_lat[0], coef_lat[1], coef_lat[2])


def read_sigma0_db(tiff_path: Path, safe_dir: Path,
                   bbox=None, max_pixels: int = 40_000_000,
                   return_fwd: bool = False):
    """Read scene (or AOI window), calibrate DN->sigma0, convert to dB.

    Geolocation goes through a GDAL WarpedVRT over the measurement GCPs
    (exact thin-plate/polynomial warp to EPSG:4326) - custom polynomial
    fits folded over large windows and misplaced masks by kilometres.

    Returns (sigma0_db [float32], affine transform of the returned array,
    decimation). `return_fwd` is accepted for API compatibility and ignored.
    """
    lines, ref_pix, lut_rows = _calibration_lut(safe_dir)
    with rasterio.open(tiff_path) as raw, \
            WarpedVRT(raw, src_crs=raw.gcps[1] if raw.gcps and raw.gcps[0]
                      else None) as vrt:
        if bbox is not None:
            window = from_bounds(*bbox, transform=vrt.transform) \
                .round_offsets().round_lengths()
            window = window.intersection(
                Window(0, 0, vrt.width, vrt.height))
            if window.width <= 0 or window.height <= 0:
                raise RuntimeError("AOI does not intersect this scene")
        else:
            window = Window(0, 0, vrt.width, vrt.height)

        decim = 1
        while (window.width * window.height) / (decim ** 2) > max_pixels:
            decim += 1
        out_h = max(int(window.height / decim), 1)
        out_w = max(int(window.width / decim), 1)
        data = vrt.read(1, window=window, out_shape=(out_h, out_w))

        # exact north-up affine of the (possibly decimated) window
        transform_dec = vrt.window_transform(window) * rasterio.Affine.scale(
            window.width / out_w, window.height / out_h)

        # calibration LUT: indexed by SOURCE azimuth line / range pixel.
        # The warp is near-identity in relative terms, so map output rows to
        # source lines by fractional position (LUT is smooth; error << 1 dB).
        src_h, src_w = raw.height, raw.width
        az_idx = ((window.row_off + (np.arange(out_h) + 0.5) * decim)
                  / vrt.height * src_h)
        col_pix = ((window.col_off + (np.arange(out_w) + 0.5) * decim)
                   / vrt.width * src_w)

    dn = data.astype(np.float32)
    dn[dn == 0] = np.nan

    row_lut = np.empty((out_h, out_w), dtype=np.float32)
    for k, line in enumerate(lines[:-1]):
        sel = (az_idx >= line) & (az_idx < lines[k + 1])
        if not sel.any():
            continue
        row_lut[sel] = np.interp(col_pix, ref_pix, lut_rows[k])[None, :]
    last = az_idx >= lines[-1]
    if last.any():
        row_lut[last] = np.interp(col_pix, ref_pix, lut_rows[-1])[None, :]
    row_lut[row_lut == 0] = np.nan

    sigma0 = dn ** 2 / (row_lut ** 2)
    sigma0_db = 10.0 * np.log10(np.clip(sigma0, 1e-8, None))
    sigma0_db[~np.isfinite(sigma0_db)] = np.nan
    if return_fwd:
        return sigma0_db.astype(np.float32), transform_dec, decim, None
    return sigma0_db.astype(np.float32), transform_dec, decim


def lee_despeckle(img: np.ndarray, win: int = 7) -> np.ndarray:
    """Classic Lee speckle filter on the dB image (NaN-safe)."""
    from scipy import ndimage
    valid = np.isfinite(img)
    filled = np.where(valid, img, np.nanmean(img))
    mean = ndimage.uniform_filter(filled, win)
    mean_sq = ndimage.uniform_filter(filled ** 2, win)
    var = np.clip(mean_sq - mean ** 2, 1e-6, None)
    # noise variance estimate from global stats (dB domain ~ additive noise)
    noise_var = max(var.mean(), 1e-3)
    weight = np.clip(var / (var + noise_var), 0, 1)
    out = mean + weight * (filled - mean)
    out[~valid] = np.nan
    return out.astype(np.float32)


class LandMask:
    """Rasterizes Natural Earth 10 m coastline to any SAR grid."""

    def __init__(self, landmask_dir: Path):
        import shapefile  # pyshp
        shp = list(landmask_dir.glob("ne_10m_land.shp"))
        if not shp:
            raise FileNotFoundError("run scripts/fetch_landmask.py first")
        sf = shapefile.Reader(str(shp[0]))
        self.polys = []
        for shp_rec in sf.shapes():
            pts = np.asarray(shp_rec.points)
            parts = list(shp_rec.parts) + [len(pts)]
            for a, b in zip(parts[:-1], parts[1:]):
                ring = pts[a:b]
                if len(ring) >= 4:
                    from shapely.geometry import Polygon
                    poly = Polygon(ring)
                    if poly.is_valid and poly.area > 1e-7:
                        self.polys.append(poly)

    def rasterize(self, transform, width: int, height: int) -> np.ndarray:
        mask = features.rasterize(
            [(p, 1) for p in self.polys], out_shape=(height, width),
            transform=transform, fill=0, all_touched=False, dtype="uint8")
        return mask.astype(bool)
