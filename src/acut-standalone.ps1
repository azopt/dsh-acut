# dsh-acut standalone capture: freeze the screen, let the user frame it, then save
# the PNG, copy it to the clipboard and pin it on screen.
#
# Used by acut-hotkey.ps1 so a capture works even when the Harness window is not
# the active window (browser, another app, the desktop itself).
#
# Pure ASCII on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM).
param(
  [string]$OutDir = '',
  [switch]$NoPin,
  [string]$Hint = '',
  [string]$HintKeys = '',
  [string]$HintDone = ''
)

$ErrorActionPreference = 'Stop'
$trace = Join-Path $env:TEMP 'acut-standalone.trace'
function Trace([string]$m) { try { ('{0}  {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $m) | Add-Content -Path $trace -Encoding ASCII } catch { } }
Trace 'start'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$temp = Join-Path $env:TEMP ('acut-' + [guid]::NewGuid().ToString('N') + '.png')

# Named splatting: an array would bind positionally and silently mislabel the args.
$selArgs = @{ Mode = 'rect'; Out = $temp }
if ($Hint) { $selArgs['Hint'] = $Hint }
if ($HintKeys) { $selArgs['HintKeys'] = $HintKeys }
if ($HintDone) { $selArgs['HintDone'] = $HintDone }

Trace ('selector args: ' + ($selArgs.Keys -join ','))
try {
  & (Join-Path $here 'select-rect.ps1') @selArgs | Out-Null
  Trace 'selector returned'
} catch {
  Trace ('selector failed: ' + $_.Exception.Message)
  exit 1
}

if (-not (Test-Path -LiteralPath $temp)) { Trace 'no output file (cancelled?)'; exit 0 }
Trace ('crop ok: ' + $temp)

if (-not $OutDir) {
  $OutDir = Join-Path ([Environment]::GetFolderPath('MyPictures')) 'DSH Screenshots'
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$dest = Join-Path $OutDir ('shot-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.png')
Move-Item -LiteralPath $temp -Destination $dest -Force

try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  $image = [System.Drawing.Image]::FromFile($dest)
  try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }
} catch {
  # Clipboard may be busy; the file is already saved, so this is not fatal.
}

if (-not $NoPin -and (Test-Path -LiteralPath (Join-Path $here 'pin-window.ps1'))) {
  try {
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', (Join-Path $here 'pin-window.ps1'),
      '-Path', $dest
    ) | Out-Null
  } catch { }
}

[Console]::Out.WriteLine($dest)
exit 0
