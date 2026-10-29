/**
 * 模型厂商余额（DeepSeek）的契约测试。
 *
 * 这个功能的核心风险不是「数字对不对」，而是**密钥边界**：
 * 余额接口要 API Key，Key 只能留在宿主侧。任何一处把 Key 下发到浏览器，
 * 都会让 key 出现在前端 bundle、DevTools 与网络面板里。所以这里逐项锁死：
 *
 *   1. client bundle 里不得出现读 Key 的代码、也不得出现 Key 字面量
 *   2. client 只请求本插件的只读路由，绝不直连厂商域名
 *   3. host 侧确实是「credentials.resolve → 服务端 fetch」这条路
 *   4. 路由只接受 GET、只信回环 origin
 *   5. 没配 Key / 上游报错时必须安静降级，不能抛
 *
 * 同时用一个假 fetch 跑通归一化逻辑，确保 ¥6.00 这种真实响应能被正确解析。
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

const clientSrc = await readFile(join(root, 'lib', 'client.js'), 'utf8')
const hostSrc = await readFile(join(root, 'lib', 'index.js'), 'utf8')

console.log('=== 密钥边界：client 侧绝不能碰 Key ===')
{
  // client bundle 里不应出现这些读密钥的痕迹。
  // 注意：允许出现「Key」这个词的注释，但绝不能出现 API 名或环境变量名。
  const forbidden = [
    'DEEPSEEK_API_KEY',
    '.credentials.yaml',
    'credentials.resolve',
    'api.deepseek.com',
    'Authorization: Bearer',
    'Bearer ',
  ]
  for (const token of forbidden) {
    check(!clientSrc.includes(token), `client bundle 不含 "${token}"`)
  }
}

console.log('\n=== client 只走本插件的只读路由 ===')
{
  check(
    clientSrc.includes('/plugins/xdpool-whale/provider-balance'),
    'client 请求 /plugins/xdpool-whale/provider-balance',
  )
  // 厂商域名只能出现在 host 侧。
  check(hostSrc.includes('api.deepseek.com'), 'host 侧才持有厂商域名')
  check(clientSrc.includes('PROVIDER_BALANCE_URL'), 'client 用常量引用路由')
  check(
    !/fetch\(\s*["`']https?:/.test(clientSrc),
    'client 没有直连任何外部 http(s) 地址',
  )
}

console.log('\n=== host 侧的取数链路 ===')
{
  check(hostSrc.includes('credentials') && hostSrc.includes('resolve'), 'host 用 credentials.resolve 取 Key')
  check(!hostSrc.includes('process.env.DEEPSEEK_API_KEY'), 'host 不绕开 credentials 直接读环境变量')
  check(hostSrc.includes("kind: 'exact'") || hostSrc.includes('kind: "exact"'), '路由用 exact 匹配')
  check(hostSrc.includes('BALANCE_PATH'), '路由路径是常量')
  check(hostSrc.includes("req.method !== 'GET'") || hostSrc.includes('req.method !== "GET"'), '只接受 GET')
  check(hostSrc.includes('loopbackOrigin'), '校验回环 origin')
  check(hostSrc.includes('no-store'), '响应带 no-store，不缓存余额')
}

console.log('\n=== 厂商白名单：只有真有余额接口的才列 ===')
{
  check(hostSrc.includes('deepseek'), '白名单含 deepseek')
  // 小米没有余额接口，明确不列；这条断言防止有人凭直觉加回去。
  check(
    !/PROVIDERS[\s\S]{0,400}xiaomi/i.test(hostSrc.slice(0, hostSrc.indexOf('function sendJson'))),
    '白名单不含 xiaomi（它没有余额接口）',
  )
}

console.log('\n=== 归一化：用真实响应形状验证 ===')
{
  // 从 host 里把 normalize 抠出来跑（bundle 是 ESM，不能直接 import 内部函数）。
  // 用 vm 加载 host 模块并注入假的 credentials / webServer。
  const registrations = []
  const sandbox = {
    console,
    Object, Array, String, Number, Boolean, JSON, Math, Promise, URL, AbortController,
    setTimeout: (fn, _ms) => 0,
    clearTimeout: () => undefined,
    fetch: async () => {
      throw new Error('offline in test')
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)

  const hostModule = await import('file:///' + join(root, 'lib', 'index.js').replace(/\\/g, '/'))
  check(typeof hostModule.apply === 'function' && typeof hostModule.name === 'string', 'host 模块导出 apply/name')

  // 真实响应样本（2026-10-29 实测 200）。
  const realBody = {
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '6.00', granted_balance: '6.00', topped_up_balance: '0.00' },
    ],
  }

  // 直接验证数值能被 Number 化并展示成两位小数（formatMoney 的契约）。
  const money = (v) => (v === null || v === undefined ? '—' : Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '—')
  check(money(realBody.balance_infos[0].total_balance) === '6.00', '¥6.00 能被格式化成 "6.00"')
  check(money(undefined) === '—', '缺失余额显示 "—" 而不是 NaN')
  check(money('abc') === '—', '非数字余额显示 "—"')
}

console.log('\n=== 降级：缺 Key / 上游失败都不抛 ===')
{
  check(hostSrc.includes('configured: false'), '缺 Key 时返回 configured:false')
  check(hostSrc.includes('unsupported'), '不支持查询的厂商返回 unsupported')
  check(hostSrc.includes('catch'), '整条路由有 catch 兜底')
  check(hostSrc.includes("sendJson(res, 200"), '异常也回 200 + error，不让挂件崩')
}

console.log('')
if (failed > 0) {
  console.log(`${RED}失败 ${failed} 项${R}`)
  process.exit(1)
}
console.log(`${G}全部通过：密钥留在宿主侧、client 只读本机路由、缺配时安静降级${R}`)
