"""Dark-spot segmentation: adaptive sea-background thresholding on SAR dB.

Oil films damp Bragg-scale capillary waves -> anomalously dark, sharp-edged
patches relative to the local sea backscatter. Look-alikes (low wind cells,
biogenic films, rain cells) share the darkness but differ in shape/texture -
those cues are scored in features.py / classify.py.
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage

BLOCK = 512          # background statistics block size (px)
K_SIGMA = 2.2        # threshold = mu - K*sigma per block
MIN_AREA_KM2 = 0.05
MAX_AREA_KM2 = 80.0


def segment(sigma0_db: np.ndarray, sea: np.ndarray,
            pixel_area_km2: float) -> tuple[np.ndarray, list[int]]:
    """Returns (label_image, kept_label_ids)."""
    img = np.where(np.isfinite(sigma0_db), sigma0_db, np.nan)
    valid = sea & np.isfinite(img)

    mu = np.full_like(img, np.nan)
    sd = np.full_like(img, np.nan)
    h, w = img.shape
    for y0 in range(0, h, BLOCK):
        for x0 in range(0, w, BLOCK):
            sl = (slice(y0, min(y0 + BLOCK, h)), slice(x0, min(x0 + BLOCK, w)))
            m = valid[sl]
            if m.sum() < 500:
                continue
            vals = img[sl][m]
            mu[sl], sd[sl] = vals.mean(), vals.std()

    # fill blocks without enough sea with global sea stats
    gm, gs = np.nanmean(img[valid]), np.nanstd(img[valid])
    mu = np.where(np.isnan(mu), gm, mu)
    sd = np.where(np.isnan(sd), gs, sd)

    thresh = mu - K_SIGMA * sd
    dark = valid & (img < thresh)

    # clean speckle noise: close small gaps, drop tiny objects
    dark = ndimage.binary_closing(dark, structure=np.ones((3, 3)))
    lab, n = ndimage.label(dark)
    if n == 0:
        return lab, []
    sizes = ndimage.sum_labels(np.ones_like(lab), lab, index=np.arange(1, n + 1))
    min_px = MIN_AREA_KM2 / pixel_area_km2
    max_px = MAX_AREA_KM2 / pixel_area_km2
    keep = [i + 1 for i, s in enumerate(sizes) if min_px <= s <= max_px]
    return lab, keep
