/**
 * 像素操作：裁剪、等比缩放、纵向拼接。
 *
 * 拼接是"滚屏截图"的核心：相邻两帧之间总有一段重叠，重叠像素完全一致。
 * 这里先在候选位移里做粗搜（抽样行），再在最优点附近做精搜，最后把新内容
 * 接上去。比较只取中段列范围，避开滚动条与贴边悬浮层。
 *
 * @module dsh-acut/image
 */
import { decodePng, encodePng } from './png.js'

/** @typedef {{width:number,height:number,data:Buffer}} Raster */

/** @param {Buffer} buf @returns {Raster} */
export function decode(buf) {
  return decodePng(buf)
}

/** @param {Raster} raster @returns {Buffer} */
export function encode(raster) {
  return encodePng(raster)
}

/**
 * @param {Raster} src
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @returns {Raster}
 */
export function crop(src, rect) {
  const x = Math.max(0, Math.min(src.width - 1, Math.round(rect.x)))
  const y = Math.max(0, Math.min(src.height - 1, Math.round(rect.y)))
  const width = Math.max(1, Math.min(src.width - x, Math.round(rect.width)))
  const height = Math.max(1, Math.min(src.height - y, Math.round(rect.height)))
  const out = Buffer.alloc(width * height * 4)
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * src.width + x) * 4
    src.data.copy(out, row * width * 4, from, from + width * 4)
  }
  return { width, height, data: out }
}

/**
 * 缩到指定宽度（盒式平均），用于把 2x 截图降到逻辑像素尺寸。
 * @param {Raster} src
 * @param {number} width
 * @returns {Raster}
 */
export function resizeToWidth(src, width) {
  const target = Math.max(1, Math.round(width))
  if (target >= src.width) return src
  const scale = src.width / target
  const height = Math.max(1, Math.round(src.height / scale))
  const out = Buffer.alloc(target * height * 4)
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * scale)
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.ceil((y + 1) * scale)))
    for (let x = 0; x < target; x++) {
      const x0 = Math.floor(x * scale)
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.ceil((x + 1) * scale)))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        let idx = (yy * src.width + x0) * 4
        for (let xx = x0; xx < x1; xx++) {
          r += src.data[idx]
          g += src.data[idx + 1]
          b += src.data[idx + 2]
          a += src.data[idx + 3]
          idx += 4
          n++
        }
      }
      const o = (y * target + x) * 4
      out[o] = (r / n) | 0
      out[o + 1] = (g / n) | 0
      out[o + 2] = (b / n) | 0
      out[o + 3] = (a / n) | 0
    }
  }
  return { width: target, height, data: out }
}

/**
 * 位移 d 的归一化误差：假设 next 的前 d 行与 acc 的末 d 行是同一段内容。
 * 抽样行 + 抽样列，跨过整段重叠，贴边的悬浮层只会污染少数采样行。
 * @returns {number} 0..1
 */
function overlapError(acc, next, d, x0, x1, colStep) {
  if (d <= 0) return 1
  const rowStep = Math.max(1, Math.floor(d / 28))
  let sum = 0
  let count = 0
  for (let i = 0; i < d; i += rowStep) {
    const ai = ((acc.height - d + i) * acc.width + x0) * 4
    const bi = (i * next.width + x0) * 4
    for (let col = x0; col < x1; col += colStep) {
      const a = ai + (col - x0) * 4
      const b = bi + (col - x0) * 4
      sum += Math.abs(acc.data[a] - next.data[b]) + Math.abs(acc.data[a + 1] - next.data[b + 1]) + Math.abs(acc.data[a + 2] - next.data[b + 2])
      count += 3
    }
  }
  return count === 0 ? 1 : sum / (count * 255)
}

const MATCH_THRESHOLD = 0.014

/**
 * 把新的一帧接到已拼接图的底部。
 *
 * @param {Raster} acc 已拼接的内容
 * @param {Raster} next 新帧
 * @param {{maxHeight?:number, expectedOverlap?:number, minOverlapRatio?:number}} [options]
 * @returns {{raster:Raster, added:number, overlap:number, matched:boolean, error:number}}
 */
export function appendFrame(acc, next, options = {}) {
  const width = Math.min(acc.width, next.width)
  const maxHeight = options.maxHeight ?? 20000
  const maxOverlap = Math.min(acc.height, next.height)
  const minOverlap = Math.max(8, Math.round(Math.min(acc.height, next.height) * (options.minOverlapRatio ?? 0.05)))
  const x0 = Math.round(width * 0.06)
  const x1 = Math.max(x0 + 8, Math.round(width * 0.94))
  const colStep = width > 1200 ? 4 : width > 600 ? 3 : 2

  const candidates = []
  const coarseStep = Math.max(2, Math.round(maxOverlap / 220))
  for (let d = maxOverlap; d >= minOverlap; d -= coarseStep) candidates.push(d)

  let best = { d: 0, error: Number.POSITIVE_INFINITY }
  for (const d of candidates) {
    const error = overlapError(acc, next, d, x0, x1, colStep)
    // 误差明显更好才换；同样好时重叠更大更稳。
    if (error < best.error - 0.0015 || (Math.abs(error - best.error) <= 0.0015 && d > best.d)) best = { d, error }
    if (error < 0.0006) break
  }

  if (best.d > 0) {
    const from = Math.max(minOverlap, best.d - coarseStep)
    const to = Math.min(maxOverlap, best.d + coarseStep)
    for (let d = from; d <= to; d++) {
      const error = overlapError(acc, next, d, x0, x1, 1)
      if (error < best.error) best = { d, error }
    }
  }

  const matched = best.d >= minOverlap && best.error < MATCH_THRESHOLD
  const overlap = matched ? best.d : 0
  const added = Math.max(0, next.height - overlap)
  if (added === 0) return { raster: acc, added: 0, overlap, matched, error: best.error }

  const height = Math.min(maxHeight, acc.height + added)
  const usable = Math.max(0, height - acc.height)
  const out = Buffer.alloc(width * height * 4)
  for (let row = 0; row < acc.height; row++) {
    const from = row * acc.width * 4
    out.set(acc.data.subarray(from, from + width * 4), row * width * 4)
  }
  for (let row = 0; row < Math.min(added, usable); row++) {
    const from = (overlap + row) * next.width * 4
    out.set(next.data.subarray(from, from + width * 4), (acc.height + row) * width * 4)
  }
  return { raster: { width, height, data: out }, added: Math.min(added, usable), overlap, matched, error: best.error }
}


/* ── 四向合并（手动滚屏用） ──────────────────────────────────────────────
 * 手动滚屏时用户可能上下左右乱滚，甚至来回滚。这里对每一帧分别在
 * "接在下 / 上 / 右 / 左" 四个方向里找最佳重叠，选误差最小的那个接上去；
 * 四个方向都对不上就当作"没有新内容"，直接丢弃这一帧。
 */

/**
 * 第 d 个像素位移在某个方向的归一化误差。
 * @param {Raster} acc
 * @param {Raster} next
 * @param {'v'|'h'} axis
 * @param {'end'|'start'} side
 * @param {number} d
 * @param {number} [step] 抽样步长
 * @returns {number} 0..1
 */
function sideError(acc, next, axis, side, d, step) {
  if (d <= 0) return 1
  const vertical = axis === 'v'
  const spanAcc = vertical ? acc.height : acc.width
  const spanNext = vertical ? next.height : next.width
  const crossSize = vertical ? Math.min(acc.width, next.width) : Math.min(acc.height, next.height)
  const crossStart = Math.round(crossSize * 0.06)
  const crossEnd = Math.max(crossStart + 8, Math.round(crossSize * 0.94))
  const sample = step ?? (crossSize > 1200 ? 4 : crossSize > 600 ? 3 : 2)
  const rowStep = Math.max(1, Math.floor(d / 26))

  let sum = 0
  let count = 0
  for (let i = 0; i < d; i += rowStep) {
    if (vertical) {
      const accY = side === 'end' ? spanAcc - d + i : i
      const nextY = side === 'end' ? i : spanNext - d + i
      const accBase = (accY * acc.width + crossStart) * 4
      const nextBase = (nextY * next.width + crossStart) * 4
      for (let col = crossStart; col < crossEnd; col += sample) {
        const a = accBase + (col - crossStart) * 4
        const b = nextBase + (col - crossStart) * 4
        sum += Math.abs(acc.data[a] - next.data[b]) + Math.abs(acc.data[a + 1] - next.data[b + 1]) + Math.abs(acc.data[a + 2] - next.data[b + 2])
        count += 3
      }
    } else {
      const accX = side === 'end' ? spanAcc - d + i : i
      const nextX = side === 'end' ? i : spanNext - d + i
      for (let row = crossStart; row < crossEnd; row += sample) {
        const a = (row * acc.width + accX) * 4
        const b = (row * next.width + nextX) * 4
        sum += Math.abs(acc.data[a] - next.data[b]) + Math.abs(acc.data[a + 1] - next.data[b + 1]) + Math.abs(acc.data[a + 2] - next.data[b + 2])
        count += 3
      }
    }
  }
  return count === 0 ? 1 : sum / (count * 255)
}

const SIDES = [
  { axis: 'v', side: 'end' },
  { axis: 'v', side: 'start' },
  { axis: 'h', side: 'end' },
  { axis: 'h', side: 'start' },
]

const MERGE_THRESHOLD = 0.016

/**
 * 把一帧并进已经拼好的图里，方向自动判定。
 *
 * @param {Raster} acc 已拼好的图
 * @param {Raster} next 新帧（与 acc 等宽或等高）
 * @param {{maxWidth?:number,maxHeight?:number}} [options]
 * @returns {{raster:Raster, added:number, side:string|null, error:number, matched:boolean}}
 */
export function mergeFrame(acc, next, options = {}) {
  const maxWidth = options.maxWidth ?? 12000
  const maxHeight = options.maxHeight ?? 20000
  // 命中阈值：平均每通道误差 0.4% 以内就算同一段像素。
  const ACCEPT = 0.004
  const order = SIDES.slice()
  if (options.expected) {
    const index = order.findIndex((item) => `${item.axis}${item.side}` === options.expected.side)
    if (index > 0) order.unshift(order.splice(index, 1)[0])
  }

  // 位移从大到小扫：第一个"够像"的位移就用它——这等于"尽量多重叠、尽量少新增"，
  // 在空白/周期性内容上不会把同一段拼两遍（那是取最小误差最容易犯的错）。
  let best = null
  for (const candidate of order) {
    const axisLen = candidate.axis === 'v' ? Math.min(acc.height, next.height) : Math.min(acc.width, next.width)
    const minD = Math.max(8, Math.round(axisLen * 0.04))
    if (axisLen <= minD + 4) continue
    const coarse = Math.max(2, Math.round(axisLen / 160))
    let hit = null
    for (let d = axisLen; d >= minD; d -= coarse) {
      const error = sideError(acc, next, candidate.axis, candidate.side, d)
      if (error < ACCEPT) {
        hit = { d, error }
        break
      }
    }
    if (!hit) continue
    let refined = hit
    for (let d = Math.max(minD, hit.d - coarse); d <= Math.min(axisLen, hit.d + coarse); d++) {
      const error = sideError(acc, next, candidate.axis, candidate.side, d, 1)
      if (error < refined.error) refined = { d, error }
    }
    best = { side: `${candidate.axis}${candidate.side}`, d: refined.d, error: refined.error, axis: candidate.axis, dir: candidate.side }
    break
  }

  if (!best) return { raster: acc, added: 0, side: null, d: 0, error: 1, matched: false }
  return mergeAt(acc, next, best, maxWidth, maxHeight)
}

/** @param {{side:string,d:number,error:number,axis:'v'|'h',dir:'start'|'end'}} best */
function mergeAt(acc, next, best, maxWidth, maxHeight) {
  const { axis, dir, d } = best
  const vertical = axis === 'v'
  const nextSpan = vertical ? next.height : next.width
  const added = nextSpan - d
  if (added <= 0) return { raster: acc, added: 0, side: best.side, d, error: best.error, matched: true }

  if (vertical) {
    const width = Math.min(acc.width, next.width)
    const height = Math.min(maxHeight, acc.height + added)
    const usable = Math.max(0, height - acc.height)
    const out = Buffer.alloc(width * height * 4)
    if (dir === 'end') {
      for (let row = 0; row < acc.height; row++) out.set(acc.data.subarray(row * acc.width * 4, row * acc.width * 4 + width * 4), row * width * 4)
      for (let row = 0; row < Math.min(added, usable); row++) out.set(next.data.subarray((d + row) * next.width * 4, (d + row) * next.width * 4 + width * 4), (acc.height + row) * width * 4)
    } else {
      const take = Math.min(added, usable)
      for (let row = 0; row < take; row++) out.set(next.data.subarray(row * next.width * 4, row * next.width * 4 + width * 4), row * width * 4)
      const offset = take * width * 4
      for (let row = 0; row < acc.height; row++) out.set(acc.data.subarray(row * acc.width * 4, row * acc.width * 4 + width * 4), offset + row * width * 4)
    }
    return { raster: { width, height, data: out }, added: Math.min(added, usable), side: best.side, d, error: best.error, matched: true }
  }

  const height = Math.min(acc.height, next.height)
  const width = Math.min(maxWidth, acc.width + added)
  const usable = Math.max(0, width - acc.width)
  const out = Buffer.alloc(width * height * 4)
  if (dir === 'end') {
    for (let row = 0; row < height; row++) {
      out.set(acc.data.subarray(row * acc.width * 4, row * acc.width * 4 + acc.width * 4), row * width * 4)
      for (let col = 0; col < Math.min(added, usable); col++) {
        const from = (row * next.width + d + col) * 4
        out.set(next.data.subarray(from, from + 4), row * width * 4 + (acc.width + col) * 4)
      }
    }
  } else {
    const take = Math.min(added, usable)
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < take; col++) {
        const from = (row * next.width + col) * 4
        out.set(next.data.subarray(from, from + 4), row * width * 4 + col * 4)
      }
      const base = row * width * 4 + take * 4
      out.set(acc.data.subarray(row * acc.width * 4, row * acc.width * 4 + acc.width * 4), base)
    }
  }
  return { raster: { width, height, data: out }, added: Math.min(added, usable), side: best.side, d, error: best.error, matched: true }
}

/**
 * 拼接一串帧；遇到没有新内容（滚到底 / 弹回顶部）就停下。
 * @param {Raster[]} frames
 * @param {{maxHeight?:number, expectedOverlap?:number}} [options]
 * @returns {{raster:Raster, frames:number, stopped:string, lastError:number}}
 */
export function stitch(frames, options = {}) {
  if (!frames.length) throw new Error('no frames to stitch')
  let acc = frames[0]
  let used = 1
  let stopped = 'frames'
  let lastError = 0
  for (let i = 1; i < frames.length; i++) {
    const result = appendFrame(acc, frames[i], options)
    lastError = result.error
    if (result.added < 2) {
      stopped = 'reached-end'
      used++
      break
    }
    acc = result.raster
    used++
    if (acc.height >= (options.maxHeight ?? 20000)) {
      stopped = 'max-height'
      break
    }
  }
  return { raster: acc, frames: used, stopped, lastError }
}
