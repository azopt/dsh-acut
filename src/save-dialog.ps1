param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$Name = '',
  [string]$InitialDir = ''
)

# dsh-acut "另存为"：弹出系统保存对话框，把 Source 复制到选定路径。
# 输出一行：OK <路径>  或  CANCEL
#
# 必须 UTF-8 with BOM（Windows PowerShell 5.1 无 BOM 时按 ANSI 读，中文会乱码）。

$ErrorActionPreference = 'Stop'
# 让 StdOut 走 UTF-8：否则中文路径回到 Node 那边会变成乱码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $Source)) {
  Write-Output 'ERROR'
  exit 2
}

if ([string]::IsNullOrWhiteSpace($Name)) {
  $Name = '截图_' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '.png'
}

# 一个几乎看不见、但置顶的宿窗：让对话框居中并压在应用窗口上面，
# 否则从后台 PowerShell 弹出来的对话框可能藏在主窗口后面。
$owner = New-Object System.Windows.Forms.Form
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'Manual'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Location = New-Object System.Drawing.Point([int]([System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Width / 2), [int]([System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Height / 2))
$owner.Opacity = 0.01
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Show()
$owner.Activate() | Out-Null

$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Filter = 'PNG 图片 (*.png)|*.png|所有文件 (*.*)|*.*'
$dialog.DefaultExt = 'png'
$dialog.AddExtension = $true
$dialog.OverwritePrompt = $true
$dialog.FileName = $Name
$dialog.Title = '另存为'
if (-not [string]::IsNullOrWhiteSpace($InitialDir) -and (Test-Path -LiteralPath $InitialDir)) {
  $dialog.InitialDirectory = $InitialDir
}

$answer = $dialog.ShowDialog($owner)
if ($answer -eq [System.Windows.Forms.DialogResult]::OK) {
  try {
    Copy-Item -LiteralPath $Source -Destination $dialog.FileName -Force
    Write-Output ('OK ' + $dialog.FileName)
  } catch {
    Write-Output ('ERROR ' + $_.Exception.Message)
  }
} else {
  Write-Output 'CANCEL'
}

$owner.Close()
