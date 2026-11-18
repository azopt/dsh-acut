# dsh-acut native screen selector (Windows / WinForms).
#
# Freezes the whole virtual desktop, shows it full screen, and lets the user
# drag a rectangle over anything on screen (desktop, browser, any app).
# Keyboard: arrows = move by 1px, Shift+arrows = 10px, Alt+arrows = resize,
# Enter = confirm, Esc = cancel, double-click = whole screen.
#
# Called by the Host plugin as:
#   powershell.exe -NoProfile -File select-rect.ps1 -Mode rect -Out <png> -Hint <text>
#
# Prints one JSON line on stdout:
#   {"ok":true,"rect":{"x":..,"y":..,"width":..,"height":..},"file":"..."}
#   {"ok":false,"cancelled":true}
#
# This file is intentionally pure ASCII: Windows PowerShell 5.1 reads .ps1 files
# as ANSI unless they carry a BOM, so non-ASCII comments would corrupt parsing.
# All user-visible Chinese text is passed in from the Host as parameters.
param(
  [string]$Mode = 'rect',
  [string]$Out = '',
  [string]$Hint = 'Drag to select a region',
  [string]$HintKeys = 'Arrows move / Shift x10 / Alt resize',
  [string]$HintDone = 'Enter confirm / Esc cancel',
  [int]$DimOpacity = 118
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ('AcutSelectNative' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AcutSelectNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
}
'@
}

try { [AcutSelectNative]::SetProcessDPIAware() | Out-Null } catch { }

function Emit($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($vs.Width -lt 2 -or $vs.Height -lt 2) { Emit @{ ok = $false; error = 'no screen' }; exit 3 }

# Freeze the desktop BEFORE the window appears, so the overlay is not in its own picture.
$full = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$grab = [System.Drawing.Graphics]::FromImage($full)
try {
  $grab.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $full.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
} finally {
  $grab.Dispose()
}

function Save-Crop([System.Drawing.Rectangle]$rect) {
  $safe = New-Object System.Drawing.Rectangle(
    [Math]::Max(0, $rect.X), [Math]::Max(0, $rect.Y),
    [Math]::Max(1, [Math]::Min($rect.Width, $full.Width - [Math]::Max(0, $rect.X))),
    [Math]::Max(1, [Math]::Min($rect.Height, $full.Height - [Math]::Max(0, $rect.Y))))
  $crop = $full.Clone($safe, $full.PixelFormat)
  try { $crop.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $crop.Dispose() }
  return $safe
}

$fullRect = New-Object System.Drawing.Rectangle(0, 0, $vs.Width, $vs.Height)

if ($Mode -eq 'full') {
  $safe = Save-Crop $fullRect
  Emit @{
    ok = $true
    rect = @{ x = ($vs.Left + $safe.X); y = ($vs.Top + $safe.Y); width = $safe.Width; height = $safe.Height }
    file = $Out
  }
  $full.Dispose()
  exit 0
}

# Dim layer: one darkened copy of the freeze, drawn as the base of every paint.
$dim = New-Object System.Drawing.Bitmap($full.Width, $full.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$d = [System.Drawing.Graphics]::FromImage($dim)
try {
  $d.DrawImage($full, 0, 0, $full.Width, $full.Height)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($DimOpacity, 0, 0, 0))
  try { $d.FillRectangle($brush, 0, 0, $dim.Width, $dim.Height) } finally { $brush.Dispose() }
} finally {
  $d.Dispose()
}

$script:sel = $null
$script:dragging = $false
$script:anchor = $null
$script:result = $null
$script:cancelled = $false

$font = New-Object System.Drawing.Font('Segoe UI', 9)
$fontBig = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$penBorder = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 36, 122, 245), 2)
$penGuide = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, 255, 255, 255), 1)
$brushLabelBg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 30, 30, 34))
$brushLabelFg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$brushHintBg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 24, 24, 28))

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Bounds = New-Object System.Drawing.Rectangle($vs.Left, $vs.Top, $vs.Width, $vs.Height)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.Cursor = [System.Windows.Forms.Cursors]::Cross
$form.KeyPreview = $true
$form.Text = 'ACut'

# Control.DoubleBuffered is public to read but protected to set, so reach it by reflection.
try {
  $flags = [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic
  $pi = [System.Windows.Forms.Control].GetProperty('DoubleBuffered', $flags)
  if ($pi) { $pi.SetValue($form, $true) }
} catch {
  # Without double buffering it still works, the drag just flickers a little.
}

function Clamp-Rect([System.Drawing.Rectangle]$r) {
  $x = [Math]::Max(0, [Math]::Min($r.X, $vs.Width - 1))
  $y = [Math]::Max(0, [Math]::Min($r.Y, $vs.Height - 1))
  $w = [Math]::Max(1, [Math]::Min($r.Width, $vs.Width - $x))
  $h = [Math]::Max(1, [Math]::Min($r.Height, $vs.Height - $y))
  return New-Object System.Drawing.Rectangle($x, $y, $w, $h)
}

function Set-Selection([int]$x1, [int]$y1, [int]$x2, [int]$y2) {
  $left = [Math]::Min($x1, $x2)
  $top = [Math]::Min($y1, $y2)
  $w = [Math]::Abs($x2 - $x1)
  $h = [Math]::Abs($y2 - $y1)
  if ($w -lt 1 -or $h -lt 1) { return }
  $script:sel = Clamp-Rect (New-Object System.Drawing.Rectangle($left, $top, $w, $h))
}

function Nudge([string]$key, [bool]$shift, [bool]$alt) {
  if (-not $script:sel) { return }
  $r = $script:sel
  $step = 1
  if ($shift) { $step = 10 }
  if (-not $alt) {
    switch ($key) {
      'Left' { $r.X -= $step }
      'Right' { $r.X += $step }
      'Up' { $r.Y -= $step }
      'Down' { $r.Y += $step }
      default { return }
    }
    $r.X = [Math]::Max(0, [Math]::Min($r.X, $vs.Width - $r.Width))
    $r.Y = [Math]::Max(0, [Math]::Min($r.Y, $vs.Height - $r.Height))
    $script:sel = $r
  } else {
    $w = $r.Width
    $h = $r.Height
    switch ($key) {
      'Left' { $w -= $step }
      'Right' { $w += $step }
      'Up' { $h -= $step }
      'Down' { $h += $step }
      default { return }
    }
    $w = [Math]::Max(8, [Math]::Min($w, $vs.Width - $r.X))
    $h = [Math]::Max(8, [Math]::Min($h, $vs.Height - $r.Y))
    $script:sel = New-Object System.Drawing.Rectangle($r.X, $r.Y, $w, $h)
  }
  $form.Invalidate()
}

$form.Add_MouseDown({
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
    $script:cancelled = $true
    $form.Close()
    return
  }
  if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
  if ($e.Clicks -ge 2) {
    $script:sel = New-Object System.Drawing.Rectangle(0, 0, $vs.Width, $vs.Height)
    $form.Invalidate()
    return
  }
  $script:dragging = $true
  $script:anchor = New-Object System.Drawing.Point($e.X, $e.Y)
  $script:sel = $null
  $form.Invalidate()
})

$form.Add_MouseMove({
  param($s, $e)
  if (-not $script:dragging) { return }
  Set-Selection $script:anchor.X $script:anchor.Y $e.X $e.Y
  $form.Invalidate()
})

$form.Add_MouseUp({
  param($s, $e)
  if (-not $script:dragging) { return }
  $script:dragging = $false
  Set-Selection $script:anchor.X $script:anchor.Y $e.X $e.Y
  $form.Invalidate()
})

$form.Add_KeyDown({
  param($s, $e)
  if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
    $script:cancelled = $true
    $form.Close()
    return
  }
  if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Enter) {
    if (-not $script:sel) { $script:sel = New-Object System.Drawing.Rectangle(0, 0, $vs.Width, $vs.Height) }
    $form.Close()
    return
  }
  $names = @('Left', 'Right', 'Up', 'Down')
  if ($names -contains $e.KeyCode.ToString()) {
    Nudge $e.KeyCode.ToString() $e.Shift $e.Alt
    $e.Handled = $true
    $e.SuppressKeyPress = $true
  }
})

$form.Add_Paint({
  param($s, $e)
  $g = $e.Graphics
  $g.DrawImage($dim, 0, 0, $vs.Width, $vs.Height)
  $sel = $script:sel
  if ($sel -and $sel.Width -gt 0 -and $sel.Height -gt 0) {
    $dest = New-Object System.Drawing.Rectangle($sel.X, $sel.Y, $sel.Width, $sel.Height)
    $g.DrawImage($full, $dest, $dest, [System.Drawing.GraphicsUnit]::Pixel)
    $g.DrawRectangle($penBorder, $sel.X, $sel.Y, $sel.Width, $sel.Height)
    $text = ('{0} x {1}' -f $sel.Width, $sel.Height)
    $size = $g.MeasureString($text, $fontBig)
    $bx = $sel.X
    $by = $sel.Y - $size.Height - 6
    if ($by -lt 0) { $by = $sel.Y + 6 }
    $g.FillRectangle($brushLabelBg, $bx, $by, $size.Width + 12, $size.Height + 4)
    $g.DrawString($text, $fontBig, $brushLabelFg, $bx + 6, $by + 2)
  } else {
    $cx = [int]($vs.Width / 2)
    $cy = [int]($vs.Height / 2)
    $size1 = $g.MeasureString($Hint, $fontBig)
    $size2 = $g.MeasureString($HintKeys, $font)
    $size3 = $g.MeasureString($HintDone, $font)
    $wBox = [Math]::Max($size1.Width, [Math]::Max($size2.Width, $size3.Width)) + 32
    $hBox = $size1.Height + $size2.Height + $size3.Height + 28
    $bx = $cx - [int]($wBox / 2)
    $by = $cy - [int]($hBox / 2)
    $g.FillRectangle($brushHintBg, $bx, $by, $wBox, $hBox)
    $g.DrawString($Hint, $fontBig, $brushLabelFg, $bx + 16, $by + 10)
    $g.DrawString($HintKeys, $font, $brushLabelFg, $bx + 16, $by + 10 + $size1.Height + 2)
    $g.DrawString($HintDone, $font, $brushLabelFg, $bx + 16, $by + 10 + $size1.Height + $size2.Height + 4)
    $px = [Math]::Max(0, [System.Windows.Forms.Cursor]::Position.X - $vs.Left)
    $py = [Math]::Max(0, [System.Windows.Forms.Cursor]::Position.Y - $vs.Top)
    $g.DrawLine($penGuide, $px, 0, $px, $vs.Height)
    $g.DrawLine($penGuide, 0, $py, $vs.Width, $py)
  }
})

[void]$form.ShowDialog()

if ($script:cancelled -or -not $script:sel) {
  Emit @{ ok = $false; cancelled = $true }
  $full.Dispose(); $dim.Dispose()
  exit 0
}

$safe = Save-Crop $script:sel
Emit @{
  ok = $true
  rect = @{ x = ($vs.Left + $safe.X); y = ($vs.Top + $safe.Y); width = $safe.Width; height = $safe.Height }
  file = $Out
}
$full.Dispose()
$dim.Dispose()
exit 0
