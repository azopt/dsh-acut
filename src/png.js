/**
 * 最小 PNG 编解码器（RGBA8）。
 *
 * 截图引擎需要裁剪和拼接像素，而 DSH 所在的 Electron 运行时里 `nativeImage`
 * 的 toBitmap() 在多倍屏上会掉到 1x，sharp 又不是必然可用的依赖。PNG 的
 * 结构本身很简单（zlib 是 Node 内置的），所以这里自带一份：
 * - decodePng：支持 8bit 的灰度/RGB/调色板/RGBA 与全部 5 种行过滤器，非隔行。
 * - encodePng：固定 RGBA、filter 0，zlib 默认压缩。
 *
 * @module dsh-acut/png
 */
import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf, start, end) {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * @param {Buffer} buf PNG 字节
 * @returns {{width:number,height:number,data:Buffer}} RGBA8 像素（行优先）
 */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) throw new Error('not a PNG: too short')
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG: bad signature')

  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette = null
  const idat = []

  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const start = pos + 8
    const end = start + length
    if (end > buf.length) throw new Error('PNG truncated')
    if (type === 'IHDR') {
      width = buf.readUInt32BE(start)
      height = buf.readUInt32BE(start + 4)
      bitDepth = buf[start + 8]
      colorType = buf[start + 9]
      interlace = buf[start + 12]
    } else if (type === 'PLTE') {
      palette = buf.subarray(start, end)
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(start, end))
    } else if (type === 'IEND') {
      break
    }
    pos = end + 4
  }

  if (width <= 0 || height <= 0) throw new Error('PNG has no image data')
  if (interlace !== 0) throw new Error('interlaced PNG is not supported')
  if (bitDepth !== 8) throw new Error(`PNG bit depth ${bitDepth} is not supported`)
  const channels = CHANNELS[colorType]
  if (channels === undefined) throw new Error(`PNG color type ${colorType} is not supported`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  if (raw.length < (stride + 1) * height) throw new Error('PNG pixel data is short')

  const out = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  let line = Buffer.alloc(stride)

  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1)
    const filter = raw[base]
    line = Buffer.from(raw.subarray(base + 1, base + 1 + stride))
    if (filter === 1) {
      for (let i = channels; i < stride; i++) line[i] = (line[i] + line[i - channels]) & 0xff
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 0xff
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? line[i - channels] : 0
        line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? line[i - channels] : 0
        const upperLeft = i >= channels ? prev[i - channels] : 0
        line[i] = (line[i] + paeth(left, prev[i], upperLeft)) & 0xff
      }
    } else if (filter !== 0) {
      throw new Error(`PNG filter ${filter} is not supported`)
    }

    let o = y * width * 4
    if (channels === 4) {
      line.copy(out, o)
    } else if (channels === 3) {
      for (let x = 0; x < width; x++) {
        out[o] = line[x * 3]
        out[o + 1] = line[x * 3 + 1]
        out[o + 2] = line[x * 3 + 2]
        out[o + 3] = 255
        o += 4
      }
    } else if (channels === 2) {
      for (let x = 0; x < width; x++) {
        const v = line[x * 2]
        out[o] = v
        out[o + 1] = v
        out[o + 2] = v
        out[o + 3] = line[x * 2 + 1]
        o += 4
      }
    } else if (colorType === 3) {
      if (palette === null) throw new Error('indexed PNG without a palette')
      for (let x = 0; x < width; x++) {
        const idx = line[x] * 3
        out[o] = palette[idx] ?? 0
        out[o + 1] = palette[idx + 1] ?? 0
        out[o + 2] = palette[idx + 2] ?? 0
        out[o + 3] = 255
        o += 4
      }
    } else {
      for (let x = 0; x < width; x++) {
        out[o] = line[x]
        out[o + 1] = line[x]
        out[o + 2] = line[x]
        out[o + 3] = 255
        o += 4
      }
    }

    const swap = prev
    prev = line
    line = swap
  }

  return { width, height, data: out }
}

function chunk(type, payload) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(payload.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload]), 0, payload.length + 4), 0)
  return Buffer.concat([head, payload, crc])
}

/**
 * @param {{width:number,height:number,data:Buffer}} image
 * @returns {Buffer} PNG 字节
 */
export function encodePng(image) {
  const { width, height, data } = image
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
