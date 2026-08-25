"""Train the U-Net oil segmenter on the Cerulean-paired dataset.

Usage: python scripts/train_unet.py [--epochs 20]
Saves the best-by-val-IoU checkpoint to data/unet_model.pt with metadata.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.detection.unet import (UNetSmall, dice_loss,  # noqa: E402
                                    normalize)

DS = ROOT / "data" / "unet_ds"
CKPT = ROOT / "data" / "unet_model.pt"


class TileDataset(Dataset):
    def __init__(self, scenes: list[Path], augment: bool = False):
        self.files = []
        for s in scenes:
            self.files.extend(sorted(s.glob("tile_*.npy")))
        self.augment = augment

    def __len__(self):
        return len(self.files)

    def __getitem__(self, i):
        arr = np.load(self.files[i]).astype(np.float32)   # (2, H, W)
        img, mask = normalize(arr[0]), (arr[1] > 0.5).astype(np.float32)
        if self.augment:
            k = np.random.randint(0, 4)
            img, mask = np.rot90(img, k), np.rot90(mask, k)
            if np.random.rand() < 0.5:
                img, mask = np.fliplr(img), np.fliplr(mask)
        return torch.from_numpy(img.copy())[None], \
            torch.from_numpy(mask.copy())[None]


def dice_score(logits, target, thr=0.5):
    """Global oil-pixel Dice (F1) over the set - robust to empty sea tiles
    (per-tile IoU with the empty-union -> 1.0 convention inflated the
    metric when the model collapsed to predicting nothing)."""
    p = torch.sigmoid(logits) > thr
    t = target > 0.5
    inter = (p & t).sum().item()
    denom = p.sum().item() + t.sum().item()
    return 2 * inter / denom if denom else 1.0


def detection_pr(logits, target, thr=0.5, min_px=40):
    """Tile-level detection: tile counted 'oil' if >=min_px predicted/mask px."""
    p = (torch.sigmoid(logits) > thr).sum(dim=(1, 2, 3)) >= min_px
    t = (target > 0.5).sum(dim=(1, 2, 3)) >= min_px
    return int((p & t).sum()), int((~p & t).sum()), int((p & ~t).sum())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--lr", type=float, default=1e-3)
    args = ap.parse_args()

    scenes = sorted([d for d in DS.iterdir() if d.is_dir()])
    by_split = {"train": [], "val": [], "test": []}
    # split dirs carry a marker file written by the dataset builder
    for d in scenes:
        split = (d / "split.txt").read_text().strip() \
            if (d / "split.txt").exists() else "train"
        by_split.setdefault(split, []).append(d)

    tr = TileDataset(by_split.get("train", []), augment=True)
    va = TileDataset(by_split.get("val", []))
    print(f"tiles: train={len(tr)} val={len(va)} "
          f"test={len(TileDataset(by_split.get('test', [])))}")
    if len(tr) < 40 or len(va) < 8:
        print("dataset too small - run scripts/build_unet_dataset.py first")
        return

    torch.manual_seed(7)
    model = UNetSmall(base=16)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    # slicks cover ~1-3 % of pixels - weight positives or the model
    # collapses to predicting all-sea
    pos_weight = torch.tensor([40.0])
    print(f"params: {sum(p.numel() for p in model.parameters()) / 1e6:.2f}M | "
          f"threads {torch.get_num_threads()} | pos_weight {pos_weight.item():.0f}")

    best_dice = 0.0
    for epoch in range(args.epochs):
        model.train()
        t0 = time.time()
        tl = 0.0
        nb = 0
        for xb, yb in DataLoader(tr, batch_size=args.batch, shuffle=True,
                                 num_workers=0):
            opt.zero_grad()
            logits = model(xb)
            loss = F.binary_cross_entropy_with_logits(logits, yb,
                                                      pos_weight=pos_weight) \
                + dice_loss(logits, yb)
            loss.backward()
            opt.step()
            tl += float(loss.detach())
            nb += 1
        model.eval()
        vdice = 0.0
        hit = miss = fp = 0
        with torch.no_grad():
            for xb, yb in DataLoader(va, batch_size=args.batch):
                logits = model(xb)
                vdice += dice_score(logits, yb)
                h, mi, f_ = detection_pr(logits, yb)
                hit += h; miss += mi; fp += f_
        vdice /= max(len(DataLoader(va, batch_size=args.batch)), 1)
        det_recall = hit / max(hit + miss, 1)
        det_prec = hit / max(hit + fp, 1)
        mark = ""
        if vdice > best_dice:
            best_dice = vdice
            torch.save({
                "state_dict": model.state_dict(),
                "val_dice": vdice,
                "det_recall": det_recall,
                "det_precision": det_prec,
                "epoch": epoch,
                "base": 16,
                "saved_at": time.time(),
            }, CKPT)
            mark = "  <- saved"
        print(f"epoch {epoch + 1:02d}/{args.epochs}  loss {tl / max(nb, 1):.3f}"
              f"  val Dice {vdice:.3f}  det R/P {det_recall:.2f}/{det_prec:.2f}"
              f"  ({time.time() - t0:.0f}s){mark}")

    print(f"best val Dice: {best_dice:.3f} -> {CKPT}")


if __name__ == "__main__":
    main()
