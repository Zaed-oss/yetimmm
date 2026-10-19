# One-command GitHub update (code-only):  powershell -File tools\repo-update.ps1 [-Message "text"]
# Needs ONE-TIME GitHub sign-in:  gh auth login  (GitHub.com > HTTPS > browser). No tokens to create or paste.
param([string]$Message = "update")
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path ".git")) { Write-Host "Not a git clone: nothing to push." -ForegroundColor Red; exit 1 }
$env:GIT_TERMINAL_PROMPT = "0"
git push --dry-run --quiet 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "GitHub is not authenticated. Run once:  gh auth login   then re-run this script." -ForegroundColor Red
  exit 1
}
git add -A
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) { Write-Host "Nothing to commit." -ForegroundColor Yellow; exit 0 }
git commit -m $Message --quiet
git push
if ($LASTEXITCODE -ne 0) { Write-Host "git push failed." -ForegroundColor Red; exit 1 }
Write-Host "Pushed." -ForegroundColor Green
