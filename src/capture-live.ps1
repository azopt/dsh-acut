# dsh-acut live capture helper (Windows / GDI+).
#
# A long-lived PowerShell process the Host keeps open during a manual
# scrolling capture: starting PowerShell costs ~0.5 s, while one capture in an
# already-warm process costs tens of milliseconds, which is what makes
# "scroll yourself, we keep stitching" feel immediate.
#
# Protocol, one command per line on stdin, one reply line on stdout:
#   cap <x> <y> <w> <h> <png path>   -> "ok"
#   quit                             -> "ok" and exit
#   anything else                    -> "err unknown <cmd>"
#
# Pure ASCII on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI unless the
# file carries a BOM, so non-ASCII comments would break parsing.
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ('AcutLive' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AcutLive {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
}
[AcutLive]::SetProcessDPIAware() | Out-Null

$out = [Console]::Out
$in = [Console]::In

function Send-Reply([string]$text) {
  $out.WriteLine($text)
  $out.Flush()
}

while ($true) {
  $line = $in.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  $parts = $line -split '\s+'
  $cmd = $parts[0]
  if ($cmd -eq 'quit') { Send-Reply 'ok'; break }

  if ($cmd -ne 'cap') { Send-Reply ('err unknown ' + $cmd); continue }

  try {
    $x = [int]$parts[1]; $y = [int]$parts[2]; $w = [int]$parts[3]; $h = [int]$parts[4]
    $path = ($parts[5..($parts.Length - 1)] -join ' ')
    if ($w -lt 1 -or $h -lt 1) { Send-Reply 'err bad-rect'; continue }
    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)), [System.Drawing.CopyPixelOperation]::SourceCopy)
    } finally {
      $g.Dispose()
    }
    try { $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $bmp.Dispose() }
    Send-Reply 'ok'
  } catch {
    Send-Reply ('err ' + $_.Exception.Message.Replace("`r", ' ').Replace("`n", ' '))
  }
}
