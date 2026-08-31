"""Shared test configuration and fixtures."""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


@pytest.fixture()
def store(tmp_path):
    from backend.store import Store
    return Store(tmp_path / "test.db")
