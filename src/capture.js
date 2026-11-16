/**
 * 抓屏引擎。
 *
 * 两条腿：
 * - Electron 主进程可用时（Desktop 版 Harness），用 BrowserWindow.webContents.capturePage()
 *   抓本应用的任何窗口；这是最干净的一条，不含窗口装饰、不受其它程序遮挡。
 * - 否则（Web 版 / 非 Electron 宿主）在 Windows 上用 PowerShell + GDI 抓屏幕区域。
 *
 * 滚屏截图：窗口模式下按固定节奏滚动页面里的滚动容器并逐帧 capturePage；
 * 桌面模式下用滚轮事件推进目标窗口并逐帧抓屏。帧的拼接在 image.js 里做。
 *
 * @module dsh-acut/capture
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { decode } from './image.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PS_SCRIPT = join(HERE, 'capture-screen.ps1')
const require = createRequire(import.meta.url)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export { sleep }

let electronState

/**
 * 解析 Electron 模块：在主进程里 import('electron') 拿到的是真正的模块对象。
 * @returns {Promise<any|null>}
 */
export async function electron() {
  if (electronState !== undefined) return electronState
  electronState = null
  const candidates = []
  try {
    candidates.push(await import('electron'))
  } catch {
    /* 非 Electron 宿主 */
  }
  try {
    candidates.push(require('electron'))
  } catch {
    /* 同上 */
  }
  for (const candidate of candidates) {
    const mod = candidate && candidate.default && typeof candidate.default.BrowserWindow === 'function' ? candidate.default : candidate
    if (mod && typeof mod.BrowserWindow === 'function') {
      electronState = mod
      break
    }
  }
  return electronState
}

function powerShell() {
  return process.platform === 'win32' ? 'powershell.exe' : null
}

/**
 * 调一次抓屏助手。
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function runHelper(args) {
  const exe = powerShell()
  if (exe === null) throw new Error('桌面抓屏只在 Windows 上可用')
  return new Promise((resolve, reject) => {
    execFile(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT, ...args], {
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1 << 20,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`抓屏助手失败：${String(stderr || error.message).trim().slice(0, 400)}`))
        return
      }
      resolve(String(stdout || '').trim())
    })
  })
}

/** 虚拟桌面与光标信息；非 Windows 返回 null。 */
export async function desktopMetrics() {
  if (process.platform !== 'win32') return null
  try {
    const out = await runHelper(['-Mode', 'metrics'])
    return JSON.parse(out)
  } catch {
    return null
  }
}

function tempFile() {
  return join(tmpdir(), `dsh-shot-${randomUUID()}.png`)
}

/**
 * 两帧是否"基本没变"。逐字节比较会被动画图标（转圈、光标闪烁）骗过去，
 * 所以按抽样像素统计差异比例。
 * @param {Buffer} a PNG
 * @param {Buffer} b PNG
 * @returns {boolean} true = 画面没有实质变化
 */
export function sameFrame(a, b) {
  if (a.length === b.length && a.equals(b)) return true
  try {
    const left = decode(a)
    const right = decode(b)
    if (left.width !== right.width || left.height !== right.height) return false
    let diff = 0
    let total = 0
    for (let y = 0; y < left.height; y += 3) {
      for (let x = 0; x < left.width; x += 3) {
        const i = (y * left.width + x) * 4
        if (Math.abs(left.data[i] - right.data[i]) > 6 || Math.abs(left.data[i + 1] - right.data[i + 1]) > 6 || Math.abs(left.data[i + 2] - right.data[i + 2]) > 6) diff++
        total++
      }
    }
    return total === 0 ? true : diff / total < 0.02
  } catch {
    return false
  }
}


const LIVE_SCRIPT = join(HERE, 'capture-live.ps1')

/**
 * 常驻抓屏助手：一次启动，之后每帧只走一次 stdin/stdout 往返。
 * 手动滚屏要跟着用户滚，冷启动 PowerShell（~0.5s/次）撑不住，所以必须常驻。
 */
class LiveHelper {
  constructor() {
    this.proc = null
    this.pending = []
    this.dead = true
  }

  async start() {
    if (this.proc && !this.dead) return
    const exe = powerShell()
    if (exe === null) throw new Error('桌面抓屏只在 Windows 上可用')
    const proc = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', LIVE_SCRIPT], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc = proc
    this.dead = false
    const lines = createInterface({ input: proc.stdout })
    lines.on('line', (line) => {
      const waiter = this.pending.shift()
      if (!waiter) return
      const text = String(line).trim()
      if (text === 'ok') waiter.resolve()
      else waiter.reject(new Error(text.replace(/^err\s*/i, '') || 'capture failed'))
    })
    proc.stderr?.on('data', () => {})
    proc.on('exit', () => {
      this.dead = true
      this.proc = null
      for (const waiter of this.pending) waiter.reject(new Error('capture helper exited'))
      this.pending.length = 0
    })
    // 预热：第一次调用要吃 Add-Type 的启动成本，顺手丢掉结果。
    await this.capture({ x: 0, y: 0, width: 8, height: 8 }).catch(() => {})
  }

  /**
   * 抓一帧。
   * @param {{x:number,y:number,width:number,height:number}} rect 物理像素
   * @returns {Promise<Buffer>} PNG
   */
  capture(rect) {
    if (!this.proc || this.dead) return Promise.reject(new Error('capture helper is not running'))
    const file = tempFile()
    const command = `cap ${Math.round(rect.x)} ${Math.round(rect.y)} ${Math.round(rect.width)} ${Math.round(rect.height)} ${file}\n`
    return new Promise((resolve, reject) => {
      this.pending.push({
        resolve: () => {
          try {
            resolve(readFileSync(file))
          } catch (error) {
            reject(error)
          } finally {
            rmSync(file, { force: true })
          }
        },
        reject: (error) => {
          rmSync(file, { force: true })
          reject(error)
        },
      })
      try {
        this.proc.stdin.write(command)
      } catch (error) {
        this.pending.pop()
        reject(error)
      }
    })
  }

  stop() {
    const proc = this.proc
    this.proc = null
    this.dead = true
    if (!proc) return
    try {
      proc.stdin.write('quit\n')
    } catch {
      /* 已经退出 */
    }
    setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* 同上 */
      }
    }, 500)
  }
}

let liveHelper = null
let liveUsers = 0

/** 取一个常驻抓屏助手（引用计数，最后一个用户释放后关掉）。 */
export async function acquireLiveHelper() {
  if (!liveHelper) liveHelper = new LiveHelper()
  await liveHelper.start()
  liveUsers += 1
  let released = false
  return {
    capture: (rect) => liveHelper.capture(rect),
    release: () => {
      if (released) return
      released = true
      liveUsers = Math.max(0, liveUsers - 1)
      if (liveUsers === 0 && liveHelper) {
        liveHelper.stop()
        liveHelper = null
      }
    },
  }
}

/**
 * 抓一块屏幕区域（物理像素，允许负坐标以支持左侧/上方的副屏）。
 * @param {{x:number,y:number,width:number,height:number}|null} rect null = 整个虚拟桌面
 * @returns {Promise<Buffer>}
 */
export async function captureScreen(rect) {
  const file = tempFile()
  try {
    const args = ['-Mode', 'capture', '-Out', file]
    if (rect) args.push('-X', String(Math.round(rect.x)), '-Y', String(Math.round(rect.y)), '-W', String(Math.round(rect.width)), '-H', String(Math.round(rect.height)))
    await runHelper(args)
    return readFileSync(file)
  } finally {
    if (existsSync(file)) rmSync(file, { force: true })
  }
}

/**
 * 在本应用的所有窗口里挑一个：标题命中优先，其次窗口位置命中，最后焦点窗口。
 * @param {any} el Electron 模块
 * @param {{title?:string, bounds?:{x:number,y:number,width:number,height:number}}} query
 */
function pickWindow(el, query) {
  const wins = el.BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && win.isVisible())
  if (!wins.length) return null
  const title = String(query?.title || '').trim()
  if (title) {
    const byTitle = wins.find((win) => String(win.getTitle() || '') === title) || wins.find((win) => String(win.getTitle() || '').includes(title))
    if (byTitle) return byTitle
  }
  const bounds = query?.bounds
  if (bounds) {
    let best = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const win of wins) {
      const b = win.getBounds()
      const score = Math.abs(b.x - bounds.x) + Math.abs(b.y - bounds.y) + Math.abs(b.width - bounds.width) * 0.35 + Math.abs(b.height - bounds.height) * 0.35
      if (score < bestScore) {
        bestScore = score
        best = win
      }
    }
    if (best && bestScore <= 90) return best
  }
  const focused = wins.find((win) => win.isFocused())
  return focused || wins[0]
}

/** 列出本应用里可抓的窗口。 */
export async function listWindows() {
  const el = await electron()
  if (!el) return []
  return el.BrowserWindow.getAllWindows()
    .filter((win) => !win.isDestroyed())
    .map((win) => {
      const bounds = win.getBounds()
      const content = win.getContentBounds()
      return {
        title: String(win.getTitle() || ''),
        visible: win.isVisible(),
        focused: win.isFocused(),
        bounds,
        content,
        url: String(win.webContents?.getURL?.() || ''),
      }
    })
}

/**
 * 抓一个应用窗口的内容（不含窗口装饰）。
 * @param {{title?:string,bounds?:object,rect?:{x:number,y:number,width:number,height:number}}} query rect 为 CSS 像素
 * @returns {Promise<{png:Buffer,cssWidth:number,cssHeight:number,title:string,width:number,height:number}>}
 */
export async function captureWindow(query = {}) {
  const el = await electron()
  if (!el) throw new Error('当前宿主不是 Electron 桌面版，抓不到应用窗口')
  const win = pickWindow(el, query)
  if (!win) throw new Error('没找到可抓的应用窗口')
  const rect = query.rect
    ? {
        x: Math.max(0, Math.round(query.rect.x)),
        y: Math.max(0, Math.round(query.rect.y)),
        width: Math.max(1, Math.round(query.rect.width)),
        height: Math.max(1, Math.round(query.rect.height)),
      }
    : undefined
  const image = rect ? await win.webContents.capturePage(rect) : await win.webContents.capturePage()
  const png = image.toPNG()
  const size = image.getSize()
  const [cssWidth, cssHeight] = win.getContentSize()
  return {
    png,
    width: size.width,
    height: size.height,
    cssWidth: rect ? rect.width : cssWidth,
    cssHeight: rect ? rect.height : cssHeight,
    title: String(win.getTitle() || ''),
  }
}

/** 在页面里从某一点往上找真正滚动的容器；找不到就退化成整个文档。 */
const FIND_SCROLLER = `function findScroller(x, y) {
  let node = document.elementFromPoint(x, y);
  while (node && node !== document.body && node !== document.documentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(String(style.overflowY)) && node.scrollHeight > node.clientHeight + 4) return node;
    node = node.parentElement;
  }
  const root = document.scrollingElement || document.documentElement;
  return root && root.scrollHeight > root.clientHeight + 4 ? root : null;
}`

/**
 * 窗口滚屏截图：找到选区内的滚动容器，按步长滚动并逐帧抓图，最后还原滚动位置。
 * @param {{title?:string,bounds?:object,rect?:{x:number,y:number,width:number,height:number},frames?:number,delayMs?:number,overlapRatio?:number}} options
 * @returns {Promise<{frames:Buffer[], restored:boolean, scrolled:number, pinned:boolean}>}
 */
export async function scrollWindow(options = {}) {
  const el = await electron()
  if (!el) throw new Error('当前宿主不是 Electron 桌面版，窗口滚屏截图不可用')
  const win = pickWindow(el, options)
  if (!win) throw new Error('没找到可抓的应用窗口')
  const rect = options.rect
  if (!rect || rect.width < 40 || rect.height < 40) throw new Error('滚屏截图需要一个足够大的选区')
  const frames = Math.max(2, Math.min(40, Math.round(options.frames ?? 14)))
  const delay = Math.max(120, Math.min(1500, Math.round(options.delayMs ?? 320)))
  const overlapRatio = Math.max(0.25, Math.min(0.85, options.overlapRatio ?? 0.62))
  const cx = Math.round(rect.x + rect.width / 2)
  const cy = Math.round(rect.y + rect.height / 2)

  const target = await win.webContents.executeJavaScript(
    `(() => { ${FIND_SCROLLER}
      const node = findScroller(${cx}, ${cy});
      window.__dshShotTarget = node;
      return node ? { ok: true, tag: node.tagName, top: node.scrollTop, height: node.scrollHeight, client: node.clientHeight } : { ok: false };
    })()`,
    true,
  ).catch(() => ({ ok: false }))

  const pinned = !target || target.ok !== true
  const clientSize = Math.max(120, Math.round(pinned ? rect.height : Math.min(rect.height, target.client || rect.height)))
  const step = Math.max(40, Math.round(clientSize * (1 - overlapRatio)))
  const scrollScript = (delta) => `(() => {
    const node = window.__dshShotTarget;
    if (node) { node.scrollTop = node.scrollTop + ${delta}; return node.scrollTop; }
    window.scrollBy(0, ${delta});
    return window.scrollY;
  })()`

  const captured = []
  const startTop = await win.webContents.executeJavaScript(
    `(() => { const node = window.__dshShotTarget; return node ? node.scrollTop : window.scrollY; })()`,
    true,
  ).catch(() => 0)

  try {
    for (let i = 0; i < frames; i++) {
      const image = await win.webContents.capturePage({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
      captured.push(image.toPNG())
      if (i === frames - 1) break
      await win.webContents.executeJavaScript(scrollScript(step), true)
      await sleep(delay)
    }
  } finally {
    await win.webContents.executeJavaScript(
      `(() => { const node = window.__dshShotTarget; if (node) { node.scrollTop = ${Number(startTop) || 0}; } else { window.scrollTo(0, ${Number(startTop) || 0}); } window.__dshShotTarget = null; return true; })()`,
      true,
    ).catch(() => {})
    await sleep(180)
  }

  return { frames: captured, restored: true, scrolled: step * (captured.length - 1), pinned }
}

/**
 * 桌面滚屏截图：滚动目标窗口并逐帧抓屏。
 *
 * Windows 上滚轮只作用于"获得焦点的窗口"（除非系统开了悬停滚动），所以调用前
 * 目标窗口必须是前台窗口。方向先向下；如果第一格没带来任何变化（页面已经在
 * 底部），自动改成向上滚，并把帧序反过来交给调用方拼接。
 *
 * @param {{rect:{x:number,y:number,width:number,height:number},frameCount?:number,delayMs?:number,wheelTicks?:number}} options
 * @returns {Promise<{frames:Buffer[], direction:'down'|'up', scrolled:number}>}
 */
export async function scrollScreen(options = {}) {
  const rect = options.rect
  if (!rect || rect.width < 40 || rect.height < 40) throw new Error('滚屏截图需要一个足够大的选区')
  const count = Math.max(2, Math.min(30, Math.round(options.frameCount ?? 10)))
  const delay = Math.max(100, Math.min(2000, Math.round(options.delayMs ?? 300)))
  // 每帧滚多少：按选区高度的三成折算成滚轮格数，保证相邻两帧仍有足够重叠。
  const notches = Math.max(1, Math.min(5, Math.round((rect.height * 0.35) / 100)))
  const step = Math.round(options.wheelTicks ?? -120) * notches
  const pointX = Math.round(rect.x + rect.width / 2)
  const pointY = Math.round(rect.y + rect.height / 2)
  const files = []

  const capture = async () => {
    const file = tempFile()
    files.push(file)
    await runHelper(['-Mode', 'capture', '-X', String(Math.round(rect.x)), '-Y', String(Math.round(rect.y)), '-W', String(Math.round(rect.width)), '-H', String(Math.round(rect.height)), '-Out', file])
    return readFileSync(file)
  }
  let wheeled = 0
  const wheel = async (ticks) => {
    await runHelper(['-Mode', 'wheel', '-PointX', String(pointX), '-PointY', String(pointY), '-Ticks', String(ticks)])
    wheeled += ticks
  }

  try {
    const frames = [await capture()]
    let direction = step < 0 ? 'down' : 'up'
    let ticks = step
    await wheel(ticks)
    await sleep(delay)
    frames.push(await capture())

    if (sameFrame(frames[0], frames[1])) {
      // 第一格没动：很可能已经在底部，改向上滚，并把已经抓到的两帧丢掉重来。
      direction = 'up'
      ticks = -step
      await wheel(ticks * 2)
      await sleep(delay)
      const first = await capture()
      if (sameFrame(first, frames[0])) {
        // 上下都不动：没有可滚内容，交一帧就够。
        return { frames: [frames[0]], direction, scrolled: 0 }
      }
      frames.length = 0
      frames.push(first)
    }

    for (let i = frames.length; i < count; i++) {
      await wheel(ticks)
      await sleep(delay)
      const next = await capture()
      const previous = frames[frames.length - 1]
      if (sameFrame(next, previous)) break
      frames.push(next)
    }
    return { frames, direction, scrolled: frames.length - 1 }
  } finally {
    // 抓完把目标窗口滚回原位（一次事件里给足反向 delta）。
    if (wheeled !== 0) {
      try {
        await runHelper(['-Mode', 'wheel', '-PointX', String(pointX), '-PointY', String(pointY), '-Ticks', String(-wheeled)])
      } catch {
        /* 还原失败不影响结果 */
      }
    }
    for (const file of files) if (existsSync(file)) rmSync(file, { force: true })
  }
}

/**
 * 把 PNG 存到目录里，文件名带时间戳。
 * @param {Buffer} png
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {{path:string,bytes:number}}
 */
export function savePng(png, dir, prefix = 'screenshot') {
  mkdirSync(dir, { recursive: true })
  const stamp = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const name = `${prefix}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}-${pad(stamp.getMilliseconds())}.png`
  const path = join(dir, name)
  writeFileSync(path, png)
  return { path, bytes: png.length }
}
