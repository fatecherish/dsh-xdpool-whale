// 校验文档里的本地相对链接是否都指向真实存在的文件。
// 用法：node scripts/check-doc-links.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.md$/i.test(name)) out.push(full)
  }
  return out
}

const docs = walk(root)
let checked = 0
const broken = []

for (const file of docs) {
  const text = readFileSync(file, 'utf8')
  const rel = file.slice(root.length + 1)

  // [文本](目标) —— 只看本地相对链接
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const link = m[1]
    if (/^(https?:|mailto:|#)/.test(link)) continue
    const targetPath = link.split('#')[0]
    if (!targetPath) continue
    checked += 1
    if (!existsSync(resolve(dirname(file), targetPath))) {
      broken.push(`${rel} -> ${link}`)
    }
  }

  // <img src="..."> —— 检查文档内嵌图片
  for (const m of text.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    const link = m[1]
    if (/^(https?:|data:)/.test(link)) continue
    checked += 1
    if (!existsSync(resolve(dirname(file), link))) {
      broken.push(`${rel} -> ${link}  (img)`)
    }
  }
}

// 报告缺失的截图（这类不算错，但要单独提示，因为可能是故意占位）
const imgDir = join(root, 'docs', 'images')
const missingImages = []
if (existsSync(join(root, 'README.md'))) {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  for (const m of readme.matchAll(/<img[^>]+src="(docs\/images\/[^"]+)"/g)) {
    if (!existsSync(join(root, m[1]))) missingImages.push(m[1])
  }
}

console.log(`检查了 ${docs.length} 个 Markdown 文件、${checked} 个本地链接`)

if (broken.length > 0) {
  console.error('\n✗ 失效链接:')
  for (const b of broken) console.error('  ' + b)
  process.exit(1)
}

console.log('✓ 所有本地链接有效')

if (missingImages.length > 0) {
  console.log(`\n⚠ 有 ${missingImages.length} 张截图尚未生成（README「界面预览」段落）:`)
  for (const p of missingImages) console.log('  ' + p)
  console.log('  这些是待补的占位图，不影响链接有效性，但 README 在 GitHub 上会显示破图。')
}
