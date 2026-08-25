"""Oil vs look-alike scoring.

Two paths:
  1. physics-informed prior score (always available, day-1 operation)
  2. RandomForest trained on labelled SAR spill datasets via train_detector.py
     - used automatically when data/model_rf.joblib exists
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np

FEATURE_ORDER = ["area_km2", "complexity", "contrast_db", "edge_sharpness",
                 "homogeneity", "elongation", "dark_fraction_local",
                 "dist_land_km"]

MODEL_PATH = Path(__file__).resolve().parents[2] / "data" / "model_rf.joblib"


def prior_score(f: dict) -> float:
    """Physics-based oil-likeness in [0,1].

    Oil slicks: large, smooth/homogeneous, sharp-edged, high contrast,
    elongated, far from land, isolated in clean water.
    Look-alikes: small, ragged (biogenic filaments are thin+ragged but very
    elongated), low contrast, soft edges, crowded dark fields, near coast.
    """
    area = f["area_px"] * f.get("pixel_area_km2", 0.01)
    s = 0.0

    # size (log scale, saturating): bigger -> more likely a real slick
    s += _sigmoid((math.log10(max(area, 0.01)) + 1.0) / 1.4) * 0.20
    # contrast: strong damping of backscatter is the primary signature
    s += _sigmoid((f["contrast_db"] - 3.5) / 2.5) * 0.30
    # edge sharpness: man-made films have crisp boundaries
    s += _sigmoid((f["edge_sharpness"] - 1.2) / 1.2) * 0.15
    # homogeneity: mineral oil is smoother than biogenic look-alikes
    s += (f["homogeneity"] - 0.45) / 0.35 * 0.10
    # complexity: compact or smoothly elongated beats ragged
    cx = f["complexity"]
    s += (_sigmoid((6.0 - cx) / 2.0) if cx < 8 else 0.15) * 0.10
    # isolation in clean water
    s += (1.0 - min(f["dark_fraction_local"], 1.0)) * 0.05
    # distance from land (coastal look-alikes, wind shadows near shore)
    dl = f.get("dist_land_km")
    if dl is not None:
        s += _sigmoid((dl - 3.0) / 3.0) * 0.10
    return float(min(max(s, 0.0), 1.0))


def rf_score(features_list: list[dict]) -> list[float] | None:
    if not MODEL_PATH.exists():
        return None
    import joblib
    model = joblib.load(MODEL_PATH)
    X = [_vectorize(f) for f in features_list]
    return [float(p[1]) for p in model.predict_proba(X)]


def score_patches(features_list: list[dict]) -> list[float]:
    probs = rf_score(features_list)
    if probs is not None:
        return probs
    return [prior_score({**f, "pixel_area_km2":
                         f.get("pixel_area_km2", 0.01)}) for f in features_list]


def _vectorize(f: dict) -> list[float]:
    out = []
    for k in FEATURE_ORDER:
        v = f.get(k)
        out.append(999.0 if v is None else float(v))
    return out


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(min(x, 30), -30)))
