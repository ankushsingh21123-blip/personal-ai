#!/usr/bin/env bash
# Cyber checks for Ankush's personal AI app. Run: bash scripts/security-check.sh
# Fails (exit 1) on any Critical/High finding. No network calls except npm audit.
set -u
cd "$(dirname "$0")/.."
FAIL=0
check() { if [ "$1" = "0" ]; then echo "PASS: $2"; else echo "FAIL: $2"; FAIL=1; fi; }

# 1. Secrets are git-ignored
grep -q '^\.env\.local$' .gitignore; check $? ".env.local is in .gitignore"
grep -q 'data/\*\.db' .gitignore; check $? "SQLite DB is in .gitignore"
grep -q '^node_modules/$' .gitignore; check $? "node_modules is in .gitignore"
# 2. No real key committed in TRACKED files (values are never printed).
#    .env.local / data / node_modules / logs are excluded — they are git-ignored
#    by design and hold the local token / DB, never a committed secret.
if grep -rE 'AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|ANKU_TOKEN=[0-9a-f]{10,}' \
    --exclude-dir=node_modules --exclude-dir=data --exclude='*.log' \
    --exclude='.env.local' --exclude='.env' . 2>/dev/null | grep -q .; then
  echo "FAIL: possible secret in tracked files (pattern match — check manually, values not shown)"; FAIL=1
else echo "PASS: no secret pattern in tracked files (excluding git-ignored .env.local/data)"; fi
# 3. Server binds loopback only (code, not comments)
grep -q "HOST = '127.0.0.1'" server.js; check $? "server binds 127.0.0.1 only"
grep -q "listen(PORT, '0.0.0.0'\|listen(PORT, \"0.0.0.0\"" server.js; [ "$?" = "1" ]; check $? "no 0.0.0.0 listen call in server.js"
# 4. No CORS, no eval, no shell exec() — execFile only
grep -q "cors(" server.js; [ "$?" = "1" ]; check $? "no CORS enabled"
grep -qE '\beval\s*\(' server.js brain.js tools.js db.js; [ "$?" = "1" ]; check $? "no eval() in backend"
grep -v '^\s*//' server.js tools.js brain.js | grep -qE '\bexec\s*\('; [ "$?" = "1" ]; check $? "no child_process.exec (shell) in code — execFile only (comments/SQLite db.exec excluded)"
# 5. Auth + rate limit present
grep -q "X-Anku-Token" server.js; check $? "token auth present"
grep -q "rateLimit" server.js; check $? "rate limit present"
grep -q "express.json({ limit: '100kb' })" server.js; check $? "JSON body limit 100kb"
# 6. Tools are allowlist-only (no rm, no sudo in the allowlist)
grep -q "ALLOWED_COMMANDS" tools.js; check $? "shell allowlist (ALLOWED_COMMANDS) present in tools.js"
grep -q "DENIED_PATHS" tools.js; check $? "secret-path deny list present"
# 7. npm audit (High/Critical only) — SKIP (not FAIL) if the audit endpoint is unreachable
if [ -d node_modules ]; then
  AUDIT_OUT=$(npm audit --audit-level=high 2>&1 || true)
  if echo "$AUDIT_OUT" | grep -q "audit endpoint returned an error"; then
    echo "SKIP: npm audit endpoint unreachable from this VM — re-run on the laptop"
  elif echo "$AUDIT_OUT" | grep -qE "found 0 vulnerabilities"; then
    echo "PASS: npm audit: 0 High/Critical vulnerabilities"
  else
    echo "$AUDIT_OUT" | tail -10
    echo "FAIL: npm audit reported High/Critical vulnerabilities (see above)"; FAIL=1
  fi
else echo "SKIP: node_modules not installed — run npm install first"; fi
# 8. .env.local permissions (if present)
if [ -f .env.local ]; then
  PERM=$(stat -c %a .env.local)
  [ "$PERM" = "600" ]; check $? ".env.local permissions are 600 (got $PERM)"
fi
echo "---"
if [ "$FAIL" = "0" ]; then echo "SECURITY CHECKS: ALL PASS"; else echo "SECURITY CHECKS: FAILURES ABOVE"; exit 1; fi
