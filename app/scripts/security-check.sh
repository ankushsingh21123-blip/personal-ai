#!/usr/bin/env bash
# Cyber checks for Ankush's personal AI app. Run: bash scripts/security-check.sh
# Fails (exit 1) on any Critical/High finding. No network calls except npm audit.
set -u
cd "$(dirname "$0")/.."
FAIL=0
check() { if [ "$1" = "0" ]; then echo "PASS: $2"; else echo "FAIL: $2"; FAIL=1; fi; }
# All backend modules — every new module must be added here so the eval/exec
# scans cover it. Keep this list in sync with the app folder.
BACKEND="server.js brain.js tools.js freeze.js queue.js routines.js sync.js vision.js screen.js desktop.js phone.js telegram.js whatsapp.js browser.js desktop-agent.js secrets.js settings.js clipboard.js windows.js notify.js replay.js route.js doctor.js"
SECRET_RE='AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|[0-9]{6,}:[A-Za-z0-9_-]{30,}|ANKU_TOKEN=[0-9a-f]{10,}'

# 1. Secrets are git-ignored
grep -q '^\.env\.local$' .gitignore; check $? ".env.local is in .gitignore"
grep -q 'data/\*\.db' .gitignore; check $? "SQLite DB is in .gitignore"
grep -q '^node_modules/$' .gitignore; check $? "node_modules is in .gitignore"
grep -q 'data/wa-auth/' .gitignore; check $? "WhatsApp auth state dir is in .gitignore"
grep -q 'data/shots/' .gitignore; check $? "replay screenshots dir (data/shots/) is in .gitignore"
grep -q 'data/shots/' ../.gitignore; check $? "replay screenshots dir is in the root .gitignore too"
# 2. No real key committed in TRACKED files (values are never printed).
#    .env.local / data / node_modules / logs are excluded — they are git-ignored
#    by design and hold the local token / DB, never a committed secret.
if grep -rE "$SECRET_RE" \
    --exclude-dir=node_modules --exclude-dir=data --exclude='*.log' \
    --exclude='.env.local' --exclude='.env' . 2>/dev/null | grep -q .; then
  echo "FAIL: possible secret in tracked files (pattern match — check manually, values not shown)"; FAIL=1
else echo "PASS: no secret pattern in tracked files (excluding git-ignored .env.local/data)"; fi
# 2b. Staged files: nothing key-shaped may be staged for commit.
if git rev-parse --git-dir >/dev/null 2>&1; then
  if git diff --cached 2>/dev/null | grep -E "^\+[^+]" | grep -qE "$SECRET_RE"; then
    echo "FAIL: possible secret in STAGED changes (git diff --cached) — unstage it before committing"; FAIL=1
  else echo "PASS: no secret pattern in staged changes"; fi
  # 2c. Nothing private is tracked: no .db, wa-auth, or shots in the index.
  if git ls-files 2>/dev/null | grep -qE '\.db(-shm|-wal)?$|wa-auth|data/shots/'; then
    echo "FAIL: private files are tracked by git (.db / wa-auth / shots) — remove them from the index"; FAIL=1
  else echo "PASS: no private files tracked (.db / wa-auth / shots)"; fi
else echo "SKIP: not a git repo — staged/tracked scans skipped"; fi
# 3. Server binds loopback only (code, not comments)
grep -q "HOST = '127.0.0.1'" server.js; check $? "server binds 127.0.0.1 only"
grep -q "listen(PORT, '0.0.0.0'\|listen(PORT, \"0.0.0.0\"" server.js; [ "$?" = "1" ]; check $? "no 0.0.0.0 listen call in server.js"
grep -q "HOST = '127.0.0.1'" desktop-agent.js; check $? "desktop agent binds 127.0.0.1 only"
grep -q "listen(PORT, HOST" desktop-agent.js; check $? "desktop agent listens on HOST (loopback)"
# 4. No CORS, no eval, no shell exec() — execFile only (all backend files;
#    db.js excluded — SQLite db.exec is not a shell call)
grep -q "cors(" server.js; [ "$?" = "1" ]; check $? "no CORS enabled"
grep -qE '\beval\s*\(' $BACKEND; [ "$?" = "1" ]; check $? "no eval() in backend (page.evaluate is a Playwright API, not eval)"
grep -v '^\s*//' $BACKEND | grep -qE '\bexec\s*\('; [ "$?" = "1" ]; check $? "no child_process.exec (shell) in code — execFile/spawn only (comments/SQLite db.exec excluded)"
grep -q "Content-Security-Policy" server.js; check $? "Content-Security-Policy header present"
# 4b. Phase B–E gates present in code
grep -q "WHATSAPP_SPARE_NUMBER_CONFIRMED" whatsapp.js; check $? "whatsapp spare-number confirmation guard present"
grep -q "sensitive" desktop.js phone.js browser.js; check $? "sensitive-action refusal present in desktop/phone/browser"
grep -q "assertNotFrozen\|isFrozen" desktop.js phone.js browser.js queue.js routines.js; check $? "freeze checks present in agent loops"
grep "BROWSER_ACTIONS = " browser.js | grep -qE "submit|send|post"; [ "$?" = "1" ]; check $? "browser action set has no submit/post/send action"
# 4c. Product-expansion gates (14 Nov 2026)
grep -q "looksLikeSecret" telegram.js whatsapp.js; check $? "key-refusal check present in telegram + whatsapp"
grep -q "KEY_REFUSAL" telegram.js whatsapp.js; check $? "key-refusal reply present in telegram + whatsapp"
grep -q "SETTING_VARS" settings.js; check $? "settings allowlist (SETTING_VARS) present"
grep -q "ANKU_TOKEN:" settings.js; [ "$?" = "1" ]; check $? "ANKU_TOKEN is not a settable variable in settings.js"
grep -q "writeEnvUpdates" server.js; check $? "settings writes go through the validated writer"
grep -q "settings/test.*brainRateLimit\|brainRateLimit.*settings/test" server.js; check $? "settings test endpoint is brain-rate-limited"
grep -q "0o600" settings.js replay.js; check $? "600 permissions on .env.local writes and replay screenshots"
grep -q "never synced\|NEVER synced" db.js sync.js server.js; check $? "never-synced tables documented (screenshots/keys stay local)"
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
