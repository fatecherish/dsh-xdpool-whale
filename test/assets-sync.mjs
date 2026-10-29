// 内联资源一致性：lib/client.js 里的 data URI 必须与 assets/ 下的源文件一致。
//
// 这些图/音频是**手工改源文件后忘了重跑内联脚本**最容易出错的地方：
// 改了 assets/whale.png 却没跑 embed-asset.mjs，挂件会一直显示旧图，
// 而且静态检查看不出来（base64 就在 bundle 里，语法完全合法）。
//
// 覆盖两条独立的内联链路：
//   scripts/embed-asset.mjs  → WHALE_DATA_URI / WHALE_ART2_DATA_URI（两套立绘）
//   scripts/embed-media.mjs  → ASSETS.press/release/click（音效）
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const G = '\u001b[32m'
const RED = '\u001b[31m'
const R = '\u001b[0m'

const scripts = [
  { name: 'embed-asset', file: join(root, 'scripts', 'embed-asset.mjs') },
  { name: 'embed-media', file: join(root, 'scripts', 'embed-media.mjs') },
]

let failed = 0

for (const { name, file } of scripts) {
  const r = spawnSync(process.execPath, [file, '--check'], { encoding: 'utf8' })
  const out = ((r.stdout || '') + (r.stderr || '')).trim()
  if (r.status === 0) {
    console.log(`${G}OK${R}   ${name}：内联资源与 assets/ 一致`)
    for (const line of out.split(/\r?\n/)) {
      if (line.trim()) console.log(`       ${line.trim()}`)
    }
  } else {
    failed++
    console.log(`${RED}FAIL${R} ${name}：内联资源与 assets/ 不一致`)
    for (const line of out.split(/\r?\n/)) {
      if (line.trim()) console.log(`       ${line.trim()}`)
    }
  }
}

console.log('')
if (failed === 0) {
  console.log(`${G}全部通过：bundle 里的立绘与音效都与 assets/ 下的源文件同步。${R}`)
  process.exit(0)
}
console.log(`${RED}${failed} 项失败：请运行对应的内联脚本重新生成。${R}`)
console.log('  立绘：node scripts/embed-asset.mjs')
console.log('  音效：node scripts/embed-media.mjs')
process.exit(1)
