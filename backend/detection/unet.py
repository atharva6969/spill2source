"""Compact U-Net for oil-slick segmentation in Sentinel-1 VH sigma0 dB tiles.

Trained on real paired data: CDSE scene imagery x Cerulean anthropogenic
slick masks (see scripts/build_unet_dataset.py). Replaces the adaptive
threshold stage when data/unet_model.pt exists.
"""
from __future__ import annotations

import numpy as np
import torch
import torch.nn as nn


class Block(nn.Module):
    def __init__(self, cin, cout):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(cin, cout, 3, padding=1), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
            nn.Conv2d(cout, cout, 3, padding=1), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
        )

    def forward(self, x):
        return self.net(x)


class UNetSmall(nn.Module):
    """1-channel in (sigma0 dB), 1-channel out (oil logit). base=16."""

    def __init__(self, base: int = 16):
        super().__init__()
        b = base
        self.enc1 = Block(1, b)
        self.enc2 = Block(b, b * 2)
        self.enc3 = Block(b * 2, b * 4)
        self.pool = nn.MaxPool2d(2)
        self.mid = Block(b * 4, b * 8)
        self.up3 = nn.ConvTranspose2d(b * 8, b * 4, 2, stride=2)
        self.dec3 = Block(b * 8, b * 4)
        self.up2 = nn.ConvTranspose2d(b * 4, b * 2, 2, stride=2)
        self.dec2 = Block(b * 4, b * 2)
        self.up1 = nn.ConvTranspose2d(b * 2, b, 2, stride=2)
        self.dec1 = Block(b * 2, b)
        self.out = nn.Conv2d(b, 1, 1)

    def forward(self, x):
        e1 = self.enc1(x)
        e2 = self.enc2(self.pool(e1))
        e3 = self.enc3(self.pool(e2))
        m = self.mid(self.pool(e3))
        d3 = self.dec3(torch.cat([self.up3(m), e3], dim=1))
        d2 = self.dec2(torch.cat([self.up2(d3), e2], dim=1))
        d1 = self.dec1(torch.cat([self.up1(d2), e1], dim=1))
        return self.out(d1)


# dB normalization: sea background sits around -20 dB in VH GRD
DB_LOW, DB_HIGH = -32.0, -8.0


def normalize(img_db: np.ndarray) -> np.ndarray:
    x = (img_db - DB_LOW) / (DB_HIGH - DB_LOW)
    x = np.clip(x, 0.0, 1.0)
    x = np.nan_to_num(x, nan=0.5)   # no-data -> neutral sea level, not black
    return x.astype(np.float32)


def dice_loss(logits, target, eps=1.0):
    p = torch.sigmoid(logits)
    num = 2 * (p * target).sum(dim=(2, 3)) + eps
    den = (p + target).sum(dim=(2, 3)) + eps
    return 1 - (num / den).mean()


@torch.no_grad()
def predict_mask(model, tile_db: np.ndarray, thr: float = 0.5) -> np.ndarray:
    """tile_db: HxW float dB -> binary mask uint8."""
    model.eval()
    device = next(model.parameters()).device
    with torch.inference_mode():
        x = torch.from_numpy(normalize(tile_db))[None, None].to(device)
        with torch.autocast(device_type=device.type, enabled=(device.type == 'cuda')):
            logit = model(x)[0, 0]
        return (torch.sigmoid(logit) > thr).cpu().numpy().astype(np.uint8)


@torch.no_grad()
def predict_large(model, img_db: np.ndarray, tile: int = 256, thr: float = 0.5,
                  batch_size: int = 32, sea_mask: np.ndarray | None = None) -> np.ndarray:
    """Run the U-Net over a large dB image with high-performance batched inference."""
    model.eval()
    device = next(model.parameters()).device
    h, w = img_db.shape
    out = np.zeros((h, w), dtype=np.uint8)

    if h < tile or w < tile:
        pad_h = max(tile - h, 0)
        pad_w = max(tile - w, 0)
        padded = np.pad(img_db, ((0, pad_h), (0, pad_w)), mode="constant", constant_values=np.nan)
        mask = predict_mask(model, padded, thr)
        return mask[:h, :w]

    ys = list(range(0, h - tile + 1, tile))
    xs = list(range(0, w - tile + 1, tile))
    if ys[-1] != h - tile:
        ys.append(h - tile)
    if xs[-1] != w - tile:
        xs.append(w - tile)

    # Normalize entire image once in vectorized NumPy
    norm_img = normalize(img_db)

    # Collect tile coordinates that contain valid sea/data pixels
    valid_tiles = []
    for y0 in ys:
        for x0 in xs:
            y1, x1 = y0 + tile, x0 + tile
            if sea_mask is not None:
                # If tile has zero sea pixels, skip inference completely
                if not sea_mask[y0:y1, x0:x1].any():
                    continue
            valid_tiles.append((y0, y1, x0, x1))

    if not valid_tiles:
        return out

    # Process tiles in vectorized batches
    with torch.inference_mode():
        for i in range(0, len(valid_tiles), batch_size):
            batch_coords = valid_tiles[i:i + batch_size]
            batch_np = np.stack([norm_img[y0:y1, x0:x1] for (y0, y1, x0, x1) in batch_coords], axis=0)
            # shape: (B, 1, tile, tile)
            batch_tensor = torch.from_numpy(batch_np[:, None, :, :]).to(device)
            with torch.autocast(device_type=device.type, enabled=(device.type == 'cuda')):
                logits = model(batch_tensor)[:, 0]
            masks = (torch.sigmoid(logits) > thr).cpu().numpy().astype(np.uint8)

            for (y0, y1, x0, x1), m in zip(batch_coords, masks):
                out[y0:y1, x0:x1] = np.maximum(out[y0:y1, x0:x1], m)

    return out
