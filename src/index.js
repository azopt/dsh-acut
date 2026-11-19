/**
 * dsh-acut — 截图插件（Host 半边）。
 *
 * 两件事：
 * 1. 给 Agent 一个 `screenshot` 工具：抓整个桌面 / 一块屏幕区域 / 本应用窗口 /
 *    滚屏长截图，存成 PNG 并把图片贴回对话。
 * 2. 给 Web 前端的截图遮罩提供后端：冻结帧、滚屏抓帧+拼接、保存画好的图。
 *
 * 抓屏细节见 capture.js，拼接与像素操作见 image.js。
 *
 * @module dsh-acut
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { acquireLiveHelper, captureScreen, captureWindow, desktopMetrics, electron, listWindows, sameFrame, savePng, scrollScreen, scrollWindow, selectRegion, sleep } from './capture.js'
import { decode, encode, mergeFrame, resizeToWidth, stitch } from './image.js'
import { detectLanguage, stringsFor } from './i18n.js'

export const name = 'dsh-acut'
export const inject = ['tools']

const require = createRequire(import.meta.url)

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUTE_BASE = '/dsh-acut'
const FALLBACK_VIEWPORT = { width: 1024, height: 768 }
const MAX_BODY = 96 * 1024 * 1024

/** 页面侧诊断日志：客户端把关键事件写进来，排查时直接读这个文件。 */
export function logFilePath() {
  return join(homedir(), '.dsh', 'cache', 'dsh-acut.log')
}

function appendLog(line) {
  try {
    const path = logFilePath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* 日志失败不影响截图 */
  }
}

/** 默认截图落盘目录。 */
export function defaultOutputDir() {
  return process.platform === 'win32' ? join(homedir(), 'Pictures', 'DSH Screenshots') : join(homedir(), 'Pictures', 'DSH Screenshots')
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const body = await readBody(req)
  if (!body.length) return {}
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error('body is not valid JSON')
  }
}

function dataUrlToBuffer(dataUrl) {
  const text = String(dataUrl ?? '')
  const comma = text.indexOf(',')
  if (!text.startsWith('data:') || comma < 0) throw new Error('not a data URL')
  return Buffer.from(text.slice(comma + 1), 'base64')
}

function bufferToDataUrl(png) {
  return `data:image/png;base64,${png.toString('base64')}`
}

/**
 * 截图后把图片写成附件，让它直接出现在对话里。
 * @param {object} ctx
 * @param {Buffer} png
 * @param {string} label
 */
async function attach(ctx, png, label) {
  try {
    const service = attachmentService(ctx)
    if (typeof service?.saveImage !== 'function') return undefined
    const meta = await service.saveImage({ data: png, mediaType: 'image/png', name: label })
    if (!meta) return undefined
    return {
      attachmentId: String(meta.attachmentId),
      mediaType: meta.mediaType,
      bytes: meta.bytes,
      width: meta.width,
      height: meta.height,
      ...(meta.name === undefined ? {} : { name: meta.name }),
    }
  } catch {
    return undefined
  }
}

/** 附件服务：Cordis 里既可能是 ctx 上的属性，也可能要走 ctx.get()。 */
let attachmentRef
function attachmentService(ctx) {
  if (attachmentRef) return attachmentRef
  try {
    const direct = ctx?.attachments
    if (direct && typeof direct.saveImage === 'function') return direct
  } catch {
    /* 没有该服务 */
  }
  try {
    const viaGet = ctx?.get?.('attachments')
    if (viaGet && typeof viaGet.saveImage === 'function') return viaGet
  } catch {
    /* 同上 */
  }
  return undefined
}

/** 抓完一块内容后的统一收尾：落盘 + 附件 + 返回摘要。 */
async function finish(ctx, config, png, label, extra = {}) {
  const saved = config.savePath
    ? saveExact(png, config.savePath)
    : savePng(png, config.outputDir, label)
  const raster = (() => {
    try {
      const img = decode(png)
      return { width: img.width, height: img.height }
    } catch {
      return { width: 0, height: 0 }
    }
  })()
  const attachment = await attach(ctx, png, label)
  return {
    ok: true,
    path: saved.path,
    bytes: saved.bytes,
    width: raster.width,
    height: raster.height,
    ...extra,
    ...(attachment === undefined ? {} : { attachment }),
  }
}

function describeWindows(windows) {
  if (!windows.length) return '当前宿主不是 Electron 桌面版，没有可枚举的应用窗口。'
  return windows
    .map((win, index) => `${index + 1}. ${win.visible ? '' : '(未显示) '}${win.title || '(无标题)'} — ${win.content.width}×${win.content.height} @ ${win.bounds.x},${win.bounds.y}${win.focused ? ' [焦点]' : ''}`)
    .join('\n')
}


/* ── 手动滚屏：用户自己滚，我们负责逐帧合并 ─────────────────────────────── */

/** 活跃的手动滚屏会话。 */
const manualSessions = new Map()
let manualSeq = 0

/** 把页面里的 CSS 矩形换算成屏幕物理像素矩形（并裁到可见屏幕）。 */
function pageRectToPhysical(body, fallback) {
  const scale = Number(body.scale) || 1
  const bounds = body.bounds || {}
  const viewport = body.viewport || {}
  const cssHeight = Math.max(1, Math.round(Number(viewport.height) || FALLBACK_VIEWPORT.height))
  const chromeX = Number(body.chromeX ?? 0) || 0
  const chromeY = Number(body.chromeY ?? 0) || Math.max(0, Math.round((Number(bounds.height) || cssHeight) - cssHeight))
  const page = body.rectCss || fallback || { x: 0, y: 0, width: 0, height: 0 }
  return {
    scale,
    want: {
      x: Math.round(((Number(bounds.x) || 0) + chromeX + (Number(page.x) || 0)) * scale),
      y: Math.round(((Number(bounds.y) || 0) + chromeY + (Number(page.y) || 0)) * scale),
      width: Math.max(1, Math.round((Number(page.width) || 0) * scale)),
      height: Math.max(1, Math.round((Number(page.height) || 0) * scale)),
    },
  }
}

function clipToScreen(rect, metrics) {
  if (!metrics?.virtual) return rect
  return intersect(rect, { x: metrics.virtual.x, y: metrics.virtual.y, width: metrics.virtual.width, height: metrics.virtual.height })
}

async function manualTick(session) {
  if (session.stopped) return
  try {
    const png = await session.helper.capture(session.rect)
    // 不做"整帧是否一样"的预判：滚动可能很碎，由重叠匹配自己决定这帧有没有新内容。
    const raster = decode(png)
    let merged = null
    if (!session.acc) {
      session.acc = raster
      session.frames = 1
      session.side = 'start'
    } else {
      merged = mergeFrame(session.acc, raster, { maxHeight: 30000, maxWidth: 16000, expected: session.expected })
      if (merged.matched && merged.added > 2) {
        session.acc = merged.raster
        session.side = merged.side
        session.expected = merged.d > 4 ? { side: merged.side, d: merged.d } : null
        session.misses = 0
        session.frames += 1
      } else {
        session.misses = (session.misses ?? 0) + 1
        // 连续两次对不上就别再死抱旧位移了，重新搜一次。
        if (session.misses >= 2) session.expected = null
      }
    }
    if (merged?.added > 2 && (session.changeLogs ?? 0) < 12) {
      session.changeLogs = (session.changeLogs ?? 0) + 1
      appendLog(`[manual] change frames=${session.frames} side=${merged.side} err=${merged.error.toFixed(4)} added=${merged.added} size=${session.acc.width}x${session.acc.height}`)
    }
    session.error = null
  } catch (error) {
    session.error = String(error?.message ?? error)
  }
  if (session.stopped) return
  const big = session.acc && (session.acc.height >= 30000 || session.acc.width >= 16000)
  if (session.frames >= 400 || big) {
    session.full = true
    return
  }
  session.timer = setTimeout(() => void manualTick(session), session.intervalMs)
}

async function startManual(body) {
  const metrics = await desktopMetrics()
  if (!metrics?.virtual) throw new Error('当前宿主抓不到屏幕')
  const { want } = pageRectToPhysical(body)
  const rect = clipToScreen(want, metrics)
  if (!rect) throw new Error('选区不在屏幕可见范围内')
  const id = `m${Date.now().toString(36)}${++manualSeq}`
  const intervalMs = clamp(body.intervalMs ?? 260, 120, 2000)
  const helper = await acquireLiveHelper()
  const session = {
    id,
    rect,
    helper,
    intervalMs,
    acc: null,
    lastPng: null,
    frames: 0,
    side: null,
    error: null,
    stopped: false,
    full: false,
    timer: null,
    startedAt: Date.now(),
    lastSeen: Date.now(),
  }
  manualSessions.set(id, session)
  void manualTick(session)
  return session
}

function manualStatus(id, previewMax) {
  const session = manualSessions.get(id)
  if (!session) return null
  session.lastSeen = Date.now()
  // 悬浮预览：把当前拼接结果缩到很窄再编码，控制在 ~30ms 一次。
  let preview = null
  if (previewMax && session.acc) {
    const now = Date.now()
    if (now - (session.previewAt ?? 0) > 550) {
      session.previewAt = now
      try {
        // 只缩不放：宽高都卡一下，长图按高度收，宽图按宽度收；显示端再等比缩进预览卡。
        const maxWidth = Math.max(160, Math.min(1000, Math.round(Number(previewMax) || 320)))
        const maxHeight = 1200
        const factor = Math.min(1, maxWidth / session.acc.width, maxHeight / session.acc.height)
        const targetWidth = Math.max(1, Math.round(session.acc.width * factor))
        preview = bufferToDataUrl(encode(resizeToWidth(session.acc, targetWidth)))
      } catch (error) {
        session.previewAt = 0
      }
    }
  }
  return {
    ok: true,
    id,
    frames: session.frames,
    width: session.acc?.width ?? session.rect.width,
    height: session.acc?.height ?? session.rect.height,
    baseWidth: session.acc?.width ?? 0,
    side: session.side,
    full: session.full,
    error: session.error,
    elapsed: Date.now() - session.startedAt,
    preview,
  }
}

function closeManual(id, keep) {
  const session = manualSessions.get(id)
  if (!session) return null
  session.stopped = true
  if (session.timer) clearTimeout(session.timer)
  manualSessions.delete(id)
  const result = keep && session.acc ? { raster: session.acc, frames: session.frames } : null
  try {
    session.helper.release()
  } catch {
    /* 忽略 */
  }
  return result
}

/** 页面被关掉也不会留下常驻的 PowerShell：超过 30 秒没人问就自己收摊。 */
function sweepManualSessions() {
  const now = Date.now()
  for (const [id, session] of manualSessions) {
    if (now - session.lastSeen > 30000) closeManual(id, false)
  }
}

/**
 * 注册 Host 半边。
 * @param {object} ctx Cordis 上下文
 * @param {{outputDir?:string,frames?:number,delayMs?:number}} [config]
 */
/**
 * 全局快捷键助手：Harness 不在前台时也能截图（浏览器、别的应用、桌面）。
 * 常驻一个 PowerShell 进程挂低级键盘钩子；按到 Ctrl+Shift+X 就自己跑一遍
 * 框选 → 存图 → 复制 → 钉住。Harness 窗口在前台时它会让出按键，交给页面里的流程。
 */
function startGlobalHotkey(outputDir, hints = {}) {
  if (process.platform !== 'win32') return null
  const script = join(HERE, 'acut-hotkey.ps1')
  if (!existsSync(script)) return null
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]
  if (outputDir) args.push('-OutDir', outputDir)
  if (hints.hint) args.push('-Hint', hints.hint)
  if (hints.hintKeys) args.push('-HintKeys', hints.hintKeys)
  if (hints.hintDone) args.push('-HintDone', hints.hintDone)
  try {
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore', detached: false })
    child.on('error', (error) => {
      console.warn('[dsh-acut] 全局快捷键助手启动失败：', error?.message ?? error)
    })
    child.unref()
    return child
  } catch (error) {
    console.warn('[dsh-acut] 全局快捷键助手启动失败：', error?.message ?? error)
    return null
  }
}

export async function apply(ctx, config = {}) {
  const language = await detectLanguage(config.language, electron)
  // 工具说明跟着系统语言走：中文系统给中文，其他一律英文（模型两种都读得懂）。
  const toolDescription = language.lang === 'zh'
    ? '真实截图：整个桌面、屏幕上的矩形区域、本应用某个窗口（清晰、不含窗口边框），或者滚屏长截图——把一整页/一个窗口拼成一张长图。' +
      'PNG 存到截图目录，并把图片贴回对话。不知道有哪些窗口时先用 `list`。' +
      '`screen` 和屏幕 `scroll` 的坐标是物理像素；`window` 的坐标是那个窗口内的 CSS 像素。'
    : 'Take real screenshots: the whole desktop, a screen rectangle, a window of this app (crisp, without window chrome), or a scrolling capture that stitches a long page/window into one tall image. ' +
      'Saves a PNG under the screenshots folder and attaches the image to the conversation. ' +
      'Use `list` first when you do not know which windows exist. Coordinates for `screen` and screen `scroll` are physical pixels; for `window` they are CSS pixels inside that window.'
  const settings = {
    language,
    outputDir: typeof config.outputDir === 'string' && config.outputDir.trim() ? config.outputDir.trim() : defaultOutputDir(),
    frames: clamp(config.frames ?? 14, 2, 40),
    delayMs: clamp(config.delayMs ?? 320, 120, 1500),
    chromeOffsetX: Number.isFinite(Number(config.chromeOffsetX)) && config.chromeOffsetX !== undefined ? Number(config.chromeOffsetX) : undefined,
    chromeOffsetY: Number.isFinite(Number(config.chromeOffsetY)) && config.chromeOffsetY !== undefined ? Number(config.chromeOffsetY) : undefined,
  }

  if (typeof ctx?.inject === 'function') {
    ctx.inject(['attachments'], (attachCtx) => {
      try {
        attachmentRef = attachCtx.attachments
      } catch {
        attachmentRef = undefined
      }
      return () => {
        attachmentRef = undefined
      }
    })
  }

  registerRoutes(ctx, settings)

  if (!ctx?.tools?.register) return
  let defineTool
  try {
    ({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  } catch {
    return
  }

  try {
    ctx.tools.register(defineTool({
      name: 'screenshot',
      description: toolDescription,
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'screen', 'window', 'scroll', 'diag'],
          required: true,
          description: 'list=列出可抓的窗口与桌面尺寸；screen=抓屏幕（默认整个桌面）；window=抓本应用的一个窗口内容；scroll=滚屏长截图；diag=诊断抓屏后端。',
        },
        region: {
          type: 'object',
          additionalProperties: false,
          description: 'screen 用：屏幕区域（物理像素）。省略则抓整个桌面。',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        window: {
          type: 'string',
          description: 'window/scroll 用：窗口标题（或标题片段）。省略则用当前焦点窗口。',
        },
        mode: {
          type: 'string',
          enum: ['window', 'screen'],
          description: 'scroll 用：默认 window（滚动页面内容并逐帧抓窗口，最清晰）；screen 用于抓别的程序窗口（会移动鼠标滚轮）。',
        },
        regionCss: {
          type: 'object',
          additionalProperties: false,
          description: 'window/scroll(window) 用：窗口内的 CSS 像素矩形，省略为整个窗口。',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        frames: {
          type: 'number',
          description: 'scroll 用：最多抓多少帧，默认 14（上限 40）。',
        },
        delayMs: {
          type: 'number',
          description: 'scroll 用：每帧之间等多久让页面稳定，默认 320ms。',
        },
        savePath: {
          type: 'string',
          description: '可选的落盘路径（.png）。省略则存到默认截图目录。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            summary: { type: 'string', required: true },
            path: { type: 'string' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            bytes: { type: 'integer' },
            attachment: { type: 'object', additionalProperties: true },
          },
        },
        render: (_args, value) => {
          const rows = [{ type: 'text', text: value.summary }]
          if (value.attachment) rows.push({ type: 'image', attachment: value.attachment })
          return rows
        },
      },
      async execute(args = {}, exec = {}) {
        const action = String(args.action || 'list')
        if (action === 'diag') {
          const info = { pid: process.pid, execPath: process.execPath, type: process.type ?? null, versions: { electron: process.versions.electron ?? null, node: process.versions.node, chrome: process.versions.chrome ?? null }, argv: process.argv.slice(0, 4) }
          const attempts = {}
          try {
            const mod = await import('electron')
            attempts.import = { ok: Boolean(mod?.BrowserWindow), keys: Object.keys(mod || {}).slice(0, 8) }
          } catch (error) {
            attempts.import = { error: String(error?.message ?? error) }
          }
          try {
            const mod = require('electron')
            attempts.require = { ok: Boolean(mod?.BrowserWindow), keys: Object.keys(mod || {}).slice(0, 8) }
          } catch (error) {
            attempts.require = { error: String(error?.message ?? error) }
          }
          const metrics = await desktopMetrics()
          const attachments = (() => {
            const service = attachmentService(ctx)
            return { available: Boolean(service), canSaveImage: typeof service?.saveImage === 'function' }
          })()
          return { ok: true, summary: `诊断：\n${JSON.stringify({ info, attempts, metrics, attachments }, null, 2)}`, info, attempts, metrics }
        }
        if (action === 'list') {
          const windows = await listWindows()
          const metrics = await desktopMetrics()
          const lines = [`截图目录：${settings.outputDir}`]
          if (metrics?.virtual) lines.push(`桌面：${metrics.virtual.width}×${metrics.virtual.height}（原点 ${metrics.virtual.x},${metrics.virtual.y}）`)
          lines.push('窗口：', describeWindows(windows))
          return { ok: true, summary: lines.join('\n'), windows, metrics }
        }

        if (action === 'screen') {
          const rect = args.region && args.region.width > 0 ? args.region : null
          const png = await captureScreen(rect)
          const where = rect ? `屏幕区域 ${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}×${Math.round(rect.height)}` : '整个桌面'
          const result = await finish(ctx, { outputDir: settings.outputDir, savePath: args.savePath }, png, 'screen', {})
          return { ...result, summary: `已抓取${where}（${result.width}×${result.height}）。\n文件：${result.path}` }
        }

        if (action === 'window') {
          const shot = await captureWindow({ title: args.window, rect: args.regionCss })
          const result = await finish(ctx, { outputDir: settings.outputDir, savePath: args.savePath }, shot.png, 'window', {})
          return { ...result, summary: `已抓取窗口「${shot.title}」（${result.width}×${result.height}）。\n文件：${result.path}` }
        }

        if (action === 'scroll') {
          const mode = args.mode === 'screen' ? 'screen' : 'window'
          const frames = clamp(args.frames ?? settings.frames, 2, 40)
          const delayMs = clamp(args.delayMs ?? settings.delayMs, 120, 2000)
          let captured
          let pinned = false
          if (mode === 'screen') {
            const rect = args.region || { x: 0, y: 0, width: 0, height: 0 }
            const metrics = await desktopMetrics()
            const region = rect.width > 0 ? rect : metrics?.virtual ?? rect
            captured = await scrollScreen({ rect: region, frameCount: frames, delayMs, wheelTicks: -120 })
          } else {
            const shot = await scrollWindow({ title: args.window, rect: args.regionCss, frames, delayMs })
            captured = shot
            pinned = shot.pinned === true
          }
          if (exec.signal?.aborted) throw new Error('cancelled')
          let rasters = captured.frames.map((png) => decode(png))
          if (captured.direction === 'up') rasters = rasters.reverse()
          const stitched = stitch(rasters, { maxHeight: 20000 })
          const png = encode(stitched.raster)
          const result = await finish(ctx, { outputDir: settings.outputDir, savePath: args.savePath }, png, 'scroll', {})
          const nothingNew = stitched.raster.height <= (rasters[0]?.height ?? 0) + 4
          const reason = nothingNew
            ? '选区里没有可滚动的内容（可能已经在底部，或该位置不在滚动区域上），结果就是当前一屏'
            : stitched.stopped === 'reached-end' ? '已滚到底' : stitched.stopped === 'max-height' ? '已达高度上限' : '已用完全部帧'
          return {
            ...result,
            summary: [
              `已滚屏截图：${stitched.frames} 帧拼成 ${result.width}×${result.height}（${reason}）。`,
              pinned ? '注意：选区里没找到可滚动区域，结果可能只是窗口内容。' : '',
              `文件：${result.path}`,
            ].filter(Boolean).join('\n'),
          }
        }

        throw new Error(`unknown action: ${action}`)
      },
    }))
  } catch (error) {
    console.warn('[dsh-acut] tool registration failed:', error?.message ?? error)
  }
}

/** 两个矩形的交集；没有交集返回 null。 */
function intersect(a, b) {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.round(n)))
}

/** 按用户给的完整路径落盘。 */
function saveExact(png, path) {
  const target = String(path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, png)
  return { path: target, bytes: png.length }
}

function dirOf(path) {
  const text = String(path)
  const at = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return at > 0 ? text.slice(0, at) : defaultOutputDir()
}

/**
 * 页面用的接口：冻结帧 / 滚屏抓帧 / 保存。
 * 只接受同源连接（Host 的连接准入检查），不额外开 CORS。
 */

/* ── 贴住屏幕 / 另存为（PowerShell + WPF/WinForms） ─────────────────────── */

const TEMP_DIR = join(tmpdir(), 'dsh-acut')

function tempPng(png, tag) {
  mkdirSync(TEMP_DIR, { recursive: true })
  const file = join(TEMP_DIR, `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
  writeFileSync(file, png)
  return file
}

function sweepTempFiles() {
  try {
    if (!existsSync(TEMP_DIR)) return
    const cutoff = Date.now() - 6 * 60 * 60 * 1000
    for (const name of readdirSync(TEMP_DIR)) {
      const full = join(TEMP_DIR, name)
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full)
      } catch {
        /* 正被贴住窗口占用就算了 */
      }
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 贴住屏幕：把 PNG 贴成一个无边框置顶窗口，窗口自己管复制/另存/关闭。 */
function pinImage(png, options = {}) {
  const file = tempPng(png, 'pin')
  sweepTempFiles()
  const args = [
    '-Sta', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(HERE, 'pin-window.ps1'),
    '-Path', file,
    '-MaxWidth', String(Math.max(0, Math.round(Number(options.maxWidth) || 0))),
    '-MaxHeight', String(Math.max(0, Math.round(Number(options.maxHeight) || 0))),
  ]
  // 不能 detached：Windows 上 detached + windowsHide 的子进程会立刻退出，窗口起不来。
  const child = spawn('powershell.exe', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) appendLog(`[pin] ps stderr: ${text.slice(0, 400)}`)
  })
  child.on('exit', (code) => appendLog(`[pin] ps exit code=${code}`))
  child.unref()
  return { pid: child.pid, file }
}

function runScript(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
      finish('')
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
    })
    child.stderr?.on('data', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      finish('')
    })
    child.on('close', () => {
      clearTimeout(timer)
      finish(out.replace(/\r/g, '').trim())
    })
  })
}

/** 另存为：弹系统保存对话框，把当前图另存到用户选的位置。 */
async function saveAsDialog(png, options = {}) {
  const file = tempPng(png, 'saveas')
  const name = typeof options.name === 'string' && options.name.trim() ? options.name.trim() : ''
  const out = await runScript([
    '-Sta', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(HERE, 'save-dialog.ps1'),
    '-Source', file,
    '-Name', name,
    '-InitialDir', options.initialDir || homedir(),
  ])
  const lines = out.split('\n').map((line) => line.trim()).filter(Boolean)
  const line = lines.length ? lines[lines.length - 1] : ''
  if (line.startsWith('OK ')) return { ok: true, path: line.slice(3).trim() }
  if (line === 'CANCEL') return { ok: true, canceled: true }
  return { ok: false, error: line || 'dialog-failed' }
}

function registerRoutes(ctx, settings) {
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer
    if (!server || typeof server.register !== 'function') return
    let admission
    ctx.inject(['connection'], (connectionCtx) => {
      admission = (req) => connectionCtx.connection.requestRejection(req)
      return () => {
        admission = undefined
      }
    })

    const guard = (path, handler) => (req, res) => {
      try {
        if (typeof admission === 'function') {
          const rejection = admission(req)
          if (rejection !== undefined && rejection !== null) {
            json(res, rejection === 401 ? 401 : rejection === 503 ? 503 : 403, { ok: false, error: 'forbidden' })
            return
          }
        }
        const answer = handler(req, res)
        if (answer && typeof answer.then === 'function') {
          answer.catch((error) => {
            appendLog(`[host] ${path} failed: ${String(error?.message ?? error)}`)
            try {
              if (!res.headersSent) json(res, 500, { ok: false, error: String(error?.message ?? error) })
              else if (!res.writableEnded) res.end()
            } catch {
              /* 响应已经不在了 */
            }
          })
        }
      } catch (error) {
        try {
          if (!res.headersSent) json(res, 500, { ok: false, error: String(error?.message ?? error) })
        } catch {
          /* 同上 */
        }
      }
    }

    const routes = [
      [`${ROUTE_BASE}/state`, async (req, res) => {
        const el = await electron()
        const windows = el ? await listWindows() : []
        const metrics = await desktopMetrics()
        json(res, 200, { ok: true, electron: Boolean(el), platform: process.platform, outputDir: settings.outputDir, windows, metrics })
      }],
      [`${ROUTE_BASE}/freeze`, async (req, res) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method' })
        const body = await readJson(req)
        const el = await electron()
        if (el) {
          const shot = await captureWindow({ title: body.title, bounds: body.bounds, rect: body.rect })
          json(res, 200, {
            ok: true,
            source: 'window',
            title: shot.title,
            dataUrl: bufferToDataUrl(shot.png),
            width: shot.width,
            height: shot.height,
            cssWidth: shot.cssWidth,
            cssHeight: shot.cssHeight,
            scale: shot.width / Math.max(1, shot.cssWidth),
            screenRect: null,
          })
          return
        }

        // 非 Electron 宿主：按窗口在外接屏幕上的位置抓屏幕区域。
        const metrics = await desktopMetrics()
        if (!metrics?.virtual) return json(res, 500, { ok: false, error: '当前宿主不是 Electron，也不是 Windows：抓不到屏幕' })
        const scale = Number(body.scale) || 1
        const bounds = body.bounds || {}
        const viewport = body.viewport || {}
        const cssWidth = Math.max(1, Math.round(Number(viewport.width) || FALLBACK_VIEWPORT.width))
        const cssHeight = Math.max(1, Math.round(Number(viewport.height) || FALLBACK_VIEWPORT.height))
        const chromeX = Number(body.chromeX ?? settings.chromeOffsetX) || 0
        const chromeY = Number(body.chromeY ?? settings.chromeOffsetY) || Math.max(0, Math.round((Number(bounds.height) || cssHeight) - cssHeight))
        const want = {
          x: Math.round(((Number(bounds.x) || 0) + chromeX) * scale),
          y: Math.round(((Number(bounds.y) || 0) + chromeY) * scale),
          width: Math.max(1, Math.round(cssWidth * scale)),
          height: Math.max(1, Math.round(cssHeight * scale)),
        }
        const screen = { x: metrics.virtual.x, y: metrics.virtual.y, width: metrics.virtual.width, height: metrics.virtual.height }
        const clip = intersect(want, screen)
        if (!clip) return json(res, 400, { ok: false, error: '窗口不在屏幕可见范围内' })
        const png = await captureScreen(clip)
        const raster = decode(png)
        json(res, 200, {
          ok: true,
          source: 'screen',
          dataUrl: bufferToDataUrl(png),
          width: raster.width,
          height: raster.height,
          scale,
          cssWidth,
          cssHeight,
          window: want,
          screenRect: clip,
          offsetX: (clip.x - want.x) / scale,
          offsetY: (clip.y - want.y) / scale,
        })
      }],
      [`${ROUTE_BASE}/select`, async (req, res) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method' })
        const body = await readJson(req)
        if (process.platform !== 'win32') return json(res, 200, { ok: false, unsupported: true })
        let shot
        try {
          shot = await selectRegion({ mode: body.mode, hint: body.hint, hintKeys: body.hintKeys, hintDone: body.hintDone })
        } catch (error) {
          appendLog(`[host] select failed: ${String(error?.message ?? error)}`)
          return json(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
        if (shot.cancelled) return json(res, 200, { ok: false, cancelled: true })
        const raster = decode(shot.png)
        json(res, 200, {
          ok: true,
          source: 'crop',
          dataUrl: bufferToDataUrl(shot.png),
          width: raster.width,
          height: raster.height,
          screenRect: shot.rect,
        })
      }],
      [`${ROUTE_BASE}/scroll`, async (req, res) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method' })
        const body = await readJson(req)
        const frames = clamp(body.frames ?? settings.frames, 2, 30)
        const delayMs = clamp(body.delayMs ?? settings.delayMs, 120, 2000)
        const preDelay = clamp(body.preDelayMs ?? 0, 0, 4000)
        if (preDelay > 0) await sleep(preDelay)
        const el = await electron()
        let rasters
        let pinned = false
        if (el && body.mode === 'window') {
          const shot = await scrollWindow({ title: body.title, bounds: body.bounds, rect: body.rectCss, frames, delayMs, overlapRatio: body.overlapRatio })
          pinned = shot.pinned === true
          rasters = shot.frames.map((png) => decode(png))
        } else {
          const metrics = await desktopMetrics()
          if (!metrics?.virtual) return json(res, 500, { ok: false, error: '当前宿主抓不到屏幕' })
          const scale = Number(body.scale) || 1
          const bounds = body.bounds || {}
          const viewport = body.viewport || {}
          const cssHeight = Math.max(1, Math.round(Number(viewport.height) || FALLBACK_VIEWPORT.height))
          const chromeX = Number(body.chromeX ?? settings.chromeOffsetX) || 0
          const chromeY = Number(body.chromeY ?? settings.chromeOffsetY) || Math.max(0, Math.round((Number(bounds.height) || cssHeight) - cssHeight))
          const page = body.rectCss || { x: 0, y: 0, width: 0, height: 0 }
          const want = {
            x: Math.round(((Number(bounds.x) || 0) + chromeX + (Number(page.x) || 0)) * scale),
            y: Math.round(((Number(bounds.y) || 0) + chromeY + (Number(page.y) || 0)) * scale),
            width: Math.max(1, Math.round((Number(page.width) || 0) * scale)),
            height: Math.max(1, Math.round((Number(page.height) || 0) * scale)),
          }
          const clip = intersect(want, { x: metrics.virtual.x, y: metrics.virtual.y, width: metrics.virtual.width, height: metrics.virtual.height })
          if (!clip) return json(res, 400, { ok: false, error: '选区不在屏幕可见范围内' })
          const shot = await scrollScreen({ rect: clip, frameCount: frames, delayMs, wheelTicks: -120 })
          rasters = shot.frames.map((png) => decode(png))
          if (shot.direction === 'up') rasters.reverse()
        }
        const result = stitch(rasters, { maxHeight: 20000 })
        const png = encode(result.raster)
        const nothingNew = result.raster.height <= (rasters[0]?.height ?? 0) + 4
        json(res, 200, {
          ok: true,
          dataUrl: bufferToDataUrl(png),
          width: result.raster.width,
          height: result.raster.height,
          frames: result.frames,
          stopped: nothingNew ? 'no-scroll' : result.stopped,
          pinned,
        })
      }],
      [`${ROUTE_BASE}/manual/start`, async (req, res) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method' })
        sweepManualSessions()
        const body = await readJson(req)
        const session = await startManual(body)
        json(res, 200, { ok: true, id: session.id, rect: session.rect, intervalMs: session.intervalMs })
      }],
      [`${ROUTE_BASE}/manual/status`, async (req, res) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method' })
        const body = await readJson(req)
        const status = manualStatus(body.id, body.previewMax)
        if (!status) return json(res, 404, { ok: false, error: 'session-not-found' })
        json(res, 200, status)
      }],
      [`${ROUTE_BASE}/manual/stop`, async (req, res) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method' })
        const body = await readJson(req)
        const result = closeManual(body.id, true)
        if (!result) return json(res, 404, { ok: false, error: 'session-not-found' })
        const png = encode(result.raster)
        json(res, 200, {
          ok: true,
          dataUrl: bufferToDataUrl(png),
          width: result.raster.width,
          height: result.raster.height,
          frames: result.frames,
        })
      }],
      [`${ROUTE_BASE}/manual/cancel`, async (req, res) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method' })
        const body = await readJson(req)
        closeManual(body.id, false)
        json(res, 200, { ok: true })
      }],
      [`${ROUTE_BASE}/pin`, async (req, res) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method' })
        const body = await readJson(req)
        const png = dataUrlToBuffer(body.dataUrl)
        if (!png.length) return json(res, 400, { ok: false, error: 'empty image' })
        const pinned = pinImage(png, { maxWidth: body.maxWidth, maxHeight: body.maxHeight })
        appendLog(`[host] pin ${png.length} bytes pid=${pinned.pid}`)
        json(res, 200, { ok: true, pid: pinned.pid })
      }],
      [`${ROUTE_BASE}/saveas`, async (req, res) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method' })
        const body = await readJson(req)
        const png = dataUrlToBuffer(body.dataUrl)
        if (!png.length) return json(res, 400, { ok: false, error: 'empty image' })
        const result = await saveAsDialog(png, { name: body.name, initialDir: settings.outputDir })
        appendLog(`[host] saveas ${result.ok ? (result.canceled ? 'canceled' : result.path) : 'failed: ' + result.error}`)
        if (!result.ok) return json(res, 500, { ok: false, error: result.error })
        json(res, 200, { ok: true, canceled: !!result.canceled, path: result.path || null })
      }],
      [`${ROUTE_BASE}/manual/pin`, async (req, res) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method' })
        const body = await readJson(req)
        const result = closeManual(body.id, true)
        if (!result) return json(res, 404, { ok: false, error: 'session-not-found' })
        const png = encode(result.raster)
        const pinned = pinImage(png, { maxWidth: body.maxWidth, maxHeight: body.maxHeight })
        appendLog(`[host] manual/pin frames=${result.frames} ${result.raster.width}x${result.raster.height} pid=${pinned.pid}`)
        json(res, 200, { ok: true, pid: pinned.pid, width: result.raster.width, height: result.raster.height, frames: result.frames })
      }],
      [`${ROUTE_BASE}/save`, async (req, res) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method' })
        const body = await readJson(req)
        const png = dataUrlToBuffer(body.dataUrl)
        if (!png.length) return json(res, 400, { ok: false, error: 'empty image' })
        if (typeof body.savePath === 'string' && body.savePath.trim()) {
          const saved = saveExact(png, body.savePath.trim())
          json(res, 200, { ok: true, path: saved.path, bytes: png.length })
          return
        }
        const target = settings.outputDir
        const saved = savePng(png, target, body.prefix || 'screenshot')
        json(res, 200, { ok: true, path: saved.path, bytes: png.length, outputDir: target })
      }],
      [`${ROUTE_BASE}/locale`, async (req, res) => {
        json(res, 200, {
          ok: true,
          locale: settings.language.locale,
          lang: settings.language.lang,
          source: settings.language.source,
          strings: stringsFor(settings.language.lang),
        })
      }],
      [`${ROUTE_BASE}/log`, async (req, res) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method' })
        const body = await readJson(req).catch(() => ({}))
        appendLog(`[page] ${body.message ?? ''}`)
        json(res, 200, { ok: true })
      }],
      [`${ROUTE_BASE}/reveal`, async (req, res) => {
        const body = await readJson(req).catch(() => ({}))
        const dir = typeof body.path === 'string' && body.path ? body.path : settings.outputDir
        const el = await electron()
        if (el) el.shell?.showItemInFolder?.(dir)
        json(res, 200, { ok: true, path: dir, exists: existsSync(dir) })
      }],
    ]

    webCtx.effect(() => {
      const disposers = []
      for (const [path, handler] of routes) {
        try {
          const dispose = server.register({ kind: 'exact', path, handler: guard(path, handler) })
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch (error) {
          console.warn(`[dsh-acut] route ${path} failed:`, error?.message ?? error)
        }
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 卸载时忽略 */
          }
        }
      }
    }, 'dsh-acut: capture routes')
  })

  // 全局快捷键：只在 Windows 上装，失败不影响插件其它功能。
  const hotkey = startGlobalHotkey(settings.outputDir, language.lang === 'zh'
    ? {
        hint: '悬停自动吸附：窗口 / 应用内模块 / 网页元素',
        hintKeys: '单击确认 · Tab 换吸附层级 · 方向键微调 · 按住 Ctrl 自由框选',
        hintDone: 'Enter 完成 · Esc 取消 · 双击 = 整屏',
      }
    : {
        hint: 'Hover to snap: window / pane / web element',
        hintKeys: 'Click to confirm · Tab cycles levels · arrows nudge · hold Ctrl for a free drag',
        hintDone: 'Enter confirm · Esc cancel · double-click = whole screen',
      })
  if (hotkey) {
    const stop = () => {
      try {
        hotkey.kill()
      } catch {
        /* 已经退出了 */
      }
    }
    if (typeof ctx?.effect === 'function') ctx.effect(() => stop, 'dsh-acut: global hotkey')
    else process.once('exit', stop)
  }
}
