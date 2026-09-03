"""End-to-end SAR scene processing: download -> preprocess -> detect -> store.

Called by scheduler for new catalog scenes and by POST /api/scenes/scan.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy import ndimage
from shapely.geometry import Polygon, shape

from backend.providers.sentinel_cdse import parse_product_name
from . import darkspot, classify, characterize
from .features import patch_features
from .sar_preprocess import (LandMask, find_measurement, lee_despeckle,
                             read_sigma0_db, unpack_safe)

log = logging.getLogger("detect")


class DetectionPipeline:
    def __init__(self, store, settings):
        self.store = store
        self.s = settings
        self._landmask: LandMask | None = None
        self._unet = None
        self._unet_loaded = False

    def _land(self) -> LandMask:
        if self._landmask is None:
            self._landmask = LandMask(self.s.data_dir / "landmask")
        return self._landmask

    def _segmentation_mask(self, sigma_db: np.ndarray, img: np.ndarray,
                           sea: np.ndarray, pixel_area_km2: float) -> np.ndarray:
        """Oil mask from the configured segmenter (U-Net if available)."""
        mode = self.s.detector_mode
        ckpt = self.s.data_dir / "unet_model.pt"
        if not self._unet_loaded:
            self._unet_loaded = True
            if ckpt.exists() and mode in ("auto", "unet"):
                import torch
                from .unet import UNetSmall
                device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
                ck = torch.load(ckpt, weights_only=False)
                self._unet = UNetSmall(base=ck.get('base', 16))
                self._unet.load_state_dict(ck['state_dict'])
                self._unet.to(device)
                self._unet.eval()
                try:
                    dummy_input = torch.zeros(1, 1, 256, 256, device=device)
                    self._unet = torch.jit.optimize_for_inference(torch.jit.trace(self._unet, dummy_input))
                except Exception:
                    pass
        if self._unet is not None and mode in ("auto", "unet"):
            from .unet import predict_large
            mask = predict_large(self._unet, sigma_db, sea_mask=sea, batch_size=32).astype(bool) & sea
            # light morphological cleanup
            mask = ndimage.binary_closing(mask, np.ones((3, 3)))
            return mask
        # heuristic fallback
        lab, keep = darkspot.segment(img, sea, pixel_area_km2)
        out = np.zeros_like(sea)
        for gid in keep:
            out |= (lab == gid)
        return out

    async def process_product(self, product_id: str, local_zip: str,
                              broadcast=None) -> list[int]:
        """Run detection on a downloaded product; returns slick ids created."""
        meta = self.store.one("SELECT * FROM scenes WHERE product_id=?",
                              (product_id,))
        name = meta["name"] if meta else product_id
        self.store.exec("UPDATE scenes SET status='processing' WHERE product_id=?",
                        (product_id,))
        if broadcast:
            await broadcast({"type": "scene_status", "product_id": product_id,
                             "status": "processing", "name": name})
        t0 = time.time()
        loop = asyncio.get_running_loop()
        safe_dir = None
        try:
            # heavy CPU work (unzip, calibration, segmentation) must not block
            # the event loop feeding the live dashboard
            slick_ids = await loop.run_in_executor(
                None, self._run, product_id, name, local_zip)
            dt = time.time() - t0
            log.info("%s processed in %.0fs -> %d slick candidates",
                     name, dt, len(slick_ids))
            # C2: immediate cleanup — detection results live in SQLite now
            local = Path(local_zip)
            scenes = local.parent if local.is_file() else local.parent
            base = name.removesuffix(".SAFE")
            for d in scenes.iterdir():
                if d.is_dir() and d.name.startswith(base):
                    shutil.rmtree(d, ignore_errors=True)
                    safe_dir = d
            if local.is_file():
                local.unlink(missing_ok=True)
            return slick_ids
        except Exception as exc:
            log.exception("detection failed for %s", name)
            self.store.exec(
                "UPDATE scenes SET status='error', error=?, processed_at=? "
                "WHERE product_id=?", (str(exc)[:500], time.time(), product_id))
            if broadcast:
                await broadcast({"type": "scene_status", "product_id": product_id,
                                 "status": "error", "name": name})
            return []

    async def process_sh(self, product_id: str, sigma_db, transform, pol: str,
                          broadcast=None) -> list[int]:
        """Run detection on a Sentinel-Hub AOI raster (no download/unpack)."""
        meta = self.store.one("SELECT * FROM scenes WHERE product_id=?",
                              (product_id,))
        name = meta["name"] if meta else product_id
        self.store.exec("UPDATE scenes SET status='processing' WHERE product_id=?",
                        (product_id,))
        if broadcast:
            await broadcast({"type": "scene_status", "product_id": product_id,
                             "status": "processing", "name": name})
        t0 = time.time()
        loop = asyncio.get_running_loop()
        try:
            slick_ids = await loop.run_in_executor(
                None, self._run_sh, product_id, name, sigma_db, transform, pol)
            log.info("%s processed (SH) in %.0fs -> %d slick candidates",
                     name, time.time() - t0, len(slick_ids))
            return slick_ids
        except Exception as exc:
            log.exception("detection failed for %s", name)
            self.store.exec(
                "UPDATE scenes SET status='error', error=?, processed_at=? "
                "WHERE product_id=?", (str(exc)[:500], time.time(), product_id))
            if broadcast:
                await broadcast({"type": "scene_status", "product_id": product_id,
                                 "status": "error", "name": name})
            return []

    def _run(self, product_id: str, name: str, local_zip: str) -> list[int]:
        safe_dir = unpack_safe(local_zip, self.s.data_dir / "scenes")
        tiff, pol = find_measurement(safe_dir)
        bbox = self.s.aoi_bbox
        sigma_db, transform, decim = read_sigma0_db(tiff, safe_dir, bbox=bbox)
        return self._detect_core(product_id, name, sigma_db, transform,
                                 pol=pol, decim=decim)

    def _run_sh(self, product_id: str, name: str, sigma_db, transform,
                pol: str) -> list[int]:
        """Detection on an AOI raster fetched via Sentinel Hub (already
        calibrated + geocoded, so no SAFE unpack/warp)."""
        return self._detect_core(product_id, name, sigma_db, transform,
                                 pol=pol, decim=1)

    def _detect_core(self, product_id: str, name: str, sigma_db, transform,
                     pol: str, decim: int) -> list[int]:
        h, w = sigma_db.shape
        if h < 50 or w < 50:
            raise RuntimeError("AOI barely intersects scene; nothing to scan")

        land = self._land().rasterize(transform, w, h)
        sea = ~land

        img = lee_despeckle(sigma_db)

        # rotated affine: pixel area from the Jacobian determinant
        det_deg2 = abs(transform.a * transform.e - transform.b * transform.d)
        lat_center = (transform.f + transform.e * (h / 2) + transform.b * (w / 2))
        coslat = math.cos(math.radians(min(max(lat_center, 45.0), 70.0)))
        pixel_area_km2 = det_deg2 * 111.32 * 110.574 * coslat
        px_km = float(np.sqrt(pixel_area_km2))

        oil_mask = self._segmentation_mask(sigma_db, img, sea, pixel_area_km2)
        lab, n_raw = ndimage.label(oil_mask)
        if n_raw == 0:
            self.store.exec(
                "UPDATE scenes SET status='clear', processed_at=? "
                "WHERE product_id=?", (time.time(), product_id))
            return []
        sizes = ndimage.sum_labels(np.ones_like(lab), lab,
                                   index=np.arange(1, n_raw + 1))
        min_px = darkspot.MIN_AREA_KM2 / pixel_area_km2
        max_px = darkspot.MAX_AREA_KM2 / pixel_area_km2
        keep_ids = [i + 1 for i, s in enumerate(sizes) if min_px <= s <= max_px]
        if not keep_ids:
            self.store.exec(
                "UPDATE scenes SET status='clear', processed_at=? "
                "WHERE product_id=?", (time.time(), product_id))
            return []

        # distance to land (px) for feature extraction
        land_dist_px = ndimage.distance_transform_edt(~land)

        vecs = characterize.vectorize_patches(lab, keep_ids, transform)
        feats_list, gids = [], []
        for gid, v in vecs.items():
            mask = (lab == gid)
            f = patch_features(img, mask, sea, land_dist_px, px_km=px_km)
            f["area_km2"] = v["area_km2"]
            f["pixel_area_km2"] = pixel_area_km2
            feats_list.append(f)
            gids.append(gid)

        probs = classify.score_patches(feats_list)
        sensed = parse_product_name(name).get("start") \
            or datetime.now(timezone.utc).timestamp()

        slick_ids = []
        for gid, f, p in zip(gids, feats_list, probs):
            geom = vecs[gid]["geometry"]
            gprops = characterize.geometry_properties(geom)
            confidence = round(p, 3)
            cur = self.store.query(
                "SELECT id FROM slicks WHERE scene_id=? AND centroid_lon BETWEEN ? AND ? "
                "AND centroid_lat BETWEEN ? AND ?",
                (product_id, gprops["centroid_lon"] - 0.01,
                 gprops["centroid_lon"] + 0.01,
                 gprops["centroid_lat"] - 0.01, gprops["centroid_lat"] + 0.01))
            # NOTE: dedupe is per-scene; linking the same slick across passes
            # requires drift correlation and is deliberately not faked here.
            props = {
                "features": {k: f.get(k) for k in
                             ("complexity", "contrast_db", "edge_sharpness",
                              "homogeneity", "elongation", "dark_fraction_local",
                              "dist_land_km")},
                "polarization": pol.upper(),
                "decimation": decim,
            }
            if cur:
                sid = cur[0]["id"]
                self.store.exec(
                    """UPDATE slicks SET detected_at=?, area_km2=?, major_axis_km=?,
                       minor_axis_km=?, orientation_deg=?, confidence=?,
                       oil_probability=?, geometry=?, properties=? WHERE id=?""",
                    (sensed, vecs[gid]["area_km2"],
                     gprops["major_axis_km"], gprops["minor_axis_km"],
                     gprops["orientation_deg"], confidence, confidence,
                     _j(characterize.to_geojson(geom)),
                     _j(props), sid))
                slick_ids.append(sid)
                continue
            self.store.exec(
                """INSERT INTO slicks(scene_id, scene_name, detected_at,
                   centroid_lon, centroid_lat, area_km2, major_axis_km,
                   minor_axis_km, orientation_deg, confidence, oil_probability,
                   age_estimate_h, age_sigma_h, geometry, properties)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (product_id, name, sensed,
                 gprops["centroid_lon"], gprops["centroid_lat"],
                 vecs[gid]["area_km2"], gprops["major_axis_km"],
                 gprops["minor_axis_km"], gprops["orientation_deg"],
                 confidence, confidence, None, None,
                 _j(characterize.to_geojson(geom)), _j(props)))
            row = self.store.one(
                "SELECT id FROM slicks WHERE scene_id=? ORDER BY id DESC LIMIT 1",
                (product_id,))
            slick_ids.append(row["id"])

        self.store.exec(
            "UPDATE scenes SET status='detected', processed_at=? WHERE product_id=?",
            (time.time(), product_id))
        return slick_ids


def _j(v):
    return json.dumps(v)


def footprint_polygon(footprint_coords) -> Polygon | None:
    try:
        return Polygon(footprint_coords[0])
    except Exception:
        return None
