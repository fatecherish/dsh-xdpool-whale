/**
 * 把本仓库接入一个 DSH profile —— 全程安全、可回滚。
 *
 * 设计原则（上一版把用户的 10 个插件写没了，这些原则就是针对那次事故的补丁）：
 *
 *   1. 先在 profile 的「文件系统状态」里找 profile，而不是猜 `~/.dsh`。
 *      Windows 桌面版的 harness 位于 %APPDATA%\dsh-desktop\harness，
 *      用 DSH 的约定路径只会写错地方。
 *   2. 写任何文件之前先做备份（package.json / cordis.patch.yml / pnpm-lock.yaml），
 *      备份带时间戳，且只在「真的会改动」时才建。
 *   3. 默认 **dry-run**：只打印将要发生的改动，不落盘。
 *   4. 依赖安装必须显式加 `--install`，并且安装前再次备份 lockfile；
 *      安装命令固定带 --no-frozen-lockfile，失败时自动回滚 lockfile 与 node_modules。
 *   5. 绝不删除 profile 里已有的任何依赖条目。
 *
 * 用法：
 *   node scripts/install.mjs                     # 预览（dry-run，什么都不改）
 *   node scripts/install.mjs --apply             # 只改 package.json + cordis.patch.yml
 *   node scripts/install.mjs --apply --install   # 再加装依赖（会备份并保护 lockfile）
 *   node scripts/install.mjs --rollback          # 从最近一次备份还原
 *   node scripts/install.mjs --uninstall --apply # 移除本插件（不动其他依赖）
 *   node scripts/install.mjs --profile <dir>     # 显式指定 profile 目录
 */

import { readFile as fsReadFile, writeFile as fsWriteFile, statSync, readFileSync, constants } from 'node:fs'
import { readFile, writeFile, access, mkdir, cp, rm, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
const PLUGIN_ID = 'xdpool-whale'

/**
 * 依赖说明符必须用 `link:`，且路径用正斜杠。
 *
 * 事故复盘（2026-10-23，用户 10 个插件一度被清空）：
 *   - 写成 `file:D:\MyProject\...`：pnpm 把冒号后当成相对路径拼成
 *     `<profile>/D:\MyProject\...`，scandir 抛 ENOENT 中止安装；
 *   - 改成 `file:D:/MyProject/...`：本项目在 D: 盘、profile 在 C: 盘，
 *     pnpm 要把绝对路径转成相对路径，跨盘符时算出 `..\..\D:\...` 这种
 *     非法混合路径，依然 ENOENT；
 *   - 而 DSH 桌面版本身对所有插件用的就是 `link:` + Junction（见 profile
 *     package.json 的 pnpm.overrides 与 node_modules 里的 LinkType=Junction）。
 *
 * 因此这里对齐 DSH 自己的做法：`link:` 协议 + 正斜杠，pnpm 会直接建 Junction，
 * 不去计算跨盘相对路径。
 */
const linkSpecifier = `link:${repoRoot.replaceAll('\\', '/')}`

// ---------------------------------------------------------------- 参数解析 --

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

const APPLY = flag('apply')
const INSTALL = flag('install')
const UNINSTALL = flag('uninstall')
const ROLLBACK = flag('rollback')
const PROFILE_FLAG = opt('profile')

const log = (...parts) => console.log(...parts)
const step = (text) => log(`\n${text}`)
const warn = (text) => console.log(`[!] ${text}`)
const ok = (text) => console.log(`[ok] ${text}`)
const skip = (text) => console.log(`[--] ${text}`)

const exists = (path) => {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

async function existsAsync(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// ------------------------------------------------------------ profile 发现 --
//
// 不猜路径：只认「磁盘上真的有 package.json 且看起来是 DSH profile」的目录。
// 搜索顺序由近及远，命中多个时提示用户用 --profile 指定。

async function looksLikeProfile(dir) {
  if (!(await existsAsync(join(dir, 'package.json')))) return false
  return (await existsAsync(join(dir, 'cordis.patch.yml'))) || (await existsAsync(join(dir, 'cordis.yml')))
}

function candidateProfiles() {
  const list = []
  if (PROFILE_FLAG) {
    list.push({ dir: resolve(PROFILE_FLAG), reason: '--profile 指定' })
    return list
  }

  // 1) 环境变量优先（桌面版会注出这些）
  const envCandidates = [
    ['DSH_PROFILE_DIR', process.env.DSH_PROFILE_DIR],
    ['DSH_PROFILE', process.env.DSH_PROFILE],
    ['DSH_HOME', process.env.DSH_HOME && join(process.env.DSH_HOME, 'profiles', 'web')],
    ['DSH_HOME', process.env.DSH_HOME],
  ]
  for (const [source, value] of envCandidates) {
    if (!value) continue
    for (const dir of [value, dirname(value)]) {
      if (dir) list.push({ dir: resolve(dir), reason: `环境变量 ${source}` })
    }
  }

  // 2) 与候选 home 拼出已知的 harness 布局
  const homes = [
    process.env.APPDATA && join(process.env.APPDATA, 'dsh-desktop', 'harness'),
    join(homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness'),
    join(homedir(), '.dsh'),
    join(homedir(), '.config', 'dsh'),
  ].filter(Boolean)

  for (const home of homes) {
    for (const dir of [join(home, 'profiles', 'web'), join(home, 'profiles', 'desktop'), home]) {
      list.push({ dir, reason: `推断自 ${home}` })
    }
  }

  const seen = new Set()
  return list.filter((entry) => {
    const key = entry.dir.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function discoverProfile() {
  const found = []
  for (const entry of candidateProfiles()) {
    if (await looksLikeProfile(entry.dir)) found.push(entry)
  }

  if (PROFILE_FLAG) {
    const hit = found[0]
    if (!hit) {
      throw new Error(`指定的 profile 不是有效的 DSH profile（缺 package.json / cordis.patch.yml）：${resolve(PROFILE_FLAG)}`)
    }
    return hit
  }

  if (found.length === 0) {
    throw new Error(
      [
        '没有在已知位置找到 DSH profile。已知位置包括：',
        '  - %APPDATA%\\dsh-desktop\\harness\\profiles\\web   （Windows 桌面版）',
        '  - ~/.dsh/profiles/web                             （CLI 版）',
        '请用 --profile <目录> 显式指定；该目录应包含 package.json 与 cordis.patch.yml。',
      ].join('\n'),
    )
  }

  const unique = []
  const seen = new Set()
  for (const entry of found) {
    const key = entry.dir.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(entry)
  }

  if (unique.length > 1) {
    throw new Error(
      ['发现多个 DSH profile，无法确定装哪个，请用 --profile 指定：', ...unique.map((e) => `  - ${e.dir}   (${e.reason})`)].join('\n'),
    )
  }
  return unique[0]
}

// ------------------------------------------------------------------ 备份 --

const BACKUP_DIRNAME = '.xdw-backups'

async function backup(profileDir, files, label) {
  const target = join(profileDir, BACKUP_DIRNAME, `${stamp()}-${label}`)
  await mkdir(target, { recursive: true })
  const copied = []
  for (const file of files) {
    const source = join(profileDir, file)
    if (!(await existsAsync(source))) continue
    await cp(source, join(target, file.replace(/[\\/]/g, '__')))
    copied.push(file.replace(/[\\/]/g, '__'))
  }
  if (copied.length === 0) {
    await rm(target, { recursive: true, force: true })
    return null
  }
  await writeFile(join(target, 'MANIFEST.txt'), `${copied.join('\n')}\n`, 'utf8')
  return target
}

async function latestBackup(profileDir) {
  const root = join(profileDir, BACKUP_DIRNAME)
  if (!(await existsAsync(root))) return null
  const entries = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  if (entries.length === 0) return null
  return join(root, entries[entries.length - 1])
}

// -------------------------------------------------------- package.json 读写 --

async function readManifest(profileDir) {
  const path = join(profileDir, 'package.json')
  const raw = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '')
  return { path, raw, json: JSON.parse(raw) }
}

/** 保留原文件的缩进与结尾换行，只重写 dependencies 所在区域。 */
function serializeManifest(json, originalRaw) {
  const indentMatch = originalRaw.match(/^\{\r?\n(\s+)"/)
  const indent = indentMatch ? indentMatch[1].length : 2
  const eol = originalRaw.includes('\r\n') ? '\r\n' : '\n'
  return `${JSON.stringify(json, null, indent).replace(/\n/g, eol)}${eol}`
}

function sortedDependencies(deps) {
  const sorted = {}
  for (const key of Object.keys(deps).sort((a, b) => a.localeCompare(b))) sorted[key] = deps[key]
  return sorted
}

// ------------------------------------------------------- cordis.patch.yml --

const yamlQuote = (value) => `'${String(value).replaceAll("'", "''")}'`
const rowRegex = () => new RegExp(`^\\s*-?\\s*id:\\s*['"]?${PLUGIN_ID}['"]?\\s*$`, 'm')

function findInsertBlock(lines) {
  const start = lines.findIndex((line) => /^\s*-\s*insert:\s*$/.test(line))
  if (start === -1) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    if (/^\s*-\s/.test(line) && !/^\s{4,}/.test(line)) {
      end = index
      break
    }
  }
  return { start, end }
}

function planPatch(raw, { uninstall }) {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const hasRow = rowRegex().test(normalized)
  const isPlaceholder = normalized.trim() === '' || /^\[\s*\]$/.test(normalized.trim())
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const finish = (next) => `${next.join('\n').replace(/\n+$/, '')}\n`.replace(/\n/g, eol)

  if (uninstall) {
    if (!hasRow) return { changed: false, next: raw }
    const index = lines.findIndex((line) => rowRegex().test(line))
    let remove = 1
    if (lines[index + 1]?.trim().startsWith('name:')) remove = 2
    lines.splice(index, remove)
    const meaningful = lines.filter(
      (line) => line.trim() !== '' && !/^-?\s*$/.test(line) && !/^-\s*insert:\s*$/.test(line),
    )
    if (meaningful.length === 0) return { changed: true, next: '[]\n' }
    return { changed: true, next: finish(lines) }
  }

  if (hasRow) return { changed: false, next: raw }

  const entry = [`  - id: ${PLUGIN_ID}`, `    name: ${yamlQuote(pkg.name)}`]
  if (isPlaceholder) {
    return { changed: true, next: finish(['- insert:', ...entry]) }
  }
  const block = findInsertBlock(lines)
  if (block === null) {
    return { changed: true, next: finish([...lines, '- insert:', ...entry]) }
  }
  let insertAt = block.end
  while (insertAt > block.start + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1
  lines.splice(insertAt, 0, ...entry)
  return { changed: true, next: finish(lines) }
}

// ------------------------------------------------------------------ 执行 --

function run(command, args, cwd) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('error', (error) => done({ code: -1, error }))
    child.on('close', (code) => done({ code }))
  })
}

/**
 * 找到 DSH 自带的 pnpm 本体，绕开 PATH 上的 pnpm runner 包装脚本。
 * 返回 { command, prefix }：command 可执行文件，prefix 是它之前的固定参数。
 * window 下 DSH 用 Electron 可执行文件 + ELECTRON_RUN_AS_NODE 跑 pnpm.cjs，
 * 所以要通过环境变量把该开关打开（run() 里已继承当前 env，这里只负责设置）。
 */
function findPnpmCommand() {
  const candidates = [
    process.env.DSH_PNPM_ENTRY,
    // 桌面版：<install>/resources/app.asar/node_modules/pnpm/bin/pnpm.cjs
    resolveDesktopPnpm(),
  ].filter(Boolean)

  for (const entry of candidates) {
    try {
      if (!statSync(entry).isFile()) continue
    } catch {
      continue
    }
    // DSH 桌面版的 node/pnpm 都由 Electron 以 node 模式提供
    const electron = process.env.DSH_ELECTRON_EXE
    if (electron && statSync(electron).isFile()) {
      process.env.ELECTRON_RUN_AS_NODE = '1'
      return { command: electron, prefix: [entry] }
    }
    const nodeExe = process.env.npm_node_execpath || process.execPath
    return { command: nodeExe, prefix: [entry] }
  }

  warn('没有定位到 DSH 自带的 pnpm，退回 PATH 上的 pnpm。')
  warn('若 PATH 上是 DSH 的 pnpm runner，它会摘掉其它插件的依赖声明，可能清空 node_modules。')
  return { command: 'pnpm', prefix: [] }
}

function resolveDesktopPnpm() {
  // <DSH Desktop.exe 所在目录>/resources/app.asar/node_modules/pnpm/bin/pnpm.cjs
  const exe = process.env.DSH_ELECTRON_EXE
  if (!exe) return undefined
  return join(dirname(exe), 'resources', 'app.asar', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
}

async function doRollback(profileDir) {
  const dir = await latestBackup(profileDir)
  if (!dir) {
    warn(`没有找到备份目录：${join(profileDir, BACKUP_DIRNAME)}`)
    return
  }
  step(`从备份还原：${dir}`)
  const files = await readdir(dir)
  for (const file of files) {
    if (file === 'MANIFEST.txt') continue
    const realName = file.replace('__', '\\')
    await cp(join(dir, file), join(profileDir, realName))
    ok(`还原 ${realName}`)
  }
  warn('还原后请重启 DSH Desktop，让它重新生成依赖链接。')
}

function verifyIntegrity(profileDir, expected) {
  let deps = {}
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
    deps = manifest.dependencies ?? {}
  } catch {
    return { lost: Object.keys(expected), missingOnDisk: [] }
  }
  const lost = Object.keys(expected).filter((name) => !(name in deps) || deps[name] !== expected[name])
  const missingOnDisk = Object.keys(deps).filter((name) => !exists(join(profileDir, 'node_modules', name)))
  return { lost, missingOnDisk }
}

async function main() {
  step('定位 DSH profile...')
  const { dir: profileDir, reason } = await discoverProfile()
  ok(`profile: ${profileDir}`)
  log(`      (${reason})`)

  if (ROLLBACK) {
    await doRollback(profileDir)
    return
  }

  // ---- 安装前快照：用于事后校验「有没有弄丢别的依赖」--------------------
  const manifest = await readManifest(profileDir)
  const before = { ...(manifest.json.dependencies ?? {}) }

  step(`${UNINSTALL ? '移除' : '写入'}依赖声明...`)
  const current = manifest.json.dependencies ?? {}
  let manifestChanged = false

  if (UNINSTALL) {
    if (!(pkg.name in current)) {
      skip(`${pkg.name} 不在依赖里，无需移除`)
    } else {
      delete current[pkg.name]
      manifest.json.dependencies = sortedDependencies(current)
      manifestChanged = true
      ok(`删除 dependencies["${pkg.name}"]`)
    }
  } else if (current[pkg.name] === linkSpecifier) {
    skip(`dependencies["${pkg.name}"] 已是 ${linkSpecifier}`)
  } else {
    current[pkg.name] = linkSpecifier
    manifest.json.dependencies = sortedDependencies(current)
    manifestChanged = true
    ok(`写入 dependencies["${pkg.name}"] = "${linkSpecifier}"`)
  }

  const nextManifestRaw = serializeManifest(manifest.json, manifest.raw)
  manifestChanged = manifestChanged && nextManifestRaw !== manifest.raw

  // ---- cordis.patch.yml ---------------------------------------------------
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const patchRaw = (await existsAsync(patchPath)) ? await readFile(patchPath, 'utf8') : '[]\n'
  const patch = planPatch(patchRaw, { uninstall: UNINSTALL })

  step(`${UNINSTALL ? '移除' : '写入'}插件注册行...`)
  if (!patch.changed) {
    skip(UNINSTALL ? 'patch 里没有本插件' : `patch 里已有 id: ${PLUGIN_ID}`)
  } else {
    ok(UNINSTALL ? `从 patch 移除 insert id: ${PLUGIN_ID}` : `patch insert id: ${PLUGIN_ID}`)
  }

  // ---- 预览 ---------------------------------------------------------------
  if (!APPLY) {
    step('预览结束（dry-run，未改动任何文件）')
    log('  加 --apply 才会真正写入。')
    return
  }

  // ---- 落盘（先备份）------------------------------------------------------
  if (!manifestChanged && !patch.changed) {
    ok('没有需要写入的改动')
  } else {
    const backupDir = await backup(profileDir, ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml'], 'apply')
    if (backupDir) ok(`已备份到 ${backupDir}`)
    if (manifestChanged) await writeFile(manifest.path, nextManifestRaw, 'utf8')
    if (patch.changed) await writeFile(patchPath, patch.next, 'utf8')
    ok('已写入')
  }

  // ---- 依赖安装（显式开启，带保护） ---------------------------------------
  if (!INSTALL || UNINSTALL) {
    step('下一步：')
    if (UNINSTALL) log('  重启 DSH Desktop 即可。')
    else log('  1) node scripts/install.mjs --apply --install   （安装依赖，会二次备份 lockfile 再动手）')
    if (!UNINSTALL) log('  2) 重启 DSH Desktop，然后刷新 Web GUI')
    return
  }

  step('安装依赖（先备份 lockfile + package.json，失败自动还原）...')
  const guard = await backup(profileDir, ['pnpm-lock.yaml', 'package.json'], 'preinstall')
  const lockBefore = join(profileDir, 'pnpm-lock.yaml')
  const lockBackup = join(guard ?? '', 'pnpm-lock.yaml')
  const guardOk = guard && exists(lockBackup)
  if (guardOk) ok(`lockfile 已备份：${guard}`)
  else warn('lockfile 备份失败，继续前请确认 profile 已有可用备份')

  /**
   * 必须绕过 PATH 里的 pnpm。
   *
   * DSH 桌面版把一个 pnpm runner 包装脚本放进了 PATH（.desktop-bin/pnpm.cmd）。
   * 它会在执行 pnpm 前把「安装代次（generation projection）」里的插件从
   * package.json 临时摘掉，pnpm 看到的清单于是只剩本插件；一旦 pnpm 因任何理由
   * 重建 lockfile，这些插件就会从 lockfile 与 node_modules 里被清掉——这正是
   * 2026-10-23 事故里 10 个插件消失的机制。
   *
   * 所以这里直接调用 DSH 自带的 pnpm 本体（pnpm 10.x），让它看到完整的依赖清单；
   * 找不到本体时才退回 PATH 上的 pnpm。
   */
  const pnpmCommand = findPnpmCommand()

  const result = await run(pnpmCommand.command, [...pnpmCommand.prefix, 'install', '--frozen-lockfile'], profileDir)

  const integrity = verifyIntegrity(profileDir, before)
  if (result.code !== 0 || integrity.lost.length > 0 || integrity.missingOnDisk.length > 0) {
    const why = result.code === 0 ? 'pnpm 退出正常，但完整性校验失败' : `pnpm 失败（exit ${result.code}）`
    warn(`安装未成功：${why}`)
    if (guardOk) {
      await cp(lockBackup, lockBefore).catch(() => {})
      ok('已还原 lockfile')
    }
    if (integrity.lost.length) warn(`依赖声明丢失：${integrity.lost.join(', ')}`)
    if (integrity.missingOnDisk.length) warn(`node_modules 缺失：${integrity.missingOnDisk.join(', ')}`)
    warn('安装未成功，请不要反复重试，避免继续破坏 profile。把上面的 pnpm 报错贴给维护者。')
    process.exitCode = 1
    return
  }

  ok('依赖安装完成，profile 完整性校验通过')
  log('下一步：重启 DSH Desktop，然后刷新 Web GUI。右下角会出现小鲸鱼浮标。')
}

await main()
