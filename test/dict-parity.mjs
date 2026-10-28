// 词典键一致性检查：zh / en 必须一一对应，否则某个语言下会出现裸 key。
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const zhStart = src.indexOf('zh: {')
const enStart = src.indexOf('en: {')
if (zhStart < 0 || enStart < 0) {
  console.error('找不到 zh/en 词典')
  process.exit(1)
}

const slice = (from, to) => src.slice(from, to)
const zhBlock = slice(zhStart, enStart)
// en 块结束于它自己的 "}" 后跟 "\n\t\t};"
const enEnd = src.indexOf('\n\t\t};', enStart)
const enBlock = slice(enStart, enEnd < 0 ? src.length : enEnd)

const keys = (block) => [...block.matchAll(/^\s{3,5}(\w+):\s*"/gm)].map((m) => m[1])

const zh = keys(zhBlock)
const en = keys(enBlock)
const onlyZh = zh.filter((k) => !en.includes(k))
const onlyEn = en.filter((k) => !zh.includes(k))

console.log(`zh 键数: ${zh.length}  en 键数: ${en.length}`)
console.log(`只在 zh: ${onlyZh.join(', ') || '无'}`)
console.log(`只在 en: ${onlyEn.join(', ') || '无'}`)

if (onlyZh.length || onlyEn.length) {
  console.error('FAIL: 词典键不一致')
  process.exit(1)
}
console.log('OK: 词典键一致')
