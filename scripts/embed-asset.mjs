// 把 assets/whale.png 内联进 lib/client.js 的 WHALE_DATA_URI 常量。
//
// 为什么必须内联：DSH 宿主只允许插件通过 `/plugins/<id>/client.<name>.js` 提供
// 客户端 chunk（CLIENT_CHUNK 正则只放行 js/map），图片之类的外部静态文件没有路由，
// 而 client bundle 的 require 也只认宿主模块，不能按相对路径 require 本地文件。
//
// 用法：node scripts/embed-asset.mjs [--check]
//   --check  只校验当前内联值与 assets/whale.png 是否一致，不写文件
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pngPath = join(root, 'assets', 'whale.png')
const clientPath = join(root, 'lib', 'client.js')

const MARK_BEGIN = '//#region whale-asset'
const MARK_END = '//#endregion whale-asset'

const check = process.argv.includes('--check')

const png = await readFile(pngPath)
const hash = createHash('sha256').update(png).digest('hex').slice(0, 16)
const uri = `data:image/png;base64,${png.toString('base64')}`

const raw = await readFile(clientPath, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'

const block = [
  MARK_BEGIN,
  `\t\t/** 鲸鱼立绘（内联 data URI，源文件 assets/whale.png，sha256:${hash}）。 */`,
  `\t\tconst WHALE_DATA_URI = "${uri}";`,
  MARK_END,
].join(eol)

const beginIdx = raw.indexOf(MARK_BEGIN)
const endIdx = raw.indexOf(MARK_END)

if (check) {
  if (beginIdx < 0) {
    console.error('MISSING: lib/client.js 里没有 whale-asset 区块')
    process.exit(1)
  }
  const current = raw.slice(beginIdx, endIdx + MARK_END.length)
  const m = /sha256:([0-9a-f]{16})/.exec(current)
  if (m === null || m[1] !== hash) {
    console.error(`STALE: 内联图与 assets/whale.png 不一致（内联=${m ? m[1] : '无'}，当前=${hash}）`)
    process.exit(1)
  }
  console.log(`OK: 内联图与 assets/whale.png 一致（sha256:${hash}，${png.length} 字节）`)
  process.exit(0)
}

let out
if (beginIdx >= 0 && endIdx > beginIdx) {
  out = raw.slice(0, beginIdx) + block + raw.slice(endIdx + MARK_END.length)
} else {
  // 首次注入：放在 constants 区域开头
  const anchor = '//#region constants' + eol
  const at = raw.indexOf(anchor)
  if (at < 0) {
    console.error('找不到 //#region constants 锚点，放弃注入')
    process.exit(1)
  }
  const insertAt = at + anchor.length
  out = raw.slice(0, insertAt) + block + eol + eol + raw.slice(insertAt)
}

await writeFile(clientPath, out, 'utf8')
console.log(`已写入 lib/client.js（sha256:${hash}，${png.length} 字节 → ${uri.length} 字符）`)
