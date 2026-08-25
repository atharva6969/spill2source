"""Sentinel-1 provider - Copernicus Data Space Ecosystem.

Catalog search works keyless (OData, returns GeoFootprint). Scene download
requires a free CDSE account (OAuth2 password grant, client_id=cdse-public).

Prefers the smaller *_COG.SAFE GRD variant when available.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import datetime, timedelta, timezone

import httpx

log = logging.getLogger("cdse")

ODATA = "https://catalogue.dataspace.copernicus.eu/odata/v1"
TOKEN_URL = ("https://identity.dataspace.copernicus.eu/auth/realms/CDSE/"
             "protocol/openid-connect/token")
UA = "OilSpillAttribution/1.0"


class CdseProvider:
    def __init__(self, store, settings):
        self.store = store
        self.settings = settings
        self.last_poll: float | None = None
        self.error: str | None = None
        self._token: str | None = None
        self._token_exp = 0.0
        self._client = httpx.AsyncClient(headers={"User-Agent": UA},
                                         timeout=httpx.Timeout(60))
        # product_id -> {"pct": float, "mb_done": float} while downloading
        self.download_progress: dict[str, dict] = {}

    async def close(self) -> None:
        await self._client.aclose()

    @property
    def configured(self) -> bool:
        return self.settings.cdse_configured

    # ---- catalog -------------------------------------------------------------
    async def search(self, hours_back: int = 48, top: int = 20) -> list[dict]:
        x0, y0, x1, y1 = self.settings.aoi_bbox
        ring = f"{x0} {y0},{x1} {y0},{x1} {y1},{x0} {y1},{x0} {y0}"
        start = (datetime.now(timezone.utc) - timedelta(hours=hours_back)) \
            .strftime("%Y-%m-%dT%H:%M:%S.000Z")
        filt = (
            "Collection/Name eq 'SENTINEL-1' and contains(Name,'GRDH') and "
            f"OData.CSC.Intersects(area=geography'SRID=4326;POLYGON(({ring}))') and "
            f"ContentDate/Start gt {start}"
        )
        r = await self._client.get(
            f"{ODATA}/Products",
            params={
                "$filter": filt,
                "$orderby": "ContentDate/Start desc",
                "$top": top,
            },
        )
        r.raise_for_status()
        out = []
        for p in r.json().get("value", []):
            out.append({
                "product_id": p["Id"],
                "name": p["Name"],
                "sensed_start": _parse_iso(p["ContentDate"]["Start"]),
                "size_mb": round(p["ContentLength"] / 1e6, 1),
                "footprint": (p.get("GeoFootprint") or {}).get("coordinates"),
                "cog": "_COG" in p["Name"],
            })
        return out

    async def poll_catalog(self) -> list[dict]:
        """Refresh scene catalog into store; returns new scenes."""
        try:
            scenes = await self.search(hours_back=48)
        except Exception as exc:
            self.error = str(exc)
            log.error("catalog search failed: %s", exc)
            return []
        self.error = None
        self.last_poll = time.time()
        fresh = []
        for s in scenes:
            known = self.store.one("SELECT status FROM scenes WHERE product_id=?",
                                   (s["product_id"],))
            self.store.exec(
                """INSERT INTO scenes(product_id,name,sensed_start,size_mb,footprint,status)
                   VALUES(?,?,?,?,?,?)
                   ON CONFLICT(product_id) DO UPDATE SET size_mb=excluded.size_mb""",
                (s["product_id"], s["name"], s["sensed_start"], s["size_mb"],
                 _json(s["footprint"]), "catalogued"),
            )
            if not known:
                fresh.append(s)
        log.info("S1 catalog: %d scenes in last 48 h (%d new)", len(scenes), len(fresh))
        return fresh

    # ---- auth + download -------------------------------------------------------
    async def _get_token(self) -> str:
        if self._token and time.time() < self._token_exp - 60:
            return self._token
        r = await self._client.post(TOKEN_URL, data={
            "grant_type": "password", "client_id": "cdse-public",
            "username": self.settings.cdse_user,
            "password": self.settings.cdse_pass,
        })
        r.raise_for_status()
        tok = r.json()
        self._token = tok["access_token"]
        self._token_exp = time.time() + int(tok.get("expires_in", 600))
        return self._token

    async def download(self, product_id: str, dest_dir=None,
                       progress_cb=None) -> str:
        """Stream a product to data/scenes/<name>.zip. Returns local path."""
        meta = self.store.one("SELECT name FROM scenes WHERE product_id=?",
                              (product_id,))
        if not meta:
            raise RuntimeError("unknown product_id (poll catalog first)")
        base = meta["name"].removesuffix(".SAFE")
        dest = (dest_dir or self.settings.data_dir / "scenes") / f"{base}.zip"
        token = await self._get_token()
        auth = {"Authorization": f"Bearer {token}"}

        # follow redirects manually so the Authorization header is re-attached
        # (catalogue 301s to download.dataspace.copernicus.eu)
        url = f"{ODATA}/Products({product_id})/$value"
        resp = None
        for _ in range(5):
            ctx = self._client.stream("GET", url, headers=auth)
            resp = await ctx.__aenter__()
            if resp.status_code in (301, 302, 303, 307, 308):
                loc = resp.headers.get("location")
                await ctx.__aexit__(None, None, None)
                if not loc:
                    raise RuntimeError("download redirect without location")
                url = loc
                continue
            break

        try:
            resp.raise_for_status()
            total = int(resp.headers.get("content-length", 0))
            done = 0
            self.download_progress[product_id] = {"pct": 0.0, "mb": 0.0}
            with open(dest, "wb") as fh:
                async for chunk in resp.aiter_bytes(1 << 20):
                    fh.write(chunk)
                    done += len(chunk)
                    if total:
                        pct = round(done / total * 100, 1)
                        self.download_progress[product_id] = {
                            "pct": pct, "mb": round(done / 1e6, 1)}
                        if progress_cb and int(pct * 4) % 10 == 0:
                            await progress_cb(product_id, pct)
        finally:
            await ctx.__aexit__(None, None, None)
        self.download_progress.pop(product_id, None)
        return str(dest)

    async def run(self, on_new_scene=None, broadcast=None) -> None:
        """Catalog poll loop."""
        while True:
            fresh = await self.poll_catalog()
            for s in fresh:
                if broadcast:
                    await broadcast({"type": "scene", **s})
                if on_new_scene:
                    asyncio.create_task(on_new_scene(s))
            await asyncio.sleep(self.settings.sat_poll_seconds)


def _parse_iso(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def _json(v):
    import json
    return None if v is None else json.dumps(v)


def parse_product_name(name: str):
    """S1C_IW_GRDH_1SDV_20260824T153122_... -> dict of mission/mode/time."""
    m = re.match(
        r"(S1[ABCD])_(IW|EW|SM)_(GRD[HMS])_(1S(?:[DV][HV]|[HV]))_([\dT]{15})_",
        name)
    if not m:
        return {}
    t = datetime.strptime(m.group(5), "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
    return {"mission": m.group(1), "mode": m.group(2), "product": m.group(3),
            "pols": m.group(4), "start": t.timestamp()}
