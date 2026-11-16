# dsh-acut desktop capture helper (Windows / GDI+).
#
# Called by the Host plugin as: powershell.exe -NoProfile -File capture-screen.ps1 -Mode <mode> ...
# Modes:
#   capture : grab a screen rectangle into a PNG
#   scroll  : grab first, then send one wheel notch at a screen point (scrolling capture)
#   wheel   : only send one wheel notch
#   metrics : print virtual desktop bounds and cursor position as JSON
#
# This file is intentionally pure ASCII: Windows PowerShell 5.1 reads .ps1 files
# as ANSI unless they carry a BOM, so non-ASCII comments would corrupt parsing.
param(
  [string]$Mode = 'capture',
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 0,
  [int]$H = 0,
  [string]$Out = '',
  [int]$PointX = 0,
  [int]$PointY = 0,
  [int]$Ticks = -120,
  [int]$BackX = -1,
  [int]$BackY = -1
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ('DshShotNative' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DshShotNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
}
'@
}
# Without DPI awareness CopyFromScreen returns the DPI-virtualized size, which
# no longer matches the CSS pixels the browser reports.
[DshShotNative]::SetProcessDPIAware() | Out-Null

function Get-VirtualScreen {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  return @{ x = [int]$vs.X; y = [int]$vs.Y; w = [int]$vs.Width; h = [int]$vs.Height }
}

function Invoke-Capture([int]$cx, [int]$cy, [int]$cw, [int]$ch, [string]$file) {
  if ($cw -le 0 -or $ch -le 0) {
    $vs = Get-VirtualScreen
    $cx = $vs.x; $cy = $vs.y; $cw = $vs.w; $ch = $vs.h
  }
  $bmp = New-Object System.Drawing.Bitmap($cw, $ch, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($cx, $cy, 0, 0, (New-Object System.Drawing.Size($cw, $ch)), [System.Drawing.CopyPixelOperation]::SourceCopy)
  } finally {
    $g.Dispose()
  }
  try {
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bmp.Dispose()
  }
}

function Invoke-Wheel([int]$px, [int]$py, [int]$ticks) {
  [DshShotNative]::SetCursorPos($px, $py) | Out-Null
  Start-Sleep -Milliseconds 30
  [DshShotNative]::mouse_event(0x0800, 0, 0, $ticks, [UIntPtr]::Zero)
}

switch ($Mode) {
  'capture' {
    Invoke-Capture $X $Y $W $H $Out
    Write-Output '{"ok":true}'
  }
  'scroll' {
    Invoke-Capture $X $Y $W $H $Out
    Invoke-Wheel $PointX $PointY $Ticks
    if ($BackX -ge 0 -and $BackY -ge 0) { [DshShotNative]::SetCursorPos($BackX, $BackY) | Out-Null }
    Write-Output '{"ok":true}'
  }
  'wheel' {
    Invoke-Wheel $PointX $PointY $Ticks
    if ($BackX -ge 0 -and $BackY -ge 0) { [DshShotNative]::SetCursorPos($BackX, $BackY) | Out-Null }
    Write-Output '{"ok":true}'
  }
  'metrics' {
    $vs = Get-VirtualScreen
    $pos = [System.Windows.Forms.Cursor]::Position
    Write-Output ('{"virtual":{"x":' + $vs.x + ',"y":' + $vs.y + ',"width":' + $vs.w + ',"height":' + $vs.h + '},"cursor":{"x":' + $pos.X + ',"y":' + $pos.Y + '}}')
  }
  default {
    Write-Error "unknown mode: $Mode"
    exit 2
  }
}
