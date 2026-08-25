"""Benchmark: U-Net vs adaptive-threshold heuristic against held-out
Cerulean masks (test-split scenes). Reports pixel IoU and tile-level
detection precision/recall for both segmenters.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.detection import darkspot                     # noqa: E402
from backend.detection.unet import UNetSmall, normalize, predict_mask  # noqa: E402

DS = ROOT / "data" / "unet_ds"
CKPT = ROOT / "data" / "unet_model.pt"
# production heuristic parameters, evaluated at dataset resolution (20 m px)
PIXEL_AREA_KM2 = (20 / 111.32) ** 2


def load_model():
    if not CKPT.exists():
        return None
    ck = torch.load(CKPT, weights_only=False)
    m = UNetSmall(base=ck.get("base", 16))
    m.load_state_dict(ck["state_dict"])
    m.eval()
    label = ck.get("val_dice")
    label = f"val Dice {label:.3f}" if label else f"val IoU {ck.get('val_iou')}"
    print(f"U-Net checkpoint: epoch {ck.get('epoch')} {label}")
    return m


def heuristic_mask(tile_db: np.ndarray) -> np.ndarray:
    lab, keep = darkspot.segment(tile_db.astype(np.float32),
                                 np.isfinite(tile_db), PIXEL_AREA_KM2)
    out = np.isin(lab, keep).astype(np.uint8) if keep else \
        np.zeros(tile_db.shape, np.uint8)
    return out


def iou(a: np.ndarray, b: np.ndarray) -> float:
    inter = np.logical_and(a, b).sum()
    union = np.logical_or(a, b).sum()
    return float(inter / union) if union else 1.0


def main() -> None:
    model = load_model()
    test_dirs = [d for d in sorted(DS.iterdir()) if d.is_dir()
                 and (d / "split.txt").exists()
                 and (d / "split.txt").read_text().strip() == "test"]
    if not test_dirs:
        print("no test split found - tag scene dirs with split.txt")
        return

    stats = {name: {"inter": 0, "union": 0, "hit": 0, "miss": 0, "fp": 0}
             for name in ("unet", "heuristic")}
    n_tiles = 0
    for d in test_dirs:
        for f in sorted(d.glob("tile_*.npy")):
            arr = np.load(f).astype(np.float32)
            img, gt = arr[0], (arr[1] > 0.5)
            has_oil = gt.sum() >= 40
            for name in stats:
                pred = (predict_mask(model, img) if name == "unet" and model
                        else heuristic_mask(img)).astype(bool)
                if pred.sum() == 0 and gt.sum() == 0:
                    continue  # both empty: no information, skip
                stats[name]["inter"] += int(np.logical_and(pred, gt).sum())
                stats[name]["union"] += int(np.logical_or(pred, gt).sum())
                if has_oil:
                    if pred.sum() >= 40:
                        stats[name]["hit"] += 1
                    else:
                        stats[name]["miss"] += 1
                elif pred.sum() >= 40:
                    stats[name]["fp"] += 1
            n_tiles += 1

    print(f"\nheld-out test tiles: {n_tiles}\n")
    print(f"{'segmenter':<12} {'pixel IoU':>10} {'det recall':>11} "
          f"{'false alarms':>13}")
    for name, s in stats.items():
        if name == "unet" and model is None:
            print(f"{name:<12} {'-':>10}  (no checkpoint)")
            continue
        miou = s["inter"] / s["union"] if s["union"] else float("nan")
        det = s["hit"] + s["miss"]
        recall = s["hit"] / det if det else float("nan")
        print(f"{name:<12} {miou:>10.3f} {recall:>11.3f} {s['fp']:>13d}")


if __name__ == "__main__":
    main()
