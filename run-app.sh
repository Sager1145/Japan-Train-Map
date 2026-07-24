#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="/Users/sager/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

# The pinned runtime above is machine-specific; fall back to whatever node is
# on PATH so the script works on any machine with Node 18+ installed.
if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi

if [[ -z "${NODE_BIN}" || ! -x "$NODE_BIN" ]]; then
  echo "No Node runtime found (checked the pinned path and PATH)." >&2
  echo "Install Node.js 18+ and run: cd \"$ROOT_DIR/app\" && npm install && npm start" >&2
  exit 1
fi

cd "$ROOT_DIR/app"
exec "$NODE_BIN" server.js
