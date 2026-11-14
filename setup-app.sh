#!/usr/bin/env bash
# One-command laptop setup for the Personal AI app (Linux / macOS).
#   bash setup-app.sh            — full setup (idempotent, safe to re-run)
#   bash setup-app.sh --dry-run  — print what would happen, change nothing
# What it does: checks Node >= the security floor, installs app
# dependencies, installs the Playwright Chromium binary, creates
# app/.env.local from app/.env.example when missing (mode 600), checks
# Ollama, and runs the doctor. It never writes a key, never starts the
# server, and never downloads a model unless you ask (--with-ollama-model).
# Windows: use setup-app.ps1 instead. Full guide: SETUP.md.
set -u
DRY_RUN=0
WITH_MODEL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --with-ollama-model) WITH_MODEL=1 ;;
    *) echo "unknown option: $arg (use --dry-run or --with-ollama-model)"; exit 2 ;;
  esac
done
if [ "${DRY_RUN_ENV:-0}" = "1" ]; then DRY_RUN=1; fi
ROOT="$(cd "$(dirname "$0")" && pwd)"
run() {
  if [ "$DRY_RUN" = "1" ]; then echo "[dry-run] $*"; else echo "+ $*"; "$@"; fi
}
fail() { echo "SETUP FAILED: $1"; exit 1; }
echo "Personal AI — setup (root: $ROOT)"

# 1. Node version floor (same as server.js: CVE-2026-111497 fix).
if ! command -v node >/dev/null 2>&1; then fail "node not found — install Node 24.22.1+ from https://nodejs.org (see SETUP.md Phase 0)"; fi
NODE_VER="$(node --version)"
echo "node: $NODE_VER"
if ! node -e "const [a,b,c]=process.versions.node.split('.').map(Number);const ok=(a===24&&(b>22||(b===22&&c>=1)))||(a===22&&(b>23||(b===23&&c>=4)))||(a===26&&(b>12||(b===12&&c>=1)));process.exit(ok?0:1)"; then
  fail "Node $NODE_VER is below the security floor (>=24.22.1, >=22.23.4 or >=26.12.1)"
fi
command -v npm >/dev/null 2>&1 || fail "npm not found — install it with Node"

# 2. Dependencies (app folder).
run npm --prefix "$ROOT/app" install --no-audit --no-fund

# 3. Playwright Chromium binary.
run npx --prefix "$ROOT/app" playwright install chromium

# 4. .env.local from the example, only when missing. Never overwrites.
if [ -f "$ROOT/app/.env.local" ]; then
  echo ".env.local already exists — leaving it untouched"
else
  if [ "$DRY_RUN" = "1" ]; then echo "[dry-run] copy app/.env.example -> app/.env.local (mode 600)"; else
    cp "$ROOT/app/.env.example" "$ROOT/app/.env.local"
    chmod 600 "$ROOT/app/.env.local"
    echo "created app/.env.local from the example (mode 600) — add your keys in the Settings page, or edit the file"
  fi
fi

# 5. Ollama (optional): report status, pull a model only when asked.
if command -v ollama >/dev/null 2>&1; then
  echo "ollama: installed ($(ollama --version 2>/dev/null | head -1))"
  if [ "$WITH_MODEL" = "1" ]; then run ollama pull qwen3:8b; else echo "ollama model: not downloaded (re-run with --with-ollama-model to pull qwen3:8b, ~5 GB)"; fi
else
  echo "ollama: not installed — optional; the app works with API keys alone. Install from https://ollama.com for the offline local path."
fi

# 6. Doctor: verify instead of assuming.
if [ "$DRY_RUN" = "1" ]; then echo "[dry-run] node $ROOT/app/doctor.js"; else
  (cd "$ROOT/app" && node doctor.js) || echo "doctor reported failures above — follow the fix lines, then re-run: node app/doctor.js"
fi

echo ""
echo "Setup done. Next steps:"
echo "  1. Start the server:  cd app && node server.js"
echo "  2. Open http://127.0.0.1:3100 — the token is in app/.env.local"
echo "  3. Add API keys in Settings (free sources: docs/API-KEYS.md)"
echo "  4. Desktop control (Windows laptop): second terminal, cd app, node desktop-agent.js"
echo "  Full guide: SETUP.md"
