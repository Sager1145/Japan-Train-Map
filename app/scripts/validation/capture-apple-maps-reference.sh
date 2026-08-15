#!/usr/bin/env bash
set -euo pipefail

# Reproducible macOS Maps transit-reference matrix for the railway visual
# contract.  Coordinates are intentionally opened without `q`, so Maps has no
# search pin, selected station, route plan, or navigation overlay.

APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT_DIR="$APP_DIR/../outputs/apple-maps-reference"
CAPTURE_REGION="0,33,1512,855"
mkdir -p "$OUTPUT_DIR"

ROWS=(
  "jp-tokyo-city-z13|35.6812|139.7671|13"
  "jp-tokyo-stations-z16|35.6812|139.7671|16"
  "jp-osaka-kansai-z13|34.6937|135.5023|13"
  "jp-kyoto-z14|35.0116|135.7681|14"
  "jp-sapporo-z14|43.0687|141.3508|14"
  "jp-sendai-z14|38.2601|140.8824|14"
  "jp-nagoya-z14|35.1709|136.8815|14"
  "jp-kanazawa-z14|36.5781|136.6486|14"
  "jp-hiroshima-z14|34.3974|132.4758|14"
  "jp-hakata-z14|33.5898|130.4207|14"
  "jp-kobuchizawa-z16|35.8639|138.3161|16"
  "jp-kiyosato-z16|35.9198|138.4367|16"
  "jp-biei-z16|43.5910|142.4611|16"
  "jp-hida-furukawa-z16|36.2368|137.1890|16"
  "tw-taipei-z15|25.0478|121.5170|15"
  "tw-sanying-z15|24.9500|121.3750|15"
  "tw-kaohsiung-z14|22.6273|120.3014|14"
  "hk-kowloon-z14|22.3125|114.1818|14"
  "hk-tuen-mun-z15|22.3910|113.9730|15"
  "hk-tin-shui-wai-z16|22.4580|114.0030|16"
  "hk-island-tram-z16|22.2830|114.1810|16"
)

requested_names=("$@")

for row in "${ROWS[@]}"; do
  IFS="|" read -r name latitude longitude zoom <<<"$row"
  if (( ${#requested_names[@]} )); then
    selected=0
    for requested_name in "${requested_names[@]}"; do
      if [[ "$requested_name" == "$name" ]]; then
        selected=1
        break
      fi
    done
    if (( ! selected )); then
      continue
    fi
  fi
  open -a Maps "http://maps.apple.com/?ll=${latitude},${longitude}&z=${zoom}&t=r"
  osascript -e 'tell application "Maps" to activate'
  osascript \
    -e 'tell application "System Events" to tell process "Maps"' \
    -e 'set position of front window to {0, 33}' \
    -e 'set size of front window to {1512, 855}' \
    -e 'end tell'
  sleep 3
  screencapture -x -o -R"$CAPTURE_REGION" "$OUTPUT_DIR/$name.png"
  echo "$name | $latitude,$longitude | z$zoom | transit"
done
