#!/usr/bin/env python3
"""Download every official input used by build-taiwan-rail-package.py."""

from __future__ import annotations

import argparse
import shutil
import urllib.error
import urllib.request
from pathlib import Path
from typing import Dict, Optional, Sequence


TDX_ROOT = "https://tdx.transportdata.tw/api/basic/v2/Rail"
PTX_ROOT = "https://ptx.transportdata.tw/MOTC/v2/Rail/Metro"

# TGOS currently advertises this legacy resource through data.gov.tw but
# returns HTTP 403 even with a browser user agent and TGOS referer.  The build
# can use the current PTX station coordinates when this optional refinement
# layer is unavailable; all route geometry still comes from official sources.
OPTIONAL_SOURCES = {"tw_lrt_station_open.zip"}


def official_sources() -> Dict[str, str]:
    sources: Dict[str, str] = {}
    for system in ("thsr", "tra"):
        api_system = system.upper()
        for kind, api_kind in (
            ("shape", "Shape"),
            ("station", "Station"),
            ("station_of_line", "StationOfLine"),
        ):
            sources[f"tdx_{system}_{kind}.json"] = (
                f"{TDX_ROOT}/{api_system}/{api_kind}?%24top=1000&%24format=JSON"
            )
    for system in (
        "TRTC",
        "KRTC",
        "TYMC",
        "NTDLRT",
        "TMRT",
        "KLRT",
        "NTMC",
        "NTALRT",
    ):
        for kind, api_kind in (
            ("shape", "Shape"),
            ("station", "Station"),
            ("station_of_line", "StationOfLine"),
        ):
            sources[f"ptx_{system.lower()}_{kind}.json"] = (
                f"{PTX_ROOT}/{api_kind}/{system}?%24top=1000&%24format=JSON"
            )
    sources.update(
        {
            "tw_rail_open.zip": "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/299841E1-714A-40BA-AF4B-D6527EEA2A41/resource/801DECA5-E75E-40A4-816C-1BD6A1F322C9/download",
            "tw_rail_station_open.zip": "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/50508007-F7C7-482B-9959-D178561A0945/resource/6D00CEF8-C64A-4AF4-BF53-94456C6895E8/download",
            "tw_mrt_open.zip": "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/159E4D93-A053-4382-A6BD-9DE6B5C4E19F/resource/9D9CF5D4-EEA3-4E1C-ACB0-ECDBBA27C713/download",
            "tw_lrt_open.zip": "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/E58E306B-37FA-4EF5-82EE-C700F854ED10/resource/5C569FD6-6024-4FF5-86B0-FDAE2B243FF2/download",
            "tw_lrt_station_open.zip": "https://www.tgos.tw/tgos/VirtualDir/Product/d1bd5527-f205-44a7-afaf-e7d9b5d89840/MARK_%E8%BC%95%E8%BB%8C%E6%8D%B7%E9%81%8B%E8%BB%8A%E7%AB%99.zip",
            "alishan_official_11001.zip": "https://data.moa.gov.tw/GetOpenDataFile.aspx?id=754&FileType=DataMore&RID=4656",
            "taipei_metro_official.json": "https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=1139b06e-8128-4a07-8148-f27f038bd8b4",
        }
    )
    return sources


def download(url: str, output: Path) -> None:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 TaiwanRailOfficialBuilder/1.0",
            "Referer": "https://tdx.transportdata.tw/",
        },
    )
    temporary = output.with_suffix(output.suffix + ".tmp")
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            with temporary.open("wb") as stream:
                shutil.copyfileobj(response, stream)
    except urllib.error.HTTPError as error:
        temporary.unlink(missing_ok=True)
        if error.code == 429:
            raise RuntimeError(
                "official API rate limit reached; retry after the TDX/PTX window resets"
            ) from error
        raise
    temporary.replace(output)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, url in official_sources().items():
        output = args.output_dir / filename
        if output.is_file() and not args.force:
            print(f"kept       {output}")
            continue
        try:
            download(url, output)
        except urllib.error.HTTPError as error:
            if filename not in OPTIONAL_SOURCES:
                raise
            print(f"unavailable {output} (official endpoint HTTP {error.code}; optional)")
            continue
        print(f"downloaded {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
