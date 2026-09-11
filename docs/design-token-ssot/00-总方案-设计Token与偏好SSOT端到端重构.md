# 00-总方案：设计 Token 与偏好 SSOT 端到端重构

> **口径声明**（对齐 `AGENTS.md` §1 与 `.agents/LOGIC_PLAN_NO_RETREAT.md`）
> 本文档只含**纯逻辑依赖拓扑与执行顺序**，不含工期、人天、人员分配、优先级排序。所有列出的病灶**逻辑同权**，排列顺序仅由「谁必须在谁之前才能成立」决定，与业务重要性无关。
> 任何条目不得被降级为"简化版 / 先做一半 / 分期砍功能"。效果完整度优先于一切。
> 文档内所有事实均带 `文件:行号` 锚点，可复核。

---

## 一、目标形态：唯一权威源（四层契约）

本方案要求 token 与偏好共同构成一条**四层单轨**。每一层只允许一个权威源：

```
【触发端】 用户交互（主题/皮肤/字号/密度/外观）
      │  唯一入口：preference action（禁止组件内 setProperty / setItem）
      ▼
【传输端】 prefs_get / prefs_set        ← 必须在主注册表中真实注册（双端 1:1）
      │
      ▼
【介质端】 conex-db  app_preferences 表  ← 法定存储；LocalStorage 零写入
      │
      ▼
【消费端】 TokenRuntimeController（唯一 setProperty 点，primitive → semantic 派生）
      │
      ▼
【渲染树】 DOM computed style 真实携带    ← 验收物证
```

**每层的唯一性约束**

| 层 | 唯一权威 | 禁止 |
|---|---|---|
| Token 定义 | `apps/crish-desktop/src/styles/tokens.css`（primitive + semantic 两级） | 任何第二套色板（TS 常量、yaml、内联调色板） |
| Token 注入 | 单一 `TokenRuntimeController` | 多处 `setProperty` 写同族 token |
| 偏好数据 | `app_preferences` 表 | LocalStorage 孤岛、zustand `persist` 默认存储 |
| 偏好访问 | 单一 `preferences` 领域模块 | 各 store / 各组件自行 `getItem` |
| 命令契约 | `command_manifest.rs` 主注册表 | 前端清单与注册表漂移、调用未注册命令 |

---

## 二、端到端链路拓扑与现状断点

### 2.1 触发端

| 用户动作 | 现有入口 | 现状 |
|---|---|---|
| 切主题 | `themeStore.setTheme` → `applyTheme` 写 `data-theme` | 同时写 `localStorage.setItem('crish_theme')`（`api/themeStore.ts:66`） |
| 选皮肤/自定义背景/字号/亮度 | `themeStore` 读 8 个 LS key（`api/themeStore.ts:102-111`），写 8 个（`:121-126`） | 全在孤岛 |
| 改 UI 尺寸 / 壳层模式 | `layoutStore` 的 `withPersist`（`store/layoutStore.ts:123`，key 定义在 `:136`） | 落 `localStorage` key `crish-layout-v1` |
| 改字体 | `fontStore` → `crish_fonts`（`api/fontStore.ts:84`） | 孤岛 |
| 拖侧栏 / diff 分栏 / 换行 | `crish_sidebar_width`（`components/sidebar/useSidebarResize.ts:40,99`）、`crish:files-list-ratio`（`components/files/FilesCard.tsx`）、`crish:file-viewer-word-wrap`（`components/files/hooks/useWordWrapPreference.ts`） | 孤岛 |

**断点 1（触发端）**：入口分散在 `themeStore` / `layoutStore` / `fontStore` / `productMode` / 各 resize hook，**没有单一 preference action**。任何一个入口都能独立写孤岛。

### 2.2 传输端

**现状：不存在。**

- `command_manifest.rs` 中的 `config_*` 家族只覆盖 provider 域，落盘到 `provider-config.json`（`apps/agent-workbench/src-tauri/src/config/profile.rs:11`），与 UI 偏好无关。
- 全仓**没有任何** settings / prefs / preferences 类命令。

**断点 2（传输端）**：偏好根本没有跨层通道，因此也不存在"幽灵命令"问题——但也意味着这条链路要从零建立。

### 2.3 介质端

**现状：法定存储不存在。**

| 候选 | 事实 | 结论 |
|---|---|---|
| `conex-db` 的 `metadata` KV 表 | 只存在于 **v1 起始形态**（`crates/conex-db/src/schema.rs:29`，位于 `create_v1_schema()`）；v4 迁移显式 `DROP TABLE IF EXISTS metadata`（`crates/conex-db/src/migrate_steps.rs:151`）；v5 目标形态注释写明「metadata 旧表不创建（v4 删除）」（`schema.rs:121`） | **当前 DB 无此表** |
| 当前 DB 版本 | `LATEST_VERSION = 10`（`crates/conex-db/src/lib.rs:97`） | 需新增迁移步 |
| `provider-config.json` | 承载 provider/model 配置，非 UI 偏好 | 不可复用 |

**断点 3（介质端）**：UI 偏好 **100% 停留在 LocalStorage**。纯前端统计：**466 处** `localStorage/sessionStorage` 使用点（排除测试），其中 21 个直接字面量 key + 81 个 KEY 常量。样式/外观类孤岛清单：

```
crish-layout-v1                 uiSize / shellChromeMode / sidebarCollapsed / tabModeEnabled
crish_theme                     主题
crish_theme_skin                皮肤
crish_theme_custom_bg/_fg       自定义前景/背景
crish_font_size_adjust          字号调整
crish_theme_brightness_adjust   亮度
crish_theme_brightness_vibrant  鲜艳度
crish_theme_brightness_auto_time 智能时光
crish_fonts                     字体偏好
crish_sidebar_width             侧栏宽度
crish:files-list-ratio          diff 分栏比
crish:file-viewer-word-wrap     代码换行
crish_app_mode / crish_product_shell / crish_show_engine_settings  产品壳模式
conex_pi_settings               ← 旧版遗留，作为 fallback 被读取
```

### 2.4 消费端

| 现状注入点 | 位置 | 问题 |
|---|---|---|
| `applyTheme` 写 `data-theme` / `theme-dark` class | `api/themeStore.ts:76-81` | 与下方注入点无统一编排 |
| `visualThemeController` 写 `data-ui-size` / `data-density` / `--ui-scale` / `data-shell-chrome` | `services/visualThemeController.ts` | 第二个注入点 |
| `themePersonalization` 注入 ~30 个 surface/文本 token | `api/themePersonalization.ts` | 第三个，且数据源是 `themePresets.ts` 的 **209 处硬编码颜色** → 平行色板 |
| `oklchColorGuard` 覆写 `--text-primary/secondary/tertiary` | `api/oklchColorGuard.ts:114-127` | 第四个；且 `:118` **用字符串相等 `textPrimary === 'hsl(0, 0%, 94%)'` 反推明暗**，随后写死 4 个 hsl |
| `themeStore` 自定义背景默认值 | `api/themeStore.ts:103-104` `'#f4f3f0'` / `'#1a1a1a'` | **裸 hex 作为默认值**，即"真实调用处传 Default" |
| 终端主题 | `components/workspace/useXtermTerminal.ts:219,230` | 仅在创建/restart 时读 token，**无 `crish-theme-changed` 监听** → 已开终端不随主题重上色 |
| 文本测量字体桥 | `utils/pretextFontBridge.ts:48-50` | 取字体栈中"第一个具名字体"做测量；字体加载期/缺失时测量与渲染不一致 → 高度估算失真 |

**断点 4（消费端）**：**4 个独立注入点**写同族 token，无统一编排；token 定义真源被 `themePresets.ts` 的 209 处硬编码绕过。

### 2.5 会话持久化的三轨并存（同源问题，须一并切除）

| 轨道 | 位置 | 事实 |
|---|---|---|
| 轨 1：zustand persist → LocalStorage | `store/sessionStore.ts:49`（`withPersist`），key 在 `:63`，`partialize`（`:64-70`）含 **`sessions`（全量消息）** | 业务数据落在孤岛 |
| 轨 2：`sessionLocalStorage.ts` | `crish_session_body_v1:` 等 key 族 | 旧岛仍在 |
| 轨 3：`sessionRustDb*.ts`（8 个文件） | conex-db SQLite | 法定存储 |
| 一次性迁移 | `migrateFromLocalStorage.ts:106` `localStorage → SQLite` | 迁移后仍 `console.warn` 吞失败（`:178`），且 `:211` 存在 **30 天 LS 保留**；另有 `sessionRustDbLegacyCleanup.ts` |

`migrateFromLocalStorage.ts` 的 `SESSION_BODY_PREFIX` 引用如今**只存在于测试**（`migrateFromLocalStorage.test.ts:26,105,111,167,200,252-288`），但 `sessionStore` 的 zustand persist 仍在持续写入 —— **迁移完成 ≠ 旧轨停止**。

---

## 三、病灶清单与根因链

按**根因**归类（同权，不分先后）：

### R1 「定义真源不唯一」根因

| 病灶 | 锚点 |
|---|---|
| 平行硬编码色板 209 处，运行时覆盖同名 token | `api/themePresets.ts`（`themePersonalization` 消费） |
| 文字层级 SSOT 在个性化开启后不在 tokens.css | `api/oklchColorGuard.ts:120-127` 写死 4 个 hsl |
| 明暗推断靠字符串相等 | `api/oklchColorGuard.ts:118` |
| 裸 hex 作为默认值 | `api/themeStore.ts:103-104` |
| 混合色彩空间：99 个 hex + 123 个 hsl 混在 66 个 oklch 中 | `styles/tokens.css` |
| `--radius-2xl` 与 `--radius-xl` 三档全等（12/10/14），纯重复 | `tokens.css:373-374,1471-1472,1547-1548` |
| 组件直接引用 primitive 约 400 次（`--brand` 86 / `--accent-color` 70 / `--accent-orange` 44 …），绕过语义层 | 全仓组件 CSS |

### R2 「刻度不成立 → 用魔术数字补」根因

| 病灶 | 锚点 |
|---|---|
| `border-radius` **25.8%（118/458）** 落在刻度外，14 个离群值（1/3/5/7/9/10/13/14/16/18/20/22/24/999） | 138 个 `.module.css` |
| tokens.css 已写「圆角锁：默认档 8px」（`:474`），但组件 `border-radius: 7px` 仍有 **23 处** | 规则写在定义层，无执行机制 |
| `padding/margin/gap` **155 处**不在 `--space-*` 刻度 | 同上 |
| 间距刻度 17 档但 2/4/5/6/7/8 六档挤在 8px 内，同时缺 3/9 | `tokens.css` |
| 高程 5 档要服务 7 类场景；**裸 `box-shadow` 约 300 处** | 全仓 |
| 动效：**69 处内联 `cubic-bezier`**，其中 33 处是在**重写已有的 `--ease-emphasized`**；34 处内联时长 | 全仓 TSX |
| `z-index` 裸写值包含 **`100000`** 逃逸 | 全仓 |

### R3 「层叠与几何靠样式假象」根因

| 病灶 | 锚点 |
|---|---|
| `--z-pinned-bar` / `--z-sticky-bar` / `--z-decorative` **未定义且无 fallback** → `z-index: var(...)` 整条声明无效，退回 `auto` | `ChatMessageList.module.css:55`、`ChatMsgFilterBar.module.css:12`、`SidebarContextMenus.module.css:152`、`ChatToolCallBlock.module.css:467` |
| `overflowAnchor: 'none'` 散布 **11+ 处**主动关闭原生锚定，另以 3 套手工坐标补偿替代（`useVirtualScroll.ts:167-176`、`useUndoWithScrollAnchor.ts:65`、`PagingAnchor.ts:130,141`） | 未检查祖先盒模型与 Stacking Context 即关闭原生机制 |
| 无任何滚动视口使用 `contain: strict`；全仓仅 1 处 `content-visibility`（设置页） | 消除抖动靠补偿而非原生几何稳定 |

### R4 「静默失效」根因

| 病灶 | 数值 |
|---|---|
| **被引用但 css/JS 均未定义** | **75** 个，其中 **16** 个所有引用点都无 fallback |
| 高危（会静默失效）示例 | `--sem-error`（`ChatComposer.module.css:151`、`AttachmentCard.module.css:280`）、`--sem-warn`、`--error-color`、`--text-warning`、`--text-on-overlay`、`--shadow-dropdown`、`--diff-bg-header`、`--font-weight-regular`、`--tint-subtle`、`--sep-danger-bg-hover`、`--z-pinned-bar`/`--z-sticky-bar`/`--z-decorative` |
| **死 token（定义 0 消费）** | **146** 个 |

### R5 「无执行机制」根因

| 病灶 | 锚点 |
|---|---|
| 10 类样式问题**没有一类**被现有门禁覆盖；且 34 个 `check-*.mjs` 中**不存在**已写好未接线的样式检查 → 从来没人写过 | `scripts/` |
| `check-text-color-tokens.mjs:61` 只匹配 `color:` 属性（`:65` 主动跳过 background/border/fill/stroke/shadow），**不认 `oklch(`**，对 `.tsx` 内联 `style={{color:'#fff'}}` 因引号漏检 | 117 处硬编码色、352 处内联样式全部通过 |
| `eslint.config.js` 的 `local/*` **无任何样式规则** | — |
| `.husky/pre-commit` 只跑 `git diff --check` + 冲突标记 | 无 lint / 无 typecheck |
| 仓库**无 git remote** → 4 个 CI 工作流从未执行 | 门禁全部空转 |
| 8 个 `check-*.mjs` 无任何调用方 | `check-chat-state` / `check-coverage-threshold` / `check-layoutstore-actions` / `check-legacy-shim` / `check-lr-t1-memory-prod-ban` / `check-sec7-gfm-emoji` / `check-tsc-threshold` / `check-ui-negative-churn` |

### R6 「兼容 Shim 续命」根因

| 病灶 | 锚点 |
|---|---|
| `SETTINGS_KEY_LEGACY = 'conex_pi_settings'` 作为 fallback 被读取 | `api/themeStore.ts:51` |
| `LEGACY_MIGRATION_FLAG_KEY` / `LEGACY_PROFILES_KEY` / `LS_IMPORT_FLAG_KEY` | 前端 key 常量表 |
| 迁移后 30 天 LS 保留 | `migrateFromLocalStorage.ts:211` |
| 静默吞错使迁移失败可长期不被发现 | `migrateFromLocalStorage.ts:178`；`useChatQueue.ts:62`；`useChatSessionActions.ts:117,136` |

---

## 四、依赖拓扑（执行顺序的**逻辑**依据）

### 4.1 有向依赖图

```
                        ┌──────────────────────────────────────────┐
                        │ 组 A：Token 定义与刻度（前端自闭环）      │
                        │                                          │
                        │  A1 Token 定义真源唯一化                 │
                        │      └─► A2 刻度重建（圆角/间距/高程/    │
                        │             动效/状态色/overlay/密度）   │
                        │              └─► A3 消费者改写（去裸 hex、│
                        │                    去内联、去 primitive） │
                        │                     └─► A4 未定义/死 token│
                        │                           清零            │
                        └──────────────┬───────────────────────────┘
                                       │
        ┌──────────────────────────────┴──────────────────────────────┐
        │ 交点 C：运行时注入点唯一化（TokenRuntimeController）          │
        │   必须同时晚于 A1（定义真源）与 B3（偏好通道）               │
        └──────────────┬──────────────────────────────────────────────┘
                       │
┌──────────────────────┴───────────────────────────────────────────────┐
│ 组 B：偏好数据链路（跨层）                                            │
│                                                                      │
│  B1 app_preferences 表 + 迁移步 v10→v11                              │
│      └─► B2 prefs_get / prefs_set 注册命令（双端清单 1:1）            │
│              └─► B3 前端 preferences 领域模块（唯一访问口）            │
│                      └─► B4 各 store 改读偏好（theme/font/layout/…）   │
│                              └─► B5 孤岛物理切除（含 Shim）            │
└──────────────────────────────────────────────────────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────────────┐
        │ 组 D：门禁（G）与负向断言（N）            │
        │   依赖 A4 与 B5 完成才有可断言的目标态     │
        │   例外：G1（var 引用完整性）可立即建线     │
        └──────────────────────────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────────────┐
        │ 组 E：会话三轨合一（并行独立链）           │
        │  E1 sessionStore 停写 sessions           │
        │      └─► E2 sessionLocalStorage 物理切除  │
        │              └─► E3 30 天保留/Shim 切除   │
        │                      └─► E4 吞错改正      │
        └──────────────────────────────────────────┘
```

### 4.2 为什么必须是这个顺序（逐条给出逻辑前提，非优先级）

| 边 | 逻辑前提 |
|---|---|
| A1 → A2 | 刻度是定义的真子集。若先改刻度而定义层仍有多源，刻度会被平行色板覆盖，改完即失效。 |
| A2 → A3 | 消费者改写需要一个**已存在的目标刻度**作为落点。先改消费者会把魔术数字从一个位置搬到另一个位置（例如把 `7px` 换成 `--radius-btn` 而刻度里没有该档）。 |
| A3 → A4 | 「未定义引用」与「死 token」互为镜像：必须先确定每个 token 的**去留**（消费者改写会决定它是否仍被需要），再清理。顺序颠倒会先删掉将要被用到的 token。 |
| B1 → B2 | 命令必须有一个真实介质可读写。无介质就建命令 = 功能伪连通（红线 1）。 |
| B2 → B3 | 前端模块必须调用**已注册**命令。先写模块会产出幽灵契约（红线 3）。 |
| B3 → B4 | store 改读偏好需先有唯一访问口，否则每个 store 各写一套读写 = 多轨。 |
| B4 → B5 | 孤岛只能在**消费方已切换**之后切除；先删孤岛会让尚未切换的消费方读到空值。 |
| A1 + B3 → C | 运行时注入点唯一化需要「定义真源」与「偏好数据源」两端都已存在；否则控制器要么没有权威定义可读，要么没有权威数据可注入。 |
| B5 → C | 控制器要读偏好，必须先确认偏好只来自法定通道（不与孤岛双写）。 |
| A4 + B5 → G/N | 门禁与负向断言要有**稳定目标态**。早建门禁会把过渡态固化成"基线"，反而给旧轨发通行证。 |
| G1 例外 | `var()` 引用完整性检查针对已有事实，不依赖目标态，故可独立先建。 |
| E 组独立 | 会话三轨与会话无关的 token/偏好链路无共享节点，可并行推进；但 E1 必须先于 E2（先停写、再删旧）。 |

### 4.3 交付终点的**定义**（不是里程碑，是逻辑闭合条件）

链路闭合当且仅当同时满足：

1. 用户改任一外观偏好的路径上，`localStorage.setItem` **调用次数为 0**；
2. `prefs_set` 返回成功后，`prefs_get` 能读回**字段级无损**的同值；
3. DB 文件内 `app_preferences` 表真实存在对应行（外部可查）；
4. 渲染树 `getComputedStyle` 返回的 token 值等于偏好值派生的期望值；
5. 旧孤岛 key 在整个启动 + 交互过程中**零访问**，且相关模块文件**已不存在**。

---

## 五、物理切除清单

> 全部为**物理删除**：不得以注释、开关、隐藏、保留 shim 的方式掩盖。每条均为可勾选验收项。

### 5.1 存储孤岛（物理删除读写点）

| # | 对象 | 位置 |
|---|---|---|
| 1 | `crish-layout-v1`（zustand persist 默认存储） | `store/layoutStore.ts:123-143` 移除 `withPersist` 包装 |
| 2 | `crish_theme` | `api/themeStore.ts:40,66` |
| 3 | `crish_theme_skin` / `crish_theme_custom_bg` / `crish_theme_custom_fg` | `api/themeStore.ts:102-104,121-123` |
| 4 | `crish_font_size_adjust` | `api/themeStore.ts:105,124` |
| 5 | `crish_theme_brightness_adjust` / `_vibrant` / `_auto_time` | `api/themeStore.ts:107-111,125-126` |
| 6 | `crish_fonts` | `api/fontStore.ts:84` |
| 7 | `crish_sidebar_width` | `components/sidebar/useSidebarResize.ts:40,99` |
| 8 | `crish:files-list-ratio` | `components/files/FilesCard.tsx` |
| 9 | `crish:file-viewer-word-wrap` | `components/files/hooks/useWordWrapPreference.ts` |
| 10 | `crish_app_mode` / `crish_product_shell` / `crish_show_engine_settings` | `api/productMode.ts:30,41`（读）+ 对应写入点；`crish_app_mode` 另见 `createSsrGlobals.ts` |
| 11 | `conex_pi_settings`（legacy fallback 读取） | `api/themeStore.ts:51` |
| 12 | 会话三轨中的孤岛轨 | 见 5.3 |

### 5.2 兼容 Shim 与无日落期残留

| # | 对象 | 位置 |
|---|---|---|
| 13 | `SETTINGS_KEY_LEGACY` 常量与全部读取分支 | `api/themeStore.ts:51` 及常量定义处 |
| 14 | `LEGACY_MIGRATION_FLAG_KEY` / `LEGACY_PROFILES_KEY` / `LS_IMPORT_FLAG_KEY` 及其迁移分支 | 前端 key 常量表 + 各持有模块 |
| 15 | 迁移后 30 天 LS 保留逻辑 | `migrateFromLocalStorage.ts:211` |
| 16 | `sessionRustDbLegacyCleanup.ts`（若其唯一职责是兼容旧轨） | `api/session-persistence/sessionRustDbLegacyCleanup.ts` |

### 5.3 会话多轨（双写必须物理切除）

| # | 对象 | 位置 |
|---|---|---|
| 17 | `sessionStore` 的 `withPersist` + `partialize` 中的 `sessions` | `store/sessionStore.ts:64-70` |
| 18 | `sessionLocalStorage.ts` 整个模块及其调用点 | `api/session-persistence/sessionLocalStorage.ts` |
| 19 | `migrateFromLocalStorage.ts` 及其测试 | `api/session-persistence/migrateFromLocalStorage.ts`、`migrateFromLocalStorage.test.ts` |
| 20 | ~~`sessionRustDbFallback.ts`~~ **【核实后撤回】** 它不是遗留孤岛，而是非 Tauri 宿主（浏览器/dev/test）的**同步回退能力**（被 3 个模块 import）。删除它等于砍功能，不是还债。须先做"单宿主 vs 双宿主"的显式架构决策 | 详见 `audits/物理切除可行性核实.md` |

### 5.4 Token 层

| # | 对象 | 位置 |
|---|---|---|
| 21 | 平行硬编码色板（209 处）→ 降为 **primitive 层唯一来源**，语义层改由 `var()` 派生 | `api/themePresets.ts` |
| 22 | `oklchColorGuard` 的字符串反推 + 写死 4 个 hsl | `api/oklchColorGuard.ts:118-127` |
| 23 | `themeStore` 的裸 hex 默认值 `'#f4f3f0'` / `'#1a1a1a'` | `api/themeStore.ts:103-104` |
| 24 | `--radius-2xl`（与 `--radius-xl` 三档全等） | `tokens.css:374,1472,1548` |
| 25 | 146 个死 token（逐个判定"删"或"补消费"；不得保留为注释或 `/* reserved */`） | `tokens.css` |
| 26 | 组件 CSS 中的 117 处硬编码颜色、458 处中越界的 118 处圆角、155 处越界间距、约 300 处裸 `box-shadow`、69 处内联 `cubic-bezier`、34 处内联时长 | 138 个 `.module.css` + 142 个 `.tsx` |
| 27 | 352 处内联 `style={{}}` 中 143 处硬编码 | 142 个 `.tsx` |
| 28 | 4 份 monospace 字体栈中多余的 3 份 | `tokens.css:224,547`、`markdown-typography.css:15`、`utils/pretextFontBridge.ts:2` |
| 29 | 裸 `z-index` 数值（含 `100000` 逃逸） | 全仓 |

### 5.5 门禁层面

| # | 对象 |
|---|---|
| 30 | 8 个无任何调用方的 `check-*.mjs`：要么接线，要么删除（不得留作死快照） |

---

## 六、新建节点清单

### 6.1 介质端

| # | 新建项 | 要求 |
|---|---|---|
| N1 | conex-db 迁移步 `v10 → v11`：`CREATE TABLE app_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)` | 与 `create_v1_schema` 里已废弃的 `metadata` 不同名，避免与历史 `DROP` 语义混淆；迁移幂等；必须有回滚/前向兼容断言 |
| N2 | `LATEST_VERSION` 10 → 11（`crates/conex-db/src/lib.rs:97`）+ `SCHEMA_VERSION_STRING` 同步 | 二者必须一致，否则版本断言失败 |

### 6.2 传输端

| # | 新建项 | 要求 |
|---|---|---|
| N3 | 命令 `prefs_get`（读全量或按 key）、`prefs_set`（写单 key，**禁止**收整体对象后丢弃未知字段）、`prefs_delete` | 三个命令都必须在 `command_manifest.rs` **与** `apps/crish-desktop/src/api/transport/commandManifest.ts` 双端登记为 `registered = true`，且条数断言同步更新 |
| N4 | `prefs_set` 的载荷校验：**未知 key 拒绝而非忽略**，值类型不符拒绝而非回落默认 | 直击红线 3「破坏性容错回退」 |

### 6.3 触发端 / 消费端

| # | 新建项 | 要求 |
|---|---|---|
| N5 | `api/preferences/preferencesClient.ts`：唯一访问口，封装 N3 | 不得出现第二处 `transport.request('prefs_*')` |
| N6 | `api/preferences/preferencesSchema.ts`：偏好的**唯一字段定义**（键名、类型、默认值） | 默认值只允许来自 token 定义或此表，禁止散落裸值 |
| N7 | `TokenRuntimeController`（合并现 `themeStore.applyTheme` + `visualThemeController` + `themePersonalization` + `oklchColorGuard` 的注入职责） | 唯一 `setProperty` 点；输入为偏好 + primitive 定义；输出为 semantic token 派生；`isDark` 以**布尔返回**而非字符串反推 |
| N8 | 启动水合 `usePreferencesHydration`：启动时一次 `prefs_get` → 灌入 N6 定义的 store 切片 | 必须在首帧前完成（避免"不跟随系统深色"这类首屏错色） |
| N9 | 偏好变更的单一订阅：偏好 → `TokenRuntimeController` 重算 → DOM | 含 `prefers-color-scheme` 监听与已开 xterm 实例的重上色 |

### 6.4 Token 定义层

| # | 新建项 | 要求 |
|---|---|---|
| N10 | 三级分层定稿：primitive（色阶原始值）→ semantic（`--text-*`/`--bg-*`/`--border-*`/`--color-*`）→ component 只允许引用 semantic | 组件引用 primitive 约 400 处须全部改写 |
| N11 | 刻度补齐：圆角补 7px 档、间距收敛并补 3/9、状态色补 hover/active/soft/border/text-on、新增 overlay 色阶、高程补 4 档、动效补四族时长、密度令牌 | 每个刻度值必须可从语义推导，禁止"补偿型常量" |
| N12 | 层叠标尺：补齐并定义 `--z-pinned-bar` / `--z-sticky-bar` / `--z-decorative`，同时给出 **Stacking Context 检查规范**（滚动/粘性层必须穿透检查祖先盒模型与层叠上下文） | 直击红线 4 |

### 6.5 门禁层

| # | 门禁 | 检测方式 | 目标态 |
|---|---|---|---|
| G1 | `var()` 引用完整性 | 定义集（css + JS `setProperty` + 对象键/计算键）vs 引用集（含按名读取） | 未定义引用 = **0** —— ✅ **已达成**（71 → 0），门禁 `scripts/check-token-consistency.mjs` 已落成并接线 `check:desktop` + `ci.yml` |
| G2 | 死 token | 定义集 vs 引用集差集 | 死 token = **0** —— ✅ **已达成**（126 → 0），基线冻结为 0/0/0 |
| G3 | 颜色字面量（全属性 + oklch + 关键字） | 扩 `check-text-color-tokens.mjs`：属性放开到 background/border/outline/fill/stroke/shadow，正则补 `oklch(` 与颜色关键字，`.tsx` 走 AST | 硬编码色 = **0**（当前 117） |
| G4 | 内联 `style` 硬编码 | AST 遍历 JSX style 对象字面量 | 硬编码内联 = **0**（当前 143） |
| G5 | 刻度合规 | PostCSS 提取 `border-radius/padding/margin/gap`，值须落在 token 刻度（放行 `var`/`calc`） | 越界 = **0**（当前 118 + 155） |
| G6 | 逃逸值拦截 | `z-index` 须用 `--z-*`；`box-shadow` / `transition` 须用 token；`!important` 全量计数（去掉 `src/styles/` 例外） | 裸值 = **0**（当前 z-index 含 100000、shadow ≈300、`!important` 91） |
| G7 | 偏好通道唯一性 | 断言样式/偏好写入路径上 `localStorage.setItem` 零调用；断言仅 `preferencesClient` 调用 `prefs_*` | 违反 = **0** |
| G8 | 命令契约 1:1 | 前端调用集 ⊆ 主注册表；双端清单条数一致 | 幽灵命令 = **0** |
| G9 | 门禁接线 | `check:desktop` 串联全部 G*；`.husky/pre-commit` 调用 `check:desktop` | 未接线 = **0** |

---

## 七、负向断言清单

> 依据交付准则「自动化测试中必须包含断言旧字段、旧方法、旧类名已被彻底根除的负向用例」。以下每条为**必须存在**的自动化断言。

### 7.1 旧存储根除

```
V1  样式/偏好交互全流程中 localStorage.setItem 调用次数 === 0（spy 计数）
V2  localStorage.getItem 对以下 key 的访问次数 === 0：
      crish-layout-v1, crish_theme, crish_theme_skin, crish_theme_custom_bg,
      crish_theme_custom_fg, crish_font_size_adjust, crish_theme_brightness_*,
      crish_fonts, crish_sidebar_width, crish:files-list-ratio,
      crish:file-viewer-word-wrap, crish_app_mode, crish_product_shell,
      crish_show_engine_settings, conex_pi_settings
V3  启动 + 主题切换 + 会话切换后，localStorage 中不存在上述任一 key
V4  sessionStore 变更后，localStorage 中不存在 crish_session_store_v1
```

### 7.2 旧模块根除

```
V5  import('api/session-persistence/sessionLocalStorage') 抛错（文件不存在）
V6  import('api/session-persistence/migrateFromLocalStorage') 抛错
V7  import('api/oklchColorGuard') 抛错（职责并入 TokenRuntimeController）
V8  全仓不存在标识符 SETTINGS_KEY_LEGACY / LEGACY_MIGRATION_FLAG_KEY /
      LEGACY_PROFILES_KEY / LS_IMPORT_FLAG_KEY / SESSION_BODY_PREFIX
V9  全仓不存在字符串 'conex_pi_settings'
```

### 7.3 Token 层根除

```
V10 全仓 var() 引用集 ⊆ 定义集（G1 断言，失败即列出缺失名）
V11 '--radius-2xl' 不出现在 tokens.css
V12 16 个曾未定义的 token（--sem-error/--sem-warn/--error-color/--text-warning/
      --text-on-overlay/--shadow-dropdown/--diff-bg-header/--font-weight-regular/
      --tint-subtle/--sep-danger-bg-hover/--z-pinned-bar/--z-sticky-bar/
      --z-decorative …）在定义集内
V13 tokens.css 中不含裸 hex（仅允许 oklch/lch/color() 或 var()）
V14 全仓组件 CSS/TSX 不含裸 hex/rgb/rgba/hsl/颜色关键字（G3）
V15 全仓 border-radius/padding/margin/gap 取值 ∈ token 刻度（G5）
V16 全仓无裸 z-index 数值、无裸 box-shadow、无裸 transition 时长/缓动（G6）
V17 全仓 !important 出现次数 === 0
V18 组件 CSS 引用集与 primitive 层集合交集 === ∅（组件只许用 semantic）
```

### 7.4 契约与静默

```
V19 前端 transport.request 的命令名集合 ⊆ 主注册表命令集合（G8）
V20 双端清单长度 === 142 且 registered 集合逐项相等
V21 prefs_set 传入未知 key 时返回错误（而非静默忽略）
V22 prefs_set 落库后 prefs_get 回读，字段级 deepEqual（含 undefined/空字符串边界）
V23 全仓 catch 块中不存在无注解空 catch（含 `/* swallow-ok */` 之外的一切形式）
V24 迁移路径失败时抛出并使启动失败，而非 console.warn 后继续
```

### 7.5 消费端生效

```
V25 切换主题后，存活 xterm 实例 options.theme 等于新主题派生值
V26 偏好写入后，document.documentElement 的 computed 值与期望派生值相等
V27 首帧即应用偏好（首屏 computed 值 !== 默认值，当偏好非默认时）
V28 prefers-color-scheme 变化时，无显式偏好则跟随
```

---

## 八、五类物证验收矩阵

| 物证类型 | 取证方式 | 通过判据 |
|---|---|---|
| **触发端** | 自动化交互（真实 UI 点击主题/字号/密度控件），spy 拦截跨层调用 | 交互**准确发起** `prefs_set` 请求，参数与 UI 选择一致 |
| **传输端** | ① `core_list_commands` 返回值中检索 `prefs_get`/`prefs_set`/`prefs_delete` 且 `registered === true`；② 真实 `transport.request` 收到成功响应 | 契约在主注册表中**真实存在并有效收发** |
| **介质端** | ① 直接查 SQLite：`SELECT * FROM app_preferences WHERE key = ?` 有对应行且值与 UI 选择一致；② 全流程 `localStorage` spy 计数为零；③ 旧孤岛 key 不存在 | 数据**无损落盘至法定存储**，**旧孤岛零写入且已物理清退** |
| **消费端** | ① `getComputedStyle(document.documentElement).getPropertyValue('--…')` 等于派生期望值；② 真实渲染元素（如按钮）的 computed `border-radius`/`color` 等于 token 派生值；③ xterm 实例 `options.theme` 等于新主题值 | 内核/渲染树**真实携带并应用**新配置 |
| **负向断言** | 第七章 V1–V28 全部自动化用例 | 旧字段、旧方法、旧类名、旧 key **已被彻底根除** |

**禁止**以下任何一项作为交付依据：模块内自测绿灯、`tsc` 无报错、文档声明完成、单项门禁 PASS。

---

## 九、零容忍红线自查表

| 红线 | 本方案的对应约束 | 自查点 |
|---|---|---|
| **1 功能伪连通** | N5/N7 必须被真实调用链调用；N3 命令必须双端注册且真实收发；禁止 `Default/None/空配置` 在真实调用处；禁止 `#[allow(dead_code)]` 与零真实调用的死快照 | 6.2/6.3 每条都标注了"由谁调用"；§八 传输端物证强制真实收发 |
| **2 多轨并存 / 给旧岛续命** | §五 全部为**物理删除**；N1 表名避开历史 `metadata` 以免语义混淆；禁止把偏好双写回 localStorage；E 组 E1 先停写再删旧 | 5.1/5.3/5.4/5.2 逐条可勾选；V1–V4 断言零写入 |
| **3 幽灵契约 / 截肢式降级** | N3/N4 未知 key 拒绝而非忽略；N2 版本号双处一致；禁止丢弃字段的回退；V19/V21/V24 断言 | 6.2 N4；7.4 |
| **4 虚构 Token / 样式欺骗** | 16 个未定义 token **必须真实定义或连同消费者一起物理删除**，不得留空壳；组件 100% 用 semantic；层叠类问题必须穿透检查祖先盒模型与 Stacking Context（N12） | V10–V18；6.4 N12 |

**反退避自查**（对齐 `AGENTS.md` §1）：

- **效果锁**：本方案不接受"先做 token 定义、偏好通道等以后"这类降级；A 组与 B 组必须同时闭合，C 组才成立。
- **禁止退避裁判**：不以"改动面大 / 涉及 138 个 CSS、142 个 TSX / 需新增 DB 迁移与 IPC"为由压缩范围；不确定项（如 `sessionRustDbFallback` 是否属破坏性回退）以**读码验证**判定，而非按"业界惯例"推定。
- **禁止魔术数字补偿**：圆角 7px 必须以**刻度档位**形式进入定义层（N11），不得用 `calc()` 偏移或组件内常量补偿；`oklchColorGuard` 的字符串反推必须改为布尔返回（N7），不得保留为"能跑就行"的兼容。
- **测试资产保护**：V1–V28 与 G1–G9 为新增验证资产，任何阶段不得删除或弱化；§五 删除的旧测试（如 `migrateFromLocalStorage.test.ts`）必须由**对应的负向断言**替代，而非净减。
- **问题同权**：第三章 R1–R6 六类根因同权；不得因"R5 门禁只是工程问题"而将其排后——事实上 R5 是 R1/2/3/4 会再次漂移的**唯一防线**。

---

## 附：本方案依据的关键事实锚点索引

| 事实 | 锚点 |
|---|---|
| 法定 KV 表已在 v4 被删 | `crates/conex-db/src/migrate_steps.rs:151`、`crates/conex-db/src/schema.rs:121` |
| 当前 DB 版本 10 | `crates/conex-db/src/lib.rs:97` |
| 无任何偏好类 IPC 命令 | `apps/agent-workbench/src-tauri/src/command_manifest.rs`（`config_*` 仅 provider 域） |
| provider 配置落 `provider-config.json` | `apps/agent-workbench/src-tauri/src/config/profile.rs:11` |
| 会话三轨并存 | `store/sessionStore.ts:64-70`、`api/session-persistence/sessionLocalStorage.ts`、`api/session-persistence/sessionRustDb*.ts` |
| 迁移吞错与 30 天保留 | `api/session-persistence/migrateFromLocalStorage.ts:178,211` |
| legacy 设置被 fallback 读取 | `api/themeStore.ts:51` |
| 主题裸 hex 默认值 | `api/themeStore.ts:103-104` |
| 明暗靠字符串反推 | `api/oklchColorGuard.ts:118` |
| 四注入点分散 | `api/themeStore.ts:76-81`、`services/visualThemeController.ts`、`api/themePersonalization.ts`、`api/oklchColorGuard.ts:114-127` |
| xterm 不随主题重上色 | `components/workspace/useXtermTerminal.ts:219,230` |
| `--radius-2xl` == `--radius-xl` | `styles/tokens.css:373-374,1471-1472,1547-1548` |
| 圆角锁注释 | `styles/tokens.css:474` |
| 16 个未定义且无 fallback 的 token | 见 §3 R4 |
| `check-text-color-tokens` 盲区 | `scripts/check-text-color-tokens.mjs:61,65` |
| pre-commit 仅空白检查 | `.husky/pre-commit` |
| 无 git remote | `git remote -v` 空 |

**复核工具**：`scripts/check-token-consistency.mjs`（G1/G2 已正式落成门禁；基线 `docs/multi-agent-repair/基线记录/token-consistency-baseline.md`）。运行 `npm run check:token-consistency` 走 ratchet 检查，`--list` 打印全部未定义/高危/死 token 清单，`--update` 显式收敛基线。当前口径 **71 / 22 / 126**（比 `analysis/` 审查报告的 75/16/146 更准——脚本已修正三类假阳性：注释内示例、对象计算键、按名读取；差异记录见基线文件"精度修复"节）。
