#!/usr/bin/env python3
"""Collect Japan railway rebuild inventory artifacts into one stable bundle."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[2]
JP_ROOT = APP_ROOT / "data/raw/railway/jp"
DEFAULT_OUTPUT = JP_ROOT / "rebuild-inventory"

COPY_MAP = {
    "lines/n02-source-line-keys.csv": JP_ROOT / "classification/n02-source-line-keys.csv",
    "lines/n02-line-shape-classification.csv": JP_ROOT / "classification/n02-line-shape-classification.csv",
    "lines/README.md": JP_ROOT / "classification/README.md",
    "stations/n02-station-network.csv": JP_ROOT / "classification/n02-station-network.csv",
    "stations/n02-station-network.json": JP_ROOT / "classification/n02-station-network.json",
    "stations/n02-station-connections.csv": JP_ROOT / "classification/n02-station-connections.csv",
    "stations/n02-station-interchanges.csv": JP_ROOT / "classification/n02-station-interchanges.csv",
    "stations/README.md": JP_ROOT / "classification/STATION_NETWORK.md",
    "colours/n02-official-line-colours.csv": JP_ROOT / "classification/n02-official-line-colours.csv",
    "colours/line-colours.json": JP_ROOT / "colours/line-colours.json",
    "colours/operator-colours.json": JP_ROOT / "colours/operator-colours.json",
    "colours/sources.md": JP_ROOT / "colours/sources.md",
    "evidence/line-shape-overrides.json": JP_ROOT / "classification/line-shape-overrides.json",
    "evidence/network-line-shape-research.json": JP_ROOT / "classification/network-line-shape-research.json",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def csv_rows(path: Path) -> int:
    with path.open(encoding="utf-8-sig", newline="") as source:
        return sum(1 for _row in csv.reader(source)) - 1


def organize(output: Path) -> dict:
    missing = [str(path) for path in COPY_MAP.values() if not path.exists()]
    if missing:
        raise FileNotFoundError("Missing inventory inputs:\n" + "\n".join(missing))

    files = []
    for relative, source in COPY_MAP.items():
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        files.append(
            {
                "path": relative,
                "bytes": destination.stat().st_size,
                "sha256": sha256(destination),
                "source_path": str(source.relative_to(APP_ROOT)),
            }
        )

    counts = {
        "raw_n02_line_keys": csv_rows(output / "lines/n02-source-line-keys.csv"),
        "canonical_lines": csv_rows(output / "lines/n02-line-shape-classification.csv"),
        "operator_stations": csv_rows(output / "stations/n02-station-network.csv"),
        "directed_rail_connections": csv_rows(output / "stations/n02-station-connections.csv"),
        "directed_interchanges": csv_rows(output / "stations/n02-station-interchanges.csv"),
        "line_colour_records": csv_rows(output / "colours/n02-official-line-colours.csv"),
    }
    manifest = {
        "schema_version": 1,
        "bundle": "Japan railway rebuild inventory",
        "counts": counts,
        "files": sorted(files, key=lambda row: row["path"]),
    }
    (output / "MANIFEST.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    readme = f"""# 日本铁路重建资料包

本目录集中保存线路形状分类、公司级车站网络、官方线路颜色及联网核验证据。原始 N02、OSM 和 Apple Maps tiles 体积较大，不复制进本目录；这里保存的是第一阶段可直接用于重建的完整索引和审计结果。

## 覆盖

- N02 原始线路键：**{counts['raw_n02_line_keys']}**
- 规范线路：**{counts['canonical_lines']}**
- 公司级车站：**{counts['operator_stations']}**
- 有向铁路连接：**{counts['directed_rail_connections']}**
- 有向跨公司换乘：**{counts['directed_interchanges']}**
- 线路颜色记录：**{counts['line_colour_records']}**

## 目录

```text
rebuild-inventory/
├── README.md
├── MANIFEST.json
├── lines/       线路分类、主干、支线和 N02 原始键审计
├── stations/    车站实体、站间连接、换乘和车站样式
├── colours/     具体 HEX、权威等级、渲染回退值和来源说明
└── evidence/    线路形状人工覆写及逐条联网研究证据
```

`MANIFEST.json` 记录每个文件的来源路径、字节数和 SHA-256，可用于确认复制完整性。CSV 均为 UTF-8 with BOM，JSON 为 UTF-8。

## 重新生成

```bash
python3 app/scripts/railway/classify-japan-line-shapes.py
python3 app/scripts/railway/build-japan-station-network.py
python3 app/scripts/railway/organize-japan-network-inventory.py
```

颜色字段的严格定义见 `colours/sources.md`；车站身份和连接字段见 `stations/README.md`；线路类别与重建算法路由见 `lines/README.md`。
"""
    (output / "README.md").write_text(readme, encoding="utf-8")
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest = organize(args.output)
    print(
        json.dumps(
            {
                "output": str(args.output.resolve()),
                "files": len(manifest["files"]),
                "counts": manifest["counts"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
