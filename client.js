window.__ModuleLoader__.load({
  id: 'dsh-acut',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /* ── 文案：语言跟随系统，由 Host 用 /locale 告诉页面 ─────────────────── */
    const KNOWN_LANGS = ['zh', 'zh-Hant', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'ru', 'pt']
    const normalizeTag = (tag) => {
      const raw = String(tag ?? '').trim().toLowerCase().replace(/_/g, '-')
      if (!raw) return ''
      if (raw.startsWith('zh')) return /hant|tw|hk|mo/.test(raw) ? 'zh-Hant' : 'zh'
      const base = raw.split('-')[0]
      return KNOWN_LANGS.includes(base) ? base : 'en'
    }
    /** 拿不到 Host 答案之前的猜测：网页语言 → 浏览器语言 → 英文。 */
    const guessLang = () => {
      const tags = []
      try {
        tags.push(typeof document !== 'undefined' ? document.documentElement?.lang : '')
        tags.push(...(navigator.languages || []))
        tags.push(navigator.language)
      } catch {
        /* 取不到就算了 */
      }
      for (const tag of tags) {
        const lang = normalizeTag(tag)
        if (lang) return lang
      }
      return 'en'
    }
    let ACTIVE_LANG = guessLang()
    let STRINGS = {}
    /** 中文原文是键；当前语言没有这条译文就退回英文。 */
    const T = (cn, en) => {
      if (ACTIVE_LANG === 'zh') return cn
      const hit = STRINGS ? STRINGS[cn] : undefined
      return typeof hit === 'string' && hit ? hit : en
    }
    /** 带占位符的文案：模板里用 {frames} {w} {h} {path} 之类。 */
    const Tf = (cn, en, params) => {
      let text = String(T(cn, en))
      for (const [key, value] of Object.entries(params || {})) text = text.split(`{${key}}`).join(String(value))
      return text
    }

    /* ── 常量 ─────────────────────────────────────────────────────────────── */
    const TOOLS = [
      { id: 'rect', path: 'M4 5h16v14H4z', cn: '矩形', en: 'Rectangle' },
      { id: 'ellipse', path: 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z', cn: '椭圆', en: 'Ellipse' },
      { id: 'arrow', path: 'M5 19 19 5M19 5h-6m6 0v6', cn: '箭头', en: 'Arrow' },
      { id: 'pen', path: 'M4 20l4-1 9-9-3-3-9 9zM14 7l3 3', cn: '画笔', en: 'Pen' },
      { id: 'text', path: 'M5 5h14M12 5v14M9 19h6', cn: '文字', en: 'Text' },
      { id: 'mosaic', path: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z', cn: '马赛克', en: 'Mosaic' },
    ]
    const COLORS = ['#f5222d', '#fa8c16', '#52c41a', '#1677ff']
    const MIN_SIZE = 8
    const TOOLBAR_WIDTH = 900
    /** 手动滚动截图时，抓帧相对选区各向内缩多少像素。 */
    const CAPTURE_INSET = 12
    /** 向 Host 要的预览图宽度：比显示尺寸大一截，显示时只缩小不放大，才不会糊。 */
    const PREVIEW_WIDTH = 760
    /** 预览卡的显示上限（会按图片比例在里面等比缩放，整张图都看得见）。 */
    const PREVIEW_MAX_W = 300
    const PREVIEW_MAX_H = 380
    /** 已经有结果时，要多拖这么远才允许重新拉选区（防误点清空长图）。 */
    const NEW_SELECTION_DRAG = 8
    /** 首屏快捷键提示只弹一次。 */
    const HINT_KEY = 'dsh-acut:hint-v1'

    /* ── 组件状态 ─────────────────────────────────────────────────────────── */
    const store = {
      state: {
        phase: 'idle', // idle | capturing | select | scrolling | saving
        frozen: null, // { dataUrl, width, height, cssWidth, cssHeight, source }
        rect: null, // 选区（CSS，相对视口）
        tool: 'rect',
        color: COLORS[0],
        annotations: [],
        draft: null,
        toast: null,
        showHelp: false,
      },
      listeners: new Set(),
      get() {
        return store.state
      },
      set(patch) {
        store.state = { ...store.state, ...patch }
        for (const listener of store.listeners) listener()
      },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      },
      reset() {
        store.set({ phase: 'idle', frozen: null, rect: null, annotations: [], draft: null, showHelp: false, manualId: null, manualRect: null, manualFrames: 0, manualW: 0, manualH: 0, manualError: null, manualPreview: null, manualFull: false })
      },
    }

    const useStore = () => {
      const [, force] = useState(0)
      useEffect(() => store.subscribe(() => force((n) => n + 1)), [])
      return store.state
    }

    let toastTimer = null
    const toast = (text) => {
      store.set({ toast: text })
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => store.set({ toast: null }), 3200)
    }

    /* ── 与 Host 通信 ─────────────────────────────────────────────────────── */
    const API = '/dsh-acut'

    async function post(path, body) {
      const response = await fetch(`${API}/${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const text = await response.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error(`${response.status} ${text.slice(0, 160)}`)
      }
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`)
      return data
    }

    /** 诊断用：把关键事件写进 Host 的日志文件，页面自己不丢线索。 */
    let logSeq = 0
    const log = (message) => {
      try {
        void fetch(`${API}/log`, {
          method: 'POST',
          credentials: 'same-origin',
          keepalive: true,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seq: ++logSeq, message: String(message).slice(0, 500), at: new Date().toISOString() }),
        }).catch(() => {})
      } catch {
        /* 日志本身不能影响截图 */
      }
    }

    // 渲染期异常也写进日志，方便定位"按了快捷键却没反应"。
    try {
      window.addEventListener('error', (event) => {
        try { log(`page:error ${event.message} @${event.filename}:${event.lineno}`) } catch { /* 忽略 */ }
      })
      window.addEventListener('unhandledrejection', (event) => {
        try { log(`page:reject ${String(event.reason?.message ?? event.reason)}`) } catch { /* 忽略 */ }
      })
    } catch { /* 忽略 */ }

    /** 窗口装饰到内容区的偏移：抓屏要按内容区对齐，页面坐标才对得上。 */
    const chromeOffsets = () => {
      const chromeX = Math.max(0, Math.round(((window.outerWidth || 0) - window.innerWidth) / 2))
      const chromeY = Math.max(0, Math.round((window.outerHeight || 0) - window.innerHeight))
      return { chromeX, chromeY }
    }

    const windowQuery = () => ({
      title: typeof document !== 'undefined' ? document.title : '',
      bounds: {
        x: Math.round(window.screenX || 0),
        y: Math.round(window.screenY || 0),
        width: Math.round(window.outerWidth || 0),
        height: Math.round(window.outerHeight || 0),
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scale: window.devicePixelRatio || 1,
      ...chromeOffsets(),
    })

    async function openCapture() {
      if (store.state.phase !== 'idle' && store.state.phase !== 'select') return
      log('openCapture:start')
      store.set({ phase: 'capturing' })
      try {
        const data = await post('freeze', windowQuery())
        log(`openCapture:ok source=${data.source} ${data.width}x${data.height} css=${data.cssWidth}x${data.cssHeight} scale=${data.scale}`)
        store.set({ phase: 'select', frozen: data, rect: null, annotations: [], draft: null })
      } catch (error) {
        log(`openCapture:fail ${String(error?.message ?? error)}`)
        store.reset()
        toast(`${T('截图失败：', 'Capture failed: ')}${String(error?.message ?? error)}`)
      }
    }

    /**
     * 把 host 返回的一张位图摆成冻结帧：等比缩进窗口、居中，再把选区（可选）预设成整张。
     * @param {{dataUrl:string,width:number,height:number,screenRect?:object}} data
     * @param {{presetRect:boolean}} options
     */
    function presentFrozen(data, options) {
      const imgW = Math.max(1, Number(data.width) || 1)
      const imgH = Math.max(1, Number(data.height) || 1)
      const vw = window.innerWidth
      const vh = window.innerHeight
      const fit = Math.min(1, (vw - 48) / imgW, (vh - 140) / imgH)
      const cssW = Math.max(1, Math.round(imgW * fit))
      const scale = imgW / cssW
      const cssH = Math.max(1, Math.round(imgH / scale))
      const offsetX = Math.round((vw - cssW) / 2)
      const offsetY = Math.round((vh - cssH) / 2)
      log(`presentFrozen ${imgW}x${imgH} css=${cssW}x${cssH} scale=${scale.toFixed(2)} preset=${options.presetRect}`)
      store.set({
        phase: 'select',
        frozen: { dataUrl: data.dataUrl, width: imgW, height: imgH, cssWidth: cssW, cssHeight: cssH, scale, offsetX, offsetY, source: 'crop', screenRect: data.screenRect },
        rect: options.presetRect ? { x: offsetX, y: offsetY, width: cssW, height: cssH } : null,
        annotations: [],
        draft: null,
      })
    }

    /**
     * 截图入口，三层降级：
     * 1. 原生全屏框选（整块桌面上随便框，浏览器/别的应用都行）
     * 2. 拿不到原生层时：抓整屏，在窗口里当缩略图框选
     * 3. 再不行：退回原来的"只框本窗口"路径
     */
    async function startCapture(mode = 'rect') {
      if (store.state.phase !== 'idle' && store.state.phase !== 'select') return
      log(`startCapture:${mode}`)
      store.set({ phase: 'capturing' })
      const hints = {
        hint: T('悬停自动吸附：窗口 / 应用内模块 / 网页元素', 'Hover to snap: window / pane / web element'),
        hintKeys: T('单击确认 · Tab 换吸附层级 · 方向键微调 1px（Shift 10px）· 按住 Ctrl 自由框选', 'Click to confirm · Tab cycles levels · arrows 1px (Shift 10px) · hold Ctrl for a free drag'),
        hintDone: T('Enter 完成 · Esc 取消 · 双击 = 整屏', 'Enter confirm · Esc cancel · double-click = whole screen'),
      }
      try {
        const data = await post('select', { mode, ...hints })
        if (data.cancelled) {
          store.reset()
          return
        }
        if (!data.ok) throw new Error(data.error || 'native select unavailable')
        presentFrozen(data, { presetRect: true })
        return
      } catch (error) {
        log(`startCapture:native unavailable ${String(error?.message ?? error)}`)
      }
      try {
        // 退一步：抓整屏，让用户在窗口里的缩略图上框（精度差一点，但能截到任何画面）。
        const data = await post('select', { mode: 'full', ...hints })
        if (!data.ok) throw new Error(data.error || 'no desktop frame')
        presentFrozen(data, { presetRect: mode === 'full' })
        return
      } catch (error) {
        log(`startCapture:thumbnail unavailable ${String(error?.message ?? error)}`)
      }
      store.reset()
      await openCapture()
    }

    /* ── 几何与绘制 ───────────────────────────────────────────────────────── */
    const normalizeRect = (rect) => ({
      x: Math.min(rect.x, rect.x + rect.width),
      y: Math.min(rect.y, rect.y + rect.height),
      width: Math.abs(rect.width),
      height: Math.abs(rect.height),
    })

    function drawArrow(ctx, from, to, width) {
      const angle = Math.atan2(to.y - from.y, to.x - from.x)
      const head = Math.max(10, width * 4)
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(to.x - Math.cos(angle) * head * 0.7, to.y - Math.sin(angle) * head * 0.7)
      ctx.lineWidth = width
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(to.x, to.y)
      ctx.lineTo(to.x - Math.cos(angle - 0.42) * head, to.y - Math.sin(angle - 0.42) * head)
      ctx.lineTo(to.x - Math.cos(angle + 0.42) * head, to.y - Math.sin(angle + 0.42) * head)
      ctx.closePath()
      ctx.fill()
    }

    function drawAnnotations(ctx, items) {
      for (const item of items) {
        ctx.save()
        ctx.strokeStyle = item.color
        ctx.fillStyle = item.color
        ctx.lineWidth = item.width || 3
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        if (item.type === 'rect') {
          const r = normalizeRect(item.rect)
          ctx.strokeRect(r.x, r.y, r.width, r.height)
        } else if (item.type === 'ellipse') {
          const r = normalizeRect(item.rect)
          ctx.beginPath()
          ctx.ellipse(r.x + r.width / 2, r.y + r.height / 2, Math.max(1, r.width / 2), Math.max(1, r.height / 2), 0, 0, Math.PI * 2)
          ctx.stroke()
        } else if (item.type === 'arrow') {
          drawArrow(ctx, item.from, item.to, item.width || 3)
        } else if (item.type === 'pen') {
          if (item.points.length > 1) {
            ctx.beginPath()
            ctx.moveTo(item.points[0].x, item.points[0].y)
            for (let i = 1; i < item.points.length; i++) ctx.lineTo(item.points[i].x, item.points[i].y)
            ctx.stroke()
          }
        } else if (item.type === 'text') {
          const size = item.fontSize || 18
          ctx.font = `600 ${size}px Inter, system-ui, -apple-system, sans-serif`
          ctx.textBaseline = 'top'
          String(item.text || '').split('\n').forEach((line, index) => {
            ctx.fillText(line, item.x, item.y + index * size * 1.25)
          })
        }
        ctx.restore()
      }
    }

    /** 马赛克：把目标区域压到 1/block 再放大，得到硬边像素块。 */
    function applyMosaic(canvas, item) {
      const r = normalizeRect(item.rect)
      const block = Math.max(6, item.block || 10)
      const w = Math.max(1, Math.round(r.width / block))
      const h = Math.max(1, Math.round(r.height / block))
      const tmp = document.createElement('canvas')
      tmp.width = w
      tmp.height = h
      const tctx = tmp.getContext('2d')
      tctx.imageSmoothingEnabled = false
      tctx.drawImage(canvas, r.x, r.y, r.width, r.height, 0, 0, w, h)
      const ctx = canvas.getContext('2d')
      ctx.save()
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(tmp, 0, 0, w, h, r.x, r.y, r.width, r.height)
      ctx.restore()
    }

    /**
     * 把底图的选区 + 标注合成到画布上。坐标系始终是"选区内的 CSS 像素"。
     * @param {HTMLCanvasElement} canvas
     * @param {{image:HTMLImageElement, sel:object, scaleX:number, scaleY:number, dpr:number, annotations:Array, draft:object|null}} options
     */
    function compose(canvas, options) {
      const { image, sel, scaleX, scaleY, dpr, annotations, draft, offsetX = 0, offsetY = 0 } = options
      const cssW = Math.max(1, sel.width)
      const cssH = Math.max(1, sel.height)
      canvas.width = Math.max(1, Math.round(cssW * dpr))
      canvas.height = Math.max(1, Math.round(cssH * dpr))
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(image, (sel.x - offsetX) * scaleX, (sel.y - offsetY) * scaleY, cssW * scaleX, cssH * scaleY, 0, 0, cssW, cssH)
      const all = draft ? annotations.concat([draft]) : annotations
      const mosaic = all.filter((item) => item.type === 'mosaic')
      drawAnnotations(ctx, all.filter((item) => item.type !== 'mosaic'))
      for (const item of mosaic) applyMosaic(canvas, item)
      return canvas
    }

    /* ── 遮罩组件 ─────────────────────────────────────────────────────────── */
    // 重新加载插件时，旧页面里的那份遮罩可能还挂在 DOM 上（还会吃鼠标事件）。
    // 新实例挂载时把"上一代"实例的 store 复位，让它们自己卸载。
    /** 本实例的 UI 标记：旧实例（插件重载后）残留的 DOM 会被新实例清掉。 */
    const UI_ID = `acut-${Math.random().toString(36).slice(2, 10)}`

    const instanceMounts = (() => {
      try {
        window.__dshAcutMounts = window.__dshAcutMounts || []
        return window.__dshAcutMounts
      } catch {
        return []
      }
    })()

    function ScreenshotOverlay() {
      const state = useStore()
      useEffect(() => {
        // 语言跟随系统：Host 用 Electron 的系统语言解析，页面只负责套上文案表。
        let alive = true
        void fetch(`${API}/locale`, { credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => {
            if (!alive || !data?.ok) return
            const nextLang = normalizeTag(data.lang)
            if (nextLang) ACTIVE_LANG = nextLang
            STRINGS = data.strings || {}
            log(`locale ${data.locale} → ${ACTIVE_LANG} (${data.source})`)
            store.set({ lang: ACTIVE_LANG, locale: data.locale })
          })
          .catch(() => {
            /* 拿不到就继续用浏览器语言猜的 */
          })
        return () => {
          alive = false
        }
      }, [])

      useEffect(() => {
        // 插件热重载后，上一代实例的节点可能还留在 DOM 里（还会吃鼠标事件、挡视线）。
        try {
          for (const node of document.querySelectorAll('[data-dsh-acut-ui]')) {
            if (node.getAttribute('data-dsh-acut-ui') !== UI_ID) node.remove()
          }
        } catch {
          /* 清理失败不影响截图 */
        }
        const self = { at: Date.now(), dismiss: () => store.reset() }
        const now = Date.now()
        for (const other of instanceMounts) {
          if (other !== self && now - other.at > 1500) {
            try {
              other.dismiss()
            } catch {
              /* 旧实例已经不能响应就算了 */
            }
          }
        }
        instanceMounts.push(self)
        return () => {
          const index = instanceMounts.indexOf(self)
          if (index >= 0) instanceMounts.splice(index, 1)
        }
      }, [])
      const rootRef = useRef(null)
      const canvasRef = useRef(null)
      const imageRef = useRef(null)
      const dragRef = useRef(null)
      const pendingNewRef = useRef(null)
      const boxRef = useRef({ width: 1280, height: 800 })
      const [imageReady, setImageReady] = useState(false)
      const [editing, setEditing] = useState(null)
      const [box, setBox] = useState(boxRef.current)

      // 冻结帧加载
      useEffect(() => {
        setImageReady(false)
        setEditing(null)
        if (!state.frozen) return
        const img = new Image()
        img.onload = () => {
          imageRef.current = img
          const next = { width: state.frozen.cssWidth || window.innerWidth, height: state.frozen.cssHeight || window.innerHeight }
          boxRef.current = next
          setBox(next)
          setImageReady(true)
        }
        img.onerror = () => toast(T('截图读取失败', 'Could not load the capture'))
        img.src = state.frozen.dataUrl
      }, [state.frozen?.dataUrl])

      const scaleX = state.frozen?.scale || (state.frozen && box.width ? state.frozen.width / box.width : 1)
      const scaleY = scaleX

      // 选区 / 标注变化后重画选区画布
      useEffect(() => {
        if (!state.frozen || !state.rect || !imageReady) return
        const canvas = canvasRef.current
        const image = imageRef.current
        if (!canvas || !image) return
        compose(canvas, {
          image,
          sel: state.rect,
          scaleX,
          scaleY,
          offsetX: state.frozen?.offsetX || 0,
          offsetY: state.frozen?.offsetY || 0,
          dpr: window.devicePixelRatio || 1,
          annotations: state.annotations,
          draft: state.draft,
        })
      }, [state.frozen, state.rect, state.annotations, state.draft, imageReady, scaleX, scaleY])

      const local = (event) => {
        const rect = rootRef.current?.getBoundingClientRect() || { left: 0, top: 0 }
        return { x: event.clientX - rect.left, y: event.clientY - rect.top }
      }

      const clampToViewport = (rect) => {
        const x = Math.max(0, Math.min(rect.x, window.innerWidth - MIN_SIZE))
        const y = Math.max(0, Math.min(rect.y, window.innerHeight - MIN_SIZE))
        return { x, y, width: Math.max(0, Math.min(rect.width, window.innerWidth - x)), height: Math.max(0, Math.min(rect.height, window.innerHeight - y)) }
      }

      const insideSelection = (point) => {
        const rect = state.rect
        return Boolean(rect) && point.x > rect.x && point.x < rect.x + rect.width && point.y > rect.y && point.y < rect.y + rect.height
      }

      const hitTest = (point) => {
        const rect = state.rect
        if (!rect) return 'new'
        const edge = 7
        const nearLeft = Math.abs(point.x - rect.x) <= edge
        const nearRight = Math.abs(point.x - (rect.x + rect.width)) <= edge
        const nearTop = Math.abs(point.y - rect.y) <= edge
        const nearBottom = Math.abs(point.y - (rect.y + rect.height)) <= edge
        if (nearLeft && nearTop) return 'nw'
        if (nearRight && nearTop) return 'ne'
        if (nearLeft && nearBottom) return 'sw'
        if (nearRight && nearBottom) return 'se'
        if (nearLeft) return 'w'
        if (nearRight) return 'e'
        if (nearTop) return 'n'
        if (nearBottom) return 's'
        if (insideSelection(point)) return 'move'
        return 'new'
      }

      /* —— 标注（坐标一律是"选区内部坐标"，导出时不用再换算） —— */
      const toLocal = (point) => ({ x: point.x - (state.rect?.x || 0), y: point.y - (state.rect?.y || 0) })

      const startAnnotation = (pagePoint) => {
        const point = toLocal(pagePoint)
        const base = { color: state.color, width: 3 }
        if (state.tool === 'pen') store.set({ draft: { type: 'pen', points: [point], ...base } })
        else if (state.tool === 'arrow') store.set({ draft: { type: 'arrow', from: point, to: point, ...base } })
        else if (state.tool === 'mosaic') store.set({ draft: { type: 'mosaic', rect: { x: point.x, y: point.y, width: 0, height: 0 }, block: 10, color: state.color } })
        else if (state.tool === 'text') {
          const next = state.annotations.concat([{ type: 'text', x: point.x, y: point.y, text: '', fontSize: 18, color: state.color }])
          store.set({ annotations: next })
          setEditing({ index: next.length - 1, value: '' })
          return
        } else store.set({ draft: { type: state.tool, rect: { x: point.x, y: point.y, width: 0, height: 0 }, ...base } })
        dragRef.current = { mode: 'annotation', start: point }
      }

      const moveAnnotation = (pagePoint) => {
        const drag = dragRef.current
        const draft = state.draft
        if (!drag || drag.mode !== 'annotation' || !draft) return
        const point = toLocal(pagePoint)
        if (draft.type === 'pen') store.set({ draft: { ...draft, points: draft.points.concat([point]) } })
        else if (draft.type === 'arrow') store.set({ draft: { ...draft, to: point } })
        else
          store.set({
            draft: {
              ...draft,
              rect: {
                x: Math.min(drag.start.x, point.x),
                y: Math.min(drag.start.y, point.y),
                width: Math.abs(point.x - drag.start.x),
                height: Math.abs(point.y - drag.start.y),
              },
            },
          })
      }

      const endAnnotation = () => {
        const draft = state.draft
        dragRef.current = null
        if (!draft) return
        const tiny =
          draft.type === 'pen'
            ? draft.points.length < 2
            : draft.type === 'arrow'
              ? Math.hypot(draft.to.x - draft.from.x, draft.to.y - draft.from.y) < 5
              : (draft.rect?.width ?? 0) < 5 || (draft.rect?.height ?? 0) < 5
        if (!tiny) store.set({ annotations: state.annotations.concat([draft]) })
        store.set({ draft: null })
      }

      const commitEditing = () => {
        setEditing((current) => {
          if (!current) return null
          const next = store.state.annotations.slice()
          if (next[current.index]) {
            if (String(current.value).trim() === '') next.splice(current.index, 1)
            else next[current.index] = { ...next[current.index], text: current.value }
          }
          store.set({ annotations: next })
          return null
        })
      }

      /* —— 指针 —— */
      const onPointerDown = (event) => {
        if (store.state.phase === 'idle') return
        if (event.button !== 0) return
        if (event.target.closest?.('[data-dsh-toolbar]')) return
        if (editing) commitEditing()
        const point = local(event)
        const mode = hitTest(point)
        if (state.rect) {
          if (mode !== 'new' && mode !== 'move') {
            // 贴着选区边缘：调整大小
            dragRef.current = { mode, start: point, origin: { ...state.rect } }
            return
          }
          if (mode === 'move' || insideSelection(point)) {
            // 选区内部：用当前工具画标注
            startAnnotation(point)
            return
          }
        }
        // 没有选区，或按在选区外面：准备重新拉选区。
        // 但先不拆掉现有结果——必须真的拖动超过阈值才换选区，否则一次误点就把长图弄没了。
        dragRef.current = { mode: 'new', start: point, origin: { x: point.x, y: point.y, width: 0, height: 0 }, armed: !state.rect }
        if (state.rect) pendingNewRef.current = point
      }

      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (!drag) return
        const point = local(event)
        if (drag.mode === 'annotation') {
          moveAnnotation(point)
          return
        }
        if (drag.mode === 'new') {
          if (!drag.armed) {
            if (Math.hypot(point.x - drag.start.x, point.y - drag.start.y) < NEW_SELECTION_DRAG) return
            drag.armed = true
            pendingNewRef.current = null
            store.set({ annotations: [] })
          }
          store.set({
            rect: clampToViewport({
              x: Math.min(drag.start.x, point.x),
              y: Math.min(drag.start.y, point.y),
              width: Math.abs(point.x - drag.start.x),
              height: Math.abs(point.y - drag.start.y),
            }),
          })
          return
        }
        const dx = point.x - drag.start.x
        const dy = point.y - drag.start.y
        const o = drag.origin
        const rect = { ...o }
        if (drag.mode === 'move') {
          rect.x = o.x + dx
          rect.y = o.y + dy
        } else {
          if (drag.mode.includes('w')) {
            rect.x = o.x + dx
            rect.width = o.width - dx
          }
          if (drag.mode.includes('e')) rect.width = o.width + dx
          if (drag.mode.includes('n')) {
            rect.y = o.y + dy
            rect.height = o.height - dy
          }
          if (drag.mode.includes('s')) rect.height = o.height + dy
        }
        store.set({ rect: clampToViewport(normalizeRect(rect)) })
      }

      const onPointerUp = () => {
        pendingNewRef.current = null
        const drag = dragRef.current
        if (!drag) return
        if (drag.mode === 'annotation') {
          endAnnotation()
          return
        }
        dragRef.current = null
        const rect = store.state.rect
        if (!rect || rect.width < MIN_SIZE || rect.height < MIN_SIZE) store.set({ rect: null, annotations: [] })
      }

      /* —— 导出 —— */
      const renderOutput = useCallback(() => {
        const image = imageRef.current
        const sel = state.rect
        if (!image || !sel) throw new Error(T('还没有选区', 'No selection yet'))
        if (sel.width * scaleX < 4 || sel.height * scaleY < 4) throw new Error(T('选区太小了，先拖出一块区域', 'The selection is too small — drag a region first'))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(sel.width * scaleX))
        canvas.height = Math.max(1, Math.round(sel.height * scaleY))
        const ctx = canvas.getContext('2d')
        ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0)
        const offsetX = state.frozen?.offsetX || 0
        const offsetY = state.frozen?.offsetY || 0
        ctx.drawImage(image, (sel.x - offsetX) * scaleX, (sel.y - offsetY) * scaleY, sel.width * scaleX, sel.height * scaleY, 0, 0, sel.width, sel.height)
        const mosaic = state.annotations.filter((item) => item.type === 'mosaic')
        drawAnnotations(ctx, state.annotations.filter((item) => item.type !== 'mosaic'))
        for (const item of mosaic) {
          const r = normalizeRect(item.rect)
          const block = Math.max(6, item.block || 10)
          const w = Math.max(1, Math.round((r.width * scaleX) / block))
          const h = Math.max(1, Math.round((r.height * scaleY) / block))
          const tmp = document.createElement('canvas')
          tmp.width = w
          tmp.height = h
          const tctx = tmp.getContext('2d')
          tctx.imageSmoothingEnabled = false
          tctx.drawImage(canvas, r.x * scaleX, r.y * scaleY, r.width * scaleX, r.height * scaleY, 0, 0, w, h)
          ctx.save()
          ctx.imageSmoothingEnabled = false
          ctx.drawImage(tmp, 0, 0, w, h, r.x, r.y, r.width, r.height)
          ctx.restore()
        }
        return canvas.toDataURL('image/png')
      }, [state.rect, state.annotations, scaleX, scaleY])

      const copyToClipboard = async (dataUrl) => {
        try {
          const blob = await (await fetch(dataUrl)).blob()
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          return true
        } catch {
          return false
        }
      }

      const save = useCallback(async () => {
        try {
          store.set({ phase: 'saving' })
          const dataUrl = renderOutput()
          const data = await post('save', { dataUrl })
          const copied = await copyToClipboard(dataUrl)
          store.reset()
          toast(copied ? `${T('已复制到剪贴板，并存到', 'Copied to clipboard, saved to')} ${data.path}` : `${T('已保存到', 'Saved to')} ${data.path}`)
        } catch (error) {
          store.set({ phase: 'select' })
          toast(`${T('保存失败：', 'Save failed: ')}${String(error?.message ?? error)}`)
        }
      }, [renderOutput])

      /** 另存为：弹系统对话框，由用户决定路径（默认那份仍在截图目录里）。 */
      const saveAs = useCallback(async () => {
        try {
          const dataUrl = renderOutput()
          const data = await post('saveas', { dataUrl })
          if (data.canceled) toast(T('已取消另存为', 'Save as cancelled'))
          else toast(`${T('已另存为', 'Saved as')} ${data.path}`)
        } catch (error) {
          toast(`${T('另存为失败：', 'Save as failed: ')}${String(error?.message ?? error)}`)
        }
      }, [renderOutput])

      /** 钉住：把当前画面贴成置顶小窗口，边看边操作别的窗口。 */
      const pin = useCallback(async () => {
        try {
          const dataUrl = renderOutput()
          await post('pin', { dataUrl })
          store.reset()
          toast(T('已钉住：拖动移动，双击或 Esc 关闭', 'Pinned — drag to move, double-click to close'))
        } catch (error) {
          toast(`${T('钉住失败：', 'Pin failed: ')}${String(error?.message ?? error)}`)
        }
      }, [renderOutput])

      /** 滚动截图收工时直接钉住，不留文件。 */
      const pinManualScroll = useCallback(async () => {
        const id = store.state.manualId
        if (!id) return
        store.set({ phase: 'manual-finishing' })
        try {
          const data = await post('manual/pin', { id })
          store.reset()
          log(`manual:pin frames=${data.frames} ${data.width}x${data.height}`)
          toast(Tf('已钉住长图 {w}×{h}：拖动移动，双击关闭', 'Pinned {w}×{h} — drag to move, double-click to close', { w: data.width, h: data.height }))
        } catch (error) {
          store.reset()
          toast(`${T('钉住失败：', 'Pin failed: ')}${String(error?.message ?? error)}`)
        }
      }, [])


      /* —— 手动滚屏：用户自己滚，Host 逐帧抓 + 合并 —— */
      const startManualScroll = useCallback(async () => {
        const sel = state.rect
        if (!sel) return
        log(`manual:start rect=${Math.round(sel.x)},${Math.round(sel.y)},${Math.round(sel.width)},${Math.round(sel.height)}`)
        // 抓帧比选区各缩进 CAPTURE_INSET：虚线框画在选区外沿，缩进之后它绝不会被拍进去。
        const capture = {
          x: sel.x + CAPTURE_INSET,
          y: sel.y + CAPTURE_INSET,
          width: Math.max(8, sel.width - CAPTURE_INSET * 2),
          height: Math.max(8, sel.height - CAPTURE_INSET * 2),
        }
        store.set({ phase: 'manual-starting', manualRect: { ...sel }, manualFrames: 0, manualW: 0, manualH: 0, manualError: null, manualPreview: null })
        try {
          const data = await post('manual/start', {
            ...windowQuery(),
            rectCss: capture,
            intervalMs: 240,
          })
          store.set({ phase: 'manual', manualId: data.id, manualW: 0, manualH: 0 })
        } catch (error) {
          log(`manual:start-fail ${String(error?.message ?? error)}`)
          store.set({ phase: 'select' })
          toast(`${T('滚动截图启动失败：', 'Could not start the scrolling capture: ')}${String(error?.message ?? error)}`)
        }
      }, [state.rect])

      const finishManualScroll = useCallback(async () => {
        const id = store.state.manualId
        if (!id) return
        store.set({ phase: 'manual-finishing' })
        try {
          // 收工即保存：长图不再走标注界面，直接落盘 + 进剪贴板。
          const capture = await post('manual/stop', { id })
          store.set({ phase: 'saving', manualId: null, manualRect: null })
          const saved = await post('save', { dataUrl: capture.dataUrl })
          const copied = await copyToClipboard(capture.dataUrl)
          store.reset()
          log(`manual:save frames=${capture.frames} ${capture.width}x${capture.height} → ${saved.path}`)
          toast(copied
            ? Tf('已复制到剪贴板，并存到 {path}（{frames} 帧 · {w}×{h}）', 'Copied and saved to {path} ({frames} frames · {w}×{h})', { path: saved.path, frames: capture.frames, w: capture.width, h: capture.height })
            : Tf('已保存到 {path}（{frames} 帧 · {w}×{h}）', 'Saved to {path} ({frames} frames · {w}×{h})', { path: saved.path, frames: capture.frames, w: capture.width, h: capture.height }))
        } catch (error) {
          log(`manual:save-fail ${String(error?.message ?? error)}`)
          store.reset()
          toast(`${T('滚动截图保存失败：', 'Could not save the scroll capture: ')}${String(error?.message ?? error)}`)
        }
      }, [])

      const cancelManualScroll = useCallback(async () => {
        const id = store.state.manualId
        store.reset()
        if (id) void post('manual/cancel', { id }).catch(() => {})
        toast(T('已取消滚动截图', 'Scrolling capture cancelled'))
      }, [])

      // 手动模式里每 700ms 问一次进度
      useEffect(() => {
        if (state.phase !== 'manual' || !state.manualId) return undefined
        let alive = true
        const id = state.manualId
        const poll = async () => {
          try {
            const status = await post('manual/status', { id, previewMax: PREVIEW_WIDTH })
            if (alive) {
              const patch = { manualFrames: status.frames, manualW: status.width, manualH: status.height, manualError: status.error, manualFull: status.full }
              // 预览是限流返回的：没拿到新图就保留上一张，避免闪。
              if (status.preview) patch.manualPreview = status.preview
              store.set(patch)
            }
          } catch {
            /* 下一次再问 */
          }
        }
        void poll()
        const timer = setInterval(() => void poll(), 700)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [state.phase, state.manualId])

      /**
       * 光标下的元素。覆盖层自己会吃掉命中测试，所以先把 pointer-events 关掉再问。
       */
      const elementAt = (x, y) => {
        const root = rootRef.current
        let node = null
        try {
          if (root) root.style.pointerEvents = 'none'
          node = document.elementFromPoint(x, y)
        } finally {
          if (root) root.style.pointerEvents = ''
        }
        return node || document.body
      }

      /**
       * 找一个真能滚的祖先：从光标下的元素往上试，谁真的动了就滚谁。
       * 比"读 computed overflow"可靠——宿主可能把滚动交给 JS 或 virtual list。
       * @returns {Element|null} 真正被滚动的元素
       */
      const describeChain = (start) => {
        const rows = []
        let node = start
        for (let i = 0; i < 8; i++) {
          if (!node) break
          const style = getComputedStyle(node)
          rows.push(`${node.tagName}${node.className ? '.' + String(node.className).split(' ')[0].slice(0, 18) : ''}(oy=${style.overflowY},sh=${node.scrollHeight},ch=${node.clientHeight},st=${Math.round(node.scrollTop)})`)
          node = node.parentElement
        }
        return rows.join(' > ')
      }

      const scrollTarget = (x, y, dx, dy) => {
        const start = elementAt(x, y)
        let node = start
        while (node) {
          // 只滚"能吃掉大部分位移"的容器：只挪了 2px 的元素不该把整次滚动吞掉。
          if (dy) {
            const before = node.scrollTop
            node.scrollTop = before + dy
            const moved = node.scrollTop - before
            if (Math.abs(moved) >= Math.min(12, Math.abs(dy) * 0.5)) return node
            node.scrollTop = before
          }
          if (dx) {
            const beforeX = node.scrollLeft
            node.scrollLeft = beforeX + dx
            const movedX = node.scrollLeft - beforeX
            if (Math.abs(movedX) >= Math.min(12, Math.abs(dx) * 0.5)) return node
            node.scrollLeft = beforeX
          }
          node = node.parentElement
        }
        // 原生滚不动：可能是自己监听 wheel 做虚拟滚动的容器，派一个合成事件试试。
        try {
          const synthetic = new WheelEvent('wheel', { deltaX: dx, deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true, clientX: x, clientY: y })
          start.dispatchEvent(synthetic)
          if (synthetic.defaultPrevented) return start
        } catch {
          /* 老引擎没有 WheelEvent 构造器 */
        }
        return null
      }

      const wheelLogs = useRef(0)
      const onManualWheel = (event) => {
        if (store.state.phase !== 'manual') return
        event.preventDefault()
        let dx = event.deltaX || 0
        let dy = event.deltaY || 0
        if (event.shiftKey && dx === 0) {
          dx = dy
          dy = 0
        }
        // 行/页模式换算成像素，否则一次滚轮只挪 3px，看起来像没动。
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1
        dx *= unit
        dy *= unit
        const start = elementAt(event.clientX, event.clientY)
        const node = scrollTarget(event.clientX, event.clientY, dx, dy)
        if (wheelLogs.current < 3) {
          wheelLogs.current += 1
          log(`manual:wheel dy=${Math.round(dy)} hit=${node ? node.tagName + '.' + String(node.className || '').slice(0, 16) : 'NONE'} chain=${describeChain(start)}`)
        }
      }

      const manualDrag = useRef(null)
      const onManualPointerDown = (event) => {
        if (store.state.phase !== 'manual') return
        if (event.button !== 0) return
        if (event.target.closest?.('[data-dsh-manual-bar]')) return
        manualDrag.current = { x: event.clientX, y: event.clientY }
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }
      const onManualPointerMove = (event) => {
        const drag = manualDrag.current
        if (!drag) return
        const dx = event.clientX - drag.x
        const dy = event.clientY - drag.y
        if (dx === 0 && dy === 0) return
        drag.x = event.clientX
        drag.y = event.clientY
        // 抓住内容拖：内容跟着手走，所以滚动方向与位移相反。
        scrollTarget(event.clientX, event.clientY, -dx, -dy)
      }
      const onManualPointerUp = () => {
        manualDrag.current = null
      }


      // 快捷键：Esc 取消、Enter 保存
      useEffect(() => {
        if (state.phase === 'idle') return
        const onKey = (event) => {
          const phase = store.state.phase
          // 方向键微调选区：裸方向键移动 1px，Shift ×10，Alt 改成改大小。
          const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
          const dir = arrows[event.key]
          if (dir && phase === 'select' && !editing && store.state.rect) {
            event.preventDefault()
            event.stopPropagation()
            const rect = store.state.rect
            const step = event.shiftKey ? 10 : 1
            if (event.altKey) {
              store.set({
                rect: clampToViewport({
                  ...rect,
                  width: Math.max(MIN_SIZE, rect.width + dir[0] * step),
                  height: Math.max(MIN_SIZE, rect.height + dir[1] * step),
                }),
              })
            } else {
              store.set({ rect: clampToViewport({ ...rect, x: rect.x + dir[0] * step, y: rect.y + dir[1] * step }) })
            }
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            if (phase === 'manual' || phase === 'manual-starting') void cancelManualScroll()
            else store.reset()
          } else if (event.key === 'Enter' && phase === 'manual') {
            event.preventDefault()
            void finishManualScroll()
          } else if (event.key === 'Enter' && store.state.rect && !editing && phase === 'select') {
            event.preventDefault()
            save()
          } else if ((event.key === 's' || event.key === 'S') && !event.ctrlKey && !event.metaKey && !event.altKey && store.state.rect && !editing && phase === 'select') {
            event.preventDefault()
            void startManualScroll()
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [state.phase, editing, save, startManualScroll, finishManualScroll, cancelManualScroll])

      if (state.phase === 'idle') {
        // 保存完成后遮罩已经卸载，提示还得留在页面上。
        return state.toast ? h('div', { className: 'dshs-toast', 'data-dsh-acut-ui': UI_ID }, state.toast) : null
      }

      // ── 手动滚动截图：页面保持可见、可滚，只剩虚线框 + 进度条 ──
      if (state.phase === 'manual' || state.phase === 'manual-starting' || state.phase === 'manual-finishing') {
        const box = state.manualRect || state.rect
        const frames = state.manualFrames || 0
        const width = state.manualW || 0
        const height = state.manualH || 0
        const bar = manualBarPosition(box)
        return h('div', {
          ref: rootRef,
          className: 'dshs-manual',
          'data-dsh-acut-ui': UI_ID,
          onWheel: onManualWheel,
          onPointerDown: onManualPointerDown,
          onPointerMove: onManualPointerMove,
          onPointerUp: onManualPointerUp,
        },
        box ? h('div', {
          className: 'dshs-ants',
          style: { left: `${Math.round(box.x) - 8}px`, top: `${Math.round(box.y) - 8}px`, width: `${Math.round(box.width) + 16}px`, height: `${Math.round(box.height) + 16}px` },
        }) : null,
        h('div', { className: 'dshs-manual-bar', 'data-dsh-manual-bar': '1', style: bar },
          h('span', { className: 'dshs-manual-dot' }),
          h('span', { className: 'dshs-manual-stat' }, state.manualFull
            ? Tf('已达上限 {frames} 帧 · {w}×{h}', 'Limit reached · {frames} frames · {w}×{h}', { frames, w: width, h: height })
            : frames > 1 ? Tf('{frames} 帧 · {w}×{h}', '{frames} frames · {w}×{h}', { frames, w: width, h: height }) : (state.phase === 'manual-starting' ? T('正在启动…', 'Starting…') : T('滚一下开始拼接', 'Scroll to start stitching'))),
          h('span', { className: 'dshs-manual-hint' }, T('滚轮 / 拖动页面，上下左右都行', 'Wheel or drag the page, any direction')),
          h('button', { type: 'button', className: 'dshs-manual-btn', disabled: frames < 1 || state.phase === 'manual-finishing', title: T('钉住：收工并把长图贴成置顶小窗口', 'Pin: stop and pin the long image'), onClick: () => void pinManualScroll() }, T('钉住', 'Pin')),
          h('button', { type: 'button', className: 'dshs-manual-btn', onClick: () => void cancelManualScroll() }, T('取消', 'Cancel')),
          h('button', { type: 'button', className: 'dshs-manual-btn is-primary', disabled: frames < 1 || state.phase === 'manual-finishing', onClick: () => void finishManualScroll() }, T('完成', 'Done'))),
        state.manualPreview ? (() => {
          const dims = previewDims(width, height)
          const place = previewPosition(box, dims)
          return h('div', { className: 'dshs-preview', 'data-dsh-acut-ui': UI_ID, style: { ...place, width: `${Math.max(150, dims.width)}px` } },
            h('div', { className: 'dshs-preview-head' },
              h('span', null, T('拼接预览', 'Preview')),
              h('span', { className: 'dshs-preview-size' }, `${width}×${height}`)),
            h('div', {
              className: 'dshs-preview-body',
              style: { width: `${dims.width}px`, height: `${dims.height}px` },
            }, h('img', { src: state.manualPreview, alt: '', draggable: false })))
        })() : null
        )
      }
      // 冻结帧和滚屏抓帧期间必须什么都不画，否则自己的 UI 会被抓进截图里。
      if (state.phase === 'capturing') return null
      if (state.phase === 'saving') {
        return h('div', { className: 'dshs-busy', 'data-dsh-acut-ui': UI_ID }, h('span', { className: 'dshs-spinner' }), h('span', null, T('正在保存…', 'Saving…')))
      }

      const rect = state.rect
      const active = Boolean(rect && rect.width >= MIN_SIZE && rect.height >= MIN_SIZE)
      const toolbarStyle = toolbarPosition(rect, active)

      return h('div', {
        ref: rootRef,
        className: 'dshs-root',
        'data-dsh-acut-ui': UI_ID,
        onPointerDown,
        onPointerMove,
        onPointerUp,
      },
      h('img', {
        className: 'dshs-frame',
        src: state.frozen?.dataUrl,
        alt: '',
        draggable: false,
        style: {
          left: `${state.frozen?.offsetX || 0}px`,
          top: `${state.frozen?.offsetY || 0}px`,
          width: `${Math.round((state.frozen?.width || box.width) / (state.frozen?.scale || 1))}px`,
          height: `${Math.round((state.frozen?.height || box.height) / (state.frozen?.scale || 1))}px`,
        },
      }),
      active ? null : h('div', { className: 'dshs-dim' }),
      active
        ? h('div', {
            className: 'dshs-hole',
            style: { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` },
          })
        : null,
      active
        ? h('div', {
            className: 'dshs-selection',
            style: { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` },
          },
          h('canvas', { ref: canvasRef, className: 'dshs-canvas' }),
          ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((handle) => h('div', { key: handle, className: `dshs-handle dshs-handle-${handle}` })),
          h('div', { className: 'dshs-size' }, `${Math.round(rect.width * scaleX)} × ${Math.round(rect.height * scaleY)}`))
        : null,
      editing
        ? h('input', {
            className: 'dshs-text-input',
            autoFocus: true,
            value: editing.value,
            placeholder: T('输入文字', 'Type text'),
            style: {
              left: `${(state.rect?.x ?? 0) + (state.annotations[editing.index]?.x ?? 0)}px`,
              top: `${(state.rect?.y ?? 0) + (state.annotations[editing.index]?.y ?? 0)}px`,
              transform: 'translate(0, -130%)',
            },
            onChange: (event) => {
              const value = event.target.value
              const next = { ...editing, value }
              setEditing(next)
              const list = store.state.annotations.slice()
              if (list[editing.index]) list[editing.index] = { ...list[editing.index], text: value }
              store.set({ annotations: list })
            },
            onBlur: () => commitEditing(),
            onKeyDown: (event) => {
              event.stopPropagation()
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                commitEditing()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                commitEditing()
              }
            },
          })
        : null,
      h('div', {
        className: 'dshs-toolbar',
        'data-dsh-toolbar': '1',
        style: toolbarStyle,
        onPointerDown: (event) => event.stopPropagation(),
      },
      h('div', { className: 'dshs-tools' }, TOOLS.map((item) => h('button', {
        key: item.id,
        type: 'button',
        className: `dshs-icon${state.tool === item.id ? ' is-active' : ''}`,
        title: T(item.cn, item.en),
        'aria-label': T(item.cn, item.en),
        onClick: () => store.set({ tool: item.id }),
      }, icon(item.path)))),
      h('span', { className: 'dshs-divider' }),
      h('div', { className: 'dshs-colors' }, COLORS.map((color) => h('button', {
        key: color,
        type: 'button',
        className: `dshs-swatch${state.color === color ? ' is-active' : ''}`,
        title: color,
        'aria-label': color,
        style: { background: color },
        onClick: () => store.set({ color }),
      }))),
      h('span', { className: 'dshs-divider' }),
      h('button', {
        type: 'button',
        className: 'dshs-icon',
        title: T('撤销', 'Undo'),
        'aria-label': T('撤销', 'Undo'),
        disabled: state.annotations.length === 0,
        onClick: () => store.set({ annotations: state.annotations.slice(0, -1) }),
      }, icon('M9 14 4 9l5-5M4 9h9a7 7 0 0 1 0 14h-3')),
      h('button', {
        type: 'button',
        className: 'dshs-secondary',
        title: T('滚动截图：你自己滚，我边滚边拼成一张长图（快捷键 S）', 'Scrolling capture: you scroll, it stitches into one long image (S)'),
        'aria-label': T('滚动截图', 'Scrolling capture'),
        disabled: !active,
        onClick: startManualScroll,
      }, icon('M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4'), h('span', null, T('滚动截图', 'Scroll capture'))),
      h('button', {
        type: 'button',
        className: 'dshs-icon',
        title: T('重截', 'Retake'),
        'aria-label': T('重截', 'Retake'),
        onClick: () => { void openCapture() },
      }, icon('M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6')),
      h('button', {
        type: 'button',
        className: 'dshs-secondary',
        title: T('另存为：自己挑个位置再存一份（默认那份仍会保存）', 'Save as: pick where to keep a copy'),
        'aria-label': T('另存为', 'Save as'),
        disabled: !active,
        onClick: () => { void saveAs() },
      }, icon('M4 5h10l6 6v8H4zM9 5v5h6'), h('span', null, T('另存为', 'Save as'))),
      h('button', {
        type: 'button',
        className: 'dshs-secondary',
        title: T('钉住：把这张图贴成置顶小窗口（可拖动、可复制、双击关闭）', 'Pin: keep this image in a floating always-on-top window'),
        'aria-label': T('钉住', 'Pin'),
        disabled: !active,
        onClick: () => { void pin() },
      }, icon('M9 3h6l-1 5 3 3v2H7v-2l3-3-1-5zM12 13v8'), h('span', null, T('钉住', 'Pin'))),
      h('span', { className: 'dshs-divider' }),
      h('button', {
        type: 'button',
        className: `dshs-icon${state.showHelp ? ' is-active' : ''}`,
        title: T('快捷键一览', 'Keyboard shortcuts'),
        'aria-label': T('快捷键一览', 'Keyboard shortcuts'),
        onClick: () => store.set({ showHelp: !state.showHelp }),
      }, icon('M12 17h.01M9.5 9.2a2.6 2.6 0 1 1 3.9 2.4c-.9.5-1.4 1-1.4 2')),
      h('button', {
        type: 'button',
        className: 'dshs-icon',
        title: T('取消', 'Cancel'),
        'aria-label': T('取消', 'Cancel'),
        onClick: () => store.reset(),
      }, icon('M6 6l12 12M18 6 6 18')),
      h('button', {
        type: 'button',
        className: 'dshs-primary',
        title: T('复制并保存（Enter）', 'Copy and save (Enter)'),
        disabled: !active,
        onClick: save,
      }, icon('m5 12 4 4L19 6'), h('span', null, T('完成', 'Done')))),
      active ? null : h('div', { className: 'dshs-hint' }, T('拖动选择区域 · 方向键微调 · S 滚动截图 · Enter 完成 · Esc 取消', 'Drag to select · arrows nudge · S scroll capture · Enter finish · Esc cancel')),
      state.showHelp ? h('div', {
        className: 'dshs-help',
        'data-dsh-acut-ui': UI_ID,
        onPointerDown: (event) => event.stopPropagation(),
      },
      h('div', { className: 'dshs-help-title' }, T('快捷键', 'Shortcuts')),
      [
        ['Ctrl + Shift + X', T('截图：悬停自动吸附，框选屏幕上任意画面', 'Capture: hover snaps, frame anything on screen')],
        ['Tab', T('切换吸附层级：元素 → 模块 → 整个窗口', 'Cycle snap level: element -> pane -> window')],
        ['Ctrl（按住）', T('临时关掉吸附，自由框选', 'Hold to turn snapping off')],
        ['双击', T('直接选整屏', 'Select the whole screen')],
        ['← ↑ ↓ →', T('微调选区 1px', 'Nudge selection 1px')],
        ['Shift + 方向键', T('微调 10px', 'Nudge 10px')],
        ['Alt + 方向键', T('改选区大小', 'Resize the selection')],
        ['S', T('滚动截图', 'Scrolling capture')],
        ['Enter', T('完成：复制 + 保存', 'Done: copy + save')],
        ['Esc', T('取消', 'Cancel')],
      ].map(([keys, text]) => h('div', { key: keys, className: 'dshs-help-row' },
        h('kbd', null, keys),
        h('span', null, text)))) : null,
      state.toast ? h('div', { className: 'dshs-toast', 'data-dsh-acut-ui': UI_ID }, state.toast) : null,
      )
    }

    function toolbarPosition(rect, active) {
      if (!active || !rect) return { left: '50%', top: '16px', transform: 'translateX(-50%)' }
      const height = 52
      const gap = 12
      const maxLeft = Math.max(12, window.innerWidth - TOOLBAR_WIDTH - 12)
      const left = Math.min(Math.max(12, rect.x + rect.width - TOOLBAR_WIDTH), maxLeft)
      let top = rect.y + rect.height + gap
      if (top + height > window.innerHeight - 12) top = Math.max(12, rect.y - height - gap)
      return { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` }
    }

    /** 手动模式的进度条：优先放在选区外面，别把自己截进去。 */
    /** 悬浮预览框的位置：尽量不压住正在拼的选区（压住了会被拍进长图里）。 */
    /** 整张拼接图等比缩进预览卡（长图会变成很窄的一条，但能看全貌）。 */
    function previewDims(imageWidth, imageHeight) {
      const w = Number(imageWidth) || 0
      const h = Number(imageHeight) || 0
      if (!w || !h) return { width: PREVIEW_MAX_W, height: 120 }
      const ratio = w / h
      let width = PREVIEW_MAX_W
      let height = Math.round(width / ratio)
      if (height > PREVIEW_MAX_H) {
        height = PREVIEW_MAX_H
        width = Math.round(height * ratio)
      }
      return { width: Math.max(28, width), height: Math.max(24, height) }
    }

    /**
     * 预览卡摆在选区外面（摆进去就会被拍进长图），四个方向挑第一个放得下的，
     * 并且避开进度条。实在放不下才落到右上角。
     */
    function previewPosition(box, dims) {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const cardW = Math.max(150, dims?.width ?? PREVIEW_MAX_W)
      const cardH = (dims?.height ?? PREVIEW_MAX_H) + 40
      if (!box) return { left: `${Math.max(12, vw - cardW - 20)}px`, top: '16px' }

      const right = box.x + box.width
      const bottom = box.y + box.height
      const bar = manualBarPosition(box)
      const barLeft = parseFloat(bar.left) || 0
      const barTop = parseFloat(bar.top) || 0
      const barBox = { x: bar.transform ? (vw - 470) / 2 : barLeft, y: barTop, w: 470, h: 40 }
      const hitsBar = (x, y) => x < barBox.x + barBox.w && x + cardW > barBox.x && y < barBox.y + barBox.h && y + cardH > barBox.y
      const clamp = (value, low, high) => Math.max(low, Math.min(value, high))
      // 选区下面放进度条，所以"下方"这个位置要按进度条再往下让一让。
      const barUnder = barBox.y >= box.y && barBox.y < vh - 40
      const belowY = barUnder ? Math.max(bottom + 10, barBox.y + barBox.h + 8) : bottom + 10
      const candidates = [
        // 右 / 左：竖着贴着选区排
        { x: right + 10, y: clamp(box.y, 12, vh - cardH - 12), w: vw - right - 20, h: vh - 24 },
        { x: box.x - cardW - 10, y: clamp(box.y, 12, vh - cardH - 12), w: box.x - 20, h: vh - 24 },
        // 上 / 下：横着排在选区上方/下方（下方要避开进度条）
        { x: clamp(right - cardW, 12, vw - cardW - 12), y: 12, w: vw - 24, h: box.y - 24 },
        { x: clamp(right - cardW, 12, vw - cardW - 12), y: belowY, w: vw - 24, h: vh - belowY - 12 },
      ]
      for (const spot of candidates) {
        if (spot.w < cardW || spot.h < cardH) continue
        const x = Math.round(spot.x)
        const y = Math.round(spot.y)
        if (hitsBar(x, y)) continue
        return { left: `${x}px`, top: `${y}px` }
      }
      return { left: `${Math.max(12, vw - cardW - 20)}px`, top: `${Math.max(56, vh - cardH - 12)}px` }
    }

    function manualBarPosition(box) {
      const barWidth = 470
      const barHeight = 40
      const gap = 10
      if (!box) return { left: '50%', top: '12px', transform: 'translateX(-50%)' }
      const maxLeft = Math.max(8, window.innerWidth - barWidth - 8)
      let left = Math.min(Math.max(8, box.x + box.width - barWidth), maxLeft)
      if (box.y + box.height + gap + barHeight <= window.innerHeight - 8) return { left: `${left}px`, top: `${Math.round(box.y + box.height + gap)}px` }
      if (box.y - gap - barHeight >= 8) return { left: `${left}px`, top: `${Math.round(box.y - gap - barHeight)}px` }
      return { left: '50%', top: '8px', transform: 'translateX(-50%)' }
    }

    function screenRectFor(rect) {
      const scale = window.devicePixelRatio || 1
      const chrome = Math.max(0, (window.outerHeight || 0) - (window.innerHeight || 0))
      return {
        x: Math.round(((window.screenX || 0) + 0) * scale + rect.x * scale),
        y: Math.round(((window.screenY || 0) + chrome) * scale + rect.y * scale),
        width: Math.max(1, Math.round(rect.width * scale)),
        height: Math.max(1, Math.round(rect.height * scale)),
      }
    }

    function icon(path) {
      return h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: path }))
    }

    const STYLE = `
    .dshs-root{position:fixed;inset:0;z-index:2147482000;overflow:hidden;cursor:crosshair;user-select:none;-webkit-user-select:none;font-family:Inter,system-ui,-apple-system,sans-serif}
    .dshs-frame{position:absolute;left:0;top:0;display:block;pointer-events:none;user-select:none}
    .dshs-dim{position:absolute;inset:0;background:rgba(15,17,21,.52);pointer-events:none}
    .dshs-hole{position:absolute;pointer-events:none;box-shadow:0 0 0 9999px rgba(15,17,21,.52);outline:1px solid rgba(255,255,255,.85)}
    .dshs-selection{position:absolute;pointer-events:none}
    .dshs-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
    .dshs-handle{position:absolute;width:9px;height:9px;margin:-5px 0 0 -5px;border-radius:2px;background:#fff;border:1px solid rgba(0,0,0,.35)}
    .dshs-handle-nw{left:0;top:0}.dshs-handle-n{left:50%;top:0}.dshs-handle-ne{left:100%;top:0}
    .dshs-handle-e{left:100%;top:50%}.dshs-handle-se{left:100%;top:100%}.dshs-handle-s{left:50%;top:100%}
    .dshs-handle-sw{left:0;top:100%}.dshs-handle-w{left:0;top:50%}
    .dshs-size{position:absolute;left:0;top:-24px;padding:2px 6px;border-radius:4px;background:rgba(15,17,21,.82);color:#fff;font-size:12px;line-height:16px;white-space:nowrap;font-variant-numeric:tabular-nums}
    .dshs-toolbar{position:fixed;flex-wrap:nowrap;display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:10px;background:rgba(24,26,32,.97);box-shadow:0 8px 28px rgba(0,0,0,.38);color:#e9eaee;z-index:2147482100;cursor:default}
    .dshs-tools{display:flex;align-items:center;gap:2px}
    .dshs-icon{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer;padding:0}
    .dshs-icon:hover{background:rgba(255,255,255,.12)}
    .dshs-icon.is-active{background:#1677ff;color:#fff}
    .dshs-icon:disabled{opacity:.38;cursor:default;background:transparent}
    .dshs-secondary{display:inline-flex;align-items:center;gap:4px;height:30px;padding:0 10px;border:1px solid rgba(255,255,255,.24);border-radius:7px;background:rgba(255,255,255,.06);color:#fff;font-size:12.5px;cursor:pointer;white-space:nowrap}
    .dshs-secondary:hover{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.4)}
    .dshs-secondary:disabled{opacity:.4;cursor:default;background:transparent}
    .dshs-primary{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 12px;border:0;border-radius:7px;background:#1677ff;color:#fff;font-size:13px;cursor:pointer}
    .dshs-primary:hover{background:#0e63d8}
    .dshs-primary:disabled{opacity:.45;cursor:default}
    .dshs-divider{width:1px;height:20px;background:rgba(255,255,255,.16)}
    .dshs-colors{display:flex;align-items:center;gap:5px}
    .dshs-swatch{width:16px;height:16px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0}
    .dshs-swatch.is-active{border-color:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.5)}
    .dshs-text-input{position:fixed;z-index:2147482200;min-width:120px;padding:4px 8px;border-radius:6px;border:1px solid #1677ff;background:rgba(24,26,32,.96);color:#fff;font-size:16px;outline:none}
    .dshs-hint{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);padding:8px 14px;border-radius:999px;background:rgba(24,26,32,.9);color:#fff;font-size:13px;pointer-events:none}
    .dshs-busy{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;background:rgba(15,17,21,.35);color:#fff;font-size:13px;z-index:2147482000;pointer-events:none}
    .dshs-busy span:last-child{padding:10px 16px;border-radius:10px;background:rgba(24,26,32,.94)}
    .dshs-spinner{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;animation:dshs-spin .8s linear infinite;position:absolute;margin-left:-120px}
    .dshs-manual{position:fixed;inset:0;z-index:2147482000;overflow:hidden;cursor:grab;user-select:none;-webkit-user-select:none;font-family:Inter,system-ui,-apple-system,sans-serif;background:transparent}
    .dshs-manual:active{cursor:grabbing}
    .dshs-ants{position:absolute;pointer-events:none;border:2px dashed rgba(255,255,255,.95);outline:2px dashed rgba(0,0,0,.55);background-image:repeating-linear-gradient(90deg,rgba(22,119,255,.9) 0 8px,transparent 8px 16px);background-size:16px 2px;background-repeat:repeat-x;background-position:0 0;animation:dshs-ants 1.2s linear infinite}
    @keyframes dshs-ants{from{background-position:0 0}to{background-position:16px 0}}
    .dshs-manual-bar{position:fixed;display:flex;align-items:center;gap:10px;height:40px;padding:0 10px;border-radius:10px;background:rgba(24,26,32,.96);color:#e9eaee;font-size:12.5px;z-index:2147482100;box-shadow:0 8px 24px rgba(0,0,0,.35);pointer-events:auto}
    .dshs-manual-dot{width:8px;height:8px;border-radius:50%;background:#ff4d4f;box-shadow:0 0 0 3px rgba(255,77,79,.25);animation:dshs-pulse 1.4s ease-in-out infinite}
    @keyframes dshs-pulse{0%,100%{opacity:1}50%{opacity:.35}}
    .dshs-preview{position:fixed;z-index:2147482100;display:flex;flex-direction:column;align-items:center;width:auto;border-radius:10px;overflow:hidden;background:rgba(24,26,32,.94);border:1px solid rgba(255,255,255,.16);box-shadow:0 14px 34px rgba(0,0,0,.42);pointer-events:none}
    .dshs-preview-head{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:6px 9px;font-size:11.5px;color:#e5e7eb;white-space:nowrap}
    .dshs-preview-size{margin-left:auto;color:#a8a29e;font-variant-numeric:tabular-nums}
    .dshs-preview-body{display:flex;align-items:center;justify-content:center;overflow:hidden;background:#0b0c0f}
    .dshs-preview-body img{display:block;width:100%;height:100%;object-fit:contain}
    .dshs-manual-stat{font-variant-numeric:tabular-nums;white-space:nowrap;color:#fff}
    .dshs-manual-hint{color:#a8a29e;white-space:nowrap}
    .dshs-manual-btn{height:26px;padding:0 10px;border:1px solid rgba(255,255,255,.22);border-radius:6px;background:transparent;color:#fff;font-size:12.5px;cursor:pointer}
    .dshs-manual-btn:hover{background:rgba(255,255,255,.14)}
    .dshs-manual-btn.is-primary{background:#1677ff;border-color:#1677ff}
    .dshs-manual-btn.is-primary:hover{background:#0e63d8}
    .dshs-manual-btn:disabled{opacity:.4;cursor:default}
    .dshs-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:70vw;padding:10px 16px;border-radius:10px;background:rgba(24,26,32,.96);color:#fff;font-size:13px;z-index:2147482300;pointer-events:none;word-break:break-all}
    .dshs-help{position:fixed;right:24px;bottom:24px;z-index:2147482200;background:rgba(20,22,28,.97);border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:12px 14px;color:#fff;font-size:12.5px;min-width:320px;box-shadow:0 18px 40px rgba(0,0,0,.45)}
    .dshs-help-title{font-size:11.5px;color:#a8a29e;margin-bottom:8px;letter-spacing:.06em;text-transform:uppercase}
    .dshs-help-row{display:flex;align-items:center;gap:10px;padding:3px 0}
    .dshs-help-row kbd{flex:0 0 auto;min-width:128px;font:inherit;font-size:12px;color:#c9d3ff;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);border-radius:6px;padding:2px 7px;text-align:center;white-space:nowrap}
    .dshs-help-row span{color:#e7e5e4}
    @keyframes dshs-spin{to{transform:rotate(360deg)}}
    `

    /* ── 插件入口 ─────────────────────────────────────────────────────────── */
    return {
      inject: ['slots'],
      apply(ctx) {
        log('apply')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dshScreenshot = '1'
          style.textContent = STYLE
          document.head.appendChild(style)

          const onKey = (event) => {
            const key = String(event.key || '').toLowerCase()
            if (!event.shiftKey || !(event.ctrlKey || event.metaKey)) return
            if (key !== 'x') return
            log(`hotkey:${key}`)
            event.preventDefault()
            event.stopPropagation()
            void startCapture('rect')
          }
          window.addEventListener('keydown', onKey, true)

          // 第一次装上时告诉用户快捷键在哪儿看，之后不再打扰。
          try {
            if (!window.localStorage.getItem(HINT_KEY)) {
              window.localStorage.setItem(HINT_KEY, '1')
              setTimeout(() => {
                store.set({ toast: T('截图：Ctrl+Shift+X · 悬停自动吸附窗口/模块/网页元素 · 单击确认 · Tab 换层级 · 工具栏 ? 看全部快捷键', 'Screenshot: Ctrl+Shift+X · hover snaps to window/pane/web element · click to confirm · Tab cycles · ? for all shortcuts') })
                setTimeout(() => store.set({ toast: null }), 9000)
              }, 1500)
            }
          } catch {
            /* 隐私模式没有 localStorage，就不提示了 */
          }

          return () => {
            window.removeEventListener('keydown', onKey, true)
            style.remove()
          }
        }, 'dsh-acut: hotkey + styles')

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-acut-overlay',
          order: 40,
        }, ScreenshotOverlay))

        log('slots registered')
      },
    }
  },
})
