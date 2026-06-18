#!/usr/bin/env bash
#
# setup-native.sh — make Electron + native modules (better-sqlite3) usable after
# installing or upgrading either of them.
#
# Why this exists (two recurring traps):
#   1. Electron >= 42 dropped its `postinstall` download script. The prebuilt
#      binary is fetched lazily on first `require('electron')`, but electron-vite
#      reads `path.txt` directly and throws `Electron uninstall` if it is missing.
#      => we must run the `install-electron` bin explicitly.
#   2. better-sqlite3's npm prebuilt is compiled for plain Node's ABI
#      (NODE_MODULE_VERSION 137), but the app and tests run under Electron's node
#      (NODE_MODULE_VERSION 146 for Electron 42). `electron-builder install-app-deps`
#      skips the rebuild when its fingerprint looks unchanged, so we force it with
#      `electron-rebuild -f`. NEVER use `pnpm rebuild better-sqlite3` — that builds
#      for Node's ABI (137), i.e. exactly the wrong one.
#
# Run this after: `pnpm add electron@<v>`, `pnpm add better-sqlite3@<v>`, or any
# time `pnpm dev` / `pnpm test` complains about Electron or NODE_MODULE_VERSION.

set -euo pipefail

# Resolve repo root from this script's location so it works from any cwd.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Mirror fallback: install-electron / electron-rebuild read ELECTRON_MIRROR (and
# npm_config_electron_mirror from .npmrc). Default to npmmirror only if nothing is
# already configured, so non-CN environments are not forced onto the mirror.
if [[ -z "${ELECTRON_MIRROR:-}" ]] && ! grep -q "^electron_mirror=" .npmrc 2>/dev/null; then
  export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  echo "→ ELECTRON_MIRROR not set; defaulting to $ELECTRON_MIRROR"
fi

ELECTRON_VERSION="$(node -p "require('./node_modules/electron/package.json').version")"
echo "→ Electron version: $ELECTRON_VERSION"

# --- Step 1: ensure the Electron binary is present -------------------------------
echo "==> [1/3] Ensuring Electron binary is downloaded..."
if [[ -s node_modules/electron/path.txt ]] && [[ -d node_modules/electron/dist ]]; then
  echo "    Electron binary already present, skipping download."
else
  pnpm exec install-electron
fi

if [[ ! -s node_modules/electron/path.txt ]] || [[ ! -d node_modules/electron/dist ]]; then
  echo "ERROR: Electron binary still missing after install-electron." >&2
  echo "       Check your network / mirror, then re-run." >&2
  exit 1
fi
echo "    OK: $(cat node_modules/electron/path.txt)"

# --- Step 2: force-rebuild native modules against Electron's ABI -----------------
# -f forces a real recompile (bypasses electron-builder's skip-when-unchanged cache).
# No -w filter: rebuilds every native module found, so future native deps are covered.
echo "==> [2/3] Rebuilding native modules against Electron $ELECTRON_VERSION (forced)..."
pnpm exec electron-rebuild -f

# --- Step 3: verify better-sqlite3 loads under Electron's node -------------------
# ELECTRON_RUN_AS_NODE runs the Electron binary as a plain node with Electron's ABI,
# which is exactly how the Agent Service and the test runner load native modules.
echo "==> [3/3] Verifying better-sqlite3 loads under Electron's ABI..."
ELECTRON_RUN_AS_NODE=1 pnpm exec electron -e \
  "require('better-sqlite3'); console.log('    OK: better-sqlite3 loads under Electron ABI')"

echo "✓ Native setup complete. \`pnpm dev\` and \`pnpm test\` should now work."
