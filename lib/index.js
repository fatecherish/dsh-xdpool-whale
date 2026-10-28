/**
 * 小鲸鱼挂件 — Host 半侧。
 *
 * 浏览器半侧（./client）在 DSH Web GUI 里渲染挂件；挂件的数据全部来自同源的
 * `GET /plugins/dsh-xdpool/status`，这里不做任何数据代理：
 *
 * - `apply` 只在日志里汇报一次载体状态（webServer 是否在位），方便排查；
 * - 不注册 webServer 路由，避免与 client-modules 的 `/plugins` 后缀冲突；
 * - 不读取账号、不缓存积分，避免重复落盘敏感信息。
 *
 * 宿主只会加载 `@deepseek-ai/*` 作用域之外的插件包，本包直接以绝对路径
 * 写入 profile 的 `cordis.patch.yml` 的 insert 列表即可被加载。
 */

/** Cordis 插件名，与 profile patch 里的 `id` 保持一致。 */
export const name = 'xdpool-whale'

/**
 * 声明本插件需要的 Cordis 服务。
 *
 * Cordis 4 的 `inject` **必须是字符串数组**（可写 `['commands', 'tools']`），
 * 写成 `{ webServer: { required: false } }` 这种对象形式会让插件加载器在
 * 解析注入表时报错，进而中断整个 profile 的启动——这是 2026-10-23 那次
 * 「装完插件 DSH 打不开」的直接原因之一。
 *
 * 这里留空数组：本插件不依赖任何宿主服务，拿不到 webServer 也只是不渲染而已。
 */
export const inject = []

/**
 * 宿主半侧的 apply。除了打一条启动日志外不产生任何副作用。
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
    '%s: 小鲸鱼挂件已装载，数据源 /plugins/dsh-xdpool/status（client 半侧轮询）。',
    name,
  )
}
