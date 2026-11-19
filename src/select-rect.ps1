# dsh-acut native screen selector (Windows / WinForms).
#
# Freezes the whole virtual desktop, shows it full screen, and lets the user frame
# anything on screen. Hovering snaps to what is under the cursor: first the element
# (a window's inner pane / a web page node), then its parents, then the whole window.
# Tab cycles through those levels, Ctrl disables snapping for a free drag.
#
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
  [string]$HintKeys = 'Arrows move / Tab cycle / Ctrl free drag',
  [string]$HintDone = 'Enter confirm / Esc cancel',
  [int]$DimOpacity = 118
)

$ErrorActionPreference = 'Stop'
$PROBE_SCRIPT = Join-Path $PSScriptRoot 'uia-probe.ps1'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ('AcutSnap' -as [type])) {
  Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct AcutRect { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)]
public struct AcutPoint { public int X, Y; }
public static class AcutSnap {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out AcutRect rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out AcutRect rect, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int value, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
}
'@
}

try { [AcutSnap]::SetProcessDPIAware() | Out-Null } catch { }


function Emit($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($vs.Width -lt 2 -or $vs.Height -lt 2) { Emit @{ ok = $false; error = 'no screen' }; exit 3 }

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

function Get-WindowAt([int]$sx, [int]$sy) {
  $script:found = [IntPtr]::Zero
  $script:foundRect = $null
  $script:foundTitle = ''
  $self = $PID
  $cb = [AcutSnap+EnumProc]{
    param($hWnd, $lParam)
    if ([AcutSnap]::IsWindowVisible($hWnd) -eq $false) { return $true }
    if ([AcutSnap]::IsIconic($hWnd)) { return $true }
    $owner = 0
    [void][AcutSnap]::GetWindowThreadProcessId($hWnd, [ref]$owner)
    if ($owner -eq $self) { return $true }
    $r = New-Object AcutRect
    $ok = $false
    try { $ok = ([AcutSnap]::DwmGetWindowAttribute($hWnd, 9, [ref]$r, 16) -eq 0) } catch { $ok = $false }
    if (-not $ok) { if (-not [AcutSnap]::GetWindowRect($hWnd, [ref]$r)) { return $true } }
    $w = $r.Right - $r.Left
    $h = $r.Bottom - $r.Top
    if ($w -lt 40 -or $h -lt 40) { return $true }
    if ($sx -lt $r.Left -or $sx -ge $r.Right -or $sy -lt $r.Top -or $sy -ge $r.Bottom) { return $true }
    $script:found = $hWnd
    $script:foundRect = New-Object System.Drawing.Rectangle($r.Left, $r.Top, $w, $h)
    $len = [AcutSnap]::GetWindowTextLength($hWnd)
    if ($len -gt 0) {
      $sb = New-Object System.Text.StringBuilder ($len + 2)
      [void][AcutSnap]::GetWindowText($hWnd, $sb, $sb.Capacity)
      $script:foundTitle = $sb.ToString()
    }
    return $false
  }
  [void][AcutSnap]::EnumWindows($cb, [IntPtr]::Zero)
  if ($script:found -eq [IntPtr]::Zero) { return $null }
  return @{ hwnd = $script:found; rect = $script:foundRect; title = $script:foundTitle }
}

function Get-ClassOf([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][AcutSnap]::GetClassName($h, $sb, 256)
  return $sb.ToString()
}

function Test-SnapWindow([IntPtr]$h) {
  $cls = Get-ClassOf $h
  if ($cls -match 'IME|MSCTF|Windows\.UI\.Core\.CoreWindow|ApplicationManager|ForegroundStaging') { return $false }
  $cloaked = 0
  try { [void][AcutSnap]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4) } catch { $cloaked = 0 }
  if ($cloaked -ne 0) { return $false }
  return $true
}

# The accessibility walk runs in a child process: a slow or hung provider must
# never freeze the selector. Results are cached per window.
function Start-Probe([long]$hwnd, [int]$sx, [int]$sy) {
  if ($script:probeBanned.ContainsKey($hwnd)) { return }
  $cached = $script:probeCache[$hwnd]
  if ($cached -and $script:probePoint -and [Math]::Abs($sx - $script:probePoint.x) -lt 40 -and [Math]::Abs($sy - $script:probePoint.y) -lt 40) { return }
  if ($script:probe) {
    try { if (-not $script:probe.proc.HasExited) { return } } catch { }
  }
  if (($script:probeLast -ne $null) -and (([DateTime]::Now) - $script:probeLast).TotalMilliseconds -lt 350) { return }
  if (-not (Test-Path $PROBE_SCRIPT)) { return }
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Hwnd {1} -X {2} -Y {3}' -f $PROBE_SCRIPT, $hwnd, $sx, $sy)
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $script:probe = @{ proc = $proc; hwnd = $hwnd }
    $script:probePoint = @{ x = $sx; y = $sy }
    $script:probeLast = [DateTime]::Now
  } catch {
    $script:probeBanned[$hwnd] = $true
  }
}

function Collect-Probe() {
  $p = $script:probe
  if (-not $p) { return $false }
  $done = $false
  try { $done = $p.proc.HasExited } catch { $done = $true }
  if (-not $done) {
    if ((([DateTime]::Now) - $script:probeLast).TotalMilliseconds -gt 1600) {
      try { $p.proc.Kill() } catch { }
      $script:probeBanned[$p.hwnd] = $true
      $script:probe = $null
      return $true
    }
    return $false
  }
  $out = ''
  try { $out = $p.proc.StandardOutput.ReadToEnd() } catch { $out = '' }
  $script:probe = $null
  $parsed = @()
  try {
    if ($out.Trim()) { $parsed = @($out | ConvertFrom-Json) }
  } catch { $parsed = @() }
  if ($parsed.Count -gt 0) { $script:probeCache[$p.hwnd] = $parsed }
  else { $script:probeBanned[$p.hwnd] = $true }
  return $true
}

function Get-Candidates([int]$sx, [int]$sy) {
  $list = New-Object System.Collections.ArrayList
  $win = Get-WindowAt $sx $sy
  if (-not $win) {
    $script:windowHwnd = 0
    return , $list
  }
  if (-not (Test-SnapWindow $win.hwnd)) {
    $script:windowHwnd = 0
    return , $list
  }
  $hwnd = [long]$win.hwnd
  $script:windowHwnd = $hwnd
  $title = $win.title
  if ([string]::IsNullOrWhiteSpace($title)) { $title = 'Window' }
  $cached = $script:probeCache[$hwnd]
  if ($cached) {
    foreach ($c in $cached) {
      if ($c.width -lt 8 -or $c.height -lt 8) { continue }
      if ($sx -lt $c.x -or $sx -ge ($c.x + $c.width) -or $sy -lt $c.y -or $sy -ge ($c.y + $c.height)) { continue }
      $label = [string]$c.label
      if ([string]::IsNullOrWhiteSpace($label)) { $label = $title }
      [void]$list.Add(@{ x = $c.x; y = $c.y; width = $c.width; height = $c.height; label = $label })
    }
  }
  [void]$list.Add(@{ x = $win.rect.X; y = $win.rect.Y; width = $win.rect.Width; height = $win.rect.Height; label = $title })
  Start-Probe $hwnd $sx $sy
  # Drop duplicate rects - accessibility often reports the same box at several levels.
  $seen = @{}
  $out = New-Object System.Collections.ArrayList
  foreach ($item in $list) {
    $key = '{0},{1},{2},{3}' -f $item.x, $item.y, $item.width, $item.height
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    if ($item.width -lt 8 -or $item.height -lt 8) { continue }
    [void]$out.Add($item)
  }
  return , $out
}

if ($Mode -eq 'full') {
  $fullRect = New-Object System.Drawing.Rectangle(0, 0, $vs.Width, $vs.Height)
  $safe = Save-Crop $fullRect
  Emit @{
    ok = $true
    rect = @{ x = ($vs.Left + $safe.X); y = ($vs.Top + $safe.Y); width = $safe.Width; height = $safe.Height }
    file = $Out
  }
  $full.Dispose()
  exit 0
}

$dim = New-Object System.Drawing.Bitmap($full.Width, $full.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$d = [System.Drawing.Graphics]::FromImage($dim)
try {
  $d.DrawImage($full, 0, 0, $full.Width, $full.Height)
  $brushDim = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($DimOpacity, 0, 0, 0))
  try { $d.FillRectangle($brushDim, 0, 0, $dim.Width, $dim.Height) } finally { $brushDim.Dispose() }
} finally {
  $d.Dispose()
}

$script:sel = $null
$script:dragging = $false
$script:pressed = $false
$script:anchor = $null
$script:cancelled = $false
$script:candidates = @()
$script:snapIndex = 0
$script:windowHwnd = 0
$script:probe = $null
$script:probeCache = @{}
$script:probeBanned = @{}
$script:probePoint = $null
$script:probeLast = $null
$script:lastQuery = [DateTime]::MinValue
$script:mouse = New-Object System.Drawing.Point(0, 0)

$font = New-Object System.Drawing.Font('Segoe UI', 9)
$fontBig = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$penBorder = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 36, 122, 245), 2)
$penSnap = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 122, 245, 168), 2)
$penSnap.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
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

# The window is mapped before its first paint, so a default-coloured frame would
# flash for a moment. Paint the dimmed freeze as the background and stay fully
# transparent until that first frame is on screen.
# The window is mapped before its first paint, so a default-coloured frame could
# flash for a moment: give it the dimmed freeze as its background instead, which
# is already on screen in the very first frame.
# (Deliberately NOT using Form.Opacity: a layered window is skipped by GDI screen
# capture, which would also hide it from screenshots taken with this plugin.)
$form.BackColor = [System.Drawing.Color]::Black
$form.BackgroundImage = $dim
$form.BackgroundImageLayout = [System.Windows.Forms.ImageLayout]::Stretch

# NOTE: double buffering is deliberately NOT enabled - a buffered 3440x1440
# fullscreen form repaints unreliably here, the dim layer ends up not being shown.

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

function Snap-RectAt([int]$x, [int]$y) {
  if ($script:candidates.Count -eq 0) { return $null }
  $idx = [Math]::Min($script:snapIndex, $script:candidates.Count - 1)
  $c = $script:candidates[$idx]
  $r = New-Object System.Drawing.Rectangle(
    ($c.x - $vs.Left), ($c.y - $vs.Top), $c.width, $c.height)
  return Clamp-Rect $r
}

function Refresh-Candidates([int]$x, [int]$y, [bool]$force) {
  $now = [DateTime]::Now
  if (-not $force -and ($now - $script:lastQuery).TotalMilliseconds -lt 260) { return }
  $script:lastQuery = $now
  try {
    $script:candidates = Get-Candidates ($vs.Left + $x) ($vs.Top + $y)
  } catch {
    $script:candidates = @()
  }
  if ($script:snapIndex -ge $script:candidates.Count) { $script:snapIndex = 0 }
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

$form.Add_MouseMove({
  param($s, $e)
  $script:mouse = New-Object System.Drawing.Point($e.X, $e.Y)
  if ($script:pressed) {
    $dx = [Math]::Abs($e.X - $script:anchor.X)
    $dy = [Math]::Abs($e.Y - $script:anchor.Y)
    if ($dx -gt 4 -or $dy -gt 4) { $script:dragging = $true }
    if ($script:dragging) {
      Set-Selection $script:anchor.X $script:anchor.Y $e.X $e.Y
      $form.Invalidate()
      return
    }
  }
  # Hover snapping; holding Ctrl gives a free crosshair instead
  $ctrl = ([System.Windows.Forms.Control]::ModifierKeys -band [System.Windows.Forms.Keys]::Control) -eq [System.Windows.Forms.Keys]::Control
  if ($ctrl) {
    $script:candidates = @()
    $form.Invalidate()
    return
  }
  Refresh-Candidates $e.X $e.Y $false
  $form.Invalidate()
})

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
    $form.Close()
    return
  }
  $script:pressed = $true
  $script:dragging = $false
  $script:anchor = New-Object System.Drawing.Point($e.X, $e.Y)
})

$form.Add_MouseUp({
  param($s, $e)
  if (-not $script:pressed) { return }
  $script:pressed = $false
  if ($script:dragging) {
    $script:dragging = $false
    Set-Selection $script:anchor.X $script:anchor.Y $e.X $e.Y
    $form.Invalidate()
    return
  }
  # A plain click accepts the snapped rect and finishes
  Refresh-Candidates $e.X $e.Y $true
  $snap = Snap-RectAt $e.X $e.Y
  if ($snap) {
    $script:sel = $snap
    $form.Close()
    return
  }
  $script:sel = $null
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
    if (-not $script:sel) {
      $snap = Snap-RectAt $script:mouse.X $script:mouse.Y
      if ($snap) { $script:sel = $snap } else { $script:sel = New-Object System.Drawing.Rectangle(0, 0, $vs.Width, $vs.Height) }
    }
    $form.Close()
    return
  }
  if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Tab) {
    if ($script:candidates.Count -gt 0) {
      $script:snapIndex = ($script:snapIndex + 1) % $script:candidates.Count
      $form.Invalidate()
    }
    $e.Handled = $true
    $e.SuppressKeyPress = $true
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
    return
  }
  $snap = $null
  if (-not $script:dragging -and $script:candidates.Count -gt 0) { $snap = Snap-RectAt $script:mouse.X $script:mouse.Y }
  if ($snap) {
    $dest = New-Object System.Drawing.Rectangle($snap.X, $snap.Y, $snap.Width, $snap.Height)
    $g.DrawImage($full, $dest, $dest, [System.Drawing.GraphicsUnit]::Pixel)
    $g.DrawRectangle($penSnap, $snap.X, $snap.Y, $snap.Width, $snap.Height)
    $idx = [Math]::Min($script:snapIndex, $script:candidates.Count - 1)
    $label = [string]$script:candidates[$idx].label
    if ($label.Length -gt 46) { $label = $label.Substring(0, 46) + '...' }
    $caption = ('{0}  ({1} x {2})' -f $label, $snap.Width, $snap.Height)
    $size = $g.MeasureString($caption, $font)
    $bx = $snap.X
    $by = $snap.Y - $size.Height - 6
    if ($by -lt 0) { $by = $snap.Y + 6 }
    $g.FillRectangle($brushLabelBg, $bx, $by, $size.Width + 12, $size.Height + 4)
    $g.DrawString($caption, $font, $brushLabelFg, $bx + 6, $by + 2)
    return
  }
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
})

# The accessibility probe finishes in its own process; pick the result up here.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 160
$timer.Add_Tick({
  if (Collect-Probe) {
    Refresh-Candidates $script:mouse.X $script:mouse.Y $true
    $form.Invalidate()
  }
})
$timer.Start()
$form.Add_FormClosed({ $timer.Stop() })

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
