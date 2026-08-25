"""Fetch + extract the Natural Earth 10 m land shapefile used for land masking."""
from __future__ import annotations

import sys
import zipfile
from pathlib import Path
from urllib.request import urlretrieve

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "data" / "landmask"
URL = "https://naciscdn.org/naturalearth/10m/physical/ne_10m_land.zip"


def main() -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    shp = DEST / "ne_10m_land.shp"
    if shp.exists():
        print("land mask already present:", shp)
        return
    zpath = DEST / "ne_10m_land.zip"
    print("downloading", URL)
    urlretrieve(URL, zpath)
    with zipfile.ZipFile(zpath) as zf:
        zf.extractall(DEST)
    print("extracted ->", shp)


if __name__ == "__main__":
    sys.exit(main())
