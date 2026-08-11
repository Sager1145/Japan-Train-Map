#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Whatever `node` is on PATH. Set NODE_BIN to pin a specific runtime:
#   NODE_BIN=/path/to/node ./run-app.sh
# (This used to hardcode one machine's Codex sandbox runtime as the default,
# which meant the checked-in script only described the author's laptop.)
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "${NODE_BIN}" || ! -x "$NODE_BIN" ]]; then
  echo "No Node runtime found on PATH (override with NODE_BIN=/path/to/node)." >&2
  echo "Install Node.js 18+ and run: cd \"$ROOT_DIR/app\" && npm install && npm start" >&2
  exit 1
fi

cd "$ROOT_DIR/app"
exec "$NODE_BIN" server.js
