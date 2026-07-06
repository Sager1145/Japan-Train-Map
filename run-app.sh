#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="/Users/sager/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "Node runtime not found at: $NODE_BIN" >&2
  echo "Install Node.js 18+ and run: cd \"$ROOT_DIR/app\" && npm install && npm start" >&2
  exit 1
fi

cd "$ROOT_DIR/app"
exec "$NODE_BIN" server.js
