# Personal AI — Windows laptop setup (Phase 0–2)
# Owner: Ankush Singh. $0 only. No paid signups, no spending.
# Run this in PowerShell as Ankush (NOT as Administrator unless a step says so).
# Tested on this VM's Linux equivalent 11 Nov 2026; Windows steps follow the
# research file ~/workspace/research/personal-ai-laptop-phone-cloud-2026-11-11.md
# and the vendors' own install docs. Re-check each vendor's docs if a step fails.
#
# What this script does:
#   1. Checks Node 22+, Git, Python, WSL2
#   2. Creates ~/personal-ai (memory, logs, projects, skills) + .gitignore
#   3. Installs Ollama (Windows installer path — see notes below)
#   4. Installs OpenClaw + goose
#   5. Pulls qwen3:8b and tests it
#
# What it does NOT do (Ankush does these by hand, they need his prompts/keys):
#   - Enter the Gemini API key (via the secure form, never pasted in chat)
#   - Create a Telegram bot / link WhatsApp (Phase 4, separate steps)
#   - Create an Oracle Cloud account (Phase 6, only after Phase 5 passes)

$ErrorActionPreference = "Stop"

Write-Host "== Personal AI setup — Phase 0: checks ==" -ForegroundColor Cyan
node --version
npm --version
git --version
python --version
wsl --status

# Node must be 22+. If older, install Node.js 22 LTS first:
#   winget install OpenJS.NodeJS.LTS
# then close and re-open PowerShell and re-run this script.

Write-Host ""
Write-Host "== Phase 0: project folder ==" -ForegroundColor Cyan
$HomeDir = $HOME
$Proj = Join-Path $HomeDir "personal-ai"
New-Item -ItemType Directory -Force -Path $Proj, "$Proj\memory", "$Proj\logs", "$Proj\projects", "$Proj\skills" | Out-Null
Set-Location $Proj
if (-not (Test-Path ".git")) { git init | Out-Null }
@(
  ".env.local",
  "node_modules/",
  ".openclaw/",
  ".npm-global-cache/"
) | Set-Content ".gitignore" -Encoding utf8
Write-Host "Project folder: $Proj"

Write-Host ""
Write-Host "== Phase 1: Ollama (local brain) ==" -ForegroundColor Cyan
Write-Host "If Ollama is not installed yet, download OllamaSetup.exe from https://ollama.com/download and run it,"
Write-Host "then re-run this script. (Windows installer is the supported route; it runs as a service and auto-starts on login.)"
ollama --version
# Big context window for agent/tool use (Ollama default 4096 silently truncates):
[System.Environment]::SetEnvironmentVariable("OLLAMA_CONTEXT_LENGTH", "32768", "User")
$env:OLLAMA_CONTEXT_LENGTH = "32768"
ollama pull qwen3:8b
ollama run qwen3:8b "Say hello in one sentence, then stop."
# If qwen3:8b is too slow on 8 GB RAM, use qwen3:4b instead:
#   ollama pull qwen3:4b

Write-Host ""
Write-Host "== Phase 1b: Gemini free tier (primary brain) ==" -ForegroundColor Cyan
Write-Host "Use the EXISTING key (AI Studio, project AgroX, 'muse-email-triage-2026-11-10', created 10 Nov 2026)."
Write-Host "Put it in .env.local as GEMINI_API_KEY=... via the secure form — NEVER paste it in chat or in this script."
Write-Host "Working model names, verified 10-11 Nov 2026: gemini-3.6-flash, gemini-3.5-flash-lite."
Write-Host "gemini-2.5-flash is GONE for new users (404). gemini-3.8-flash returned 503 (high demand)."
Write-Host "Test (after the key is in .env.local):"
Write-Host '  $env:GEMINI_API_KEY = (Get-Content .env.local | Select-String GEMINI_API_KEY).ToString().Split("=")[1]'
Write-Host '  curl.exe -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=$env:GEMINI_API_KEY" -H "Content-Type: application/json" -d "{\"contents\":[{\"parts\":[{\"text\":\"Say hello in one sentence.\"}]}]}"'

Write-Host ""
Write-Host "== Phase 2: OpenClaw (gateway) ==" -ForegroundColor Cyan
npm install -g openclaw@latest
openclaw --version
openclaw onboard --install-daemon
# During onboarding: pick Quick Start, pick Gemini first (paste the key when asked — it is stored
# in the OS credential store / ~/.openclaw, never in chat), Ollama second.
# Bind the gateway to 127.0.0.1 only — refuse 0.0.0.0 if offered.
# Verify: open http://localhost:18789/ — dashboard loads, gateway RUNNING.

Write-Host ""
Write-Host "== Phase 2b: agent identity + permissions ==" -ForegroundColor Cyan
Copy-Item "$PSScriptRoot\AGENT.md" "$Proj\AGENT.md" -ErrorAction SilentlyContinue
Copy-Item "$PSScriptRoot\permissions.json" "$Proj\permissions.json" -ErrorAction SilentlyContinue
Write-Host "AGENT.md and permissions.json copied into $Proj (if present next to this script)."

Write-Host ""
Write-Host "== Phase 3: goose (coding agent) ==" -ForegroundColor Cyan
Write-Host "Install goose from https://github.com/block/goose/releases (Windows installer / CLI)."
Write-Host "Then configure it:"
Write-Host "  goose configure"
Write-Host "  Provider: ollama  ->  Model: qwen3:8b"
Write-Host "  (or Provider: gemini, if your goose version offers it)"
Write-Host ""
Write-Host "First proof project (must pass before anything else):"
Write-Host "  mkdir $Proj\projects\hello-proof; cd $Proj\projects\hello-proof"
Write-Host '  goose run "Create a small Node.js + Express + SQLite app with one page that says Hello, Ankush, and one API route /api/health that returns {ok:true}. Add a README, a .gitignore that ignores .env.local, and npm test that checks /api/health."'
Write-Host "  npm install; npm test"
Write-Host "Pass mark: npm test passes, app runs on localhost:3000, /api/health returns {`"ok`":true}, .env.local is git-ignored."

Write-Host ""
Write-Host "== Done: Phase 0-2 script complete ==" -ForegroundColor Green
Write-Host "Next: Phase 4 (phone — Telegram first, WhatsApp second on a SPARE number only) is in SETUP.md."
Write-Host "Do NOT link your primary WhatsApp number to the agent (Baileys ban risk)."
