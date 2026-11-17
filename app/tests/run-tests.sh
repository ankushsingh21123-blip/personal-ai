#!/usr/bin/env bash
# Run the real tests against a LIVE server. No mocks.
# Usage: bash tests/run-tests.sh
# Serial execution (--test-concurrency=1): test files share one SQLite DB,
# and the freeze tests toggle persisted state — parallel files raced each
# other (frozen-state flakes, 18 Nov 2026). Serial is slower and honest.
# WORKSPACE is scoped to this checkout's root so worktree runs never write
# into another checkout's workspace (download tests, scratch files).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export WORKSPACE="${WORKSPACE:-$REPO_ROOT}"
PORT="${PORT:-3100}"
if [ -f .env.local ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env.local; set +a
fi
export ANKU_TOKEN="${ANKU_TOKEN:-}"
export PORT
# The suite makes >60 API calls/minute against this one test server; raise
# the loopback rate limit for the test run only (production default is 60).
export RATE_LIMIT_PER_MIN=300
# Start server in background
node server.js > /tmp/ankush-ai-test-server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
# Wait for health (no auth needed)
for i in $(seq 1 30); do
  if curl -fsS -m 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${PORT}/api/health"
echo
# Token: server generated one in .env.local on first start if missing
if [ -z "${ANKU_TOKEN:-}" ] && [ -f .env.local ]; then
  ANKU_TOKEN="$(grep -E '^ANKU_TOKEN=' .env.local | cut -d= -f2)"
  export ANKU_TOKEN
fi
node --test --test-concurrency=1 tests/test.js tests/providers.test.js tests/phases.test.js tests/product.test.js tests/cycle.test.js tests/cycle6.test.js
echo "TESTS DONE — server log: /tmp/ankush-ai-test-server.log"
