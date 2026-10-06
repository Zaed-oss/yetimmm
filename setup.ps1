# Yetimmm one-shot setup: GitHub repo + Pages + Cloudflare Worker + Telegram menu button.
# Run from this folder:  powershell -ExecutionPolicy Bypass -File .\setup.ps1
$ErrorActionPreference = "Continue"
Set-Location -LiteralPath $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Step($m) { Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host ""; Write-Host "[X] $m" -ForegroundColor Red; exit 1 }
function Check($what) { if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE)" } }

Step "Checking tools"
$tools = @(
  @("git",  "winget install --id Git.Git -e"),
  @("node", "winget install --id OpenJS.NodeJS.LTS -e"),
  @("gh",   "winget install --id GitHub.cli -e")
)
foreach ($t in $tools) {
  if (-not (Get-Command $t[0] -ErrorAction SilentlyContinue)) {
    Fail "'$($t[0])' not found. Install it with:  $($t[1])   then open a NEW terminal and run this script again."
  }
}

Step "GitHub login"
gh auth status *> $null
if ($LASTEXITCODE -ne 0) { gh auth login -h github.com -p https -w; Check "gh auth login" }
$ghUser = (gh api user --jq .login | Out-String).Trim()
if (-not $ghUser) { Fail "Could not read your GitHub username." }
Write-Host "Logged in as $ghUser"

Step "Your details"
$repo = (Read-Host "Repository name [yetimmm]").Trim()
if (-not $repo) { $repo = "yetimmm" }
$tgId = (Read-Host "Your Telegram numeric user ID (from @userinfobot)").Trim()
if ($tgId -notmatch '^\d+$') { Fail "Telegram ID must be digits only." }
$rev = (Read-Host "Did you REVOKE the old bot token in @BotFather and get a new one? (y/n)").Trim().ToLower()
if ($rev -ne "y") { Fail "Revoke the old token first (BotFather > /mybots > your bot > API Token > Revoke), then rerun." }
$sec = Read-Host "Paste the NEW bot token (hidden)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
if ($token -notmatch '^\d{6,}:[A-Za-z0-9_-]{30,}$') { Fail "That does not look like a bot token." }
try {
  $me = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/getMe" -TimeoutSec 20
  Write-Host "Bot OK: @$($me.result.username)"
} catch { Fail "Telegram rejected the token (revoked or mistyped)." }

$bytes = New-Object byte[] 24
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$bridgeKey = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""

$origin   = "https://$($ghUser.ToLower()).github.io"
$pagesUrl = "$origin/$repo/"

Step "Configuring worker/wrangler.toml"
$tomlPath = Join-Path $PSScriptRoot "worker\wrangler.toml"
$toml = [IO.File]::ReadAllText($tomlPath)
$toml = $toml -replace 'ALLOWED_ORIGIN = ".*"', "ALLOWED_ORIGIN = `"$origin`""
$toml = $toml -replace 'ALLOWED_USERS = ".*"',  "ALLOWED_USERS = `"$tgId`""
[IO.File]::WriteAllText($tomlPath, $toml, $utf8)

Step "Deploying the Cloudflare Worker (a browser window opens for login)"
Push-Location (Join-Path $PSScriptRoot "worker")
npx.cmd --yes wrangler login
Check "wrangler login"
npx.cmd --yes wrangler deploy 2>&1 | Tee-Object -Variable deployOut
Check "wrangler deploy"
$m = [regex]::Match(($deployOut | Out-String), 'https://[A-Za-z0-9._-]+\.workers\.dev')
if ($m.Success) { $workerUrl = $m.Value }
else { $workerUrl = (Read-Host "Paste the workers.dev URL printed above").Trim() }
if ($workerUrl -notmatch '^https://') { Fail "Invalid Worker URL." }

Step "Saving secrets in Cloudflare"
$token     | npx.cmd --yes wrangler secret put BOT_TOKEN
Check "secret BOT_TOKEN"
$bridgeKey | npx.cmd --yes wrangler secret put BRIDGE_KEY
Check "secret BRIDGE_KEY"
Pop-Location

Step "Pointing index.html to the Worker"
$idx = Join-Path $PSScriptRoot "index.html"
$html = [IO.File]::ReadAllText($idx)
$html = $html -replace 'baseUrl:"https://[^"]*"', "baseUrl:`"$workerUrl`""
[IO.File]::WriteAllText($idx, $html, $utf8)

Step "GitHub repository"
gh repo view "$ghUser/$repo" *> $null
if ($LASTEXITCODE -ne 0) {
  gh repo create "$ghUser/$repo" --public
  Check "gh repo create"
} else {
  gh repo edit "$ghUser/$repo" --visibility public --accept-visibility-change-consequences
}
$ok = (Read-Host "This will REPLACE the contents of $ghUser/$repo with this folder. Continue? (y/n)").Trim().ToLower()
if ($ok -ne "y") { Fail "Stopped. Nothing was pushed." }
gh auth setup-git
if (-not (Test-Path (Join-Path $PSScriptRoot ".git"))) { git init -b main | Out-Null }
if (-not (git config user.name))  { git config user.name  $ghUser }
if (-not (git config user.email)) { git config user.email "$ghUser@users.noreply.github.com" }
git remote remove origin *> $null
git remote add origin "https://github.com/$ghUser/$repo.git"
git add -A
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { git commit -m "Yetimmm mini app" | Out-Null }
git branch -M main
git push -u origin main --force
Check "git push"

Step "Enabling GitHub Pages"
gh api -X POST "repos/$ghUser/$repo/pages" -f "source[branch]=main" -f "source[path]=/" *> $null
if ($LASTEXITCODE -ne 0) {
  gh api -X PUT "repos/$ghUser/$repo/pages" -f "source[branch]=main" -f "source[path]=/" *> $null
}

Step "Telegram menu button"
try {
  $body = @{ menu_button = @{ type = "web_app"; text = "Yetimmm"; web_app = @{ url = $pagesUrl } } } | ConvertTo-Json -Depth 5
  Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/setChatMenuButton" -ContentType "application/json" -Body $body -TimeoutSec 20 | Out-Null
  Write-Host "Menu button set."
} catch { Write-Host "Could not set the menu button automatically. Set it in BotFather: Bot Settings > Menu Button > $pagesUrl" -ForegroundColor Yellow }

Step "Worker health check"
Start-Sleep -Seconds 3
try {
  $h = Invoke-RestMethod -Uri $workerUrl -TimeoutSec 20
  if ($h.ok) { Write-Host "Worker is up." -ForegroundColor Green }
} catch { Write-Host "Worker did not answer yet; retry in a minute: $workerUrl" -ForegroundColor Yellow }

Write-Host ""
Write-Host "================ DONE ================" -ForegroundColor Green
Write-Host "Mini App URL : $pagesUrl   (live after ~1-2 minutes)"
Write-Host ""
Write-Host "MT5 > Tools > Options > Expert Advisors > Allow WebRequest, add:"
Write-Host "   $workerUrl"
Write-Host "   https://api.telegram.org"
Write-Host ""
Write-Host "EA inputs:"
Write-Host "   InpBrEnable     = true"
Write-Host "   InpBrUrl        = $workerUrl"
Write-Host "   InpBrKey        = $bridgeKey"
Write-Host "   InpTgToken      = (your NEW token)"
Write-Host "   InpTgAuthorized = $tgId"
Write-Host ""
Write-Host "Keep the bridge key private. It is not saved to any file."
