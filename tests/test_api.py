"""API endpoint integration tests using FastAPI TestClient."""
import sys
from pathlib import Path

import pytest
from unittest.mock import patch, MagicMock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402
from backend.store import Store  # noqa: E402


@pytest.fixture()
def client(tmp_path):
    from backend.main import app
    import backend.main as main_mod

    test_store = Store(tmp_path / "test.db")
    main_mod.store = test_store

    # Prevent background tasks from starting during tests. The startup event
    # builds its own System and calls .start(), so patch the class method,
    # not a throwaway instance.
    with patch("backend.scheduler.System.start"):
        with TestClient(app, raise_server_exceptions=False) as c:
            yield c

    main_mod.system = None


def test_status_endpoint(client):
    r = client.get("/api/status")
    assert r.status_code == 200
    data = r.json()
    assert "uptime_s" in data
    assert "ais" in data
    assert "met" in data


def test_vessels_live_empty(client):
    r = client.get("/api/vessels/live")
    assert r.status_code == 200
    data = r.json()
    assert data["type"] == "FeatureCollection"
    assert data["features"] == []


def test_scenes_empty(client):
    r = client.get("/api/scenes")
    assert r.status_code == 200
    assert r.json() == []


def test_slicks_empty(client):
    r = client.get("/api/slicks")
    assert r.status_code == 200
    assert r.json() == []


def test_events_empty(client):
    r = client.get("/api/events")
    assert r.status_code == 200
    assert r.json() == []


def test_slick_detail_404(client):
    r = client.get("/api/slicks/99999")
    assert r.status_code == 404


def test_vessel_track_empty(client):
    r = client.get("/api/vessels/123456789/track")
    assert r.status_code == 200
    data = r.json()
    assert data["mmsi"] == 123456789
    assert data["points"] == []


def test_risk_status(client):
    r = client.get("/api/risk/status")
    assert r.status_code == 200
    data = r.json()
    assert "trained" in data


def test_scan_unknown_product(client):
    r = client.post("/api/scenes/FAKE_ID/scan")
    assert r.status_code == 400


def test_spa_catchall(client):
    r = client.get("/nonexistent/path")
    assert r.status_code in (200, 404)


def test_events_with_limit(client):
    r = client.get("/api/events?limit=5")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_scenes_with_limit(client):
    r = client.get("/api/scenes?limit=2")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_reanalyze_nonexistent_slick(client):
    r = client.post("/api/slicks/99999/analyze")
    assert r.status_code == 404
