/**
 * 皮肤（换装）一致性测试。
 *
 * 五套皮肤的 id 散布在五个地方，任何一处漏改都会在运行时表现为：
 *   - 菜单里多出一项点了没反应（SUIT_OPTIONS 有、SKINS 没有）
 *   - 下拉框显示原始 key 名（词典缺条）
 *   - 图片空白（SKIN_IMAGES 缺条）
 *   - 立绘位置错乱（SKIN_LAYOUT 缺条）
 * 这些都不会抛异常，只会「看起来怪」，所以用测试锁死。
 *
 * 另外校验排版参数本身合法：width / height 必须二选一，
 * 且竖图（高宽比 > 1.3）必须走 height 分支——按宽度定尺寸会顶穿气泡导致切头。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const R = '\u001b[0m', G = '\u001b[32m', RED = '\u001b[31m'
let failed = 0
const check = (ok, label, detail) => {
  if (ok) console.log(`  ${G}OK${R}   ${label}`)
  else {
    failed++
    console.log(`  ${RED}FAIL${R} ${label}${detail === undefined ? '' : '  → ' + detail}`)
  }
}

// ---- 从 bundle 里把常量表抠出来（bundle 是 IIFE，不能直接 import） ----
const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')

/** 用正则截取 `const NAME = {...};` 或 `const NAME = [...];` 的原文。 */
function sliceConst(name) {
  const start = source.indexOf(`const ${name} = `)
  if (start < 0) return null
  let i = source.indexOf('=', start) + 1
  while (i < source.length && /\s/.test(source[i])) i++
  const open = source[i]
  const close = open === '{' ? '}' : open === '[' ? ']' : null
  if (close === null) return null
  let depth = 0
  let inStr = null
  for (let j = i; j < source.length; j++) {
    const c = source[j]
    if (inStr) {
      if (c === '\\') { j++; continue }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '/' && source[j + 1] === '/') {
      const nl = source.indexOf('\n', j)
      j = nl < 0 ? source.length : nl
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return source.slice(i, j + 1)
    }
  }
  return null
}

/** 在受控沙箱里求值一段对象/数组字面量。 */
function evalLiteral(text) {
  const sandbox = { Object, Array, String, Boolean }
  return vm.runInNewContext(`(${text})`, sandbox)
}

const SKINS = evalLiteral(sliceConst('SKINS'))
// SKIN_IMAGES 的值是常量引用（WHALE_DATA_URI 之类），不能求值，只能抠键名
const SKIN_IMAGES_KEYS = [...(sliceConst('SKIN_IMAGES') || '').matchAll(/^\s*(\w+):\s*\w+,/gm)].map(
  (m) => m[1],
)
const SKIN_LAYOUT = evalLiteral(sliceConst('SKIN_LAYOUT'))
const SUIT_OPTIONS = evalLiteral(sliceConst('SUIT_OPTIONS'))

console.log('=== 五个位置必须一致 ===')
check(Array.isArray(SKINS) && SKINS.length === 5, `SKINS 有 5 套皮肤`, `实际 ${SKINS?.length}`)

const missingImages = SKINS.filter((s) => !SKIN_IMAGES_KEYS.includes(s))
check(missingImages.length === 0, '每套皮肤都有 SKIN_IMAGES 映射', missingImages.join(', '))

const extraImages = SKIN_IMAGES_KEYS.filter((s) => !SKINS.includes(s))
check(extraImages.length === 0, 'SKIN_IMAGES 没有多余条目', extraImages.join(', '))

const missingLayout = SKINS.filter((s) => !(s in SKIN_LAYOUT))
check(missingLayout.length === 0, '每套皮肤都有 SKIN_LAYOUT 排版', missingLayout.join(', '))

console.log('\n=== 换装菜单 ===')
const menuIds = SUIT_OPTIONS.map(([id]) => id)
check(menuIds.length === SKINS.length, '菜单项数与 SKINS 一致', `菜单 ${menuIds.length} / SKINS ${SKINS.length}`)
check(
  menuIds.join(',') === SKINS.join(','),
  '菜单顺序与 SKINS 完全相同',
  `菜单 ${menuIds.join(',')} / SKINS ${SKINS.join(',')}`,
)
const unknownMenu = menuIds.filter((id) => !SKINS.includes(id))
check(unknownMenu.length === 0, '菜单里没有 SKINS 之外的 id', unknownMenu.join(', '))

console.log('\n=== 词典 ===')
// 词典是嵌套对象，从源码里找 suit 开头的 key（中英各一份）。
// `suitLabel`（分组标题「换装」）不是皮肤名，要排掉，它有专门的 suitLabel 检查。
const dictKeys = new Set()
for (const m of source.matchAll(/\bsuit[A-Z]\w*:\s*"/g)) {
  const key = m[0].split(':')[0].trim()
  if (key !== 'suitLabel') dictKeys.add(key)
}
const needKeys = SUIT_OPTIONS.map(([, key]) => key)
const missingKeys = needKeys.filter((k) => !dictKeys.has(k))
check(missingKeys.length === 0, '每个菜单项都有词典 key', missingKeys.join(', '))
check(dictKeys.size === needKeys.length, `词典皮肤 key 数量正确（${needKeys.length} 个）`, `实际 ${dictKeys.size}`)
check(/suitLabel:\s*"/.test(source), '分组标题 suitLabel 存在')

console.log('\n=== 排版参数合法性 ===')
for (const skin of SKINS) {
  const L = SKIN_LAYOUT[skin]
  if (!L) continue
  const hasW = L.width !== null && L.width !== undefined
  const hasH = L.height !== null && L.height !== undefined
  check(hasW !== hasH, `${skin}: width / height 恰好设置一个`, `width=${L.width} height=${L.height}`)

  // right / bottom 必须是带 % 的字符串或数字
  const validPos = (v) => typeof v === 'string' ? /^-?\d+(\.\d+)?%$/.test(v) : typeof v === 'number'
  check(validPos(L.right) && validPos(L.bottom), `${skin}: right / bottom 是百分比值`, `right=${L.right} bottom=${L.bottom}`)

  // 只允许 width / height / right / bottom 四个键，防止残留 maxHeight 之类无效字段
  const keys = Object.keys(L).sort().join(',')
  check(keys === 'bottom,height,right,width', `${skin}: 没有多余字段`, keys)
}

console.log('\n=== 竖图必须走 height 分支（防切头）===')
for (const skin of SKINS) {
  const L = SKIN_LAYOUT[skin]
  const uri = source.match(new RegExp(`const ${skinConstName(skin)} = "([^"]{0,200})`))
  // 从 PNG 头里读尺寸：IHDR 在 base64 解出后的第 16..23 字节
  if (!uri) {
    check(false, `${skin}: 能找到 data URI 常量`)
    continue
  }
  const dims = pngSize(uri[1])
  if (!dims) {
    check(false, `${skin}: 能解析出 PNG 尺寸`)
    continue
  }
  const ratio = dims[1] / dims[0] // 高 / 宽
  if (ratio > 1.3) {
    check(
      L.height !== null && L.height !== undefined,
      `${skin}: 竖图（高宽比 ${ratio.toFixed(2)}）用 height 定尺寸`,
      `width=${L.width}`,
    )
  } else {
    check(
      L.width !== null && L.width !== undefined,
      `${skin}: 方图（高宽比 ${ratio.toFixed(2)}）用 width 定尺寸`,
      `height=${L.height}`,
    )
  }
}

/** 皮肤 id → data URI 常量名（与 scripts/embed-asset.mjs 的 TARGETS 对应）。 */
function skinConstName(skin) {
  if (skin === 'whale') return 'WHALE_DATA_URI'
  if (skin === 'art2') return 'WHALE_ART2_DATA_URI'
  if (skin === 'fullBody') return 'SKIN_FULLBODY_DATA_URI'
  return 'SKIN_' + skin.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase() + '_DATA_URI'
}

/** 从 base64 PNG 头读出 [width, height]。 */
function pngSize(prefix) {
  // prefix 是 data URI 开头，形如 data:image/png;base64,iVBORw0...
  const idx = prefix.indexOf('base64,')
  if (idx < 0) return null
  const b64 = prefix.slice(idx + 7, idx + 7 + 64)
  try {
    const buf = Buffer.from(b64, 'base64')
    // PNG 签名 8 字节 + 长度 4 + 'IHDR' 4 + width 4 + height 4
    if (buf.readUInt32BE(12) && buf.length >= 24) {
      return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
    }
  } catch {
    return null
  }
  return null
}

console.log('')
if (failed > 0) {
  console.log(`${RED}失败 ${failed} 项${R}`)
  process.exit(1)
}
console.log(`${G}全部通过：五套皮肤的 id / 图片 / 排版 / 菜单 / 词典完全对齐${R}`)
