// 用量区块测试：厂商归一、聚合口径、逐日明细、空数据兜底。
// 数据形状取自线上 /plugins/dsh-xdpool/usage 的真实返回（已脱敏）。
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
function check(ok, name, detail) {
  if (ok) {
    pass += 1
    console.log(`  OK   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`)
  }
}

// 从 bundle 里把 vendorOf / normalizeUsage 抠出来跑：它们是纯函数，不依赖 React。
function extract(name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`找不到 ${name}`)
  // 从函数头开始做花括号配平，取出完整的函数体。
  const bodyStart = src.indexOf('{', start)
  let depth = 0
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`${name} 花括号不配平`)
}

const vendorOfSrc = extract('vendorOf')
const normalizeUsageSrc = extract('normalizeUsage')
const VENDOR_PREFIXES_SRC = src.slice(src.indexOf('const VENDOR_PREFIXES'), src.indexOf('];', src.indexOf('const VENDOR_PREFIXES')) + 2)
const numSrc = extract('num')

const factory = new Function(
  `${numSrc}\n${VENDOR_PREFIXES_SRC}\n${vendorOfSrc}\n${normalizeUsageSrc}\nreturn { vendorOf, normalizeUsage };`,
)
// normalizeUsage 里用到了 USAGE 常量之外的全局，这里只需要 num，已经包含。
const { vendorOf } = factory()

console.log('=== 厂商归一 ===')
check(vendorOf('deepseek-v4.1-flash') === 'DeepSeek', 'deepseek-v4.1-flash → DeepSeek')
check(vendorOf('glm-5.3-flash') === '智谱 GLM', 'glm-5.3-flash → 智谱 GLM')
check(vendorOf('kimi-k3-1') === '月之暗面 Kimi', 'kimi-k3-1 → 月之暗面 Kimi')
check(vendorOf('minimax-m3.1-flash') === 'MiniMax', 'minimax-m3.1-flash → MiniMax')
check(vendorOf('mimo-v2.6-pro') === 'MiMo', 'mimo-v2.6-pro → MiMo')
check(vendorOf('step-5-preview') === '阶跃星辰', 'step-5-preview → 阶跃星辰')
check(vendorOf('hy4-preview') === '混元 Hy', 'hy4-preview → 混元 Hy')
check(vendorOf('auto') === 'Auto', 'auto → Auto')
check(vendorOf('') === '其他', '空 id → 其他')
check(vendorOf('some-unknown-model') === '其他', '认不出的 id → 其他')
check(vendorOf('DEEPSEEK-v4-pro') === 'DeepSeek', '大小写不敏感')

console.log('\n=== 空数据兜底 ===')
{
  const r = factory().normalizeUsage(null)
  check(r === null, 'null 输入返回 null（面板走空态）')
}
{
  const r = factory().normalizeUsage({})
  check(r !== null && r.hasData === false, '空对象 hasData=false')
  check(r.models.length === 0 && r.days.length === 0, '空对象无模型无日期')
  check(r.vendors.length === 0, '空对象无厂商')
}

console.log('\n=== 真实形状归一 ===')
{
  const payload = {
    calls: 355,
    failedTurns: 7,
    rows: [
      {
        region: 'cn',
        model: 'deepseek-v4.1-flash',
        calls: 355,
        failed: 7,
        inputTokens: 31055290,
        outputTokens: 118965,
        cachedTokens: 30593152,
        lastUsedAt: 1792742740381,
      },
    ],
    days: [
      { day: '2026-10-23', calls: 355, failedTurns: 7, inputTokens: 31055290, outputTokens: 118965 },
      { day: '2026-10-22', calls: 12, failedTurns: 0, inputTokens: 1000, outputTokens: 200 },
    ],
  }
  const r = factory().normalizeUsage(payload)
  check(r.hasData === true, '有数据')
  check(r.calls === 355, `总调用数 355（实际 ${r.calls}）`)
  check(r.failed === 7, `失败 7（实际 ${r.failed}）`)
  check(r.total === 31055290 + 118965, `总 token 口径 input+output（实际 ${r.total}）`)
  check(r.cached === 30593152, '缓存命中正确')
  check(r.models.length === 1, '一个模型')
  check(r.models[0].vendor === 'DeepSeek', '模型归到 DeepSeek')
  check(r.vendors.length === 1, '一个厂商')
  check(r.vendors[0].share === 1, '唯一厂商占比 100%')
  check(r.days.length === 2, '两天明细')
  check(r.days[0].day === '2026-10-23', '日期倒序（最新在前）')
}

console.log('\n=== 多厂商聚合与占比 ===')
{
  const payload = {
    rows: [
      { model: 'deepseek-v4.1-flash', calls: 100, inputTokens: 600, outputTokens: 0 },
      { model: 'deepseek-v4-pro', calls: 50, inputTokens: 300, outputTokens: 0 },
      { model: 'glm-5.3-flash', calls: 20, inputTokens: 100, outputTokens: 0 },
    ],
    days: [],
  }
  const r = factory().normalizeUsage(payload)
  check(r.vendors.length === 2, `两个厂商（实际 ${r.vendors.length}）`)
  const ds = r.vendors.find((v) => v.vendor === 'DeepSeek')
  const glm = r.vendors.find((v) => v.vendor === '智谱 GLM')
  check(ds.total === 900, `DeepSeek 两个模型合并 900（实际 ${ds.total}）`)
  check(ds.models === 2, 'DeepSeek 计 2 个模型')
  check(ds.calls === 150, 'DeepSeek 调用 150')
  check(glm.total === 100, 'GLM 100')
  check(dfClose(ds.share, 0.9), `DeepSeek 占比 90%（实际 ${ds.share}）`)
  check(dfClose(glm.share, 0.1), `GLM 占比 10%（实际 ${glm.share}）`)
  check(r.vendors[0].vendor === 'DeepSeek', '按 total 降序，DeepSeek 在前')
  check(
    dfClose(r.vendors.reduce((s, v) => s + v.share, 0), 1),
    '各厂商占比总和为 1',
  )
}

console.log('\n=== entries 兜底形状（只有原始记录时）===')
{
  const payload = {
    entries: [
      { model: 'deepseek-v4.1-flash', usage: { inputTokens: 10, outputTokens: 2 } },
    ],
    rows: [],
    days: [],
  }
  const r = factory().normalizeUsage(payload)
  check(r.hasData === false, '只有 entries 没有 rows 时视为无聚合数据（面板不瞎猜）')
}

function dfClose(a, b) {
  return Math.abs(a - b) < 1e-9
}

console.log()
if (fail > 0) {
  console.log(`${fail} 项失败`)
  process.exit(1)
}
console.log(`全部通过：厂商归一与用量聚合口径正确（${pass} 项）。`)
