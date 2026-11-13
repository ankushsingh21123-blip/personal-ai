#!/usr/bin/env bash
# Run the real tests against a LIVE server. No mocks.
# Usage: bash tests/run-tests.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-3100}"
if [ -f .env.local ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env.local; set +a
fi
export ANKU_TOKEN="${ANKU_TOKEN:-}"
export PORT
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
node --test tests/test.js tests/providers.test.js
echo "TESTS DONE — server log: /tmp/ankush-ai-test-server.log"
