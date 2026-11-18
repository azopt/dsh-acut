# dsh-acut UIA probe: resolve the UI Automation element chain under a point.
#
# Runs as a short-lived child process so a slow or hanging accessibility provider
# can never freeze the full-screen selector. Prints one JSON array, innermost
# element first, e.g.
#   [{"x":10,"y":20,"width":300,"height":40,"label":"Session list"}, ...]
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

$items = New-Object System.Collections.ArrayList
try {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Hwnd)
  if (-not $root) { Emit '[]'; exit 0 }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $pt = New-Object System.Windows.Point($X, $Y)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $node = $root
  for ($depth = 0; $depth -lt 10; $depth++) {
    if ($sw.ElapsedMilliseconds -gt 800) { break }
    $child = $walker.GetFirstChild($node)
    $next = $null
    $guard = 0
    while ($child -and $guard -lt 60) {
      if ($sw.ElapsedMilliseconds -gt 800) { break }
      $guard++
      try {
        $r = $child.Current.BoundingRectangle
        if ($r.Width -gt 6 -and $r.Height -gt 6 -and $r.Width -lt 20000 -and $r.Contains($pt)) { $next = $child; break }
      } catch { }
      $child = $walker.GetNextSibling($child)
    }
    if (-not $next) { break }
    $label = ''
    try { $label = [string]$next.Current.Name } catch { }
    if ([string]::IsNullOrWhiteSpace($label)) {
      try { $label = ([string]$next.Current.ControlType.ProgrammaticName) -replace 'ControlType\.', '' } catch { }
    }
    try {
      $rr = $next.Current.BoundingRectangle
      if ($rr.Width -gt 6 -and $rr.Height -gt 6) {
        [void]$items.Add([ordered]@{
          x = [int][Math]::Round($rr.X); y = [int][Math]::Round($rr.Y)
          width = [int][Math]::Round($rr.Width); height = [int][Math]::Round($rr.Height)
          label = $label
        })
      }
    } catch { }
    $node = $next
  }
} catch {
  Emit '[]'
  exit 0
}

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
