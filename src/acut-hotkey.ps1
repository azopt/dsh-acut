# dsh-acut global hotkey helper.
#
# Stays resident and watches Ctrl+Shift+X with a low-level keyboard hook, so the
# key also works while another window is active (browser, editor, the desktop).
#
# - When a Harness window is focused the hook lets the key through, so the in-app
#   flow (freeze -> annotate -> save) keeps working exactly as before.
# - Otherwise it swallows the key and runs acut-standalone.ps1: freeze, frame,
#   save the PNG, copy it to the clipboard and pin it on screen.
#
# The hook callback is C#, not a PowerShell script block: a low-level hook callback
# that takes more than ~300ms makes Windows drop the hook, and a script block costs
# that much per keystroke. The C# callback only sets a flag; PowerShell polls it.
#
# Pure ASCII on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM).
param(
  [string]$AppTitleMatch = 'DeepSeek Harness',
  [string]$OutDir = '',
  [string]$LogPath = '',
  [string]$Hint = '',
  [string]$HintKeys = '',
  [string]$HintDone = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

if (-not ('AcutGlobalHook' -as [type])) {
  Add-Type -ReferencedAssemblies 'System.Windows.Forms' @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class AcutGlobalHook
{
    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
    private static HookProc _proc;
    private static IntPtr _hook = IntPtr.Zero;
    private static string _titleMatch = "";

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT { public int vkCode; public int scanCode; public int flags; public int time; public IntPtr dwExtraInfo; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint threadId);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string name);

    public static volatile int PressCount = 0;
    public static volatile bool PassedThrough = false;
    public static int LastError = 0;

    public static bool Start(string titleMatch)
    {
        _titleMatch = titleMatch ?? "";
        _proc = new HookProc(Callback);
        _hook = SetWindowsHookEx(13 /* WH_KEYBOARD_LL */, _proc, GetModuleHandle(null), 0);
        if (_hook == IntPtr.Zero)
        {
            LastError = Marshal.GetLastWin32Error();
            return false;
        }
        return true;
    }

    public static void Stop()
    {
        if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
    }

    private static string ForegroundTitle()
    {
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero) return "";
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        return sb.ToString();
    }

    private static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode < 0) return CallNextHookEx(_hook, nCode, wParam, lParam);
        int code = (int)wParam;
        if (code != 0x100 && code != 0x104) return CallNextHookEx(_hook, nCode, wParam, lParam);

        KBDLLHOOKSTRUCT info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
        if (info.vkCode != 0x58 /* X */) return CallNextHookEx(_hook, nCode, wParam, lParam);

        bool ctrl = (GetAsyncKeyState(0x11) & 0x8000) != 0;
        bool shift = (GetAsyncKeyState(0x10) & 0x8000) != 0;
        if (!ctrl || !shift) return CallNextHookEx(_hook, nCode, wParam, lParam);

        if (_titleMatch.Length > 0)
        {
            string title = ForegroundTitle();
            if (title.IndexOf(_titleMatch, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                PassedThrough = true;
                return CallNextHookEx(_hook, nCode, wParam, lParam);
            }
        }
        PressCount++;
        return (IntPtr)1;  // swallow: this capture is ours
    }
}
'@
}

function Write-Log([string]$message) {
  if (-not $LogPath) { return }
  try {
    ('{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $message) | Add-Content -Path $LogPath -Encoding ASCII
  } catch { }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$standalone = Join-Path $here 'acut-standalone.ps1'

if (-not [AcutGlobalHook]::Start($AppTitleMatch)) {
  Write-Log ("hook failed: " + [AcutGlobalHook]::LastError)
  exit 3
}
Write-Log ("hook ready (app title match: '" + $AppTitleMatch + "')")

$script:child = $null
$seen = 0

try {
  while ($true) {
    [System.Windows.Forms.Application]::DoEvents()
    if ($script:child) {
      $done = $false
      try { $done = $script:child.HasExited } catch { $done = $true }
      if ($done) {
        try {
          $out = $script:child.StandardOutput.ReadToEnd().Trim()
          $err = $script:child.StandardError.ReadToEnd().Trim()
          $line = 'capture finished'
          if ($out) { $line += ': ' + $out }
          if ($err) { $line += ' | stderr: ' + $err.Substring(0, [Math]::Min(300, $err.Length)) }
          Write-Log $line
        } catch { }
        $script:child = $null
      }
    }
    $count = [AcutGlobalHook]::PressCount
    if ($count -ne $seen) {
      $seen = $count
      $running = $false
      if ($script:child) {
        try { $running = -not $script:child.HasExited } catch { $running = $false }
      }
      if ($running) {
        Write-Log 'capture already running, ignored'
      } else {
        try {
          $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $standalone)
          if ($OutDir) { $childArgs += @('-OutDir', $OutDir) }
          if ($Hint) { $childArgs += @('-Hint', $Hint) }
          if ($HintKeys) { $childArgs += @('-HintKeys', $HintKeys) }
          if ($HintDone) { $childArgs += @('-HintDone', $HintDone) }
          $quoted = ($childArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
          $psi = New-Object System.Diagnostics.ProcessStartInfo
          $psi.FileName = 'powershell.exe'
          $psi.Arguments = $quoted
          $psi.UseShellExecute = $false
          $psi.CreateNoWindow = $true
          $psi.RedirectStandardOutput = $true
          $psi.RedirectStandardError = $true
          $script:child = [System.Diagnostics.Process]::Start($psi)
          Write-Log 'capture started'
        } catch {
          Write-Log ("capture failed: " + $_.Exception.Message)
        }
      }
    }
    Start-Sleep -Milliseconds 15
  }
} finally {
  [AcutGlobalHook]::Stop()
}
