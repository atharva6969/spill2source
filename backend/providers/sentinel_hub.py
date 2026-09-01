"""Sentinel Hub Process API provider (Copernicus Data Space Ecosystem).

Fetches a calibrated, orthorectified Sentinel-1 GRD sigma0 raster for *only*
the AOI window, tiled to respect the Process API's 2500x2500 px per-request
limit and mosaicked into a single north-up EPSG:4326 array. This replaces the
~650 MB single-band product download with a few MB of pixels over the AOI.

Auth: OAuth2 client_credentials against the CDSE identity realm (a Sentinel Hub
OAuth client created in the CDSE dashboard).
"""
from __future__ import annotations

import logging
import math
import time
from datetime import datetime, timedelta, timezone

import httpx
import numpy as np
import rasterio

log = logging.getLogger("sh")

TOKEN_URL = ("https://identity.dataspace.copernicus.eu/auth/realms/CDSE/"
             "protocol/openid-connect/token")
PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process"
MAX_TILE_PX = 2500

# Return linear sigma0 for the requested polarisation; 0 marks nodata (we turn
# those into NaN on the client so calibration/land handling stays identical).
_EVALSCRIPT = """//VERSION=3
function setup() {
  return {input: [{bands: ["%s"]}],
          output: {bands: 1, sampleType: "FLOAT32"}};
}
function evaluatePixel(s) { return [s.%s]; }
"""


class SentinelHubProvider:
    def __init__(self, settings):
        self.settings = settings
        self._token: str | None = None
        self._token_exp = 0.0
        self._client = httpx.Client(timeout=httpx.Timeout(120))

    def close(self) -> None:
        self._client.close()

    @property
    def configured(self) -> bool:
        return self.settings.sh_configured

    def _get_token(self) -> str:
        if self._token and time.time() < self._token_exp - 60:
            return self._token
        r = self._client.post(TOKEN_URL, data={
            "grant_type": "client_credentials",
            "client_id": self.settings.sh_client_id,
            "client_secret": self.settings.sh_client_secret,
        })
        r.raise_for_status()
        tok = r.json()
        self._token = tok["access_token"]
        self._token_exp = time.time() + int(tok.get("expires_in", 600))
        return self._token

    def _fetch_tile(self, bbox, w, h, t0_iso, t1_iso, pol) -> np.ndarray:
        band = pol.upper()
        body = {
            "input": {
                "bounds": {
                    "bbox": list(bbox),
                    "properties": {
                        "crs": "http://www.opengis.net/def/crs/EPSG/0/4326"},
                },
                "data": [{
                    "type": "sentinel-1-grd",
                    "dataFilter": {
                        "timeRange": {"from": t0_iso, "to": t1_iso},
                        "acquisitionMode": "IW",
                        "resolution": "HIGH",
                    },
                    "processing": {
                        "backCoeff": "SIGMA0_ELLIPSOID",
                        "orthorectify": True,
                        "demInstance": "COPERNICUS_30",
                    },
                }],
            },
            "output": {
                "width": w, "height": h,
                "responses": [{"identifier": "default",
                               "format": {"type": "image/tiff"}}],
            },
            "evalscript": _EVALSCRIPT % (band, band),
        }
        token = self._get_token()
        r = self._client.post(PROCESS_URL, json=body,
                              headers={"Authorization": f"Bearer {token}"})
        if r.status_code != 200:
            raise RuntimeError(f"SH process {r.status_code}: {r.text[:300]}")
        with rasterio.MemoryFile(r.content) as mem, mem.open() as ds:
            return ds.read(1).astype(np.float32)

    def fetch_sigma0_db(self, bbox, sensed_start: float, pol: str = "vv"):
        """Return (sigma0_db float32, north-up affine transform in EPSG:4326).

        ``sensed_start`` is the scene acquisition epoch; a +/-6 h window around
        it isolates the single overpass.
        """
        x0, y0, x1, y1 = bbox
        lat_c = (y0 + y1) / 2
        deg_lon = self.settings.sh_resolution_m / (111_320 * math.cos(
            math.radians(lat_c)))
        deg_lat = self.settings.sh_resolution_m / 110_540
        full_w = max(int(round((x1 - x0) / deg_lon)), 1)
        full_h = max(int(round((y1 - y0) / deg_lat)), 1)
        transform = rasterio.transform.from_bounds(x0, y0, x1, y1, full_w, full_h)

        dt = datetime.fromtimestamp(sensed_start, tz=timezone.utc)
        t0_iso = (dt - timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%SZ")
        t1_iso = (dt + timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%SZ")

        mosaic = np.zeros((full_h, full_w), dtype=np.float32)
        tasks = []
        for r0 in range(0, full_h, MAX_TILE_PX):
            for c0 in range(0, full_w, MAX_TILE_PX):
                th = min(MAX_TILE_PX, full_h - r0)
                tw = min(MAX_TILE_PX, full_w - c0)
                # tile bbox from the mosaic transform (row grows southward)
                tx0, ty1 = transform * (c0, r0)
                tx1, ty0 = transform * (c0 + tw, r0 + th)
                tasks.append((r0, c0, th, tw, (tx0, ty0, tx1, ty0)))

        def _fetch_worker(item):
            r0, c0, th, tw, tbbox = item
            t_data = self._fetch_tile(tbbox, tw, th, t0_iso, t1_iso, pol)
            return r0, c0, th, tw, t_data

        import concurrent.futures
        workers = min(len(tasks), 8) if tasks else 1
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            results = list(executor.map(_fetch_worker, tasks))

        for r0, c0, th, tw, t_data in results:
            mosaic[r0:r0 + th, c0:c0 + tw] = t_data

        log.info("SH fetch %s: %dx%d px over %d parallel tile(s) @ %.0f m",
                 pol, full_w, full_h, len(tasks), self.settings.sh_resolution_m)

        sigma0 = mosaic.copy()
        sigma0[sigma0 <= 0] = np.nan
        sigma0_db = 10.0 * np.log10(np.clip(sigma0, 1e-8, None))
        sigma0_db[~np.isfinite(sigma0_db)] = np.nan
        return sigma0_db.astype(np.float32), transform
