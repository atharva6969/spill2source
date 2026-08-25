"""Build the U-Net training dataset: real Sentinel-1 imagery + real oil masks.

Pairs:
  imagery  - VH sigma0 dB tiles from CDSE GRD scenes (our own calibration)
  masks    - Cerulean anthropogenic slick polygons (cls 2/4/5/6/7/8,
             machine_confidence >= 0.7) rasterized into the tile frame

Scenes: top-N Baltic scenes by historical slick count (2023-2026).
Split is BY SCENE: train / val / held-out test (for the U-Net vs
heuristic benchmark). Zips + SAFE dirs are deleted after extraction.
"""
from __future__ import annotations

import asyncio
import shutil
import sys
import time
from pathlib import Path

import httpx
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.config import settings                      # noqa: E402
from backend.store import Store                          # noqa: E402
from backend.providers.sentinel_cdse import (CdseProvider,  # noqa: E402
                                             ODATA)
from backend.detection.sar_preprocess import (find_measurement,  # noqa: E402
                                              read_sigma0_db, unpack_safe)
from backend.risk.features import make_grid              # noqa: E402  (unused here)

CER = "https://api.cerulean.skytruth.org/collections/public.slick_plus/items"
ANTHRO_CLS = {2, 4, 5, 6, 7, 8}
MIN_CONF = 0.70
TILE = 256
STRIDE = 128
DS = ROOT / "data" / "unet_ds"
N_TRAIN, N_VAL, N_TEST = 12, 2, 2

import sqlite3  # noqa: E402


def select_scenes(n: int = 16) -> list[dict]:
    c = sqlite3.connect(settings.db_path)
    c.row_factory = sqlite3.Row
    rows = c.execute(
        "SELECT s1_scene, COUNT(*) n FROM hist_slicks "
        "WHERE cls IN (2,4,5,6,7,8) AND s1_scene IS NOT NULL "
        "AND centroid_lat BETWEEN 53.5 AND 62 "
        "GROUP BY s1_scene ORDER BY n DESC LIMIT ?", (n,)).fetchall()
    out = []
    for r in rows:
        name = r["s1_scene"]
        # scene name -> product name (GRDH 1SDV slice)
        parts = name.split("_")
        out.append({"scene": name, "n_slicks": r["n"],
                    "product_hint": name + ".SAFE"})
    return out


def fetch_scene_slicks(scene: str) -> list[dict]:
    """Cerulean polygons for one scene (sensing window ± 2 min)."""
    from datetime import datetime, timedelta, timezone
    start = scene.split("_")[4]
    dt0 = datetime.strptime(start, "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
    t0 = dt0.strftime("%Y-%m-%dT%H:%M:%SZ")
    t1 = (dt0 + timedelta(seconds=120)).strftime("%Y-%m-%dT%H:%M:%SZ")
    feats = []
    offset = 0
    with httpx.Client(timeout=60) as cl:
        while True:
            r = cl.get(CER, params={
                "bbox": "9,53,31,66",
                "datetime": f"{t0}/{t1}",
                "limit": 1000, "offset": offset})
            r.raise_for_status()
            d = r.json()
            fs = d.get("features", [])
            feats.extend(fs)
            if len(fs) < 1000:
                break
            offset += 1000
    keep = []
    scene_base = scene.removesuffix("_COG")
    for f in feats:
        p = f.get("properties", {})
        if p.get("s1_scene_id") != scene_base:
            continue
        if p.get("cls") not in ANTHRO_CLS:
            continue
        if (p.get("machine_confidence") or 0) < MIN_CONF:
            continue
        from shapely.geometry import shape
        keep.append(shape(f["geometry"]))
    print(f"  {scene[:44]}: {len(feats)} slicks, {len(keep)} anthro>=conf{MIN_CONF}")
    return keep


def resolve_product_id(scene: str) -> str | None:
    with httpx.Client(timeout=60) as cl:
        r = cl.get(f"{ODATA}/Products", params={
            "$filter": f"Name eq '{scene}.SAFE'", "$top": 5})
        r.raise_for_status()
        vals = r.json().get("value", [])
        if not vals:
            return None
        # prefer the non-COG full SAFE (geocoded via GCPs either way)
        vals.sort(key=lambda p: p["ContentLength"], reverse=True)
        return vals[0]["Id"]


def extract_tiles(scene: str, safe_dir: Path, slick_polys: list) -> int:
    """Read sigma0 around slick clusters, tile + mask, save .npy."""
    from rasterio import features as rio_features
    from shapely.ops import unary_union

    out_dir = DS / scene
    out_dir.mkdir(parents=True, exist_ok=True)
    if any(out_dir.glob("tile_*.npy")):
        print(f"  {scene[:44]}: tiles already extracted, skip")
        return len(list(out_dir.glob('tile_*.npy')))

    tiff, pol = find_measurement(safe_dir)
    # window = slick bbox + margin
    union = unary_union(slick_polys).buffer(0.08)  # ~8 km
    minx, miny, maxx, maxy = union.bounds
    sigma, transform, decim = read_sigma0_db(
        tiff, safe_dir, bbox=(minx, miny, maxx, maxy), max_pixels=60_000_000)
    h, w = sigma.shape
    if h < TILE or w < TILE:
        print(f"  {scene[:44]}: window too small ({h}x{w})")
        return 0

    # the WarpedVRT transform is an exact geolocation affine - rasterize
    # the Cerulean polygons straight onto the window grid
    mask_full = rio_features.rasterize(
        [(g, 1) for g in slick_polys], out_shape=(h, w),
        transform=transform, fill=0, dtype="uint8")

    img = sigma.astype(np.float16)
    kept = 0
    pos_idx, neg_idx = [], []
    for y0 in range(0, h - TILE, STRIDE):
        for x0 in range(0, w - TILE, STRIDE):
            m = mask_full[y0:y0 + TILE, x0:x0 + TILE]
            valid = np.isfinite(img[y0:y0 + TILE, x0:x0 + TILE]).mean()
            if valid < 0.9:
                continue
            if m.sum() >= 40:
                pos_idx.append((y0, x0))
            elif m.sum() == 0:
                neg_idx.append((y0, x0))
    rng = np.random.default_rng(7)
    rng.shuffle(neg_idx)
    keep_neg = min(len(neg_idx), max(int(len(pos_idx) * 1.5), 40))
    for tag, idxs in (("pos", pos_idx), ("neg", neg_idx[:keep_neg])):
        for k, (y0, x0) in enumerate(idxs):
            t_img = img[y0:y0 + TILE, x0:x0 + TILE]
            t_msk = mask_full[y0:y0 + TILE, x0:x0 + TILE]
            np.save(out_dir / f"tile_{tag}_{k:04d}.npy",
                    np.stack([t_img, t_msk]).astype(np.float16))
            kept += 1
    print(f"  {scene[:44]}: {len(pos_idx)} positive / {keep_neg} negative tiles")
    return kept


def _retry(fn, attempts: int = 4, delay: float = 5.0):
    import time as _t
    for i in range(attempts):
        try:
            return fn()
        except Exception as exc:
            if i == attempts - 1:
                raise
            print(f"  retry {i + 1}/{attempts - 1} after error: {exc}")
            _t.sleep(delay * (i + 1))


def main() -> None:
    store = Store(settings.db_path)
    DS.mkdir(parents=True, exist_ok=True)
    scenes = select_scenes()
    splits = (["train"] * N_TRAIN + ["val"] * N_VAL + ["test"] * N_TEST)

    async def run() -> None:
        cdse = CdseProvider(store, settings)
        for i, sc in enumerate(scenes):
            scene = sc["scene"]
            split = splits[i] if i < len(splits) else "extra"
            out_dir = DS / scene
            if any(out_dir.glob("tile_*.npy")):
                print(f"[{i + 1}/{len(scenes)}] {scene[:44]} done, skip")
                continue
            print(f"[{i + 1}/{len(scenes)}] {scene} -> {split}")
            try:
                polys = _retry(lambda: fetch_scene_slicks(scene))
            except Exception as exc:
                print(f"  cerulean fetch failed, skip: {exc}")
                continue
            if len(polys) < 3:
                continue
            try:
                pid = _retry(lambda: resolve_product_id(scene))
            except Exception as exc:
                print(f"  cdse resolve failed, skip: {exc}")
                continue
            if not pid:
                print("  product not found in CDSE, skip")
                continue
            store.exec(
                """INSERT INTO scenes(product_id,name,sensed_start,size_mb,footprint,status)
                   VALUES(?,?,?,?,?,'catalogued')
                   ON CONFLICT(product_id) DO UPDATE SET name=excluded.name""",
                (pid, scene + ".SAFE",
                 _scene_ts(scene), 0.0, None))
            try:
                local = await cdse.download(pid)
                safe_dir = unpack_safe(local, settings.data_dir / "scenes")
                n = extract_tiles(scene, safe_dir, polys)
                (DS / scene / "split.txt").write_text(split)
            except Exception as exc:
                print(f"  FAILED: {exc}")
                continue
            finally:
                cdse.download_progress.pop(pid, None)
            # free disk: remove zip + SAFE after successful extraction
            if n > 0:
                base = settings.data_dir / "scenes" / scene
                shutil.rmtree(base, ignore_errors=True)
                (settings.data_dir / "scenes" / f"{scene}.zip").unlink(missing_ok=True)
                (settings.data_dir / "scenes" / f"{scene}_COG.zip").unlink(missing_ok=True)
        await cdse.close()

    asyncio.run(run())
    # summary
    tot = sum(len(list(d.glob('tile_*.npy'))) for d in DS.iterdir() if d.is_dir())
    print(f"dataset ready: {tot} tiles under {DS}")


def _scene_ts(scene: str) -> float:
    from datetime import datetime, timezone
    s = scene.split("_")[4]
    return datetime.strptime(s, "%Y%m%dT%H%M%S").replace(
        tzinfo=timezone.utc).timestamp()


if __name__ == "__main__":
    main()
