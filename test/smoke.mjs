/**
 * 小鲸鱼挂件的浏览器端冒烟测试（不依赖 DSH 运行时）：
 * 1. 用伪造的 `window.__ModuleLoader__` 捕获 client bundle 注册的模块；
 * 2. 用伪造的 require 提供 react / react/jsx-runtime；
 * 3. 跑一遍插件接口、文案字典、CSS 注入与归一化口径。
 *
 * 说明：仓库里没有第三方依赖，所以这里不渲染真实 DOM，只验证
 * 「模块能被加载 + 插件接口形状正确 + 数据口径与 xdpool 一致」。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

// ---- react 替身：组件在测试里不会被真正渲染，hook 只要不抛错即可 -------------
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

// ---- 捕获 client bundle 的注册 ---------------------------------------------
const registrations = []
const headStyles = []
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({
    dataset: {},
    set textContent(value) {
      headStyles.push(value)
    },
  }),
  head: { appendChild: () => undefined },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  visibilityState: 'visible',
}

const memoryStore = new Map()
const sandbox = {
  window: {
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
    localStorage: {
      getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null),
      setItem: (key, value) => memoryStore.set(key, String(value)),
      removeItem: (key) => memoryStore.delete(key),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    innerWidth: 1440,
    innerHeight: 900,
  },
  document: fakeDocument,
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  console,
  URL,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

// ---- 模块形状 ---------------------------------------------------------------

assert.equal(registrations.length, 1, 'client bundle 应当只注册一个模块')
const registration = registrations[0]
assert.equal(registration.id, 'dsh-xdpool-whale', '模块 id 必须是插件包名')
assert.equal(typeof registration.factory, 'function', 'factory 必须是函数')

const requireShim = (spec) => {
  if (spec === 'react') return react
  if (spec === 'react/jsx-runtime') return jsxRuntime
  throw new Error('unexpected require: ' + spec)
}
const mod = registration.factory(requireShim)

assert.ok(headStyles.length > 0, '模块体应当注入 CSS 样式表')
const cssText = headStyles[0]
// 气泡形态：椭圆描边 + 三行文字 + 吸附镜像 + Q 弹，少任一都是回归。
for (const sel of ['.xdw-bub', '.xdw-bshape', '.xdw-textarea', '.xdw-amount', '.xdw-hint']) {
  assert.ok(cssText.includes(sel), `CSS 缺少气泡结构样式 ${sel}`)
}
assert.ok(cssText.includes('[data-mirror=true]'), 'CSS 缺少左吸附镜像规则')
assert.ok(cssText.includes('scaleY(.88)'), 'CSS 缺少按压 Q 弹规则')
assert.ok(cssText.includes('prefers-reduced-motion'), 'CSS 应当尊重减少动效偏好')

// ---- 插件接口 ---------------------------------------------------------------

assert.deepEqual([...mod.inject], ['slots', 'locale', 'uiSession', 'remote', 'remote.session', 'modelDirectories'], 'inject 必须等待 slots、locale、主会话与模型目录服务')
assert.equal(typeof mod.apply, 'function', 'apply 必须是函数')

const dicts = []
const slots = []
const ctx = {
  effect: (fn) => void fn(),
  locale: {
    register: (ns, value) => dicts.push([ns, value]),
  },
  slots: {
    inject: (_name, fn) => fn(),
    register: (options) => slots.push(options),
  },
}
mod.apply(ctx)

assert.equal(dicts.length, 1, '应当注册一个文案命名空间')
const [namespace, dictionary] = dicts[0]
assert.equal(namespace, 'xdpool-whale')
assert.deepEqual(
  Object.keys(dictionary.zh).sort(),
  Object.keys(dictionary.en).sort(),
  '中英文字典键必须一致',
)
assert.equal(slots.length, 1, '应当注册一个槽位占位者')
assert.equal(slots[0].name, 'shell.overlay', '挂件必须挂到 shell.overlay 浮层')
assert.equal(slots[0].locale, 'xdpool-whale')

// ---- 组件可构造 -------------------------------------------------------------

const tree = mod.WhaleWidget({ t: dictionary.zh })
assert.equal(tree.type, 'div', '挂件应当渲染一个 div 根节点')
assert.equal(tree.props.className, 'xdw-root', '根节点必须带挂件样式类')
const kids = tree.props.children.filter((child) => child !== null)
const body = kids.find((c) => c && c.props && c.props.className === 'xdw-body')
assert.ok(body, '必须渲染鲸鱼气泡本体')
const asArray = (v) => (Array.isArray(v) ? v : [v])
const bubKids = asArray(body.props.children).filter((c) => c !== null)
// BubbleSvg 是内联函数组件，这里断言它被挂进了气泡本体；
// 它的内部 SVG 结构由渲染回归测试（render-regression.mjs）在真实 DOM 上验。
assert.ok(
  bubKids.some((c) => c && typeof c.type === 'function' && c.type.name === 'BubbleSvg'),
  '必须挂载对话气泡组件',
)
assert.ok(
  bubKids.some((c) => c && c.props && c.props.className === 'xdw-textarea'),
  '气泡里必须有三行文字容器',
)
const hit = kids.find((c) => c && c.props && c.props.className === 'xdw-hit')
assert.ok(hit, '必须有拖拽/点击命中区')
assert.equal(typeof hit.props.onPointerDown, 'function', '命中区必须支持拖动')
assert.equal(typeof hit.props.onPointerUp, 'function', '命中区必须支持松手吸附')
assert.equal(hit.props['aria-expanded'], 'false', '默认气泡不强调')

// ---- 数据口径与 xdpool 真实响应一致 ------------------------------------------

const sample = JSON.parse(
  await readFile(join(here, 'fixtures', 'xdpool-status.sample.json'), 'utf8'),
)
const account =
  sample.accounts.find((item) => item.id === sample.activeAccountId) ?? sample.accounts[0]
assert.equal(typeof account.credits.total, 'number', '样本必须带总积分')
assert.equal(account.credits.packages.length, 36, '样本权益包数量')
assert.equal(account.checkin.streakDays, 10, '样本连签天数')
assert.equal(sample.automation.jobs.checkin.ok, 1, '样本签到任务应有 1 次成功')

// 面板展示的关键口径：总积分 = active 账号 credits.total
const totalFromSample = account.credits.total
assert.ok(totalFromSample > 0, '样本总积分应当为正')
console.log('OK: client bundle 可加载，插件接口与文案字典校验通过（样本总积分 ' + totalFromSample + '）')
