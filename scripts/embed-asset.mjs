// 把立绘 PNG 内联进 lib/client.js 的 data URI 常量。
//
// 为什么必须内联：DSH 宿主只允许插件通过 `/plugins/<id>/client.<name>.js` 提供
// 客户端 chunk（CLIENT_CHUNK 正则只放行 js/map），图片之类的外部静态文件没有路由，
// 而 client bundle 的 require 也只认宿主模块，不能按相对路径 require 本地文件。
//
// 两套皮肤各对应一张图，区块结构相同，只是常量名不同：
//   assets/whale.png    → WHALE_DATA_URI      （经典鲸鱼，已抠图的纯立绘）
//   assets/DSniang03.png → WHALE_ART2_DATA_URI（思考鲸鱼，从整图裁出的纯立绘）
//
// 用法：node scripts/embed-asset.mjs [--check]
//   --check  只校验当前内联值与源图是否一致，不写文件
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const clientPath = join(root, 'lib', 'client.js')

/**
 * 每套皮肤的源图 → 内联常量。
 *
 * `region` 是 lib/client.js 里的哨兵注释名，`constName` 是生成的常量名，
 * `label` 只用于注释里的说明文字。
 */
const TARGETS = [
  {
    region: 'whale-asset',
    file: 'whale.png',
    constName: 'WHALE_DATA_URI',
    label: '鲸鱼立绘（经典，纯立绘）',
  },
  {
    region: 'whale-art2-asset',
    file: 'DSniang03.png',
    constName: 'WHALE_ART2_DATA_URI',
    label: '鲸鱼立绘（思考鲸鱼，从整图裁出的纯立绘）',
  },
]

const check = process.argv.includes('--check')

let raw = await readFile(clientPath, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'

/** 生成某个目标对应的哨兵区块文本。 */
function buildBlock(target, uri, hash, bytes) {
  return [
    `//#region ${target.region}`,
    `\t\t/** ${target.label}（内联 data URI，源文件 assets/${target.file}，sha256:${hash}，${bytes} 字节）。 */`,
    `\t\tconst ${target.constName} = "${uri}";`,
    `//#endregion ${target.region}`,
  ].join(eol)
}

let failures = 0
let changed = false

for (const target of TARGETS) {
  const pngPath = join(root, 'assets', target.file)
  const beginMark = `//#region ${target.region}`
  const endMark = `//#endregion ${target.region}`

  let png
  try {
    png = await readFile(pngPath)
  } catch {
    console.error(`MISSING: 找不到源图 assets/${target.file}`)
    failures++
    continue
  }

  const hash = createHash('sha256').update(png).digest('hex').slice(0, 16)
  const uri = `data:image/png;base64,${png.toString('base64')}`

  const beginIdx = raw.indexOf(beginMark)
  const endIdx = raw.indexOf(endMark)

  if (check) {
    if (beginIdx < 0 || endIdx < 0) {
      console.error(`MISSING: lib/client.js 里没有 ${target.region} 区块`)
      failures++
      continue
    }
    const current = raw.slice(beginIdx, endIdx + endMark.length)
    const m = /sha256:([0-9a-f]{16})/.exec(current)
    if (m === null || m[1] !== hash) {
      console.error(
        `STALE: ${target.constName} 与 assets/${target.file} 不一致（内联=${m ? m[1] : '无'}，当前=${hash}）`,
      )
      failures++
      continue
    }
    console.log(
      `  OK   ${target.constName.padEnd(20)} ← assets/${target.file.padEnd(16)} sha256:${hash}  ${png.length} 字节`,
    )
    continue
  }

  const block = buildBlock(target, uri, hash, png.length)

  if (beginIdx >= 0 && endIdx > beginIdx) {
    raw = raw.slice(0, beginIdx) + block + raw.slice(endIdx + endMark.length)
  } else {
    // 首次注入：放在 constants 区域开头
    const anchor = '//#region constants' + eol
    const at = raw.indexOf(anchor)
    if (at < 0) {
      console.error('找不到 //#region constants 锚点，放弃注入')
      process.exit(1)
    }
    const insertAt = at + anchor.length
    const before = raw.slice(0, insertAt)
    const after = raw.slice(insertAt)
    // 两个区块都在时用空行隔开，便于阅读
    raw = before + (before.endsWith(eol + eol) ? '' : eol) + block + eol + eol + after
  }
  changed = true
  console.log(
    `  OK   ${target.constName.padEnd(20)} ← assets/${target.file.padEnd(16)} sha256:${hash}  ${png.length} 字节 → ${uri.length} 字符`,
  )
}

if (check) {
  if (failures > 0) {
    console.error(`\n${failures} 项校验失败：请运行 node scripts/embed-asset.mjs 重新内联`)
    process.exit(1)
  }
  console.log('\nOK: 内联图与 assets/ 下的源图全部一致')
  process.exit(0)
}

if (changed) {
  await writeFile(clientPath, raw, 'utf8')
  console.log('\n已写入 lib/client.js')
} else {
  console.log('\n没有可写入的变更')
}
