// 把音效/GIF/第二套立绘内联进 lib/client.js 的 ASSETS 表。
//
// 背景：DSH 只给插件的 client.<name>.js chunk 开放路由，assets/ 下的文件在浏览器里
// 没有可访问的 URL，所以凡是运行时要用的资源都必须内联成 data URI。
//
// 用法：
//   node scripts/embed-media.mjs          把 assets/ 下的媒体写进 client.js
//   node scripts/embed-media.mjs --check  只校验内联结果与 assets/ 是否一致
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = join(ROOT, 'lib', 'client.js')
const ASSETS = join(ROOT, 'assets')

/** 要内联的媒体。key 是 client.js 里 ASSETS 表的键名。 */
// 只保留真正会播放的 3 个音效。
// hover(D1) 与 exp(minecraft-exp-orb.wav, 59 KB) 原本只在 warmSounds() 里预热、
// 从来没有被 playSound() 调用，属于纯体积开销，已从表里移除。
// rua.gif（摸头动图）按用户要求不再使用，也已移除。
// art2 立绘已改由 scripts/embed-asset.mjs 单独内联成 WHALE_ART2_DATA_URI
// （与 whale.png 同规格的纯立绘），不再走这张媒体表。
const MEDIA = [
  { key: 'press', file: 'Ya1.mp3', mime: 'audio/mpeg' },
  { key: 'release', file: 'Ya2.mp3', mime: 'audio/mpeg' },
  { key: 'click', file: 'D2.mp3', mime: 'audio/mpeg' },
]

const BEGIN = '/* @media-begin */'
const END = '/* @media-end */'

const source = readFileSync(CLIENT, 'utf8')
const start = source.indexOf(BEGIN)
const end = source.indexOf(END)
if (start < 0 || end < 0) {
  console.error(`找不到 ${BEGIN} / ${END} 标记，无法写入内联媒体`)
  process.exit(1)
}

const check = process.argv.includes('--check')

let total = 0
const entries = []
const fingerprints = []
for (const { key, file, mime } of MEDIA) {
  const bytes = readFileSync(join(ASSETS, file))
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
  fingerprints.push(`${file}=${hash}`)
  if (check) {
    // 校验模式下只需要确认 client.js 里确实含有该文件的完整 base64
    const b64 = bytes.toString('base64')
    if (!source.includes(b64)) {
      console.error(`不一致：${file} 的内容没有完整内联进 client.js`)
      process.exit(1)
    }
    continue
  }
  total += bytes.length
  entries.push(`\t\t\t${key}: "data:${mime};base64,${bytes.toString('base64')}",`)
}

if (check) {
  console.log(`OK: 内联媒体与 assets/ 一致（${fingerprints.join(', ')}）`)
  process.exit(0)
}

const block = [
  BEGIN,
  '\t\t/**',
  '\t\t * 内联媒体表（由 scripts/embed-media.mjs 生成，勿手改）。',
  '\t\t *',
  '\t\t * 宿主的 client-modules 只给 `client.<name>.js` 开放路由，assets/ 下的文件在',
  '\t\t * 浏览器里没有 URL，所以音频与动图必须随 bundle 一起走 data URI。',
  '\t\t */',
  '\t\tconst ASSETS = {',
  ...entries,
  '\t\t};',
  `\t\t// 内联总量 ${(total / 1024).toFixed(1)} KB`,
  `\t\t// 指纹 ${fingerprints.join(' ')}`,
  END,
].join('\n')

writeFileSync(CLIENT, source.slice(0, start) + block + source.slice(end + END.length), 'utf8')
console.log(`已写入 ${entries.length} 项媒体，合计 ${(total / 1024).toFixed(1)} KB`)
console.log(fingerprints.join(' '))
