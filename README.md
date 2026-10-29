# dsh-xdpool-whale · 小鲸鱼挂件

[![tests](https://github.com/fatecherish/dsh-xdpool-whale/actions/workflows/tests.yml/badge.svg)](https://github.com/fatecherish/dsh-xdpool-whale/actions/workflows/tests.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org/)
[![dsh](https://img.shields.io/badge/dsh-plugin-8b5cf6.svg)](https://github.com/deepseek-ai)

把 **dsh-xdpool** 的积分与用量数据渲染成 DSH Web GUI 右下角的一只可拖动鲸鱼浮标：
点一下展开面板看总积分、今日收益、签到状态、权益包到期、自动化任务健康度，
以及**调用次数 / token 用量 / 模型厂商分布 / 逐日明细**；
拖一下可以换位置；位置、尺寸和开合状态都记在浏览器本地。

> **前置条件**：已安装并启用 [`dsh-xdpool`](https://www.npmjs.com/package/dsh-xdpool)。
> 本插件只读取它暴露的 `/plugins/dsh-xdpool/status` 与 `/usage`，不代理、不篡改任何账号数据。

```bash
git clone https://github.com/fatecherish/dsh-xdpool-whale.git
cd dsh-xdpool-whale
node scripts/install.mjs                       # 预览：只打印将要改什么
node scripts/install.mjs --apply --install     # 实际安装
```

详细步骤与卸载方式见下文「[安装](#安装)」。

外观参照 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
的「白色对话气泡 + 鲸鱼立绘」形态，但数据全部换成 xdpool 的积分口径，
且立绘以 data URI 内联进客户端 bundle（原因见下文「实现要点」）。

> 数据只读、同源、不落盘：`/plugins/dsh-xdpool/status` 展开时 15 秒、收起时 60 秒拉一次；
> `/plugins/dsh-xdpool/usage` **只在面板展开时**才拉（30 秒一次，收起完全不发请求）。
> **不写任何 xdpool 状态**，也不缓存账号信息。


```
  ┌──────────────────────────┐
  │  🐳  小鲸鱼挂件            ✕ │
  │  #511af043 · workbuddy.cn │
  ├──────────────────────────┤
  │  积分余额                   │
  │  4,868                    │
  │  [今日已签到][连签 10 天]    │
  ├───────────┬──────────────┤
  │ 今日收益    │ 签到积分       │
  │ +0 积分    │ 100 积分      │
  ├───────────┼──────────────┤
  │ 权益包 36 个│ 最近到期 21 天 │
  ├───────────┴──────────────┤
  │ 自动化任务                 │
  │ ● checkin  ● report  ● tasks │
  │ ● travel   ● streak  ● comp  │
  ├──────────────────────────┤
  │ 用量记录                   │
  │ 调用次数 439 次│ 总 token 3861.54万│
  │ 缓存命中 3794.75万│ 失败轮次 7 次│
  ├──────────────────────────┤
  │ 模型厂商                   │
  │ ● DeepSeek 439次 [当前只走一家]│
  ├──────────────────────────┤
  │ 逐日明细                   │
  │ 10-23      3861.54万   439次 │
  ├──────────────────────────┤
  │ 更新于 16:16:24  [刷新]     │
  └──────────────────────────┘

  默认收起态（右下角常驻气泡）：
        ╭───────────╮
       ╱  积分余额    ╲
      │   4,926      │  ← 白色对话气泡 + 尾巴 + 两个小气泡
       ╲ 今日已签到…  ╱
        ╰─────┬─────╯
           （🐳）      ← 鲸鱼立绘，点击展开面板
```


面板从浮标**左侧**向左上展开，浮标右边缘始终贴着视口右边距。

## 数据来源

挂件镜像 `dsh-xdpool` 自己注册的两条同源只读路由：
`GET /plugins/dsh-xdpool/status` 和 `GET /plugins/dsh-xdpool/usage`。
字段映射（都已在本机真实响应上核对过）：

| 面板位置 | 取值 |
|---|---|
| 账号标题 | `accounts[]` 中 `id === activeAccountId` 的 `label` / `domain` |
| 积分余额 | `account.credits.total` |
| 今日已签到 / 连签 | `account.checkin.todayCheckedIn` / `checkin.streakDays` |
| 今日收益 | `account.automationToday.credit` |
| 签到积分 | `account.checkin.todayCredit`（回退 `automationToday.checkinCredit`） |
| 权益包 | `account.credits.packages.length` |
| 最近到期 | `account.credits.nearestExpiryMs` |
| 即将到期提醒 | `account.credits.expiringSoon` |
| 自动化任务 | `automation.jobs.<name>.ok / .failed / .firedSlots` |
| 调用次数 | `usage.calls`（回退 `sum(rows[].calls)`） |
| 总 token | `sum(rows[].inputTokens + outputTokens)` |
| 缓存命中 | `sum(rows[].cachedTokens)` |
| 失败轮次 | `usage.failedTurns`（回退 `sum(rows[].failed)`） |
| 模型厂商 | 由 `rows[].model` 的 id 前缀推导（`deepseek-*` → DeepSeek、`glm-*` → 智谱 GLM…） |
| 逐日明细 | `usage.days[]`（`day` / `calls` / `inputTokens` / `outputTokens`） |
| 浮标角标 | 总积分的「万」缩写（≥10000 时显示 `x.xx万`） |

所有字段缺失都会降级为 `0` / 空数组，**xdpool 未安装时挂件显示「读取 xdpool 状态失败」而不是崩掉整页**。

### 关于「切换厂商」

**每家渠道有独立积分余额**，挂件通过 xdpool 的 `/plugins/dsh-xdpool/channels` 拿到渠道名单，
再对每家调用 `credits.balances` 读取余额（面板展开时才拉，收起状态零请求）。

实测本机 8 家渠道（有账号的才显示）：

| 渠道 id | 名称 | 平台 |
|---|---|---|
| `codearts` | CodeArts | 华为云 |
| `buddy` | WorkBuddy 国内版 | 腾讯 |
| `workbuddy` | WorkBuddy 国际版 | 腾讯 |
| `lobsterai` | LobsterAI | 有道 |
| `qoder` / `qodercn` | Qoder 国际版 / 国内版 | 阿里云 |
| `trae` | TRAE | 字节跳动 |
| `raccoon` | Raccoon | 商汤 |
| `minimax` | MiniMax Code | MiniMax |

（`/channels` 共返回 13 家，`cline`/`loomy`/`zcode`/`gemini` 没账号，`provider.status` 过滤掉。）

**自动跟随**：宿主的会话模型 `provider` 字段**直接就是渠道 id**（实测选 Raccoon 的
`sn-deepseek-v4-1-flash` 时 `provider === "raccoon"`，不带 `xdpool` 前缀）。
挂件据此把当前会话的模型映射到对应渠道，切模型就切余额；手动点 tab 后可用
「恢复自动跟随」回到跟随模式。

> 早期版本误以为 provider 形如 `xdpool-<channel>`，只认前缀，导致自动跟随一直是关的。
> 现在 `vendorChannelOf()` 先按渠道 id 直配，再退回前缀判断。

> **`buddy` 和 `workbuddy` 千万别弄混。** 两者 id 只差一个前缀，对应的是两家
> 完全独立的账号与积分池：`buddy` 是 WorkBuddy **国内版**（copilot.tencent.com，
> 余额四位数），`workbuddy` 是 **国际版**（www.workbuddy.ai，余额 130）。
> 曾把「不带后缀的默认渠道」写成 `workbuddy`，于是选国内版模型却显示国际版的 130。
> 现在默认值 `DEFAULT_CHANNEL_ID = "buddy"`，`xdpool-global` 才映射到国际版。
> `test/vendor-mapping.mjs` 专门锁死这条对应关系。

> xdpool 的 `credits.total` 另有单一共享池口径，挂件展示的是**选中渠道自己的余额**
> 与积分包明细，不是共享池。

## 安装

```bash
# 1) 预览（dry-run，什么都不改）—— 强烈建议先跑这步
node scripts/install.mjs

# 2) 确认无误后写入并安装
node scripts/install.mjs --apply --install
```

Windows 桌面版的 profile 在 `%APPDATA%\dsh-desktop\harness\profiles\web`，
CLI 版在 `~/.dsh/profiles/web`。安装器会自己在已知位置发现 profile；
发现多个或找不到时用 `--profile <目录>` 指定。

其他选项：

```bash
node scripts/install.mjs --apply              # 只改清单文件，不装依赖
node scripts/install.mjs --uninstall --apply  # 移除本插件（不动其他依赖）
node scripts/install.mjs --rollback           # 从最近一次备份还原
```

### 安装器为什么这么啰嗦

2026-10-23 首次安装时**把用户已装的 10 个插件全清空了**，DSH 直接打不开。
复盘出四个连环坑，安装器现在逐条规避：

1. **profile 路径猜错。** 默认 `~/.dsh` 在桌面上版是错的，实际在
   `%APPDATA%\dsh-desktop\harness`。现在改为在磁盘上真实探测。

2. **`file:` 依赖跨盘符必挂。** 插件在 `D:`、profile 在 `C:` 时，pnpm 要把
   绝对路径转成相对路径，算出 `..\..\D:\...` 这种非法混合串，scandir 抛
   ENOENT 中止安装；而那一刻 lockfile 已经被按「只剩新依赖」的错误清单重写，
   node_modules 随之被清。
   → 改用 **`link:` + 正斜杠**（`link:D:/MyProject/...`），pnpm 直接建 Junction，
   不再做跨盘相对路径计算。这也是 DSH 自己对所有插件的做法。

3. **PATH 上的 pnpm 是个包装器。** DSH 在 `harness/.desktop-bin/pnpm.cmd` 放了一个
   runner，它执行前会把「安装代次」里的插件从 package.json 临时摘掉，pnpm 于是只
   看到本插件；一旦 lockfile 被重建，这些插件就从磁盘上消失了。这就是第 1 步事故里
   **插件凭空消失的机制**。
   → 安装器绕过 PATH，直接调用 DSH 自带的 pnpm 本体，并固定用 `--frozen-lockfile`。

4. **插件清单缺 `dsh.bundle.patch`。** 缺了它 DSH 根本不会加载插件的
   `cordis.patch.yml`，插件等于没装。现在 `package.json` 里有：

   ```json
   "dsh": {
     "manifestVersion": 1,
     "bundle": { "patch": "./cordis.patch.yml" },
     "client": { "inject": [...], "platform": "web" }
   }
   ```

安装器每次改动前把 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml`
备份到 profile 下的 `.xdw-backups/<时间戳>/`，装完还会复验「原有依赖一个都不能少」，
少了就回滚 lockfile 并报错退出。

## 交互

默认只显示一枚气泡（白色对话气泡 + 鲸鱼 + 积分数字），点击后才展开完整面板。

| 操作 | 行为 |
|---|---|
| 单击气泡 / Enter / Space | 展开或收起完整面板（`aria-expanded`） |
| 拖动气泡（>3px） | 移动位置，松手四边吸附；贴左边缘时整体水平镜像 |
| `Esc` | 收起面板（冒泡阶段拦截，不干扰编辑器） |
| 悬停 | 右上角出现「⋯」菜单：尺寸档位 / 立即刷新 / 开合面板 |
| 面板「刷新」 | 立即重新拉取（余额 + 厂商积分 + 用量一起刷）；失败时保留旧数据并标注「数据可能已过期」 |
| 窗口缩放 | 位置自动夹回视口，气泡不会被挤到屏幕外 |

## 实现要点

- **挂载点**：`shell.overlay`。AppFrame 里它是 `position:absolute; inset:0; z-index:20; pointer-events:none`
  的浮层，且 `> * { pointer-events:auto }`，因此不会像 `shell.bottom` 那样多占一行网格。
- **统一用 `left`/`top` 像素定位。** 早先用 `right: calc(100% - Npx)` 锚定右边缘，
  但 `right: auto → N px` 无法参与 CSS 过渡插值，右吸附时会跳变；
  现在 `defaultPosition()` 直接算出左上角像素，过渡平滑，且 `clampPosition()`
  保证整个挂件盒子（`left..left+width`）始终落在视口内。
- **读取 localStorage 必须做字段迁移与有限性校验。** 历史上存过 `{left, top}` 和
  `{rightEdge, top}` 两种格式，缺字段会让 `Math.max(min, undefined)` 得到 `NaN`，
  `NaN` 流进 style 后定位整体失效，气泡被推到视口外（实测 top 变成 1288px）。
  现在同时认三种格式，`clampPosition()` 把 `NaN`/`Infinity` 兜回默认位置。
- **翻译函数必须自己取、自己传。** `slots.register` 的组件 props 只含「五个框架 share」，
  **不含 `t`**（见 ui-slots README）。业务 props 只能由 `register` 的 `inject` 提供。
  正确写法（与官方 open-in-app 插件一致）：

  ```js
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ': dictionaries')
  const t = ctx.locale.bind(NS)                    // 拿到绑定命名空间的翻译函数
  ctx.slots.register({ /* ... */ inject: () => ({ t }) }, (props) => jsx(Widget, { t: props.t }))
  ```

  漏了这一步 → `props.t === undefined` → `t.bubbleLabel.replace(...)` 抛
  `TypeError: Cannot read properties of undefined (reading 'replace')` →
  slot 的 ErrorBoundary 捕获后**整个挂件被摘除**，表现就是「闪一下就没了」。
  组件内部还有一层 `tr = typeof t === 'function' ? t : fallbackTranslate` 兜底。
- **`shell.overlay` 是 list 槽位，注册必须带 `id`**。`SlotCore.register` 对 list
  槽位强制 `options.id`，漏传会抛
  `list slot "shell.overlay" requires options.id` —— 这个异常会冒泡进客户端插件
  装载器，表现就是**整个 Web GUI 白屏**。这也是 2026-10-23 崩溃的直接原因之一。
- **注册必须走 `slots.inject()`，不能直接 `register()`**。`SlotRegistry.register`
  内部是 `ctx.effect(() => _register(...), 'slots.register()')`，注册生命周期绑在
  「调用它的那个 fiber」上；`apply()` 里直接 register 会绑到插件初始化 fiber，
  宿主一次 reconcile 后 effect 被 dispose，挂件就消失了。
  `slots.inject(slot, cb)` 把 cb 绑到「槽位被声明」的生命周期上，槽位重声明时会重新注册。
- **注册全程 try/catch**：槽位缺失、服务缺失、被别的插件占用时一律静默跳过。
- **hook 依赖写内联箭头函数 → effect 反复重建。** `FxLayer` 原来用
  `<FxLayer onActivate={(fn) => (fxRef.current = fn)} />`，`onActivate` 每次渲染都是新引用，
  `useEffect(..., [onActivate])` 就不停清理重建，清理时把 `fxRef` 指向已卸载的闭包，
  `setVisible(false)` 不再作用于活组件——表现是**点击后 rua 动图一直盖在鲸鱼上不消失**。
  现在改成传入稳定的 `activateRef`，effect 依赖 `[]`，只挂载一次。
  > 一般规律：把「注册回调」型 props 写进 effect 依赖前，先确认它引用稳定；
  > 不稳定就改成 ref 通道。
- **绝对定位面板要按视口选展开方向。** 面板原来固定 `bottom: (px+8)px` 向上摆，
  挂件贴着屏幕底部时，760px 高的面板会把标题栏顶出视口（实测 `panelRect.y = -38`）。
  现在先量「气泡上方还有多少空间」：够就仍向上贴气泡，不够就 `position: fixed` 贴视口顶部
  并把 `max-height` 压到可用高度。
- **useCallback 之间有顺序依赖，注意 TDZ。** `beep` 必须定义在 `onPointerDown` 之前，
  否则 `useCallback(..., [beep])` 在求值时抛
  `Cannot access 'beep' before initialization`，整个挂件渲染失败。
  `togglePanel` 也有同样问题，用 `togglePanelRef` 中转。
  挂件只是装饰，任何情况下都不能拖垮宿主界面。
- **「拉一次」的 hook 等于永远不更新。** `useVendorBalance` 原来 effect 依赖
  只有 `[channelId]`，只在切换厂商那一刻拉一次 `/credits.balances`；而气泡
  又优先用它的数字（`followed.total !== null` 时完全忽略 `/status` 的轮询），
  于是用久了余额就冻结在首屏那个值上。实测 80 秒里 `credits.balances` 只发了
  1 次、`/status` 却正常刷了 2 次 —— 数据源没问题，是我们自己没再问。
  现在 60 秒轮询 + `visibilitychange` 补刷，手动刷新也走同一条链。
  > 一般规律：任何被 UI 优先采用的数字，都必须有自己的轮询，不能靠「父级
  > 顺手触发」——父级轮询的是另一个口径。
- **Host 半侧的 `inject` 必须是字符串数组**。写成 `{ webServer: { required: false } }`
  这种对象形式，Cordis 在解析注入表时报错，会中断整个 profile 启动。本插件依赖为空，
  写成 `export const inject = []`。
- **不依赖第三方包**：`require` 只用 `react` 与 `react/jsx-runtime`（二者都在外壳的冻结模块表里）。
  主题色全部走 `--dsw-*` 设计 token，明暗主题自动跟随。
- **立绘必须内联成 data URI，不能引外部文件。** DSH 宿主只给插件开放
  `/plugins/<id>/client.<name>.js` 这一条客户端 chunk 路由（`dsh-client-modules` 里的
  `CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/` 只放行 js/map），
  图片没有可用的 URL；而 client bundle 的 `factory(require)` 也只认宿主模块名，
  不能按相对路径 require 本地文件。
  源图保留在 `assets/whale.png`，用 `node scripts/embed-asset.mjs` 生成/更新
  `lib/client.js` 里 `whale-asset` 区块的 `WHALE_DATA_URI`（带 sha256 指纹，
  `--check` 可校验是否与源图一致）。
- **立绘解码失败要有兜底。** 若 `img` 触发 `onError`（例如安全策略拦掉 `data:`），
  组件切到内联的官方矢量鲸鱼，避免挂件只剩一个空气泡。
- **换装只保留两套形象：经典鲸鱼与思考鲸鱼。** 「换装」下拉的选项完全由 `SKINS` /
  `SUIT_OPTIONS` 决定，所以下线一套形象要同时清掉五处：`SKINS`、`SKIN_IMAGES`、
  `SKIN_LAYOUT`、`SUIT_OPTIONS`（及其中英词典 key）、`lib/client.js` 里的内联图区块
  与 `assets/` 下的源图。少清一处不会报错，只会留下「菜单点得到、图却是白框」或
  「词典露裸 key」这类残影，因此 `test/skin-parity.mjs` 把两套的 id 写死，
  并逐项断言下线项不在任何一个表里。上线/下线形象请连测试一起改。
- **「整图皮肤」不能当「立绘」塞进去 —— 那就先把它裁成纯立绘。** 换装的两套原始素材
  **不是同一种东西**：

  | 皮肤 | 原始素材 | 处理 |
  |---|---|---|
  | `whale` | `whale.png`：已抠图的纯立绘，透明底 | 直接用 |
  | `art2` | `DSniang02.png`：**整张构图**，自带白色思考气泡 + 两个虚线小泡泡 + 人物 | 用 `scripts/crop-art2.py` 抠掉气泡，得到 `DSniang03.png` |

  `art2` 最早也只是换 `src`、仍走立绘分支，于是图里自带的白气泡和 SVG 气泡叠成两层，
  人物被挤到右下角只剩一截，`mask-image` 还把底部又切掉一段。
  **修法不是给整图加一套独立布局**（那要按皮肤分叉 CSS、把文字塞进图里的气泡、
  还得以像素级量出气泡中心），而是**把素材本身修正成和 `whale` 同规格**：

  ```
  两张立绘统一为：512×512、透明底、人物贴底居中
  → 两套皮肤共用同一套 .xdw-whale 定位（right:3%; bottom:-14%; width:56%）
  → 零皮肤专属 CSS，根节点也不需要 data-suit 之类的开关属性
  ```

  裁切规则（`scripts/crop-art2.py`，对 1026×1026 源图逐像素扫描得出，不是手调的）：
  `y < 514` 全是气泡主体，整段清空；`y >= 514` 有 3 个不透明连通块，
  最大那个（约 236k 像素）是人物留下，另外两个（约 5.4k / 2.8k 像素）是虚线小泡泡清掉。
  脚本支持 `--check`，`assets-sync.mjs` 会跑它。

  > 一般规律：**美术素材的规格是一份契约**。当一张图用不对时，先问「它是不是根本不是
  > 这个用途的图」——把素材修正成统一规格，往往比给特例加一套布局分支成本更低、
  > 也更不容易在后续改动里回归。
- **手工改源图后必须重跑内联脚本，否则 bundle 里还是旧图。** 立绘走 `scripts/embed-asset.mjs`
  （`WHALE_DATA_URI` / `WHALE_ART2_DATA_URI`），音效走 `scripts/embed-media.mjs`（`ASSETS.*`）。
  两个都支持 `--check`，`test/assets-sync.mjs` 负责在测试里跑它们——静态检查看不出
  「base64 是旧的」这种问题，因为 bundle 语法完全合法，只是显示的是上一版图片。
- **气泡用一条闭合路径画**（`BUBBLE_BIG_D`），而不是几个独立椭圆拼：
  尾巴必须和主体融为一体，分开画会在连接处露出描边断口。
- **`max-height` 必须配 `box-sizing: border-box`。** 面板原来是 content-box +
  `max-height: min(70vh, 520px)` + `padding: 14px`，实测高度是 **548px**（520 + 上下各 14），
  上限等于失效；加了三个用量区块后 `scrollHeight` 到 690px，底部（页脚与逐日明细）
  被整个推出可视区。现在用 `border-box` + `max-height: min(calc(100vh - 140px), 760px)`，
  实测 `scrollHeight === clientHeight`，内容一次装下。

- **不注册宿主路由**：`/plugins/<id>/...` 属于 client-modules 的 bundle 前缀路由，
  宿主侧再加路由会产生歧义，所以 Host 半侧（`lib/index.js`）只打一条启动日志。
- **CSS 以 `data-plugin` 标注注入**（与官方插件一致），模块卸载时由模块系统回收。
- **无障碍**：浮标是原生 `<button>`，带 `aria-label`/`aria-expanded`；面板 `role="dialog"`；
  `prefers-reduced-motion` 下关闭游动与波纹动画。

## 开发与自测

```bash
npm test                      # 跑全部测试（推荐）
node scripts/run-tests.mjs    # 同上；--bail 遇错即停
node test/manifest.mjs        # 只校验 package.json 清单完整性
```

`scripts/run-tests.mjs` 按固定顺序执行下面的用例，最后打印汇总表；
一旦有失败就以退出码 1 结束，可直接用于 CI。

| 用例 | 校验内容 |
|---|---|
| `manifest` | `dsh.manifestVersion` / `dsh.bundle.patch` / `main` / `files` 白名单 / `client.inject` 齐全且路径存在 |
| `smoke` | 在 vm 里加载 client bundle，校验接口/字典/样式与数据口径 |
| `register-contract` | 按 `SlotCore` 真实规则校验注册调用不会拖垮宿主 |
| `render-regression` | 渲染层回归：文案缺失不崩、面板不溢出、定位不 NaN |
| `render-snapshot` | 渲染树快照：结构/文案/尺寸/默认收起态逐项核对 |
| `dict-parity` | zh/en 词典键必须一一对应（漏一条就会在英文界面露裸 key） |
| `assets-sync` | `embed-asset --check` / `embed-media --check`：bundle 里的立绘与音效必须和 `assets/` 一致 |
| `skin-parity` | 换装只保留经典鲸鱼 / 思考鲸鱼：`SKINS` / `SKIN_IMAGES` / `SKIN_LAYOUT` / `SUIT_OPTIONS` / 词典五处一致，下线项不得残留 |
| `usage-blocks` | 用量区块：厂商归一、聚合口径、占比与空数据兜底 |
| `vendor-mapping` | 渠道 id → 显示名映射（含 `buddy` 国内版 / `workbuddy` 国际版不串台） |

### 持续集成

[`.github/workflows/tests.yml`](.github/workflows/tests.yml) 在每次 push / PR 到 `main` 时
跑 **Ubuntu 与 Windows × Node 20 与 22** 四个组合，全部通过才显示绿色徽章。
本地 `npm test` 与 CI 跑的是同一份用例，不存在「本地过、CI 挂」的分叉。

`usage-blocks.mjs` 会把 `vendorOf` / `normalizeUsage` 从 bundle 里抠出来跑纯函数断言，
锁住三个容易错的口径：token 总数必须是 `input + output`（reasoning 已含在 output 内）、
多厂商占比之和必须为 1、**只有 `entries[]` 没有 `rows[]` 时必须判定为「无聚合数据」**
（否则面板会显示一堆 0，比空态更容易误导）。

`register-contract.mjs` 是那次崩溃之后补的：它复刻了 `SlotCore.register` 的
前置校验（list 槽位必须有 `id`、未声明槽位直接拒绝等），再模拟「槽位缺失 / slots 服务缺失 /
locale 服务缺失 / 槽位类型变化」四种宿主形态，确认 `apply()` 在任何一种下都不抛异常。

`render-regression.mjs` 锁住三个只在真实浏览器里暴露过的 bug（见上文「实现要点」）：
翻译函数缺失导致组件渲染期 TypeError、面板向右溢出视口、localStorage 脏数据把定位算成 `NaN`。
脏数据用例覆盖 `{left,top}`、`{rightEdge,top}`、越界负值、非法 JSON 等 7 种形态，
并额外跑一遍 360px 窄屏，确认气泡与面板都完整落在视口内。

`render-snapshot.mjs` 把 `WhaleWidget` 的完整渲染树走一遍，核对：
根节点 `.xdw-root`、气泡主体 `.xdw-body`、命中区 `.xdw-hit`、`BubbleSvg`、`Whale` 都渲染出来；
所有文本不含 `undefined`/`NaN`/`[object Object]`；定位是有限像素值且盒子不越界；
默认不展开面板；`aria-label` 是非空字符串且与 `title` 一致。
换装另外跑两轮：`skin=art2` 时只渲染一张立绘、保留 SVG 气泡、文字块仍在，
且根节点**不能**出现 `data-suit` 这类按皮肤区分的开关属性（两套皮肤共用一套布局）；
未设置时默认是 `whale`。再补一组脏存档用例：`fullBody` / `chibiSide` / `chibiFront`
这三种已下线的值，以及任意非法值，都必须回落到 `whale`，不能渲染成空白立绘。
最后核对两张立绘源图都是 512×512 方形画布。
换装只保留这两套（经典鲸鱼 / 思考鲸鱼），`skin-parity.mjs` 连同表的完整性与
下线项残留一起锁住：只要有人把旧形象加回菜单而漏了图、布局或词典，测试就会失败。

`assets-sync.mjs` 跑 `embed-asset.mjs --check` 与 `embed-media.mjs --check`，
确保 bundle 里的立绘与音效和 `assets/` 下的源文件同步——手工改图后忘了重跑内联脚本时，
bundle 语法依然合法、只是显示旧图，静态检查抓不到。

> ⚠️ 这类问题**在纯单元测试里看不出来**。真正定位它们靠的是用 Chrome DevTools Protocol
> 打开真实 GUI，抓 `Runtime.consoleAPICalled` 与 `document.querySelector('.xdw-root')`。
> 只跑 `node test/*.mjs` 会给出「全部通过」的假象——第一版就是这样带着 3 个 bug 上线的。
>
> 注意：DSH Web GUI 开启了鉴权，**裸端口用无头浏览器直接访问会返回 401**
> （页面只有一行 `dsh web: authentication required`），必须使用 `dsh web` 打印出的带 token 的链接。
> 因此自动化验证优先用 `render-snapshot.mjs`（真实 bundle + 假 DOM），
> 真机目视检查再由人工用带 token 的链接完成。

`test/fixtures/xdpool-status.sample.json` 是脱敏前结构完全一致的真实响应样本，
只用于验证字段映射，**提交/分享前请自行删掉里面的账号昵称等字段**。

## 资源优化（体积与解码内存）

立绘与音效全部内联进 `lib/client.js`（宿主只给 `client.<name>.js` chunk 开放路由，
`assets/` 下的文件在浏览器里没有 URL）。base64 会把体积放大 4/3，所以资源体积直接
决定 bundle 大小和渲染进程的解码内存。

```bash
powershell -File scripts/optimize-art.ps1   # 1) 缩放立绘并导出 raw RGBA 到 assets/.work
node scripts/optimize-png.mjs               # 2) 用最优行过滤 + zlib -9 重新编码 PNG
python scripts/crop-art2.py                 # 3) 从 DSniang02.png 裁出纯立绘 DSniang03.png
node scripts/embed-asset.mjs                # 4) 内联两套立绘（whale.png / DSniang03.png）
node scripts/embed-media.mjs                # 5) 内联音效
```

结果（实测）：

| 资源 | 优化前 | 优化后 | 说明 |
| --- | --- | --- | --- |
| `whale.png` | 610×610, 250 KB | 512×512, 193 KB | 重编码省 71 KB |
| `DSniang02.png` | 1026×1026, 456 KB | — | 只作为裁切源保留在 `assets/originals/`，不再内联 |
| `DSniang03.png` | — | 512×512, 190 KB | 由 `crop-art2.py` 裁掉气泡后得到，替换掉原来 134 KB 的整图 |
| `minecraft-exp-orb.wav` | 59 KB | — | 从未被播放，已移除 |
| `D1.mp3`（hover） | 3 KB | — | 从未被播放，已移除 |
| `client.js` | 746 KB | 646 KB | 含两张立绘（经典鲸鱼 + 思考鲸鱼） |

为什么 512px 够用：挂件立绘宽度是气泡的 56%，最大档 `SIZE_PX.lg = 244px`，
即最大显示 244 × 0.56 ≈ 137 CSS px，3 倍屏需要 411 设备像素。取 512 留有余量，
同时 512×512×4 = 1 MB，两套立绘合计 2 MB 解码，比原来的 4 MB + 1.45 MB 大幅下降。

两个实现细节：

1. **`System.Drawing.Image.FromFile` 会锁住源文件**，直接 `Save` 到同一路径会静默失败
   （文件时间戳都不变，看起来「跑成功了」其实没写）。所以脚本先把源读进 `MemoryStream`
   释放句柄，缩放结果写临时文件，最后才 `Move-Item` 覆盖。
2. **PNG 编码器差异巨大**：`System.Drawing` 把 512×512 编成 264 KB，而同样的像素用
   「5 种行过滤器取最优 + zlib level 9」只要 193 KB。`optimize-png.mjs` 自己实现
   IHDR/IDAT/IEND 与 CRC32，对每行试 None/Sub/Up/Average/Paeth 取绝对值最小者。
   没有直接引入 `sharp`/`pngquant`：本机没有这些工具，也不想为一个构建脚本增加原生依赖。

`scripts/optimize-art.ps1` 是幂等的（始终从 `assets/originals/` 的备份读），
`embed-*.mjs --check` 会校验内联结果与 `assets/` 是否一致，指纹变了就报错。

## 目录

```
.github/workflows/tests.yml  CI：Ubuntu/Windows × Node 20/22 跑全部测试
package.json                 dsh.bundle.patch / dsh.client / platform 声明
cordis.patch.yml             插件自己的注册行（由 dsh.bundle.patch 指向）
lib/index.js                 Host 半侧（inject: []，仅日志，无副作用）
lib/client.js                浏览器半侧（气泡 + 面板 + 轮询 + 归一化，立绘已内联）
assets/                      素材源文件（已全部内联，运行时不再读取）
scripts/install.mjs          写 profile 的安装器（dry-run 默认、自动备份、幂等、可回滚）
scripts/run-tests.mjs        跨平台测试执行器（npm test 的背后）
scripts/embed-asset.mjs      把 assets/whale.png 与 assets/DSniang03.png 内联进 lib/client.js（--check 校验指纹）
scripts/embed-media.mjs      把音效/动图内联进 lib/client.js（--check 校验指纹）
scripts/optimize-png.mjs     立绘重采样与量化（幂等，从 assets/originals/ 读）
docs/ARCHITECTURE.md         架构与实现细节
docs/XDPOOL-NOTES.md         dsh-xdpool 的坑与排查记录
test/manifest.mjs            插件清单完整性
test/smoke.mjs               无依赖冒烟测试
test/register-contract.mjs   挂件注册契约测试
test/render-regression.mjs   渲染层回归测试（文案缺失 / 布局溢出 / NaN 定位）
test/render-snapshot.mjs     渲染树快照测试（结构 / 文案 / 尺寸 / 收起态）
test/dict-parity.mjs         zh/en 词典键一致性
test/assets-sync.mjs         内联立绘/音效与 assets/ 源文件同步
test/skin-parity.mjs         换装只保留两套形象（去重、布局、菜单、词典）
test/usage-blocks.mjs        用量区块：厂商归一与聚合口径
test/vendor-mapping.mjs      渠道 id → 显示名映射
```

## 授权说明

代码为 MIT。`assets/whale.png` 取自参考项目
[DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)，
该项目对其 `assets/` 下的美术素材**不授予再许可**、也未声明为原创作品，
因此本仓库的 MIT 许可**不覆盖**这张图片；仅供本机自用，再分发前请自行确认授权。

