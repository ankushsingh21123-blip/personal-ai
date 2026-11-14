# One-command laptop setup for the Personal AI app (Windows, PowerShell).
#   .\setup-app.ps1            — full setup (idempotent, safe to re-run)
#   .\setup-app.ps1 -DryRun    — print what would happen, change nothing
# What it does: checks Node >= the security floor, installs app
# dependencies, installs the Playwright Chromium binary, creates
# app\.env.local from app\.env.example when missing, checks Ollama, and
# runs the doctor. It never writes a key, never starts the server, and
# never downloads a model unless you ask (-WithOllamaModel).
# Linux/macOS: use setup-app.sh instead. Full guide: SETUP.md.
# HONEST STATUS: this script is UNPROVEN live — it has never run on a
# Windows laptop. The .sh twin was dry-run-tested on the VM. Report
# failures with the exact error; the doctor prints fix commands.
param(
  [switch]$DryRun,
  [switch]$WithOllamaModel
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
function Run-Step([string]$Label, [scriptblock]$Block) {
  if ($DryRun) { Write-Host "[dry-run] $Label"; return }
  Write-Host "+ $Label"
  & $Block
}
Write-Host "Personal AI — setup (root: $Root)"

# 1. Node version floor (same as server.js: CVE-2026-111497 fix).
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error "node not found — install Node 24.22.1+ from https://nodejs.org (see SETUP.md Phase 0)"; exit 1 }
$nodeVer = (node --version).TrimStart('v')
Write-Host "node: $nodeVer"
$parts = $nodeVer.Split('.') | ForEach-Object { [int]$_ }
$ok = ($parts[0] -eq 24 -and ($parts[1] -gt 22 -or ($parts[1] -eq 22 -and $parts[2] -ge 1))) -or
      ($parts[0] -eq 22 -and ($parts[1] -gt 23 -or ($parts[1] -eq 23 -and $parts[2] -ge 4))) -or
      ($parts[0] -eq 26 -and ($parts[1] -gt 12 -or ($parts[1] -eq 12 -and $parts[2] -ge 1)))
if (-not $ok) { Write-Error "Node $nodeVer is below the security floor (>=24.22.1, >=22.23.4 or >=26.12.1)"; exit 1 }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Write-Error "npm not found — install it with Node"; exit 1 }

# 2. Dependencies (app folder).
Run-Step "npm --prefix $Root\app install" { npm --prefix "$Root\app" install --no-audit --no-fund }

# 3. Playwright Chromium binary.
Run-Step "npx playwright install chromium" { npx --prefix "$Root\app" playwright install chromium }

# 4. .env.local from the example, only when missing. Never overwrites.
$envPath = Join-Path $Root "app\.env.local"
if (Test-Path $envPath) {
  Write-Host ".env.local already exists — leaving it untouched"
} else {
  Run-Step "copy app\.env.example -> app\.env.local" { Copy-Item (Join-Path $Root "app\.env.example") $envPath }
  Write-Host "created app\.env.local from the example — add your keys in the Settings page, or edit the file"
}

# 5. Ollama (optional): report status, pull a model only when asked.
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollama) {
  Write-Host "ollama: installed"
  if ($WithOllamaModel) { Run-Step "ollama pull qwen3:8b" { ollama pull qwen3:8b } }
  else { Write-Host "ollama model: not downloaded (re-run with -WithOllamaModel to pull qwen3:8b, ~5 GB)" }
} else {
  Write-Host "ollama: not installed — optional; the app works with API keys alone. Install from https://ollama.com for the offline local path."
}

# 6. Doctor: verify instead of assuming.
Run-Step "node app\doctor.js" { Push-Location (Join-Path $Root "app"); try { node doctor.js } finally { Pop-Location } }

Write-Host ""
Write-Host "Setup done. Next steps:"
Write-Host "  1. Start the server:  cd app; node server.js"
Write-Host "  2. Open http://127.0.0.1:3100 — the token is in app\.env.local"
Write-Host "  3. Add API keys in Settings (free sources: docs/API-KEYS.md)"
Write-Host "  4. Desktop control: second PowerShell window, cd app, node desktop-agent.js"
Write-Host "  Full guide: SETUP.md"
