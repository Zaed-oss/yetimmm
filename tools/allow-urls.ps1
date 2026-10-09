<#
 Yetimmm - adds the Worker URL (+ Telegram) to MetaTrader 5 "Allowed URLs" (fixes error 4014).
 MT5 never lets an EA edit this list itself, so this script edits common.ini for you.

 USAGE (Windows):  close MetaTrader 5, then double-click allow-urls.bat
 Optional:         allow-urls.ps1 -Url https://my-worker.example.workers.dev
                   allow-urls.ps1 -CloseMt5            (closes MT5 for you)
                   allow-urls.ps1 -DataFolder "D:\MT5\Data"   (portable / custom data folder)

 The Worker URL is read from the InpBrUrl default in ..\ea\Yetimmm.mq5, so changing the
 Worker there is enough; -Url overrides it. A backup of common.ini is always made.
#>
param(
  [string[]]$Url,
  [string]$DataFolder,
  [switch]$CloseMt5
)
$ErrorActionPreference = 'Stop'

function Get-Origin([string]$u) {
  $u = ([string]$u).Trim().Trim('"')
  if ($u -match '^(https?://[^/\s"]+)') { return $Matches[1] }
  return $null
}

# 1) which URLs
$want = New-Object System.Collections.Generic.List[string]
if ($Url) { foreach ($u in $Url) { $o = Get-Origin $u; if ($o) { $want.Add($o) } } }
else {
  $ea = Join-Path $PSScriptRoot '..\ea\Yetimmm.mq5'
  if (Test-Path $ea) {
    $src = Get-Content -Raw -Path $ea
    if ($src -match 'InpBrUrl\s*=\s*"([^"]+)"') { $o = Get-Origin $Matches[1]; if ($o) { $want.Add($o) } }
  }
}
if ($want.Count -eq 0) { Write-Host 'No Worker URL found. Run again with:  -Url https://your-worker.workers.dev' -ForegroundColor Red; exit 1 }
$want.Add('https://api.telegram.org')

# 2) MT5 must be closed (it rewrites common.ini on exit)
$run = Get-Process -Name terminal64, terminal -ErrorAction SilentlyContinue
if ($run) {
  if ($CloseMt5) {
    $run | ForEach-Object { [void]$_.CloseMainWindow() }
    Start-Sleep -Seconds 5
    Get-Process -Name terminal64, terminal -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
  } else {
    Write-Host 'MetaTrader 5 is running. Close it completely, then run this again (or use -CloseMt5).' -ForegroundColor Yellow
    exit 2
  }
}

# 3) every terminal data folder
$inis = New-Object System.Collections.Generic.List[string]
if ($DataFolder) { $p = Join-Path $DataFolder 'config\common.ini'; if (Test-Path $p) { $inis.Add($p) } }
else {
  $root = Join-Path $env:APPDATA 'MetaQuotes\Terminal'
  if (Test-Path $root) {
    Get-ChildItem -Path $root -Directory | ForEach-Object {
      $p = Join-Path $_.FullName 'config\common.ini'
      if (Test-Path $p) { $inis.Add($p) }
    }
  }
}
if ($inis.Count -eq 0) {
  Write-Host 'common.ini not found. Open MT5 once, close it, then run again - or pass -DataFolder (MT5: File > Open Data Folder).' -ForegroundColor Red
  exit 3
}

foreach ($ini in $inis) {
  $bytes = [IO.File]::ReadAllBytes($ini)
  if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
    $enc = New-Object System.Text.UnicodeEncoding($false, $true); $text = $enc.GetString($bytes, 2, $bytes.Length - 2)
  } elseif ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $enc = New-Object System.Text.UTF8Encoding($true); $text = $enc.GetString($bytes, 3, $bytes.Length - 3)
  } else {
    $enc = New-Object System.Text.UTF8Encoding($false); $text = $enc.GetString($bytes)
  }
  $eol = "`r`n"; if ($text -notmatch "`r`n") { $eol = "`n" }
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($l in ($text -split "`r?`n")) { $lines.Add($l) }

  $sec = -1
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*\[Experts\]\s*$') { $sec = $i; break } }
  if ($sec -lt 0) {
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
    $lines.Add(''); $lines.Add('[Experts]'); $sec = $lines.Count - 1; $lines.Add('')
  }
  $end = $lines.Count
  for ($i = $sec + 1; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*\[') { $end = $i; break } }

  $wrIdx = -1; $urlIdx = -1; $have = @()
  for ($i = $sec + 1; $i -lt $end; $i++) {
    if ($lines[$i] -match '^\s*WebRequest\s*=') { $wrIdx = $i }
    if ($lines[$i] -match '^\s*WebRequestUrl\s*=(.*)$') { $urlIdx = $i; $have = @($Matches[1] -split '[;,]' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
  }
  $merged = New-Object System.Collections.Generic.List[string]
  foreach ($u in ($have + $want)) {
    $dup = $false; foreach ($m in $merged) { if ($m.TrimEnd('/') -ieq $u.TrimEnd('/')) { $dup = $true; break } }
    if (-not $dup) { $merged.Add($u) }
  }
  $urlLine = 'WebRequestUrl=' + ($merged -join ';')

  if ($urlIdx -ge 0) { $lines[$urlIdx] = $urlLine } else { $lines.Insert($end, $urlLine); $end++ }
  if ($wrIdx -ge 0) { $lines[$wrIdx] = 'WebRequest=1' } else { $lines.Insert($end, 'WebRequest=1') }

  Copy-Item -Path $ini -Destination ($ini + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  $out = $enc.GetPreamble() + $enc.GetBytes(($lines -join $eol))
  [IO.File]::WriteAllBytes($ini, $out)
  Write-Host ('OK  ' + $ini) -ForegroundColor Green
  Write-Host ('    ' + $urlLine)
}
Write-Host ''
Write-Host 'Done. Start MetaTrader 5 and check Tools > Options > Expert Advisors:' -ForegroundColor Cyan
Write-Host '"Allow WebRequest for listed URL" must be ticked and list the URLs above.'
Write-Host 'If it is not, add them by hand once (the EA log prints the exact text).'
