"""Per-patch discriminative features for oil vs look-alike classification."""
from __future__ import annotations

import numpy as np
from scipy import ndimage


def patch_features(img: np.ndarray, mask: np.ndarray, sea: np.ndarray,
                   land_dist_px: np.ndarray | None = None,
                   px_km: float = 0.1) -> dict:
    """img: dB image; mask: boolean pixels of this dark patch;
    land_dist_px: distance transform (px to nearest land); px_km: pixel size."""
    ys, xs = np.nonzero(mask)
    area_px = len(xs)

    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    crop = img[y0:y1, x0:x1]
    cmask = mask[y0:y1, x0:x1]

    # geometry
    coords = np.stack([xs, ys], axis=1).astype(float)
    c = coords.mean(axis=0)
    cov = np.cov((coords - c).T) + np.eye(2) * 1e-6
    evals, evecs = np.linalg.eigh(cov)
    lam1, lam2 = float(evals[1]), float(evals[0])
    elongation = float(np.sqrt(max(lam1, 1e-6) / max(lam2, 1e-6)))
    major = evecs[:, 1]
    orientation_deg = float(np.degrees(np.arctan2(major[1], major[0])) % 180.0)

    # contrast vs surrounding sea ring (dilate - erode)
    ring = ndimage.binary_dilation(cmask, iterations=8) & ~cmask & \
        sea[y0:y1, x0:x1]
    if ring.sum() >= 10:
        contrast = float(np.nanmean(crop[ring]) - np.nanmean(crop[cmask]))
    else:
        contrast = 0.0

    # edge sharpness: mean gradient magnitude along the boundary band
    grad = np.hypot(*np.gradient(np.nan_to_num(crop, nan=0.0)))
    band = ndimage.binary_dilation(cmask, iterations=1) & ~ndimage.binary_erosion(
        cmask, iterations=1)
    sharpness = float(grad[band].mean()) if band.any() else 0.0

    # texture homogeneity (GLCM on 16-level quantized crop, offset 3 px)
    homogeneity = _glcm_homogeneity(crop, cmask)

    # local dark fraction in a window 4x the patch extent (oil slicks sit in
    # otherwise clean water; wind cells come in crowded fields)
    wy0, wy1 = max(0, y0 - (y1 - y0)), min(img.shape[0], y1 + (y1 - y0))
    wx0, wx1 = max(0, x0 - (x1 - x0)), min(img.shape[1], x1 + (x1 - x0))
    win_sea = sea[wy0:wy1, wx0:wx1]
    win_dark = mask[wy0:wy1, wx0:wx1] | ~np.isfinite(img[wy0:wy1, wx0:wx1])
    dark_fraction = float(win_dark[win_sea].mean()) if win_sea.any() else 0.5

    dist_land_km = None
    if land_dist_px is not None:
        d = land_dist_px[int(round(c[1])), int(round(c[0]))]
        dist_land_km = round(float(d) * px_km, 2)

    return {
        "area_px": int(area_px),
        "complexity": _complexity(mask),
        "contrast_db": round(contrast, 2),
        "edge_sharpness": round(sharpness, 3),
        "homogeneity": round(homogeneity, 3),
        "elongation": round(elongation, 2),
        "orientation_deg": round(orientation_deg, 1),
        "dark_fraction_local": round(dark_fraction, 3),
        "dist_land_km": dist_land_km,
        "bbox_px": [int(x0), int(y0), int(x1), int(y1)],
    }


def _complexity(mask: np.ndarray) -> float:
    """Perimeter / perimeter of equal-area circle (>1, lower=simpler)."""
    er = ndimage.binary_erosion(mask)
    perim = float((er ^ mask).sum())
    area = float(mask.sum())
    if area < 3 or perim == 0:
        return 99.0
    return perim / (2.0 * np.sqrt(np.pi * area))


def _glcm_homogeneity(crop: np.ndarray, cmask: np.ndarray,
                      levels: int = 16, offset: int = 3) -> float:
    vals = crop[cmask & np.isfinite(crop)]
    if len(vals) < 20:
        return 0.5
    lo, hi = np.nanpercentile(vals, [2, 98])
    q = np.clip((crop - lo) / max(hi - lo, 1e-6), 0, 1)
    qi = (q * (levels - 1)).astype(np.int32)
    h, w = qi.shape
    glcm = np.zeros((levels, levels))
    a = qi[:, :-offset].ravel()
    b = qi[:, offset:].ravel()
    m = np.isfinite(a) & np.isfinite(b)
    np.add.at(glcm, (a[m].astype(int), b[m].astype(int)), 1)
    if glcm.sum() == 0:
        return 0.5
    glcm /= glcm.sum()
    i = np.arange(levels)
    diff2 = (i[:, None] - i[None, :]) ** 2
    return float((glcm / (1.0 + diff2)).sum())


def _px_km(transform) -> float:
    """Pixel size in km (lon direction; lat scale applied by cos(lat) caller)."""
    return abs(transform.a) * 111.32
