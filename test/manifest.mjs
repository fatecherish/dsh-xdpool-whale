// 校验 package.json 的插件清单完整性（CI 与本地共用）。
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'

const p = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const fail = (m) => {
  console.error('✗ ' + m)
  process.exit(1)
}

if (p.name !== 'dsh-xdpool-whale') fail('名字不符: ' + p.name)
if (!p.dsh || !p.dsh.manifestVersion) fail('缺少 dsh.manifestVersion')
if (!p.dsh.bundle || !p.dsh.bundle.patch) fail('缺少 dsh.bundle.patch')

const patchPath = p.dsh.bundle.patch.replace(/^\.\//, '')
if (!existsSync(new URL('../' + patchPath, import.meta.url))) fail('patch 文件不存在: ' + patchPath)

const mainPath = p.main.replace(/^\.\//, '')
if (!existsSync(new URL('../' + mainPath, import.meta.url))) fail('主入口不存在: ' + mainPath)

if (!Array.isArray(p.files) || p.files.length === 0) fail('缺少 files 白名单')
for (const f of p.files) {
  if (!existsSync(new URL('../' + f, import.meta.url))) fail('files 里的路径不存在: ' + f)
}

const inject = p.dsh.client?.inject
if (!Array.isArray(inject) || inject.length === 0) fail('缺少 dsh.client.inject')

console.log('✓ 插件清单校验通过')
console.log(`  name=${p.name} version=${p.version}`)
console.log(`  main=${p.main} patch=${p.dsh.bundle.patch}`)
console.log(`  files=${p.files.length} 项  inject=${inject.length} 项`)
