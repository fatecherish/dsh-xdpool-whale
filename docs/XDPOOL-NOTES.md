# dsh-xdpool 排查笔记

写这个小挂件的过程中，在 `dsh-xdpool` 上遇到并定位了若干问题。
这里记录**观测到的现象、定位过程、以及代码层面的证据**，
方便上游修复，也方便后来者少走弯路。

> 本文基于 `dsh-xdpool` 的一个具体版本（`lib/index.js` 758,042 字节、
> `lib/client.js` 831,470 字节、`vendor/channel-pack/pack.js` 2,762,369 字节）实测。
> 版本不同行号会变，但**结论性的结构问题**应当仍然成立。

---

## 1. 渠道 id 与显示名错位

### 现象

用户选择「XD Pool（国内版）」里的模型，挂件显示的却是**国际版账号**的余额。
反过来选国际版，也可能显示国内版。

### 证据

`REGISTERED_CHANNELS` 里两个 WorkBuddy 相关渠道：

| 渠道 id | `name` | `domain` |
|---|---|---|
| `buddy` | WorkBuddy **国内**版 | `copilot.tencent.com` |
| `workbuddy` | WorkBuddy **国际**版 | `www.workbuddy.ai` |

即 `buddy` = 国内、`workbuddy` = 国际。凭直觉写代码（「workbuddy 当然是 WorkBuddy」）
会拿到国际版的余额。

bundle 里 `pack-accounts.ts` 的原始注释也是这么说的：

> `buddy` is CodeBuddy (CN) and `workbuddy` is WorkBuddy AI (international);
> both are the two lanes the two region cards exist for.

### 影响

任何按渠道 id 做映射的下游（比如本挂件）都会踩到。用户在 `m04215` 报告的就是这个：
选了国内版模型，气泡显示 130（国际版），而国内版实际有 4,800 多。

### 建议

id 是持久化键，翻过来改名等于破坏兼容；但至少：

- 在渠道常量上补注释，说明 id 与产品的对应关系（现在只有 bundle 深处的注释提到）
- 对外暴露的接口里带上 `region` 字段，别让下游靠 id 猜

本项目的处理：`DEFAULT_CHANNEL_ID = "buddy"`（不是 `"workbuddy"`），
并用 `test/vendor-mapping.mjs` 的 26 条断言锁死映射。

---

## 2. 模型选择器里出现重复的产品分组

### 现象

模型选择器里同时出现：

- **XD Pool（国内版）** / **XD Pool（国际版）**（`dsh-xdpool` 注册的）
- **CodeBuddy (腾讯)** / **WorkBuddy (国际版)**（`channel-pack` 另注册的）

用户 `m04468` 反馈：「CodeBuddy（腾讯）和 WorkBuddy（国际版）对应 XD Pool 国内/国际版，
重复，不用展示。」

### 证据

`vendor/channel-pack/pack.js` 里的产品常量直接带 `displayName`，
而模型选择器的分组名就取这个 `displayName`：

```js
var CODEBUDDY = { id: "buddy",     displayName: "CodeBuddy (腾讯)" };
var WORKBUDDY = { id: "workbuddy", displayName: "WorkBuddy (国际版)" };
```

注册入口把这些 id **直接当 provider id 注册进 `ctx.llm`**：

```js
function registerBuddyLlm(ctx, options) {
  const product = options.product ?? CODEBUDDY;
  // ...
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)   // ← 注册成 "buddy" / "workbuddy"
}
```

而 `dsh-xdpool` 自己用 `registerConfigurableProviders` 注册的是 `xdpool` / `xdpool-global`，
显示名取自：

```js
const POOL_NAME_BY_REGION = { cn: "XD Pool（国内版）", global: "XD Pool（国际版）" };
```

两条注册链最终指向同一批底层账号，于是选择器里出现两套入口。

### 建议

`registerBuddyLlm` / `registerWorkbuddyLlm` 不应再把 `buddy` / `workbuddy`
注册为**独立 provider**——这两条已经由 `xdpool` / `xdpool-global` 托管。
若为兼容需要保留，至少应给 adapter 加个「不在模型选择器展示」的标记。

---

## 3. 扫码登录页把 pool-owned 渠道也列了出来

### 现象

用户 `m04315` 反馈：「扫码登录栏中 workbuddy 的国内和国际版已经在账号池已经有了，
但是还是显示了登录了一个账号」。

### 证据

`dsh-xdpool` 服务端明确声明这两个渠道由账号池托管：

```js
const POOL_OWNED_CHANNELS = new Set(["buddy", "workbuddy"]);
```

`channelListableAsRows()` 对它们返回 `false`，注释写得很清楚：

> The two pool-owned ids are left out on purpose … so listing them again as channels
> would offer the same models twice under two routes.

客户端也确实预留了常量：

```js
const REGION_OWNED_CHANNELS = new Set(["buddy", "workbuddy"]);   // 在账号池页用了
```

**但 `ChannelsPage` 的渲染没有用它**：

```js
channels.map(...)          // ← 没有任何 ownedByPool 过滤
```

在 `lib/client.js` 里搜 `ownedByPool`，出现次数是 **0**。

### 建议

`ChannelsPage` 的列表与空状态判断都应按 `REGION_OWNED_CHANNELS` 过滤，
与账号池页保持一致。

### 本项目的处理

本挂件不涉及登录页，所以未改上游代码；只在文档里记下这个定位。

---

## 4. 已卸载插件的残留注册

### 现象

用户 `m04493`：「已经卸载了 `dsh-workbuddy-connect` 但是还有」。

卸载 npm 包之后，配置里的注册行还在，DSH 启动时仍尝试加载，
表现为选择器里多出条目、或者启动日志里出现找不到模块的告警。

### 证据

`%APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml` 里残留：

```yaml
- id: llm-workbuddy-xdpool
  name: dsh-workbuddy-xdpool
  # distribution / disabledAccountIds / modelSelectionCn / Global /
  # automation / automationEarnings ...
```

共 92 行，而该包在磁盘上已经不存在。

同时 `.workbuddy-host-heartbeat.json` 指向 `dsh-workbuddy-connect@0.7.9`、
`pid: 26740`——那个 PID 早已退出。

### 处理

1. 从 `cordis.patch.yml` 删掉 92 行残留（283 行 → 211 行），YAML 解析复验通过
2. 孤儿心跳与目录文件改名隔离（`.bak-residue-<时间戳>`），保留 `.workbuddy-xdpool/` 里的
   `aggregate.json` / `preferred.json` / `startup.log`
3. **重启 DSH 进程**——配置在进程启动时读取一次，改完不重启不生效

> 踩过的坑：第一次改完没重启就以为没修好（服务进程 14:28:36 启动，配置 14:28:45 才写入）。

### 建议

卸载插件时应当清理 `cordis.patch.yml` 里对应的注册行。目前看起来是各管各的。

---

## 5. `status` 接口本身是实时的

排查「余额不更新」时一度怀疑后端把值缓存了。实测否定了这个猜测：

```
GET /plugins/dsh-xdpool/status
→ credits.total: 4882     （上一次采样是 5011）
→ catalogUpdatedAt: 有值且持续变化
```

接口每次都给最新值。真正的问题在挂件这一侧（`useVendorBalance` 的 effect
依赖里只有 `channelId`，切换厂商时才拉一次）——见
[ARCHITECTURE.md](./ARCHITECTURE.md#一个真实的坑只拉一次的-hook-等于永远不更新)。

**记下来是因为这个结论很有用**：以后遇到「数字不动」，先去 Network 面板看
**请求发了没有**，别急着怀疑后端。本项目实测 80 秒内 `credits.balances`
只发了 1 次请求，问题一目了然。

---

## 6. 调试期间的两条环境限制

### `/api/*` 需要同源凭证

从命令行 `curl` / `Invoke-RestMethod` 直接打 `/api/channel-pack` 会得到 **HTTP 401**。
这些接口的鉴权基于同源会话，命令行不带 cookie 和 referer。
调试时改从浏览器 console 里发 `fetch`，或者用 CDP 在页面上下文里执行。

### Web GUI 的 token 链接会失效

`dsh web` 启动时打印 `http://127.0.0.1:<port>/?token=<token>`。
这个 token 在**进程重启后失效**，此时访问只返回一行：

```
dsh web: authentication required; reopen the URL printed by dsh web
```

自动化验证（CDP）必须拿当前进程打印的那个链接，且重连时要重新取。

---

## 附：可复用的调试姿势

排查这几个问题靠的是 Chrome DevTools Protocol，不是日志。基本模式：

```
Target.createTarget({url: 'about:blank'})
  → Target.attachToTarget({targetId, flatten: true})
  → Runtime.enable
  → Page.navigate({url: <带 token 的 GUI 链接>})
  → 等页面就绪
  → Runtime.evaluate({expression: "document.querySelector('.xdw-root')", returnByValue: true})
  → Runtime.consoleAPICalled 收集 console 输出
```

顺序很重要：**先 `Runtime.enable` 再 `Page.navigate`**，否则监听不到页面初始化的日志。
反过来（先 navigate 后 enable）会报 `'Runtime.evaluate' wasn't found` 之类的错。

另外建议在代码里临时加 `console.info` 把关键变量打出来——本次定位
「`provider` 字段到底长什么样」就是靠一行临时的 `console.info`，
真机打出来是 `provider === "raccoon"`（没有 `xdpool` 前缀），
和按文档想象的完全不同。**验证完记得删掉**。
