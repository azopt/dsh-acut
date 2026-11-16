# Screenshot

截图，做在 Harness 里：同一套抓屏引擎同时服务「热键 UI」和「Agent 工具」。

## 怎么用

- **热键**：`Ctrl+Shift+X`（macOS 为 `⌘+Shift+X`），在 Harness 页面里按下即可。
  画面立即冻结，拖动拉出选区 → 工具条出现 → 标注 → `Enter`/`完成`。
- **工具条**：矩形、椭圆、箭头、画笔、文字、马赛克（六种标注）· 四种颜色 · 撤销 ·
  滚屏截图 · 重截 · 取消 · 完成。选区有八向手柄可调大小。
- **完成**：PNG 存到 `%USERPROFILE%\Pictures\DSH Screenshots`（可在插件配置里改 `outputDir`），
  同时复制到剪贴板，可以直接粘进对话；保存路径显示在提示条里。
- **滚动截图**：先拉出选区，再点工具条上带文字的 **「↕ 滚动截图」** 按钮（或按 `S`）。
  进入后页面保持原样、可以正常浏览：选区周围是闪烁的虚线框，下方浮动一条进度条
  （帧数 · 拼好的尺寸 · 取消 · 完成）。
  **滚动完全由你控制**：鼠标滚轮上下、`Shift`+滚轮或触控板左右、拖滚动条、
  按住鼠标拖动内容（抓住内容拖）都可以；插件每 240ms 抓一帧，按重叠像素自动接到
  上/下/左/右任意一边，滚回来再滚过去也不会重复。
  按 `完成`/`Enter` **直接收工保存**：长图落盘到截图目录、同时进剪贴板，
  提示条会显示路径和尺寸（不走标注界面，避免长图再进入选区那套交互）；
  想直接贴到屏幕上就按 `钉住`。

  滚动过程中，选区旁边会浮一个**预览小窗**（「拼接预览 · 宽×高」）：
  整张拼接图按比例缩进一张卡片（宽 ≤300、高 ≤380，`object-fit: contain`），
  所以长图会变成一条细长条，但**始终能看到全貌**；Host 端回传的预览图
  只缩不放（宽 ≤760、高 ≤1200），显示时只做缩小，所以不会再出现放大发糊。
  卡片会自动避开选区和进度条，实在避不开才贴角落——压住选区就会被拍进长图里。

## 另存为 / 钉住

两个按钮都在标注工具栏上，滚动截图的进度条上也有「钉住」。

- **另存为**：把当前合成结果交给系统保存对话框（`src/save-dialog.ps1`），
  由用户选路径后再写一份；取消就什么都不做。对话框带一个 1px 的置顶宿窗，
  否则从后台 PowerShell 弹出来会藏在主窗口后面。
- **钉住**：`src/pin-window.ps1` 用 WPF 开一个 `WindowStyle=None` +
  `AllowsTransparency` + `Topmost` 的窗口贴图，悬停出工具条（复制 / 另存为 / 关闭），
  拖拽 `DragMove()` 移动，双击或 Esc 关闭。图片先落到 `%TEMP%\dsh-acut`，
  窗口自己读文件，所以进程退出后图还在。

  踩过的坑：`spawn(..., { detached: true })` 在 Windows 上会让子进程立刻退出
  （窗口永远出不来），去掉 detached 就正常。

  抓帧比选区各边内缩 12px——虚线框画在选区外沿，这样它永远不会出现在长图里。
- **Agent 工具**：`screenshot`，动作 `list` / `screen` / `window` / `scroll` / `diag`，
  截图会落盘并把图片直接贴回对话。

## 两种抓屏后端

| 宿主 | 冻结帧 / 窗口截图 | 滚屏截图 |
| --- | --- | --- |
| 宿主里能拿到 Electron API | `webContents.capturePage`，只有页面内容、不含窗口装饰、不受遮挡影响 | 滚动页面内的滚动容器逐帧抓取，结束后还原滚动位置 |
| 其它宿主（Windows） | PowerShell + GDI 抓窗口所在的屏幕区域，按窗口装饰偏移对齐 | 滚轮推进目标窗口逐帧抓屏，拼接后滚回原处 |

非 Windows 的 Web 宿主只能走 Electron 路径；两者都没有时会明确报错，而不是交一张黑图。

## 已知限制

- 热键目前固定为 `Ctrl+Shift+X`，还没有接进 Harness 的快捷键面板（改键要改插件源码）。
- 滚屏截图假设选区里有一个"滚轮能滚动"的容器；横向滚动、无限列表（懒加载）、
  依赖 `IntersectionObserver` 的分页内容可能拼不完整。会话正在流式输出时视图会被钉在
  底部，此时会如实提示"没有可滚动的内容"。
- 桌面滚屏会把鼠标移到选区中心滚轮，结束后还原位置。
- 冻结帧是"当前窗口的内容"，不是整个桌面；要抓别的程序请用 Agent 工具的 `screen`。

## 语言（i18n）

- **解析**：`src/i18n.js` 的 `detectLanguage()` 依次尝试
  配置里的 `language` → `app.getSystemLocale()` / `app.getLocale()`（Electron）
  → `Intl.DateTimeFormat().resolvedOptions().locale` → `en`。
  这台机器的宿主拿不到 `require('electron')`，实际落到 Intl 分支，结果是 `zh-CN`。
- **下发**：Host 注册 `GET /dsh-acut/locale`，返回 `{ locale, lang, source, strings }`，
  `strings` 就是 `locale/<lang>.json` 里的 `strings` 表（键是中文原文）。
- **套用**：`client.js` 挂载时取一次 `/locale`，把 `ACTIVE_LANG` / `STRINGS` 设好再重渲染一次；
  之前的猜测来自 `document.documentElement.lang` → `navigator.languages` → `en`。
  `T(cn, en)`：中文直接用 `cn`，其他语言查 `STRINGS[cn]`，查不到退回 `en`。
  带变量的文案走 `Tf(cn, en, { frames, w, h })`，模板里用 `{frames}` `{w}` `{h}` `{path}`。
- **文件**：`locale/zh.json`（简体只放 meta）、`locale/en.json`，以及
  `zh-Hant / ja / ko / de / fr / es / ru / pt` 各一份，每份 45 条 `strings`。
  新增语言只加一个 JSON，不用改代码。
- **工具说明**：中文系统给中文 `description`，其他语言给英文（模型两种都读得懂）。
