"""Train the spill-risk model and persist the prediction grid.

Target: cells with >=1 anthropogenic slick in Cerulean's historical
Sentinel-1 database (2020-2026, Baltic). Features: shore/lane/terminal
distances + live AIS density (see backend/risk/features.py).

Validation: spatially grouped 5-fold CV (longitude bands) - tests whether
the model generalizes to unseen sea areas, which random cell splits would
overstate. Reports ROC AUC per fold, then fits the full model and writes
  data/risk_model.joblib   (model + metadata)
  risk_grid table          (per-cell probability for the map layer)
"""
from __future__ import annotations

import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sklearn.ensemble import RandomForestClassifier          # noqa: E402
from sklearn.metrics import roc_auc_score                    # noqa: E402
from sklearn.model_selection import GroupKFold               # noqa: E402

from backend.config import settings                          # noqa: E402
from backend.store import Store                              # noqa: E402
from backend.detection.sar_preprocess import LandMask        # noqa: E402
from backend.risk import features as F                       # noqa: E402

ANTHRO_CLS = (2, 4, 5, 6, 7, 8)
MODEL_PATH = settings.data_dir / "risk_model.joblib"


def main() -> None:
    store = Store(settings.db_path)
    lons, lats, cell = F.make_grid(settings.aoi_bbox)

    land = LandMask(settings.data_dir / "landmask")
    positions = [(r["lon"], r["lat"]) for r in
                 store.query("SELECT lon,lat FROM ais_positions")]
    slicks = [(r["lon"], r["lat"]) for r in store.query(
        f"SELECT centroid_lon lon, centroid_lat lat FROM hist_slicks "
        f"WHERE cls IN ({','.join(map(str, ANTHRO_CLS))})")]

    print(f"grid {len(lons)}x{len(lats)} cells | {len(positions)} AIS fixes | "
          f"{len(slicks)} historical anthro slicks")
    X, sea, grids = F.build_feature_matrix(lons, lats, cell, land.polys, positions)
    y_grid = F.target_grid(lons, lats, cell, slicks)
    y = y_grid[sea]

    lon_sea = np.meshgrid(lons, lats)[0][sea]
    lat_sea = np.meshgrid(lons, lats)[1][sea]

    pos = int(y.sum())
    print(f"sea cells: {len(y)} | positives (slick ever): {pos} "
          f"({pos / max(len(y), 1) * 100:.1f}%)")
    if pos < 30:
        print("too few positive cells to train")
        return

    # spatial CV: group cells into 1-degree longitude bands
    groups = np.floor(lon_sea).astype(int)
    cv = GroupKFold(n_splits=5)
    aucs = []
    for k, (tr, te) in enumerate(cv.split(X, y, groups)):
        m = RandomForestClassifier(n_estimators=300, min_samples_leaf=5,
                                   class_weight="balanced_subsample",
                                   n_jobs=-1, random_state=7)
        m.fit(X[tr], y[tr])
        p = m.predict_proba(X[te])[:, 1]
        auc = roc_auc_score(y[te], p)
        aucs.append(auc)
        print(f"  fold {k + 1}: AUC {auc:.3f} (n_test={len(te)}, "
              f"pos={int(y[te].sum())})")
    print(f"mean spatial AUC: {np.mean(aucs):.3f}")

    model = RandomForestClassifier(n_estimators=400, min_samples_leaf=5,
                                   class_weight="balanced_subsample",
                                   n_jobs=-1, random_state=7)
    model.fit(X, y)

    # in-sample probabilities for the map layer (X rows are sea cells,
    # row-major over the grid - same order as nonzero(sea))
    prob_grid = np.zeros(sea.shape, dtype=float)
    prob_grid[sea] = model.predict_proba(X)[:, 1]

    # persist model + metadata
    joblib.dump({
        "model": model,
        "features": F.FEATURES,
        "importances": dict(zip(F.FEATURES,
                                model.feature_importances_.round(4))),
        "auc_mean": float(np.mean(aucs)),
        "auc_folds": [float(a) for a in aucs],
        "trained_at": time.time(),
        "n_cells": int(len(y)),
        "n_positive": pos,
        "history": "SkyTruth Cerulean slick_plus 2020-2026 (anthro classes)",
        "cell_deg": cell,
    }, MODEL_PATH)

    # persist grid for the map layer
    store.exec("DELETE FROM risk_grid")
    rows = []
    for iy, ix in zip(*np.nonzero(sea)):
        lon0 = lons[ix] - cell / 2
        lat0 = lats[iy] - cell / 2
        rows.append((round(float(lon0), 4), round(float(lat0), 4),
                     round(float(lon0 + cell), 4), round(float(lat0 + cell), 4),
                     round(float(prob_grid[iy, ix]), 4)))
    store.exec_many(
        "INSERT INTO risk_grid(lon0,lat0,lon1,lat1,p) VALUES(?,?,?,?,?)", rows)
    print(f"saved {MODEL_PATH.name} + {len(rows)} risk cells")


if __name__ == "__main__":
    main()
