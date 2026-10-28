// vendorChannelOf 测试：会话模型 provider -> xdpool 渠道 id。
//
// 回归点：xdpool 的渠道 id 与名字是**错位**的
//   buddy     = WorkBuddy 国内版（copilot.tencent.com，余额四位数）
//   workbuddy = WorkBuddy 国际版（www.workbuddy.ai，余额 130）
// 曾经把不带后缀的默认渠道写成 workbuddy，导致选国内版模型却显示国际版的 130。
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

// 从 bundle 里抠出纯函数与常量（不依赖 React）。
function extract(name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`找不到 ${name}`)
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

function constText(name) {
  const start = src.indexOf(`const ${name} =`)
  if (start < 0) throw new Error(`找不到常量 ${name}`)
  const end = src.indexOf('\n', start)
  return src.slice(start, end)
}

const factory = new Function(
  `${constText('PROVIDER_PREFIX')}
   ${constText('DEFAULT_CHANNEL_ID')}
   let KNOWN_CHANNEL_IDS = null;
   ${extract('vendorChannelOf')}
   return {
     vendorChannelOf,
     setKnown(ids) { KNOWN_CHANNEL_IDS = new Set(ids); },
   };`,
)
const { vendorChannelOf, setKnown } = factory()

const ALL_IDS = ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini']

// 渠道名单尚未拉回（KNOWN_CHANNEL_IDS === null）时也要能判断。
console.log('=== 渠道名单未加载（启动初期）===')
check(vendorChannelOf({ provider: 'buddy', model: 'DeepSeek-V4.1-Flash' }) === null, '名单未加载时裸 provider 返回 null（由兜底处理）')
check(vendorChannelOf({ provider: 'xdpool', model: 'x' }) === 'buddy', '裸 xdpool 落到国内版 buddy')
check(vendorChannelOf({ provider: 'xdpool-global', model: 'x' }) === 'workbuddy', 'xdpool-global 落到国际版 workbuddy')
check(vendorChannelOf(null) === null, 'null 会话返回 null')

console.log('=== 渠道名单已加载（真机形态：provider 就是渠道 id）===')
setKnown(ALL_IDS)
for (const id of ALL_IDS) {
  check(vendorChannelOf({ provider: id, model: 'm' }) === id, `provider=${id} -> ${id}`)
}

console.log('=== 两个 WorkBuddy 不能串 ===')
check(
  vendorChannelOf({ provider: 'buddy', model: 'DeepSeek-V4.1-Flash' }) === 'buddy',
  '国内版 provider=buddy 必须映射到 buddy，不能是 workbuddy',
)
check(
  vendorChannelOf({ provider: 'workbuddy', model: 'DeepSeek-V4.1-Flash' }) === 'workbuddy',
  '国际版 provider=workbuddy 必须映射到 workbuddy',
)
check('buddy' !== 'workbuddy', '两个渠道 id 确实不同（防止有人合并）')

console.log('=== 带前缀的兼容形态 ===')
check(vendorChannelOf({ provider: 'xdpool-codearts', model: 'm' }) === 'codearts', 'xdpool-codearts -> codearts')
check(vendorChannelOf({ provider: 'xdpool-raccoon', model: 'm' }) === 'raccoon', 'xdpool-raccoon -> raccoon')
check(vendorChannelOf({ provider: 'xdpool', model: 'm' }) === 'buddy', '裸 xdpool -> buddy（国内版）')
check(vendorChannelOf({ provider: 'xdpool-global', model: 'm' }) === 'workbuddy', 'xdpool-global -> workbuddy（国际版）')

console.log('=== 认不出来的厂商 ===')
check(vendorChannelOf({ provider: 'unknown-vendor', model: 'm' }) === null, '未知渠道返回 null')
check(vendorChannelOf({ provider: '', model: 'm' }) === null, '空 provider 返回 null')

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：渠道映射正确，国内版与国际版不会串（${pass} 项）。`)
process.exit(fail === 0 ? 0 : 1)
