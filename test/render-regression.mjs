/**
 * 渲染回归测试：锁住三个曾经导致真实故障的 bug。
 *
 * 这三个问题都只在真实浏览器里暴露过，单元层面看不出来，因此用假 DOM 精确模拟：
 *
 * 1. **翻译函数缺失**（最严重）：组件收到 `t === undefined`，
 *    `t.bubbleLabel.replace(...)` 抛 TypeError → slot ErrorBoundary 捕获 →
 *    整个挂件被摘除，表现为「闪一下就没了 / 根本不出现」。
 * 2. **面板溢出屏幕**：按 left 定位 + 面板向左展开 308px，右半边被视口裁掉。
 * 3. **NaN 位置**：localStorage 旧格式数据缺 rightEdge，
 *    `Math.max(_, undefined) = NaN` → 定位样式失效 → 浮标跑到视口外。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

/**
 * 建一个插件实例。`hooks` 控制 react 替身行为，
 * `innerWidth/innerHeight` 控制视口，`store` 预置 localStorage。
 */
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
      createElement: () => ({ dataset: {}, set textContent(_v) {}, }),
      head: { appendChild: () => undefined },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      visibilityState: 'visible',
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    console,
    URL,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

  const mod = registrations[0].factory((spec) => {
    if (spec === 'react') return react
    if (spec === 'react/jsx-runtime') return jsxRuntime
    throw new Error('unexpected require: ' + spec)
  })
  return { mod, store }
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ---------------------------------------------------------------------------
// bug 1：翻译函数
// ---------------------------------------------------------------------------

test('apply() 用 ctx.locale.bind() 取翻译函数并通过 inject 传给组件', async () => {
  const { mod } = await load()
  const registered = []
  const boundNamespaces = []
  mod.apply({
    effect: (fn) => void fn(),
    locale: {
      register: () => undefined,
      bind: (ns) => {
        boundNamespaces.push(ns)
        // 返回真正可用的翻译函数
        return (key) => 'T:' + key
      },
    },
    slots: {
      inject: (_n, fn) => fn(),
      register: (options) => registered.push(options),
    },
  })

  assert.deepEqual(boundNamespaces, ['xdpool-whale'], '必须对插件命名空间调用 locale.bind')
  assert.equal(registered.length, 1)
  const options = registered[0]

  assert.equal(typeof options.inject, 'function', 'register 必须提供 inject 来传业务 props')
  const injected = options.inject()
  assert.equal(typeof injected.t, 'function', 'inject 必须提供翻译函数 t')
  assert.equal(injected.t('title'), 'T:title', '传下去的必须就是 locale.bind 的返回值')
})

test('locale 服务不可用时，组件仍拿到可调用的 t（不抛异常）', async () => {
  const { mod } = await load()
  const registered = []
  mod.apply({
    effect: (fn) => void fn(),
    locale: {
      register: () => undefined,
      // 故意不提供 bind —— 模拟老版本 locale 服务
    },
    slots: {
      inject: (_n, fn) => fn(),
      register: (options) => registered.push(options),
    },
  })
  const t = registered[0].inject().t
  assert.equal(typeof t, 'function', 'bind 缺失时必须回退到兜底翻译器')
  assert.equal(typeof t('title'), 'string', '兜底翻译器必须返回字符串')
  assert.equal(t('title'), '小鲸鱼挂件', '兜底翻译器应当返回中文文案')
})

test('组件渲染时绝不让 undefined 文案流进去（t 缺失也不崩）', async () => {
  const { mod } = await load()
  // 传 undefined：模拟调用方漏传
  const tree = mod.WhaleWidget({ t: undefined })
  assert.equal(tree.type, 'div')

  // 可点击的命中区（.xdw-hit）才是承载 aria-label / title 的节点；
  // body 只是贴图。按 className 找，而不是假设它是第一个子节点。
  const hitNode = tree.props.children
    .filter(Boolean)
    .find((node) => node.props && node.props.className === 'xdw-hit')
  assert.ok(hitNode, '必须仍然渲染出可点击的浮标命中区')
  const label = hitNode.props['aria-label']
  assert.equal(typeof label, 'string', 'aria-label 必须是字符串，不能是 undefined')
  assert.ok(label.length > 0, 'aria-label 不能为空')
  assert.ok(!label.includes('undefined'), '文案里不能出现 undefined：' + label)
  assert.equal(hitNode.props.title, label, 'title 必须与 aria-label 一致')
})

test('展开状态下所有 tr() 调用都返回字符串（不出现 undefined 拼接）', async () => {
  const { mod, store } = await load()
  // 预置「已展开」，让 Panel 参与渲染
  store.set('dsh-xdpool-whale:open', '1')
  const tree = mod.WhaleWidget({ t: undefined })
  assert.ok(tree, '展开状态也必须能渲染')

  // 递归收集所有字符串，确认没有 undefined 字样
  const seen = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') {
      seen.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (typeof node === 'object') {
      if (node.props !== undefined) {
        if (node.props.children !== undefined) walk(node.props.children)
        for (const [k, v] of Object.entries(node.props)) {
          if (k === 'children') continue
          if (typeof v === 'string') seen.push(v)
        }
      }
    }
  }
  walk(tree)
  const bad = seen.filter((s) => s.includes('undefined'))
  assert.deepEqual(bad, [], '渲染树里不应出现含 undefined 的字符串')
})

test('中文与英文的每个占位符都有对应参数（防止 replace 出 undefined）', async () => {
  const { mod } = await load()
  const dicts = []
  mod.apply({
    effect: (fn) => void fn(),
    locale: { register: (ns, value) => dicts.push(value) },
    slots: { inject: () => undefined, register: () => undefined },
  })
  const dict = dicts[0]
  for (const lang of ['zh', 'en']) {
    for (const [key, text] of Object.entries(dict[lang])) {
      assert.equal(typeof text, 'string', `${lang}.${key} 必须是字符串`)
      const holders = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
      const other = dict[lang === 'zh' ? 'en' : 'zh'][key]
      const otherHolders = [...String(other).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
      assert.deepEqual(holders.sort(), otherHolders, `${key} 的占位符中英必须一致`)
    }
  }
})

// ---------------------------------------------------------------------------
// bug 2 & 3：定位
// ---------------------------------------------------------------------------

const rootStyleOf = (tree) => tree.props.style

/**
 * 从根节点 style 里解出挂件在视口内的包围盒。
 * 现在统一用 left/top 像素定位（right:auto 无法参与 CSS 过渡插值），
 * 尺寸取 style.width（各档位底盘边长）。
 */
const boxOf = (style, banner) => {
  const left = Number(String(style.left).replace('px', ''))
  const top = Number(String(style.top).replace('px', ''))
  const width = Number(String(style.width).replace('px', ''))
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width)) {
    throw new Error(`${banner}: 定位必须是有限像素值，实际 left=${style.left} top=${style.top} width=${style.width}`)
  }
  return { left, top, width, right: left + width }
}

test('用 left/top 像素定位，挂件整体不溢出视口', async () => {
  const { mod } = await load({ innerWidth: 1600, innerHeight: 1000 })
  const tree = mod.WhaleWidget({ t: undefined })
  const style = rootStyleOf(tree)

  assert.ok(style.top !== undefined, '必须设置 top')
  assert.ok(style.left !== undefined, '必须设置 left')
  assert.equal(style.right, undefined, '不能用 right 定位（过渡无法与 auto 插值，右吸附会跳变）')

  const box = boxOf(style, '默认位置')
  assert.ok(box.left >= 0, `左边缘 ${box.left} 不能为负`)
  assert.ok(box.right <= 1600, `右边缘 ${box.right} 不能超出视口 1600`)
  assert.ok(box.top >= 0, `上边缘 ${box.top} 不能为负`)
  assert.ok(box.top + box.width <= 1000, `下边缘 ${box.top + box.width} 不能超出视口 1000`)
})

test('localStorage 脏数据不会让定位变成 NaN', async () => {
  const cases = [
    ['旧格式 left/top', JSON.stringify({ left: 1400, top: 850 })],
    ['旧格式且 top 超界', JSON.stringify({ left: 1400, top: 99999 })],
    ['上一版 rightEdge 格式', JSON.stringify({ rightEdge: 1588, top: 850 })],
    ['越界负值', JSON.stringify({ left: -9999, top: -9999 })],
    ['只缺 left', JSON.stringify({ top: 850 })],
    ['非法 JSON', '{not json'],
    ['空字符串', ''],
  ]

  for (const [label, raw] of cases) {
    const store = new Map([['dsh-xdpool-whale:pos', raw]])
    const { mod } = await load({ store, innerWidth: 1600, innerHeight: 1000 })
    const style = rootStyleOf(mod.WhaleWidget({ t: undefined }))

    assert.ok(typeof style.top === 'string', `${label}: top 必须存在`)
    assert.ok(/^-?\d+px$/.test(style.top), `${label}: top 必须是合法像素值，实际 "${style.top}"`)
    assert.ok(!style.top.includes('NaN'), `${label}: top 不得是 NaN`)
    assert.ok(!String(style.left).includes('NaN'), `${label}: left 不得是 NaN`)

    // 脏数据兜底后必须落在视口内 —— 这正是 NaN 那次把挂件推到屏幕外的回归点。
    const box = boxOf(style, label)
    assert.ok(box.left >= 0 && box.right <= 1600, `${label}: 水平方向 ${box.left}..${box.right} 必须在视口内`)
    assert.ok(box.top >= 0 && box.top + box.width <= 1000, `${label}: 垂直方向 ${box.top}..${box.top + box.width} 必须在视口内`)
  }
})

test('窗口很窄时，挂件仍然不越界', async () => {
  const { mod } = await load({ innerWidth: 360, innerHeight: 640 })
  const style = rootStyleOf(mod.WhaleWidget({ t: undefined }))
  const box = boxOf(style, '窄屏')
  assert.ok(box.left >= 0, `窄屏下左边缘 ${box.left} 必须为正`)
  assert.ok(box.right <= 360, `窄屏下右边缘 ${box.right} 不能超过 360`)
  assert.ok(box.top >= 0 && box.top + box.width <= 640, '窄屏下垂直方向不能越界')
})

// ---------------------------------------------------------------------------

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log('  OK  ' + name)
  } catch (error) {
    failed++
    console.log('  FAIL ' + name)
    console.log('       ' + (error && error.message ? error.message : error))
  }
}

if (failed > 0) {
  console.log(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过：渲染层不会再因文案缺失崩溃，也不会把面板顶出屏幕。')
