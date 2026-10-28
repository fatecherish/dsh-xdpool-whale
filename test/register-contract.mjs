/**
 * 挂件注册契约测试。
 *
 * 为什么需要它：`test/smoke.mjs` 只验证「模块能被 eval 出来」，而真正让
 * Web GUI 白屏的是**注册调用本身**抛异常——2026-10-23 那次就是这样：
 * `shell.overlay` 是 kind:"list" 的槽位，SlotCore.register 对 list 槽位
 * 强制要求 `options.id`，漏传就 throw，异常冒泡进客户端插件装载器，
 * 整个界面渲染中断。
 *
 * 这里按 @deepseek-ai/dsh-client-ui-slots 的真实规则做一个校验桩
 * （见其 lib/index.js 的 SlotCore.register），再喂给 client bundle 的
 * apply()，确认它在任何宿主形态下都不会把异常抛出去。
 *
 * 运行：node test/register-contract.mjs
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

let failures = 0
const pass = (text) => console.log(`  OK   ${text}`)
const fail = (text) => {
  failures += 1
  console.error(`  FAIL ${text}`)
}

// ---- 与 smoke.mjs 相同的宿主替身，用来拿到模块导出 -------------------------
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

const registrations = []
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
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, set textContent(_v) {} }),
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

const requireShim = (spec) => {
  if (spec === 'react') return react
  if (spec === 'react/jsx-runtime') return jsxRuntime
  throw new Error('unexpected require: ' + spec)
}
const mod = registrations[0].factory(requireShim)

/**
 * 按 SlotCore.register 的真实前置校验搭一个假宿主。
 * @param {Record<string, {kind: string, scope: string}>} declared 槽位声明表
 */
function makeHost(declared) {
  const registered = []
  const errors = []
  const injectCalls = []
  /** 最近一次 inject 注册进去的回调，用来模拟宿主重新声明槽位。 */
  let lastInjectCallback = null

  const register = (options, component) => {
    const spec = declared[options.name]
    if (spec === undefined) {
      throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
    }
    const priority = options.priority ?? 0
    switch (spec.kind) {
      case 'single':
        if (registered.some((r) => r.options.name === options.name && (r.options.priority ?? 0) === priority)) {
          throw new Error(`single slot "${options.name}" already has a registration`)
        }
        break
      case 'keyed':
        if (options.key === undefined) throw new Error(`keyed slot "${options.name}" requires options.key`)
        break
      case 'list':
        if (options.id === undefined) throw new Error(`list slot "${options.name}" requires options.id`)
        break
      case 'chain':
        if (options.select === undefined) throw new Error(`chain slot "${options.name}" requires options.select`)
        break
    }
    registered.push({ options, component })
    return () => {}
  }

  const ctx = {
    effect: (fn) => {
      try {
        return fn()
      } catch (error) {
        errors.push(error)
        return undefined
      }
    },
    locale: {
      register: (ns, dict) => {
        if (typeof ns !== 'string' || typeof dict !== 'object') {
          throw new Error('locale.register expects (namespace, dictionaries)')
        }
        return () => {}
      },
    },
    slots: {
      inject: (slotName, fn) => {
        injectCalls.push(slotName)
        lastInjectCallback = fn
        if (!(slotName in declared)) return false
        return fn()
      },
      register,
    },
  }
  return {
    ctx,
    registered,
    errors,
    injectCalls,
    reinject: () => {
      if (lastInjectCallback !== null) lastInjectCallback()
    },
  }
}

// ----------------------------------------------------------------- 用例 --

console.log('挂件注册契约测试\n')

if (typeof mod.apply !== 'function') fail('client 未导出 apply()')
else pass('client 导出 apply()')

// 用例 1：真实宿主形态（shell.overlay = list）—— 必须注册成功且带 id
{
  const { ctx, registered, errors } = makeHost({ 'shell.overlay': { kind: 'list', scope: 'root' } })
  try {
    mod.apply(ctx)
    if (errors.length) fail(`完整宿主下 locale.effect 抛错：${errors[0].message}`)
    else if (registered.length !== 1) fail(`期望注册 1 个挂件，实际 ${registered.length}`)
    else {
      const options = registered[0].options
      if (options.name !== 'shell.overlay') fail(`应注册到 shell.overlay，实际 ${options.name}`)
      else pass('注册到 shell.overlay')
      if (options.id === undefined) fail('shell.overlay 是 list 槽位，必须传 options.id')
      else pass(`list 槽位带 id：${options.id}`)
      if (typeof registered[0].component !== 'function') fail('register 第二参数必须是渲染函数')
      else pass('register 第二参数是渲染函数')
    }
  } catch (error) {
    fail(`完整宿主下 apply() 抛出了异常：${error.message}`)
  }
}

// 用例 2：宿主没有 shell.overlay —— 必须静默降级
{
  const { ctx, registered } = makeHost({})
  try {
    mod.apply(ctx)
    if (registered.length !== 0) fail('槽位缺失时不应发生注册')
    else pass('槽位缺失时静默跳过，未抛异常')
  } catch (error) {
    fail(`槽位缺失时 apply() 不应抛出，实际抛出：${error.message}`)
  }
}

// 用例 3：slots 服务整体缺失 —— 必须静默降级
{
  const { ctx } = makeHost({ 'shell.overlay': { kind: 'list', scope: 'root' } })
  delete ctx.slots
  try {
    mod.apply(ctx)
    pass('slots 服务缺失时静默跳过，未抛异常')
  } catch (error) {
    fail(`slots 缺失时 apply() 不应抛出，实际抛出：${error.message}`)
  }
}

// 用例 4：locale 服务缺失 —— 必须静默降级
{
  const { ctx, registered } = makeHost({ 'shell.overlay': { kind: 'list', scope: 'root' } })
  delete ctx.locale
  try {
    mod.apply(ctx)
    pass(`locale 缺失时未抛异常（注册数 ${registered.length}）`)
  } catch (error) {
    fail(`locale 缺失时 apply() 不应抛出，实际抛出：${error.message}`)
  }
}

// 用例 5：槽位类型变化（list → single）—— 多带的 id 不能炸
{
  const { ctx } = makeHost({ 'shell.overlay': { kind: 'single', scope: 'root' } })
  try {
    mod.apply(ctx)
    pass('槽位类型变化时仍能安全注册')
  } catch (error) {
    fail(`槽位类型变化时不应抛出：${error.message}`)
  }
}

/*
 * 用例 6：必须走 slots.inject()，而不是直接 register()。
 *
 * 这是「挂件闪一下就消失」那个 bug 的回归测试。
 * SlotRegistry.register 内部是 ctx.effect(() => _register(...))，注册绑在
 * 「调用方 fiber」上；宿主一次 reconcile 之后 effect 被 dispose，挂件就没了。
 * inject() 把回调绑在「槽位被声明」的生命周期上，因此这里必须看到 inject 被调用。
 */
{
  const { ctx, injectCalls } = makeHost({ 'shell.overlay': { kind: 'list', scope: 'root' } })
  try {
    mod.apply(ctx)
    if (injectCalls.length === 0) fail('apply() 没有走 slots.inject()——注册会绑在插件初始化 fiber 上，reconcile 后挂件会消失')
    else if (injectCalls[0] !== 'shell.overlay') fail(`slots.inject 的目标应是 shell.overlay，实际 ${injectCalls[0]}`)
    else pass('通过 slots.inject("shell.overlay") 注册（绑定槽位生命周期）')
  } catch (error) {
    fail(`用例 6 抛出异常：${error.message}`)
  }
}

/*
 * 用例 7：槽位重新声明时必须能再次注册。
 *
 * 模拟宿主 reconcile：ui-layout 先注销再重新声明 shell.overlay 的 children 表，
 * 期间 inject 的回调会再跑一次。挂件必须还能挂上去，而不是因为
 * 「同 id 已存在」被拒绝。
 */
{
  const { ctx, registered, reinject } = makeHost({ 'shell.overlay': { kind: 'list', scope: 'root' } })
  try {
    mod.apply(ctx)
    const first = registered.length
    // 宿主把挂件卸掉后再走一次 inject 回调
    registered.length = 0
    reinject()
    if (registered.length !== 1) fail(`槽位重新声明后未重新注册（注册数 ${registered.length}，首次 ${first}）`)
    else pass('槽位重新声明后能再次注册挂件')
  } catch (error) {
    fail(`用例 7 抛出异常：${error.message}`)
  }
}

console.log('')
if (failures > 0) {
  console.error(`失败 ${failures} 项`)
  process.exitCode = 1
} else {
  console.log('全部通过：挂件注册不会拖垮宿主界面。')
}
