# 架构

本文说明小鲸鱼挂件怎么插进 DSH、数据从哪来、以及为什么几个地方写成现在这样。
排查过程中踩到的坑单独记在 [`XDPOOL-NOTES.md`](./XDPOOL-NOTES.md)。

---

## 1. 两个进程，两半代码

DSH 插件天然分两半：

| 半侧 | 文件 | 运行在 | 能力 |
|---|---|---|---|
| Host | `lib/index.js` | Node 进程（`cordis` 容器） | 文件系统、子进程、别的插件服务 |
| Client | `lib/client.js` | 浏览器（Web GUI） | DOM、`fetch` 同源请求、`localStorage` |

本项目 **Host 半侧几乎为空**（`inject: []`，不打日志之外不做任何事），
所有功能都在 Client 半侧。这不是偷懒——是因为要的数据全都能从**同源 HTTP 接口**拿到，
没必要为了读它去 Host 那边开一条 RPC。少一条 IPC 就少一处能挂的地方。

```
┌─────────────────────── DSH Web GUI（浏览器）────────────────────────┐
│                                                                    │
│  shell.overlay 槽位                                                 │
│   └── <WhaleWidget>  ← lib/client.js 注册进来的组件                 │
│        ├── 气泡（默认）      积分余额 / 签到状态 / 厂商名             │
│        └── 面板（点开后）    状态 / 用量 / 厂商积分 三个 tab          │
│                                                                    │
│        fetch('/plugins/dsh-xdpool/status')   ← 15s / 60s            │
│        fetch('/plugins/dsh-xdpool/usage')    ← 仅展开时 30s          │
│        fetch('/api/channel-pack')            ← 渠道名（缓存）         │
└────────────────────────────┬───────────────────────────────────────┘
                             │ 同源 HTTP
┌────────────────────────────▼───────────────────────────────────────┐
│                        DSH Host（Node）                            │
│  dsh-xdpool 插件暴露的路由                                          │
│    GET /plugins/dsh-xdpool/status   积分、签到、权益包、自动化、机位   │
│    GET /plugins/dsh-xdpool/usage    调用次数、token、逐日、厂商分布    │
└────────────────────────────────────────────────────────────────────┘
```

**关键约束**：Client 半侧不能 `import` 别的插件的 npm 包——宿主只给
`client.<name>.js` 这一个 chunk 开路由。所以两边唯一的联系就是这几个 HTTP 接口，
接口返回结构一变，挂件必须跟着改（这正是 `test/fixtures/xdpool-status.sample.json`
存在的原因：真实响应快照，字段改名时测试会先炸）。

---

## 2. 注册链路

```
package.json
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },   ← 没有它 DSH 根本不加载本插件
    "client": {
      "inject": ["...ui-renderer", "...ui-layout", "...locale", "...modules"],
      "platform": "web"
    }
  }
        │
        ▼
cordis.patch.yml        一行注册：name: dsh-xdpool-whale，不注入任何服务
        │
        ▼
lib/index.js            Host 侧 apply()，只做 logger 记录
        │
        ▼  宿主把 client.js 打包成 chunk 下发
lib/client.js
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))   ← 词典
  const t = ctx.locale.bind(NS)                           ← 翻译函数
  ctx.slots.register(
    { name: 'whale', slot: 'shell.overlay', inject: () => ({ t, ... }) },
    (props) => jsx(WhaleWidget, props)
  )
```

### 为什么 `inject` 里有 `sessions` 和 `modelDirectories`

第一版 `inject` 只有 `["slots", "locale"]`，结果运行时抛：

```
cannot get property "sessions" without inject
```

宿主对**任何一个**没在 `inject` 里声明的服务，访问时不是返回 `undefined`，
而是直接抛异常。所以用到什么必须全列进去。当前是四个：

| 注入 | 用途 |
|---|---|
| `slots` | 注册挂件组件到 `shell.overlay` |
| `locale` | zh/en 词典与 `t()` |
| `sessions` | 读当前会话用的模型，用于「厂商积分自动跟随」 |
| `modelDirectories` | 模型 → 厂商归属（`sessions` 只给模型 id，不够） |

### 为什么翻译函数要自己取自己传

`slots.register` 回调收到的 props **只含五个框架 share，不含 `t`**（见 `ui-slots` README）。
组件里直接写 `props.t(...)` 会 TypeError，整块挂件白屏。
正确做法是 `register` 时用 `inject` 把 `t` 显式塞进 props（上面代码块里的 `inject: () => ({ t })`）。

`test/render-regression.mjs` 有专门一条用例锁这个：传入缺 `t` 的 props，断言不抛异常。

---

## 3. 数据流与轮询

```
                ┌──────────────┐
   面板展开 ────▶│ 快轮询 15s   │──▶ /status
                └──────────────┘
                ┌──────────────┐
   面板收起 ────▶│ 慢轮询 60s   │──▶ /status
                └──────────────┘
                ┌──────────────┐
   面板展开 ────▶│ 用量 30s     │──▶ /usage        （收起时完全停发）
                └──────────────┘
                ┌──────────────┐
   厂商跟随 ────▶│ 余额 60s     │──▶ /api/channel-pack/credits/balances
                └──────────────┘
```

**收起时 60 秒一次**是个折中：太慢会让用户觉得数据旧，太快会让一个纯装饰性挂件
持续发请求。展开时才需要新数据，所以展开升到 15 秒。

**`/usage` 收起时彻底不拉**：这个接口要聚合几百条记录，响应大、计算重，
挂件收起时用户根本看不到它，没理由付这个成本。

### 一个真实的坑：只拉一次的 hook 等于永远不更新

第一版 `useVendorBalance` 的 effect 依赖是 `[channelId]`——只在**切换厂商**时拉一次。
而气泡显示余额时优先用它的结果（`followed.total !== null` 时完全忽略 `/status` 的值）。
于是：用户用了一段时间，消耗了几百积分，气泡数字纹丝不动，仍是挂件打开那一刻的值。

实测确认：80 秒里 `credits.balances` 只发了 **1 次**请求。

修法是加 `setInterval` 轮询 + `visibilitychange` 补刷（标签页切回来立刻补一次），
并用 `lastIdRef` 区分「真换了厂商」与「只是刷新」——前者才清空数字，
后者保留旧值，避免每轮询一次气泡就闪一下 `/status` 的旧数字。

> 教训：**effect 依赖里只有「标识」没有「时间」时，要问一句它到底会不会再跑一次。**

---

## 4. 厂商跟随

气泡上的积分必须对应「用户此刻在用的那个模型属于哪家厂商」。

```
sessionModel（来自 sessions 服务）
      │  provider 字段
      ▼
vendorChannelOf(provider)  ──►  渠道 id（buddy / raccoon / codearts / ...）
      │
      ▼
在 /channels 返回的列表里找到该渠道
      │
      ▼
拉 /api/channel-pack/credits/balances，取该渠道余额
```

### `provider` 居然是渠道 id 本身

一开始按「provider 会带 `xdpool` 前缀」来写（`xdpool-raccoon` → 剥前缀 → `raccoon`），
真机日志打出来却是：

```
provider === "raccoon"          // 没有前缀
model    === "sn-deepseek-v4-1-flash"
```

宿主的 provider 字段**直接就是渠道 id**。`vendorChannelOf()` 现在按三级优先判断：

1. `KNOWN_CHANNEL_IDS.has(provider)` → 原样返回（最常见）
2. `provider.startsWith("xdpool")` → 剥前缀；空则取默认渠道；`global` 映射到国际版
3. 其余 → `null`（认不出来就不跟随，退回「第一个有余额的」）

`KNOWN_CHANNEL_IDS` 由 `/channels` 拉到结果后填充。**注意顺序**：
它在第一次渲染时还是 `null`，所以 `followId` 必须在 `useVendors()` **之后**算，
否则算出的 `null` 不会被重算，永远停在默认渠道。

（早期版本还试过用「模型名反查厂商」，已删除——好几家渠道提供同名模型，反查找不到唯一渠道。）

### `buddy` 与 `workbuddy` 不是同一个东西

| 渠道 id | 显示名 | 域名 |
|---|---|---|
| `buddy` | WorkBuddy **国内**版 | copilot.tencent.com |
| `workbuddy` | WorkBuddy **国际**版 | www.workbuddy.ai |

名字和 id 是**错位**的，凭直觉写 `DEFAULT_CHANNEL_ID = "workbuddy"` 会让中国区用户
看到国际账号的余额。正确默认值是 `"buddy"`。
`test/vendor-mapping.mjs` 有 26 条断言专门锁这个映射，包括「两个 id 必须不同」这条防合并检查。

详见 [`XDPOOL-NOTES.md`](./XDPOOL-NOTES.md#1-渠道-id-与显示名错位)。

---

## 5. 定位与布局

### `shell.overlay` 而不是 `shell.bottom`

`shell.overlay` 在 AppFrame 里是 `position:absolute; inset:0; z-index:20; pointer-events:none`
的浮层，且 `> * { pointer-events:auto }`。挂件浮在上面，不占网格行。
用 `shell.bottom` 的话会多挤出一行，把宿主布局撑开。

### 统一用 `left`/`top` 像素

早先用 `right: calc(100% - Npx)` 锚定右边缘：拖动时改 `right`，吸附时也改 `right`。
问题在于 `right: auto → 24px` **无法参与 CSS 过渡插值**，右吸附时会硬跳一下。
现在 `defaultPosition()` 一次算出左上角像素，`clampPosition()` 保证整个盒子
（`left..left+width`）落在视口内。

### 面板位置按视口选方向

面板默认固定 `position:absolute; right:0; bottom:(气泡高+8)px`——向上展开。
如果气泡贴在屏幕顶部，上方空间不够，面板就会被顶到视口外（实测 `y = -38`）。

现在先算 `spaceAbove = innerHeight - position.top - gap`：

- 够用 → `absolute` 向上展开
- 不够 → `fixed`，贴视口右上角（`top: 12px`）

### localStorage 脏数据会让定位整体失效

历史版本存过两种格式（`{left, top}` 与 `{rightEdge, top}`），读旧值时缺字段会让
`Math.max(min, undefined)` 得到 `NaN`，`NaN` 流进 `style.left` 后整个挂件被推到
视口外（实测 top 变成 1288px，屏幕上什么都看不到）。

现在三种格式都认，且 `clampPosition()` 把 `NaN` / `Infinity` 兜回默认位置。
`test/render-regression.mjs` 覆盖 7 种脏数据形态。

---

## 6. 为什么美术资源要内联

立绘、音效、动图全部以 base64 data URI 塞进 `lib/client.js`。原因：宿主只给
`client.<name>.js` 这一个 chunk 开放路由，`assets/whale.png` 这种相对路径在浏览器里
请求不到（404）。内联是唯一不依赖 Host 半侧开静态路由的方案。

代价是 bundle 体积与解码内存。处理过程记在 README「资源优化」段：
`whale.png` 从 610×610/256KB 降到 512×512/197KB，`client.js` 从 746KB 降到 646KB
（`assets/originals/` 保留原图，`scripts/optimize-png.mjs` 幂等可重跑）。
换装只保留经典鲸鱼与思考鲸鱼两套立绘，下线的三套形象连同其 data URI 区块、
词典 key 与源图一并移除（`test/skin-parity.mjs` 锁住它们不会悄悄回来）。

`scripts/embed-*.mjs --check` 会校验内联后的指纹与 `assets/` 是否一致，
改了图忘了重跑 embed 会直接报错。

---

## 7. 测试为什么长这样

纯单元测试**看不出**渲染层的问题。上面提到的三个 bug（翻译函数 TypeError、
面板溢出视口、NaN 定位）全都是在真实浏览器里才暴露的，而单元测试当时是绿的——
第一版就是这样带着 3 个 bug 上线的。

所以测试策略是分层的：

| 层 | 做法 | 能抓到什么 |
|---|---|---|
| 契约层 | `register-contract.mjs` 复刻 `SlotCore.register` 的校验规则，模拟四种残缺宿主 | 注册调用把宿主搞崩 |
| 逻辑层 | `usage-blocks.mjs` 把纯函数从 bundle 里抠出来断言 | 口径算错（占比不为 1、token 重复计入） |
| 渲染层 | `render-snapshot.mjs` 在假 DOM 里跑完整渲染树 | 文本出现 `undefined`/`NaN`、结构缺节点 |
| 回归层 | `render-regression.mjs` 复现已知 bug 的输入 | 修好的 bug 复发 |

**真机验证仍然是必要的**（用 CDP 连真实 GUI 抓 `Runtime.consoleAPICalled`），
但它不能进 CI——GUI 有鉴权，需要带 token 的会话链接。所以：
CI 负责「不会退步」，人负责「真的对」。

---

## 8. 已知边界

- **只读**：不写 xdpool 的任何状态，不缓存账号信息，`localStorage` 里只存位置/尺寸/开合状态。
- **单厂商视图**：气泡一次只显示一家厂商的余额（跟随当前会话模型）。
  想看全部得开面板的「厂商积分」tab。
- **不处理后端改结构**：`/status` 字段一旦改名，挂件会显示空态而不是崩溃
  （`normalizeUsage` 做了兜底），但数字会不对——所以 fixture 快照很重要。
- **`/api/channel-pack` 需要同源**：无 token 的命令行请求返回 401，调试时从浏览器 console 发。
