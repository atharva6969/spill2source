"""Tests for DetectionPipeline U-Net model loading."""
import sys
from pathlib import Path
import pytest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.detection.pipeline import DetectionPipeline  # noqa: E402


def test_unet_loading_import(tmp_path):
    # Mock settings and store
    settings = MagicMock()
    settings.detector_mode = "unet"
    settings.data_dir = tmp_path

    # Create dummy unet_model.pt
    ckpt_path = tmp_path / "unet_model.pt"
    
    import torch
    from backend.detection.unet import UNetSmall
    
    model = UNetSmall(base=16)
    torch.save({'state_dict': model.state_dict(), 'base': 16}, ckpt_path)

    pipeline = DetectionPipeline(store=MagicMock(), settings=settings)
    assert pipeline._unet is None
    assert not pipeline._unet_loaded

    # Run _segmentation_mask to trigger model initialization
    import numpy as np
    dummy_sigma = np.zeros((256, 256), dtype=np.float32)
    dummy_img = np.zeros((256, 256), dtype=np.uint8)
    dummy_sea = np.ones((256, 256), dtype=bool)
    
    # Executing _segmentation_mask should load UNetSmall without NameError
    mask = pipeline._segmentation_mask(dummy_sigma, dummy_img, dummy_sea, pixel_area_km2=0.01)
    assert pipeline._unet_loaded is True
    assert pipeline._unet is not None
