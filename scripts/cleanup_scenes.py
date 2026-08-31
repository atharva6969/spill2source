"""One-shot cleanup: remove extracted SAFE dirs and old scene zips.

Usage:
    python scripts/cleanup_scenes.py              # interactive (shows what would be deleted)
    python scripts/cleanup_scenes.py --apply       # actually delete
    python scripts/cleanup_scenes.py --max-gb 5    # set cache limit (default 10)
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def dir_size_mb(d: Path) -> float:
    return sum(f.stat().st_size for f in d.rglob("*") if f.is_file()) / 1e6


def total_scenes_mb(scenes_dir: Path) -> float:
    total = 0.0
    for item in scenes_dir.iterdir():
        if item.is_file():
            total += item.stat().st_size / 1e6
        elif item.is_dir():
            total += dir_size_mb(item)
    return total


def main():
    parser = argparse.ArgumentParser(description="Clean up Sentinel-1 scene data")
    parser.add_argument("--apply", action="store_true", help="Actually delete files")
    parser.add_argument("--max-gb", type=float, default=10.0,
                        help="Max total scene cache in GB (default: 10)")
    parser.add_argument("--scenes-dir", type=str, default=None,
                        help="Path to scenes directory (default: data/scenes)")
    args = parser.parse_args()

    scenes_dir = Path(args.scenes_dir) if args.scenes_dir else ROOT / "data" / "scenes"
    if not scenes_dir.exists():
        print(f"No scenes directory at {scenes_dir}")
        return

    before_mb = total_scenes_mb(scenes_dir)
    print(f"Scene cache: {before_mb:.0f} MB ({before_mb / 1024:.1f} GB) in {scenes_dir}")
    print(f"Target limit: {args.max_gb:.0f} GB\n")

    # 1. Remove extracted SAFE directories (the big ones)
    safe_dirs = [d for d in scenes_dir.iterdir() if d.is_dir()]
    safe_mb = sum(dir_size_mb(d) for d in safe_dirs)
    print(f"Found {len(safe_dirs)} extracted SAFE dirs ({safe_mb:.0f} MB)")

    if args.apply and safe_dirs:
        for d in safe_dirs:
            print(f"  Removing {d.name} ({dir_size_mb(d):.0f} MB)")
            shutil.rmtree(d, ignore_errors=True)
        print(f"  -> Reclaimed {safe_mb:.0f} MB\n")
    else:
        print(f"  -> Would reclaim {safe_mb:.0f} MB (use --apply)\n")

    # 2. If still over limit, remove oldest zips
    after_mb = total_scenes_mb(scenes_dir)
    max_bytes = args.max_gb * 1024 * 1024 * 1024
    if after_mb * 1e6 > max_bytes:
        zips = sorted(scenes_dir.glob("*.zip"), key=lambda f: f.stat().st_mtime)
        excess_mb = after_mb - args.max_gb * 1024
        print(f"Still {after_mb:.0f} MB — need to remove ~{excess_mb:.0f} MB more")
        removed = 0.0
        for f in zips:
            if removed >= excess_mb:
                break
            sz_mb = f.stat().st_size / 1e6
            if args.apply:
                print(f"  Removing {f.name} ({sz_mb:.0f} MB)")
                f.unlink()
            else:
                print(f"  Would remove {f.name} ({sz_mb:.0f} MB)")
            removed += sz_mb

    final_mb = total_scenes_mb(scenes_dir) if args.apply else before_mb
    print(f"\nDone. {'Final' if args.apply else 'Current'} cache: {final_mb:.0f} MB")


if __name__ == "__main__":
    main()
