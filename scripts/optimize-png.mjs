// 把 raw RGBA 编码成体积最小的 PNG。
//
// 背景：System.Drawing 的 PNG 编码器压缩率一般（512x512 的立绘会编成
// 264 KB，而同样的像素用「最优行过滤 + zlib -9」可以压到 170 KB 上下）。
// 内联进 client.js 的 base64 会放大 4/3，所以文件每省 1 KB，bundle 省 1.33 KB，
// 这个差距值得自己编一遍。
//
// 用法:
//   powershell scripts/resize-art.ps1        # 先缩放并导出 raw
//   node scripts/optimize-png.mjs             # 再重新编码成 PNG
//
// raw 文件约定：assets/.work/<name>.raw = width*height*4 字节 RGBA，
// 配套 assets/.work/<name>.json 记录 { width, height }。
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, 'assets', '.work')

/** 计算 PNG CRC32。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 组一个 PNG chunk：长度 + 类型 + 数据 + CRC。 */
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

/**
 * 对每一行试 5 种过滤器（0 None / 1 Sub / 2 Up / 3 Average / 4 Paeth），
 * 取「绝对值和最小」的那个。这是 libpng 的默认启发式，能显著改善 deflate 率。
 */
function filterRows(rgba, width, height) {
  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc((stride + 1) * height)

  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    if (pa <= pb && pa <= pc) return a
    return pb <= pc ? b : c
  }

  for (let y = 0; y < height; y++) {
    const rowStart = y * stride
    const prevStart = (y - 1) * stride
    let bestType = 0
    let bestScore = Infinity
    let bestBuf = null

    for (let type = 0; type <= 4; type++) {
      const line = Buffer.alloc(stride)
      let score = 0
      for (let x = 0; x < stride; x++) {
        const cur = rgba[rowStart + x]
        const left = x >= bpp ? rgba[rowStart + x - bpp] : 0
        const up = y > 0 ? rgba[prevStart + x] : 0
        const upLeft = y > 0 && x >= bpp ? rgba[prevStart + x - bpp] : 0
        let v
        switch (type) {
          case 0: v = cur; break
          case 1: v = (cur - left) & 0xff; break
          case 2: v = (cur - up) & 0xff; break
          case 3: v = (cur - ((left + up) >> 1)) & 0xff; break
          default: v = (cur - paeth(left, up, upLeft)) & 0xff; break
        }
        line[x] = v
        // 有符号字节的绝对值和更适合评估压缩率
        score += v < 128 ? v : 256 - v
      }
      if (score < bestScore) {
        bestScore = score
        bestType = type
        bestBuf = line
      }
    }
    out[y * (stride + 1)] = bestType
    bestBuf.copy(out, y * (stride + 1) + 1)
  }
  return out
}

function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const filtered = filterRows(rgba, width, height)
  // level 9 + 尽量多试策略，取最小
  let best = null
  for (const strategy of [0, 1, 3]) {
    const packed = deflateSync(filtered, { level: 9, memLevel: 9, strategy })
    if (best === null || packed.length < best.length) best = packed
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', best),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

if (!existsSync(WORK)) {
  console.error('找不到 assets/.work，请先运行 scripts/resize-art.ps1')
  process.exit(1)
}

const raws = readdirSync(WORK).filter((f) => f.endsWith('.raw'))
if (raws.length === 0) {
  console.error('assets/.work 里没有 .raw 文件，请先运行 scripts/resize-art.ps1')
  process.exit(1)
}

let savedTotal = 0
for (const file of raws) {
  // raw 文件名带原始扩展名（DSniang02.png.raw），去掉 .raw 之后还要去掉扩展名，
  // 否则拼出来会变成 DSniang02.png.png。
  const base = file.replace(/\.raw$/, '')
  const name = base.replace(/\.(png|jpe?g|webp|gif)$/i, '')
  const meta = JSON.parse(readFileSync(join(WORK, base + '.json'), 'utf8'))
  const rgba = readFileSync(join(WORK, file))
  const expected = meta.width * meta.height * 4
  if (rgba.length !== expected) {
    console.error(`${name}: raw 长度 ${rgba.length} 与 ${meta.width}x${meta.height}x4=${expected} 不符`)
    process.exit(1)
  }
  const png = encodePng(rgba, meta.width, meta.height)
  const target = join(ROOT, 'assets', name + '.png')
  const before = existsSync(target) ? readFileSync(target).length : 0
  writeFileSync(target, png)
  savedTotal += before - png.length
  console.log(
    `${name}.png: ${meta.width}x${meta.height}, ${Math.round(before / 1024)} KB -> ${Math.round(png.length / 1024)} KB`,
  )
}
console.log(`合计省 ${Math.round(savedTotal / 1024)} KB（内联成 base64 后约省 ${Math.round((savedTotal * 4) / 3 / 1024)} KB）`)
