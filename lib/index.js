/**
 * 小鲸鱼挂件 — Host 半侧。
 *
 * 浏览器半侧（./client）在 DSH Web GUI 里渲染挂件。数据分两类来源：
 *
 * 1. **xdpool 的积分/签到/用量**：来自 `GET /plugins/dsh-xdpool/status`，
 *    本插件只做轮询，不代理、不缓存。
 * 2. **DSH 自带模型厂商的余额**（如 DeepSeek）：这些 provider 不在 xdpool 的
 *    渠道名单里，余额也拿不到 xdpool 的 `credits.balances` RPC，因此本插件
 *    新增一条**只读**的 host 路由 `GET /plugins/xdpool-whale/provider-balance`，
 *    由宿主侧调用厂商的官方余额接口。
 *
 * 为什么余额必须走 host：
 *
 * 厂商余额接口要用 API Key。Key 存在 `$DSH_HOME/.credentials.yaml`，由宿主的
 * `credentials` 服务持有。**绝不能把 Key 下发到浏览器**（那会把 bearertoken
 * 暴露给页面、并落进 DevTools/网络面板/前端内存）。所以：
 *
 *   host 侧 ctx.credentials.resolve(ref) 拿值 → 服务端 fetch → 只返回余额数字
 *
 * 官方契约（@deepseek-ai/dsh-credentials）：
 *   `ctx.credentials.resolve(credentialRef(name)) -> { value, source } | undefined`
 *   `ctx.credentials.describe(ref) -> { configured, source?, writable }`（不含值）
 *
 * 其余设计约束（与既有实现一致）：
 * - `inject` 必须是字符串数组，写成对象会让加载器解析注入表时抛错、
 *   中断整个 profile 启动（2026-10-23 事故原因之一）。
 * - 路由只读、GET only、仅回环 origin，避免被跨站脚本探测。
 * - 不缓存余额（余额会变），不做写操作。
 * - 任何一家查不到都必须安静降级成 `configured:false` / 无数据，
 *   挂件只是装饰，不能拖垮宿主界面。
 */

/** Cordis 插件名，与 profile patch 里的 `id` 保持一致。 */
export const name = 'xdpool-whale'

/**
 * 声明本插件需要的 Cordis 服务。
 *
 * Cordis 4 的 `inject` **必须是字符串数组**。这里仍然留空：`credentials` 与
 * `webServer` 都通过 `ctx.inject([...], ...)` 在内部按需注入——服务缺失时
 * 对应功能不启用即可，不能让整个 profile 因为本插件而启动失败。
 */
export const inject = []

/** 本插件的只读路由前缀。与 client-modules 的 `/plugins` 约定保持一致。 */
const BALANCE_PATH = '/plugins/xdpool-whale/provider-balance'

/**
 * 支持的厂商：只列**确实有公开余额接口**的。
 *
 * DeepSeek：`GET https://api.deepseek.com/user/balance`，Bearer API Key。
 * 返回 `{ is_available, balance_infos: [{ currency, total_balance,
 * granted_balance, topped_up_balance }] }`。
 *
 * 小米 `xiaomi-token-plan-cn` 不在表里——实测它的推理端点
 * （`token-plan-cn.xiaomimimo.com/v1`）没有任何余额/账户路由（15 个候选
 * 路径全是 404），官方只提供控制台进度条 `platform.xiaomimimo.com/api/v1/
 * tokenPlan/usage`，且要 Cookie 会话（API Key 会 401）。所以它只能显示
 * 「该厂商不提供余额查询」，强行做会逼用户粘贴会过期的 session cookie。
 */
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    credential: 'DEEPSEEK_API_KEY',
    /** 官方余额接口。 */
    url: 'https://api.deepseek.com/user/balance',
    /** 超时：余额接口很快，但桌面端网络可能被代理拖慢。 */
    timeoutMs: 12_000,
    /**
     * 把上游响应压成挂件要的形状。
     *
     * 只取 CNY 口径的 `total_balance`（DeepSeek 的余额就是人民币余额），
     * 并保留赠送/充值拆分便于排查「为什么余额和充值对不上」。
     * @param json - 上游 JSON。
     */
    normalize(json) {
      const infos = Array.isArray(json?.balance_infos) ? json.balance_infos : []
      const cny = infos.find((info) => String(info?.currency ?? '').toUpperCase() === 'CNY') ?? infos[0]
      if (cny === undefined) return null
      const num = (value) => {
        const n = Number(value)
        return Number.isFinite(n) ? n : null
      }
      return {
        currency: String(cny.currency ?? 'CNY').toUpperCase(),
        total: num(cny.total_balance),
        granted: num(cny.granted_balance),
        toppedUp: num(cny.topped_up_balance),
        available: json?.is_available === true,
      }
    },
  },
}

/**
 * 把一条 JSON 写回响应。统一带上 no-store，余额不能被任何缓存留下。
 * @param res - http 响应对象。
 * @param status - HTTP 状态码。
 * @param body - 可序列化的响应体。
 */
function sendJson(res, status, body) {
  if (typeof res?.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
  }
  res.statusCode = status
  res.end(JSON.stringify(body))
}

/**
 * 判定请求是否来自本机回环。
 *
 * 余额路由只服务本机 GUI；Origin/Referer 若不是回环就拒绝，避免局域网内
 * 其它页面对它发跨站请求（虽然它本身只读、且不含密钥，但没必要开放）。
 * @param req - http 请求对象。
 */
function loopbackOrigin(req) {
  const raw = req?.headers?.origin ?? req?.headers?.referer
  if (typeof raw !== 'string' || raw === '') return true
  try {
    const host = new URL(raw).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/**
 * 用某家的 API Key 请求官方余额接口。
 *
 * 单独抽出便于测试替身：runner 注入一个假的 fetch 就能离线验证整条链路。
 * @param provider - PROVIDERS 里的一项。
 * @param apiKey - 从 credentials 服务解析出的密钥值。
 * @param fetchImpl - 注入的 fetch（默认全局 fetch）。
 * @returns 归一化后的余额，或 null（上游没有余额信息）。
 */
async function fetchBalance(provider, apiKey, fetchImpl) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), provider.timeoutMs)
  try {
    const response = await fetchImpl(provider.url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      // 401/403 说明 Key 失效；其它状态码说明上游异常。都不抛给页面，只报错。
      return { error: `upstream ${response.status}` }
    }
    const json = await response.json()
    return provider.normalize(json)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把 `credentials.define`/`resolve` 的返回值统一成字符串或 null。
 *
 * 官方 `resolve` 返回 `{ value, source } | undefined`——注意未配置时是
 * `undefined` 而不是 `null`，两种都要当「没配」。也兼容直接返回字符串。
 * @param hit - resolve 的结果。
 */
function secretValue(hit) {
  if (typeof hit === 'string') return hit.trim() === '' ? null : hit
  if (hit !== null && hit !== undefined && typeof hit === 'object' && typeof hit.value === 'string') {
    return hit.value.trim() === '' ? null : hit.value
  }
  return null
}

/**
 * 宿主半侧的 apply。
 *
 * 只在拿到 `webServer` 时注册余额路由；拿不到就退化成纯日志（挂件仍可通过
 * xdpool 的同源路由工作）。
 * @param ctx - Cordis 上下文。
 */
export function apply(ctx) {
  const server = ctx.get?.('webServer')

  if (server === undefined || server === null) {
    ctx.logger?.info?.(
      '%s: 未发现 webServer，挂件仅在 Web GUI 下可用；当前 profile 不渲染浏览器界面。',
      name,
    )
    return
  }

  ctx.logger?.info?.(
    '%s: 小鲸鱼挂件已装载，数据源 /plugins/dsh-xdpool/status + %s（client 半侧轮询）。',
    name,
    BALANCE_PATH,
  )

  /**
   * 注册只读余额路由。
   *
   * 用 `ctx.inject(['webServer'], ...)` 而不是直接读 `ctx.webServer`：
   * Desktop 的启动顺序不保证服务在 apply 时已就位，注入式注册才不会丢。
   */
  try {
    ctx.inject?.(['webServer'], (webCtx) => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: BALANCE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
          if (!loopbackOrigin(req)) return sendJson(res, 403, { error: 'origin-not-trusted' })

          const url = new URL(req.url ?? '/', 'http://localhost')
          const id = String(url.searchParams.get('provider') ?? '').toLowerCase()
          const provider = PROVIDERS[id]
          if (provider === undefined) {
            // 未知/不支持查询的厂商：明确报出来，让挂件显示「不提供余额查询」。
            return sendJson(res, 200, { provider: id, configured: false, unsupported: true })
          }

          try {
            const ref = await credentialRefOf(provider.credential)
            const hit = await ctx.get?.('credentials')?.resolve?.(ref)
            const apiKey = secretValue(hit)
            if (apiKey === null) {
              // Key 没配：这不是错误，用户可能只是还没填。
              return sendJson(res, 200, { provider: id, configured: false })
            }

            const result = await fetchBalance(provider, apiKey, fetch)
            if (result === null || result?.error !== undefined) {
              return sendJson(res, 200, {
                provider: id,
                configured: true,
                error: result?.error ?? 'no balance field',
              })
            }
            return sendJson(res, 200, { provider: id, configured: true, balance: result })
          } catch (error) {
            // 任何异常都不能让路由挂掉：返回 200 + error，挂件自行降级。
            ctx.logger?.warn?.('%s: 余额查询失败（%s）', name, String(error?.message ?? error))
            return sendJson(res, 200, { provider: id, configured: false, error: 'lookup failed' })
          }
        },
      })
      // 路由随插件卸载一起回收。
      return typeof dispose === 'function' ? dispose : undefined
    })
  } catch (error) {
    // 早期宿主没有注入式 API；降级为日志，不影响 xdpool 那条链路。
    ctx.logger?.warn?.('%s: 注册余额路由失败（%s）', name, String(error?.message ?? error))
  }
}

/**
 * 构造 credentials 服务的引用对象。
 *
 * 官方推荐 `credentialRef(name)`：它会做 POSIX 标识符校验并带上 brand。
 * 本包不把 `@deepseek-ai/*` 列为依赖（那些只存在于宿主的模块表里），所以
 * 动态 import 拿官方函数；拿不到就回落到同形状的普通对象——`resolve`
 * 只关心名字字段。
 * @param name - 环境变量式密钥名，例如 DEEPSEEK_API_KEY。
 */
async function credentialRefOf(name) {
  try {
    const mod = await import('@deepseek-ai/dsh-credentials')
    if (typeof mod?.credentialRef === 'function') return mod.credentialRef(name)
  } catch {
    /* 宿主没暴露该包：回落到普通对象 */
  }
  return { name }
}
