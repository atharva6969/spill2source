"""Central configuration, loaded from .env (with sensible live defaults)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def _bbox(raw: str) -> tuple[float, float, float, float]:
    lon0, lat0, lon1, lat1 = [float(v) for v in raw.split(",")]
    return (lon0, lat0, lon1, lat1)


@dataclass
class Settings:
    # Credentials for Copernicus Data Space Ecosystem (free account)
    cdse_user: str = os.getenv("CDSE_USER", "")
    cdse_pass: str = os.getenv("CDSE_PASS", "")

    aoi_bbox: tuple = field(default_factory=lambda: _bbox(os.getenv("AOI_BBOX", "21.8,58.9,30.6,60.7")))

    ais_poll_seconds: int = int(os.getenv("AIS_POLL_SECONDS", "30"))
    met_refresh_seconds: int = int(os.getenv("MET_REFRESH_SECONDS", "3600"))
    sat_poll_seconds: int = int(os.getenv("SAT_POLL_SECONDS", "600"))

    drift_hours_back: int = int(os.getenv("DRIFT_HOURS_BACK", "18"))
    drift_hours_fwd: int = int(os.getenv("DRIFT_HOURS_FWD", "24"))
    particles: int = int(os.getenv("PARTICLES", "600"))

    data_dir: Path = ROOT / os.getenv("DATA_DIR", "data")
    db_path: Path = ROOT / os.getenv("DB_PATH", "data/app.db")

    # segmenter: 'auto' (U-Net if trained, else heuristic) | 'unet' | 'heuristic'
    detector_mode: str = os.getenv("DETECTOR", "auto")

    # --- physics constants (leeway model) -----------------------------------
    windage_factor: float = 0.03      # 3 % of 10 m wind speed
    windage_deflection_deg: float = 20.0  # right of wind in NH (Ekman/leeway)
    stokes_factor: float = 0.02       # Stokes drift approx from wave data
    diffusion_m2_s: float = 1.5       # horizontal eddy diffusivity
    timestep_s: int = 300             # integration step

    @property
    def cdse_configured(self) -> bool:
        return bool(self.cdse_user and self.cdse_pass)

    def ensure_dirs(self) -> None:
        (self.data_dir / "scenes").mkdir(parents=True, exist_ok=True)
        (self.data_dir / "landmask").mkdir(parents=True, exist_ok=True)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)


settings = Settings()
settings.ensure_dirs()
