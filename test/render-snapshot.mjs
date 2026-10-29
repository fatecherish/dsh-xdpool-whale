/**
 * 渲染树快照：用与 render-regression 相同的沙箱加载真实 bundle，
 * 把 WhaleWidget 的完整渲染树走一遍，核对：
 *   1. 关键节点齐全（.xdw-root / .xdw-body / .xdw-hit / BubbleSvg / Whale）
 *   2. 文案没有 undefined / [object Object]
 *   3. 尺寸与定位是合法像素值且在视口内
 *   4. 面板默认收起（只有点击后才展开）
 *
 * 这是在没有 Web 访问权限（GUI 需要 token）时的替代真机验证手段。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

async function load({ store = new Map(), innerWidth = 1600, innerHeight = 1000 } = {}) {
  const registrations = []
  const react = {
    useCallback: (fn) => fn,
    useEffect: () => undefined,
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
    createElement: () => null,
  }
  const jsxRuntime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Fragment: 'Fragment',
  }
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (r) => registrations.push(r) },
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      setInterval: () => 0,
      clearInterval: () => undefined,
      innerWidth,
      innerHeight,
    },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, set textContent(_v) {} }),
      head: { appendChild: () => undefined },
      documentElement: { lang: 'zh-CN' },
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    },
    fetch: async () => ({ ok: true, json: async () => ({ accounts: [] }) }),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    console,
    Object, Math, Number, String, Boolean, Array, JSON, Date, Error, Map, Set, Promise,
    Symbol, RegExp, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    performance: { now: () => 0 },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

  // 模块加载器注册的是 { factory }，由它注入 react / jsx-runtime
  const mod = registrations[0].factory((spec) => {
    if (spec === 'react') return react
    if (spec === 'react/jsx-runtime') return jsxRuntime
    throw new Error('unexpected require: ' + spec)
  })
  return { mod, store }
}

const R = '\u001b[0m', G = '\u001b[32m', RED = '\u001b[31m', Y = '\u001b[33m'
let failed = 0
const check = (ok, label, detail) => {
  if (ok) console.log(`  ${G}OK${R}   ${label}`)
  else {
    failed++
    console.log(`  ${RED}FAIL${R} ${label}${detail === undefined ? '' : '  → ' + detail}`)
  }
}

/** 深度遍历渲染树，收集 (tag/className, 文本, style) */
function walk(node, out = [], path = '') {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ kind: 'text', text: String(node), path })
    return out
  }
  if (Array.isArray(node)) {
    node.forEach((n, i) => walk(n, out, `${path}[${i}]`))
    return out
  }
  if (typeof node !== 'object' || !node.props) return out
  const cls = node.props.className
  const label = typeof node.type === 'string' ? node.type + (cls ? '.' + cls : '') : String(node.type?.name || 'Component')
  out.push({ kind: 'node', tag: label, cls, props: node.props, path })
  const children = node.props.children
  if (children !== undefined) walk(children, out, path + '>' + label)
  return out
}

console.log('=== 默认状态（气泡收起）===')
{
  const { mod } = await load()
  if (!mod || typeof mod.WhaleWidget !== 'function') {
    check(false, 'WhaleWidget 从 bundle 导出', 'mod=' + String(mod))
  } else {
    const tree = mod.WhaleWidget({ t: undefined })
    const nodes = walk(tree)
    const byCls = (c) => nodes.filter((n) => n.cls === c)
    const texts = nodes.filter((n) => n.kind === 'text').map((n) => n.text)

    check(tree.type === 'div' && tree.props.className === 'xdw-root', '根节点是 .xdw-root')
    check(byCls('xdw-root').length === 1, '只有一个挂件根节点')
    check(byCls('xdw-body').length === 1, '有气泡主体 .xdw-body')
    check(byCls('xdw-hit').length === 1, '有可点击命中区 .xdw-hit')
    check(byCls('xdw-panelwrap').length === 0, '默认不展开面板（点击后才展开）')
    check(nodes.some((n) => n.tag === 'BubbleSvg'), '渲染了白色对话气泡 BubbleSvg')
    // 挂件现在默认渲染立绘图（WhaleImage），只有图片加载失败才退化到矢量 Whale。
    // 所以这里断言「至少有一个鲸鱼图形」，而不是非要是某一种。
    check(
      nodes.some((n) => n.tag === 'WhaleImage') || nodes.some((n) => n.tag === 'Whale'),
      '渲染了鲸鱼图形（立绘或矢量兜底）',
    )

    // 文案
    const bad = texts.filter((s) => /undefined|null|NaN|\[object/.test(s))
    check(bad.length === 0, '所有文本无 undefined/null/NaN/[object]', JSON.stringify(bad.slice(0, 5)))
    const label = byCls('xdw-label')[0]
    const amount = byCls('xdw-amount')[0]
    const hint = byCls('xdw-hint')[0]
    check(!!label, '有高度标签 .xdw-label')
    check(!!amount, '有积分数字 .xdw-amount')
    check(!!hint, '有状态提示 .xdw-hint')
    if (amount) {
      // amount 节点的子文本就是积分数字：从该节点自身往下收集纯文本
      const inside = walk(amount.props ? { props: amount.props } : null, []).filter((n) => n.kind === 'text')
      const amountText = inside.map((n) => n.text).join('')
      check(amountText.length > 0, '积分数字非空', JSON.stringify(amountText))
      console.log(`      积分数字文本 = ${JSON.stringify(amountText)}`)
    }

    // 定位与尺寸
    const style = tree.props.style
    check(style.left !== undefined && style.top !== undefined, '用 left/top 定位')
    check(String(style.width).endsWith('px'), '宽度是像素值', style.width)
    const lx = parseFloat(style.left), ty = parseFloat(style.top), wd = parseFloat(style.width)
    check(Number.isFinite(lx) && Number.isFinite(ty) && Number.isFinite(wd), '定位与尺寸均为有限数字')
    check(lx >= 0 && ty >= 0, '不贴负边缘', `left=${style.left} top=${style.top}`)
    check(lx + wd <= 1600, '右边缘不越界', `right=${lx + wd}`)
    check(ty + wd <= 1000, '下边缘不越界', `bottom=${ty + wd}`)
    check(tree.props['data-size'] === 'md', '默认尺寸档位 md', tree.props['data-size'])

    // aria
    const hit = byCls('xdw-hit')[0]
    const aria = hit && hit.props['aria-label']
    check(typeof aria === 'string' && aria.length > 0, 'aria-label 是非空字符串', aria)
    check(hit && hit.props['aria-expanded'] === 'false', '默认 aria-expanded=false')
    console.log(`      aria-label = ${JSON.stringify(aria)}`)
  }
}

console.log('')
console.log('=== art2 皮肤（思考鲸鱼，纯立绘）===')
{
  // art2 的源图 DSniang02.png 原本是「白气泡 + 人物」的整图，
  // 已由 scripts/crop-art2.py 抠掉气泡、裁成和 whale.png 同规格的纯立绘。
  // 所以两套皮肤必须**走同一套布局**：不能有按皮肤区分的 CSS 分支，
  // 否则又会回到「两层气泡叠在一起、人物只剩一截」那个 bug。
  const store = new Map([['dsh-xdpool-whale:skin', 'art2']])
  const { mod } = await load({ store })
  const tree = mod.WhaleWidget({ t: undefined })
  const nodes = walk(tree)
  const byCls = (c) => nodes.filter((n) => n.cls === c)

  check(byCls('xdw-whale').length === 1, 'art2 只渲染一张立绘（不多不少）')
  // WhaleImage 是组件节点，walk 只展开到组件外层（src 由组件自己渲染时加上），
  // 这里核对传进去的 suit prop。
  const whale = byCls('xdw-whale')[0]
  check(whale && whale.props.suit === 'art2', 'WhaleImage 收到 suit=art2', whale && whale.props.suit)
  // 立绘靠 SVG 气泡承载文字，两套皮肤都必须保留。
  check(nodes.some((n) => n.tag === 'BubbleSvg'), 'art2 保留 SVG 气泡（不再靠图里自带的气泡）')
  check(byCls('xdw-label').length === 1, 'art2 仍有积分标题')
  check(byCls('xdw-amount').length === 1, 'art2 仍有积分数字')

  // 关键回归点：根节点不能再出现按皮肤区分的开关属性。
  // （`data-suit` 只允许出现在 img 自身当诊断标记，绝不能挂到根节点去驱动 CSS 分支。）
  check(
    tree.props['data-suit'] === undefined,
    'art2 不在根节点打 data-suit（两套皮肤共用布局）',
    tree.props['data-suit'],
  )

  const texts = nodes.filter((n) => n.kind === 'text').map((n) => n.text)
  const bad = texts.filter((s) => /undefined|null|NaN|\[object/.test(s))
  check(bad.length === 0, 'art2 文本无 undefined/null/NaN', JSON.stringify(bad.slice(0, 5)))
}

console.log('')
console.log('=== 默认皮肤是 whale ===')
{
  const { mod } = await load()
  const tree = mod.WhaleWidget({ t: undefined })
  const nodes = walk(tree)
  const byCls = (c) => nodes.filter((n) => n.cls === c)
  check(nodes.some((n) => n.tag === 'BubbleSvg'), 'whale 皮肤保留 SVG 气泡')
  check(byCls('xdw-whale')[0].props.suit === 'whale', 'WhaleImage 收到 suit=whale')
}

console.log('')
console.log('=== 两套立绘素材同规格 ===')
{
  // 两套皮肤共用 `.xdw-whale` 定位（right:3%; bottom:-14%; width:56%），
  // 前提是素材同为「方形 + 透明底 + 人物贴底居中」。这里直接读源图核对，
  // 避免以后换了图却没同步布局假设。
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')

  const readPngSize = (buf) => ({
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  })

  for (const file of ['whale.png', 'DSniang03.png']) {
    const buf = await readFile(join(root, 'assets', file))
    const { width, height } = readPngSize(buf)
    check(
      width === 512 && height === 512,
      `${file} 是 512x512 方形画布`,
      `${width}x${height}`,
    )
  }
}

console.log('')
console.log('=== 展开状态（面板，空账号）===')
{
  const store = new Map([['dsh-xdpool-whale:open', '1']])
  const { mod } = await load({ store })
  const tree = mod.WhaleWidget({ t: undefined })
  const nodes = walk(tree)
  const byCls = (c) => nodes.filter((n) => n.cls === c)
  const texts = nodes.filter((n) => n.kind === 'text').map((n) => n.text)
  check(byCls('xdw-panelwrap').length === 1, '展开后有面板容器 .xdw-panelwrap')
  const bad = texts.filter((s) => /undefined|null|NaN|\[object/.test(s))
  check(bad.length === 0, '展开状态文本无 undefined/null/NaN', JSON.stringify(bad.slice(0, 5)))
  // 测试沙箱里 useEffect 是空操作，数据永远不会到达，
  // 因此面板必须停在「加载中…」或给出明确提示，绝不能是空白。
  check(
    texts.some((t) => t.includes('加载') || t.includes('账号') || t.includes('尚未')),
    '无数据时面板给出加载中或明确提示（不留空白）',
    JSON.stringify(texts.slice(0, 8)),
  )
}

console.log('')
console.log(failed === 0 ? `${G}全部通过：渲染树结构完整、文案齐全、定位不越界。${R}` : `${RED}${failed} 项失败${R}`)
process.exit(failed === 0 ? 0 : 1)
