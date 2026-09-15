# Runs two SoundBridge instances on this PC for a few seconds:
#   HostPC    - hosts on $Port, receives (muted so nothing is heard twice)
#   LaptopSim - joins 127.0.0.1, shares system audio while playing a quiet test tone
# Screenshots and logs land in dist\e2e. Use it after changing anything in renderer/ or lib/.
param([int]$Port = 47810, [int]$Seconds = 14)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'dist\e2e'
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force $out | Out-Null
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
# VS Code / Electron-hosted terminals set this, which would make electron.exe run as plain Node.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

function Launch($name, $seed, $tone, $x, $life, $shownAs) {
  $env:SB_HOSTNAME = $shownAs
  $env:SB_USER_DATA = Join-Path $out "$name-data"
  $env:SB_SEED_SETTINGS = $seed
  $env:SB_SCREENSHOT = Join-Path $out "$name.png"
  $env:SB_SCREENSHOT_AFTER = ($life - 3) * 1000
  $env:SB_QUIT_AFTER = $life * 1000
  $env:SB_LOG_CONSOLE = '1'
  $env:SB_TONE = $tone
  $env:SB_WINDOW_X = $x
  Start-Process -FilePath $electron -ArgumentList @('.') -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $out "$name.out.log") -RedirectStandardError (Join-Path $out "$name.err.log") -PassThru
}

$hostSeed = "{`"role`":`"host`",`"port`":$Port,`"password`":`"test1234`",`"autoConnect`":true,`"muteIncoming`":true,`"displayName`":`"desk-pc`"}"
$joinSeed = "{`"role`":`"join`",`"address`":`"127.0.0.1`",`"port`":$Port,`"password`":`"test1234`",`"autoConnect`":true,`"shareSystem`":true,`"muteLocal`":false,`"quality`":128000,`"displayName`":`"gaming-laptop`"}"

# Host outlives the joiner so both screenshots show a live session.
$h = Launch 'host' $hostSeed '0' '20' ($Seconds + 4) 'desk-pc'
Start-Sleep -Seconds 2
$j = Launch 'join' $joinSeed '1' '980' $Seconds 'gaming-laptop'
Wait-Process -Id $h.Id, $j.Id -Timeout ($Seconds + 20) -ErrorAction SilentlyContinue
foreach ($p in @($h, $j)) { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } }

foreach ($name in @('host', 'join')) {
  Write-Host "===== $name ====="
  Get-Content (Join-Path $out "$name.out.log")
  $err = Get-Content (Join-Path $out "$name.err.log")
  if ($err) { Write-Host "--- stderr ---"; $err }
}
