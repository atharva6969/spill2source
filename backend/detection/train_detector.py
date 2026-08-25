"""Train the RandomForest oil/look-alike classifier.

Optional upgrade path - the detector works day-1 on physics priors alone.
Provide labelled patches as 16-bit or 8-bit SAR crops:

    data/training/oil/*.png|*.tif|*.npy        (positive slicks)
    data/training/lookalike/*.png|*.tif|*.npy  (negatives: low-wind, biogenic)

e.g. from the Zenodo Sentinel-1 oil-spill datasets. Each image is one patch;
features are computed exactly as in production, then a RandomForest is fitted
and saved to data/model_rf.joblib (auto-picked-up by classify.py).
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.detection.features import patch_features  # noqa: E402
from backend.detection.classify import MODEL_PATH      # noqa: E402


def _load_patch(p: Path) -> tuple[np.ndarray, np.ndarray]:
    """Load one labelled crop -> (dB image, all-pixel mask)."""
    if p.suffix == ".npy":
        arr = np.load(p)
    else:
        from PIL import Image
        arr = np.asarray(Image.open(p).convert("L"), dtype=float)
    img = arr.astype(np.float32)
    if img.max() > 0 and img.min() >= 0:            # DN-like -> dB
        img = 10 * np.log10(np.clip(img, 1e-3, None))
    mask = np.ones(img.shape, bool)
    return img, mask


def extract_dataset() -> tuple[list[dict], list[int]]:
    feats, labels = [], []
    for label, sub in [(1, "oil"), (0, "lookalike")]:
        d = ROOT / "data" / "training" / sub
        files = [q for q in d.glob("*") if q.suffix.lower() in
                 (".png", ".tif", ".tiff", ".npy")] if d.exists() else []
        for p in files:
            img, mask = _load_patch(p)
            sea = np.isfinite(img)
            f = patch_features(img, mask, sea, None,
                               px_km=abs(10.0 / 111.32))  # GRD ~10 m px
            feats.append(f)
            labels.append(label)
        print(f"{sub}: {len(files)} samples")
    return feats, labels


def main() -> None:
    feats, labels = extract_dataset()
    if len(set(labels)) < 2 or len(labels) < 20:
        print("Not enough labelled data (need >=20 patches incl. both classes).")
        print("Drop crops into data/training/{oil,lookalike}/ and re-run.")
        return
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.model_selection import cross_val_score
    import joblib
    X = [[float(f.get(k) or 999) for k in
          ("area_px", "complexity", "contrast_db", "edge_sharpness",
           "homogeneity", "elongation", "dark_fraction_local",
           "dist_land_km")] for f in feats]
    y = np.array(labels)
    model = RandomForestClassifier(n_estimators=300, min_samples_leaf=3,
                                   class_weight="balanced", random_state=7)
    cv = cross_val_score(model, X, y, cv=min(5, int(len(y) // 4)),
                         scoring="f1")
    print("CV F1:", np.round(cv, 3), "mean", round(cv.mean(), 3))
    model.fit(X, y)
    joblib.dump(model, MODEL_PATH)
    print("saved ->", MODEL_PATH)


if __name__ == "__main__":
    main()
