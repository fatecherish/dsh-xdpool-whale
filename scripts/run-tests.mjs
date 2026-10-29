#!/usr/bin/env node
// 跨平台测试执行器：按顺序跑 test/ 下的全部用例，任一失败即退出。
// 用法：node scripts/run-tests.mjs [--bail]
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const testDir = join(here, '..', 'test')

// 固定顺序：基础契约在前，渲染快照在后。
const ORDER = [
  'manifest',
  'smoke',
  'register-contract',
  'dict-parity',
  'assets-sync',
  'skin-parity',
  'provider-balance',
  'render-regression',
  'render-snapshot',
  'usage-blocks',
  'vendor-mapping',
]

const available = new Set(readdirSync(testDir).filter((f) => f.endsWith('.mjs')))
const runOrder = ORDER.filter((n) => available.has(`${n}.mjs`))

// 兜底：ORDER 里没列出但实际存在的新测试也要跑，避免漏测。
for (const f of available) {
  const name = f.replace(/\.mjs$/, '')
  if (!ORDER.includes(name)) runOrder.push(name)
}

const results = []
for (const name of runOrder) {
  const file = join(testDir, `${name}.mjs`)
  process.stdout.write(`\n── ${name} ${'─'.repeat(Math.max(0, 50 - name.length))}\n`)
  const started = Date.now()
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit', encoding: 'utf8' })
  const ms = Date.now() - started
  const ok = r.status === 0
  results.push({ name, ok, ms, status: r.status })
  if (!ok) {
    process.stdout.write(`\n✗ ${name} 失败 (exit ${r.status})\n`)
    if (process.argv.includes('--bail')) break
  }
}

const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok)

// 附加检查：文档内相对链接必须有效（不属于 test/ 下的用例，单独跑）
process.stdout.write(`\n── 文档链接 ${'─'.repeat(45)}\n`)
const links = spawnSync(process.execPath, [join(here, 'check-doc-links.mjs')], {
  stdio: 'inherit',
  encoding: 'utf8',
})
const linksOk = links.status === 0
if (!linksOk) failed.push({ name: 'doc-links' })

process.stdout.write(`\n${'═'.repeat(56)}\n`)
for (const r of results) {
  process.stdout.write(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(20)} ${String(r.ms).padStart(6)}ms\n`)
}
process.stdout.write(`${linksOk ? '✓' : '✗'} ${'doc-links'.padEnd(20)} ${'--'.padStart(8)}\n`)
process.stdout.write(`${'═'.repeat(56)}\n`)

if (failed.length > 0) {
  process.stdout.write(`\n✗ ${failed.length} 个测试失败: ${failed.map((f) => f.name).join(', ')}\n`)
  process.exit(1)
}

process.stdout.write(`\n✓ 全部 ${passed} 个测试通过（含文档链接检查）\n`)
