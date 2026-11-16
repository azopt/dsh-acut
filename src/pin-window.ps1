param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$MaxWidth = 0,
  [int]$MaxHeight = 0
)

# dsh-acut 贴住屏幕：把一张 PNG 贴成无边框、置顶的小窗口（对标 Snipping Tool 的"贴住屏幕"）。
# 拖拽移动、悬停显示工具条（复制 / 另存为 / 关闭）、双击或 Esc 关闭。
#
# 这个文件必须保存为 UTF-8 with BOM：Windows PowerShell 5.1 在没有 BOM 时按 ANSI 读 .ps1，
# 中文会变成乱码。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not (Test-Path -LiteralPath $Path)) { Write-Error "missing image: $Path"; exit 2 }

$probe = [System.Drawing.Image]::FromFile($Path)
$imageWidth = $probe.Width
$imageHeight = $probe.Height
$probe.Dispose()

$work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$limitWidth = if ($MaxWidth -gt 0) { $MaxWidth } else { [int]($work.Width * 0.62) }
$limitHeight = if ($MaxHeight -gt 0) { $MaxHeight } else { [int]($work.Height * 0.74) }
$fit = [Math]::Min(1.0, [Math]::Min($limitWidth / [double]$imageWidth, $limitHeight / [double]$imageHeight))
$width = [Math]::Max(80, [int]($imageWidth * $fit))
$height = [Math]::Max(60, [int]($imageHeight * $fit))

function New-Brush([string]$hex) {
  return [System.Windows.Media.BrushConverter]::new().ConvertFromString($hex)
}

$window = New-Object System.Windows.Window
$window.WindowStyle = 'None'
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.ResizeMode = 'NoResize'
$window.Width = $width
$window.Height = $height
$window.Left = [Math]::Max(8, $work.Right - $width - 48)
$window.Top = [Math]::Max(8, $work.Top + 72)
$window.Focusable = $true

$card = New-Object System.Windows.Controls.Border
$card.CornerRadius = New-Object System.Windows.CornerRadius(10)
$card.BorderThickness = New-Object System.Windows.Thickness(1)
$card.BorderBrush = New-Brush '#40000000'
$card.Background = New-Brush '#FFFFFFFF'
$card.ClipToBounds = $true

$shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
$shadow.BlurRadius = 20
$shadow.ShadowDepth = 5
$shadow.Opacity = 0.45
$shadow.Color = [System.Windows.Media.Colors]::Black
$card.Effect = $shadow

$grid = New-Object System.Windows.Controls.Grid
$card.Child = $grid

$bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
$bitmap.BeginInit()
$bitmap.CacheOption = 'OnLoad'
$bitmap.CreateOptions = 'IgnoreImageCache'
$bitmap.UriSource = (New-Object System.Uri($Path))
$bitmap.EndInit()
$bitmap.Freeze()

$picture = New-Object System.Windows.Controls.Image
$picture.Source = $bitmap
$picture.Stretch = 'Uniform'
$grid.Children.Add($picture) | Out-Null

$bar = New-Object System.Windows.Controls.StackPanel
$bar.Orientation = 'Horizontal'
$bar.HorizontalAlignment = 'Right'
$bar.VerticalAlignment = 'Top'
$bar.Margin = New-Object System.Windows.Thickness(0, 10, 10, 0)
$bar.Background = New-Brush '#E61A1C22'
$bar.Visibility = 'Collapsed'
$grid.Children.Add($bar) | Out-Null

$status = New-Object System.Windows.Controls.TextBlock
$status.Text = ''
$status.Foreground = New-Brush '#FFE9EAEE'
$status.FontSize = 12
$status.VerticalAlignment = 'Center'
$status.Margin = New-Object System.Windows.Thickness(10, 0, 4, 0)
$bar.Children.Add($status) | Out-Null

function New-Chip([string]$text, [string]$tone) {
  $button = New-Object System.Windows.Controls.Button
  $button.Content = $text
  $button.FontSize = 12
  $button.Margin = New-Object System.Windows.Thickness(4, 4, 0, 4)
  $button.Padding = New-Object System.Windows.Thickness(9, 3, 9, 3)
  $button.Foreground = [System.Windows.Media.Brushes]::White
  $button.Background = if ($tone -eq 'primary') { New-Brush '#FF1677FF' } else { New-Brush '#33FFFFFF' }
  $button.BorderThickness = New-Object System.Windows.Thickness(0)
  $button.Cursor = 'Hand'
  return $button
}

$copyButton = New-Chip '复制' ''
$saveButton = New-Chip '另存为' ''
$closeButton = New-Chip '关闭' 'primary'
$bar.Children.Add($copyButton) | Out-Null
$bar.Children.Add($saveButton) | Out-Null
$bar.Children.Add($closeButton) | Out-Null

$copyButton.Add_Click({
  try {
    $again = [System.Drawing.Image]::FromFile($Path)
    [System.Windows.Forms.Clipboard]::SetImage($again)
    $again.Dispose()
    $status.Text = '已复制'
  } catch {
    $status.Text = '复制失败'
  }
})

$saveButton.Add_Click({
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.SaveFileDialog
    $dialog.Filter = 'PNG 图片 (*.png)|*.png'
    $dialog.DefaultExt = 'png'
    $dialog.AddExtension = $true
    $dialog.OverwritePrompt = $true
    $dialog.FileName = '截图_' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '.png'
    try { $dialog.InitialDirectory = [System.IO.Path]::GetDirectoryName($Path) } catch { }
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      Copy-Item -LiteralPath $Path -Destination $dialog.FileName -Force
      $status.Text = '已另存'
    }
  } catch {
    $status.Text = '另存失败'
  }
})

$closeButton.Add_Click({ $window.Close() })

$card.Add_MouseEnter({ $bar.Visibility = 'Visible' })
$card.Add_MouseLeave({ $bar.Visibility = 'Collapsed' })
$card.Add_MouseLeftButtonDown({
  if ($_.OriginalSource -is [System.Windows.Controls.Button]) { return }
  # Border 不是 Control，没有 MouseDoubleClick：用 ClickCount 判双击。
  if ($_.ClickCount -eq 2) { $window.Close(); return }
  try { $window.DragMove() } catch { }
})
$window.Add_KeyDown({
  if ($_.Key -eq 'Escape') { $window.Close() }
})

$window.Content = $card
$window.Add_Loaded({ $window.Activate() | Out-Null })
[void]$window.ShowDialog()
