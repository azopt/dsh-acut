# dsh-acut global hotkey helper.
#
# Watches Ctrl+Shift+X system-wide with RegisterHotKey (not a keyboard hook), so
# the key also works while another window is active (browser, editor, the desktop).
#
# - While a Harness window is focused the registration is dropped, so the key
#   reaches the page and the in-app flow (freeze -> annotate -> save) keeps working.
# - Otherwise the OS delivers WM_HOTKEY here and we run acut-standalone.ps1:
#   freeze, frame, save the PNG, copy it to the clipboard and pin it on screen.
#
# RegisterHotKey is delivered to the thread that registered it, so registration,
# the message pump and enable/disable all live on one C# background thread; the
# PowerShell loop only decides whether that thread should hold the key.
#
# Pure ASCII on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM).
param(
  [string]$AppTitleMatch = 'DeepSeek Harness',
  [string]$OutDir = '',
  [string]$LogPath = '',
  [string]$Hint = '',
  [string]$HintKeys = '',
  [string]$HintDone = '',
  [int]$CheckForegroundMs = 250
)

$ErrorActionPreference = 'Stop'

if (-not ('AcutHotkey' -as [type])) {
  Add-Type @'
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

public static class AcutHotkey
{
    private const int WM_HOTKEY = 0x0312;
    private const int WM_QUIT = 0x0012;
    private const int WM_ENABLE = 0x8001;
    private const int WM_DISABLE = 0x8002;
    private const int HOTKEY_ID = 1;
    private const uint MOD_ALT = 0x0001;
    private const uint MOD_CONTROL = 0x0002;
    private const uint MOD_SHIFT = 0x0004;
    private const uint VK_X = 0x58;

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);

    public static volatile int PressCount = 0;
    public static volatile bool Registered = false;
    public static volatile int LastError = 0;

    private static Thread _thread;
    private static uint _threadId = 0;
    private static volatile bool _ready = false;

    public static string ForegroundTitle()
    {
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero) return "";
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        return sb.ToString();
    }

    public static bool Start()
    {
        _thread = new Thread(Pump);
        _thread.IsBackground = true;
        _thread.Name = "acut-hotkey";
        _thread.Start();
        for (int i = 0; i < 200 && !_ready; i++) Thread.Sleep(10);
        return Registered;
    }

    public static void Stop()
    {
        if (_threadId != 0) PostThreadMessage(_threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
    }

    public static void Enable()
    {
        if (_threadId != 0) PostThreadMessage(_threadId, WM_ENABLE, IntPtr.Zero, IntPtr.Zero);
    }

    public static void Disable()
    {
        if (_threadId != 0) PostThreadMessage(_threadId, WM_DISABLE, IntPtr.Zero, IntPtr.Zero);
    }

    private static void Pump()
    {
        _threadId = GetCurrentThreadId();
        Register();
        _ready = true;
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            if (msg.message == WM_HOTKEY)
            {
                PressCount++;
            }
            else if (msg.message == WM_DISABLE)
            {
                if (Registered) { UnregisterHotKey(IntPtr.Zero, HOTKEY_ID); Registered = false; }
            }
            else if (msg.message == WM_ENABLE)
            {
                if (!Registered) Register();
            }
            else
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
        }
        if (Registered) { UnregisterHotKey(IntPtr.Zero, HOTKEY_ID); Registered = false; }
    }

    private static void Register()
    {
        Registered = RegisterHotKey(IntPtr.Zero, HOTKEY_ID, MOD_CONTROL | MOD_SHIFT, VK_X);
        if (!Registered) LastError = Marshal.GetLastWin32Error();
        else LastError = 0;
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

if (-not [AcutHotkey]::Start()) {
  Write-Log ("hotkey registration failed (Ctrl+Shift+X is probably taken), error " + [AcutHotkey]::LastError)
  exit 3
}
Write-Log ("Ctrl+Shift+X registered (released while '" + $AppTitleMatch + "' is focused)")

$script:child = $null
$seen = 0
$script:enabled = $true
$script:awayTicks = 0
$script:lastCheck = [DateTime]::MinValue

try {
  while ($true) {
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

    $count = [AcutHotkey]::PressCount
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

    if ($CheckForegroundMs -gt 0 -and ([DateTime]::UtcNow - $script:lastCheck).TotalMilliseconds -ge $CheckForegroundMs) {
      $script:lastCheck = [DateTime]::UtcNow
      $title = [AcutHotkey]::ForegroundTitle()
      $harnessFocused = [bool]($AppTitleMatch -and $title -like "*$AppTitleMatch*")
      # Re-grab the key only after the Harness has stayed out of focus for two
      # checks in a row: a single transient foreground change during an app switch
      # would otherwise let the helper steal the key from the page.
      if ($harnessFocused) { $script:awayTicks = 0 } else { $script:awayTicks++ }
      $wantEnabled = -not $harnessFocused -and ($script:awayTicks -ge 2 -or -not $harnessFocused -and $script:enabled)
      if (-not $harnessFocused -and $script:awayTicks -lt 2) { $wantEnabled = $script:enabled }
      if ($wantEnabled -ne $script:enabled) {
        if ($wantEnabled) { [AcutHotkey]::Enable(); Write-Log 'hotkey registered (harness not focused)' }
        else { [AcutHotkey]::Disable(); Write-Log 'hotkey released (harness focused)' }
        $script:enabled = $wantEnabled
      }
    }

    Start-Sleep -Milliseconds 15
  }
} finally {
  [AcutHotkey]::Stop()
}
