# dsh-acut UIA probe: resolve the UI Automation element chain under a point.
#
# Runs as a short-lived child process so a slow or hanging accessibility provider
# can never freeze the full-screen selector. Prints one JSON array, innermost
# element first, e.g.
#   [{"x":10,"y":20,"width":300,"height":40,"label":"Session list"}, ...]
#
# Browsers only build their accessibility tree for a *renderer* window once a
# client actually asks for it, so the probe warms the deepest child window under
# the point (that is where Chromium's web content lives) before walking it.
#
# Pure ASCII on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM).
param(
  [long]$Hwnd = 0,
  [int]$X = 0,
  [int]$Y = 0
)

$ErrorActionPreference = 'Stop'

function Emit($text) {
  [Console]::Out.WriteLine($text)
  [Console]::Out.Flush()
}

if ($Hwnd -eq 0) { Emit '[]'; exit 0 }

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  Emit '[]'
  exit 0
}

if (-not ('AcutProbeNative' -as [type])) {
  Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct AcutProbeRect { public int Left, Top, Right, Bottom; }
public static class AcutProbeNative {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out AcutProbeRect r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
'@
}

function Get-ClassOf([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][AcutProbeNative]::GetClassName($h, $sb, 256)
  return $sb.ToString()
}

# Deepest child window under the point: for Chromium that is the renderer HWND,
# which is exactly the one whose accessibility tree holds the web elements.
function Find-DeepestChild([IntPtr]$parent, [int]$px, [int]$py) {
  $best = [IntPtr]::Zero
  $bestArea = [double]::MaxValue
  $all = New-Object System.Collections.ArrayList
  $cb = [AcutProbeNative+EnumProc]{
    param($h, $p)
    [void]$all.Add($h)
    return $true
  }
  [void][AcutProbeNative]::EnumChildWindows($parent, $cb, [IntPtr]::Zero)
  foreach ($h in $all) {
    if (-not [AcutProbeNative]::IsWindowVisible($h)) { continue }
    $r = New-Object AcutProbeRect
    if (-not [AcutProbeNative]::GetWindowRect($h, [ref]$r)) { continue }
    $w = $r.Right - $r.Left
    $hh = $r.Bottom - $r.Top
    if ($w -lt 8 -or $hh -lt 8) { continue }
    if ($px -lt $r.Left -or $px -ge $r.Right -or $py -lt $r.Top -or $py -ge $r.Bottom) { continue }
    $area = [double]$w * $hh
    if ($area -lt $bestArea) {
      $bestArea = $area
      $best = $h
    }
  }
  return $best
}

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$pt = New-Object System.Windows.Point($X, $Y)
$items = New-Object System.Collections.ArrayList
$budget = [System.Diagnostics.Stopwatch]::StartNew()

function Walk-From([IntPtr]$handle, [int]$maxDepth) {
  if ($handle -eq [IntPtr]::Zero) { return }
  if ($budget.ElapsedMilliseconds -gt 900) { return }
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if (-not $root) { return }
    # Asking for the children is what makes Chromium build the tree lazily.
    try { [void]$root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) } catch { }
    $node = $root
    for ($depth = 0; $depth -lt $maxDepth; $depth++) {
      if ($budget.ElapsedMilliseconds -gt 900) { return }
      $child = $walker.GetFirstChild($node)
      $next = $null
      $guard = 0
      while ($child -and $guard -lt 80) {
        if ($budget.ElapsedMilliseconds -gt 900) { break }
        $guard++
        try {
          $r = $child.Current.BoundingRectangle
          if ($r.Width -gt 4 -and $r.Height -gt 4 -and $r.Width -lt 20000 -and $r.Contains($pt)) { $next = $child; break }
        } catch { }
        $child = $walker.GetNextSibling($child)
      }
      if (-not $next) { return }
      $label = ''
      try { $label = [string]$next.Current.Name } catch { }
      if ([string]::IsNullOrWhiteSpace($label)) {
        try { $label = ([string]$next.Current.ControlType.ProgrammaticName) -replace 'ControlType\.', '' } catch { }
      }
      try {
        $rr = $next.Current.BoundingRectangle
        if ($rr.Width -gt 4 -and $rr.Height -gt 4) {
          [void]$items.Add([ordered]@{
            x = [int][Math]::Round($rr.X); y = [int][Math]::Round($rr.Y)
            width = [int][Math]::Round($rr.Width); height = [int][Math]::Round($rr.Height)
            label = $label
          })
        }
      } catch { }
      $node = $next
    }
  } catch { }
}

# 1) the web/control surface lives in the deepest child window
$child = Find-DeepestChild ([IntPtr]$Hwnd) $X $Y
if ($child -ne [IntPtr]::Zero -and $child -ne [IntPtr]$Hwnd) {
  $cls = Get-ClassOf $child
  Walk-From $child 12
  if ($items.Count -eq 0) {
    # Some apps need a moment after the first ask before the tree fills in.
    Start-Sleep -Milliseconds 350
    Walk-From $child 12
  }
}

# 2) fall back to the top level window (native apps expose their controls here)
if ($items.Count -eq 0) { Walk-From ([IntPtr]$Hwnd) 12 }

# Innermost first, so the selector's index 0 is the tightest region.
$rev = New-Object System.Collections.ArrayList
for ($i = $items.Count - 1; $i -ge 0; $i--) { [void]$rev.Add($items[$i]) }

$parts = New-Object System.Collections.ArrayList
foreach ($it in $rev) {
  $labelJson = ConvertTo-Json -InputObject ([string]$it.label) -Compress
  [void]$parts.Add(('{{"x":{0},"y":{1},"width":{2},"height":{3},"label":{4}}}' -f $it.x, $it.y, $it.width, $it.height, $labelJson))
}
Emit ('[' + ($parts -join ',') + ']')
exit 0
