# independent-04 · 启动、资产与门禁（独立完整修复总案）

> **战役**：performance-audit → performance-fix  
> **视角**：启动链路 / 构建资产 / 体积门禁 / 防御脚本 / 观测闭环  
> **创建**：2026-09-13  
> **性质**：独立完整全局计划（不与其他并行总案对齐、不抄主控草稿 91；对照处显式标注分歧）  
> **上游必读**：`90-发现清单索引.md`、`07-启动链路性能审查报告.md`、`11-资产与构建体积审查报告.md`、`16-可观测性与perf资产审查报告.md`、`materials/11-dist-chunk实测与静态图.md`、`scripts/check-startup-budget.mjs`、`scripts/check-dist.mjs`、`.github/workflows/ci.yml`、`apps/crish-desktop/vite.config.ts`、`App.tsx` / `firstRunWizardLib` / `AppGlobalDialogs` / `readiness.ts` / `package.json`  
> **对照（可推翻）**：`91-系统性修复总方案.md` §3 L0-B、§10 L7、§13 防御表、§14 U-BUNDLE/U-GUARD  
> **禁止**：git commit；门禁只 warn 不 fail 的「假完成」。

---

## 1. 全局效果与维度划分

### 1.1 效果锁（本方案锁定的目标，不得降级）

| 锁 | 目标态 | 现状（2026-09-13 实测/走读） |
| -- | ------ | --------------------------- |
| **E1 · 首屏静态图** | entry 静态 import 闭包（JS）≤ 冻结后预算；catalog **不在** entry 静态图与 modulepreload | 静态图 **1709.3 KiB / 9 chunks**；`chat-provider-catalog` **550.5 KiB** 静态边 + modulepreload 钉死 |
| **E2 · catalog 物质** | catalog chunk = 纯 profiles/catalog 元数据（期望 &lt;150 KiB，基线冻结后定）；无 zod/迁移/surface/autofill JSON 焊入 | 杂物抽屉：zod + `import_from_localstorage` + `navigateToSurface` + 59.5 KiB baseline JSON |
| **E3 · 体积门禁 fail+CI** | 静态图合计、modulepreload 白名单、entry css、（可选）dist 总量：**超限 exit 1**；接线 `ci.yml` frontend-build + `check:desktop` | `check-startup-budget` 静态图仅信息行；脚本不在 CI、不在 `check:desktop`；`check-dist` 只锚 entry&lt;500（余量仅 2.6 KiB） |
| **E4 · setup 分级** | `CoreRunState` 轻核同步 manage；重注册/槽位分级；首 run 前 `ensure_tools_ready` 门闩；工具可用性不减 | setup 同步路径全量引擎装配（`main.rs:902` → `engine_build.rs:349`） |
| **E5 · 负产出物理切除** | motion 死依赖删除；woff 双格式删除；favicon/PWA 面收敛；死门禁路径合并 | motion 声明未用；16 字体文件双格式 323.3 KB；门禁双脚本真源重叠 |
| **E6 · 观测闭环** | `crishStartupReport`（preloadSpan/tti/静态图字节）+ 断边后 Network/V1–V8 回填；门禁输出与报告同源 | 运行时 V 项未回填；startup-report 与门禁脚本未互证 |
| **E7 · 防回潮** | 任何把大块静态拉回首屏的改动 → CI 红；阈值只允许断边/重组后**下调**并记基线 | 静态图从 1.7→3 MB 只要 entry 单文件不破 500，CI 仍全绿 |

**效果锁红线（本方向）**：

1. **禁止**「只改门禁阈值、不改静态边/物质」充当修复；阈值只允许下调。
2. **禁止**门禁默认软模式且 CI 不带 `--strict` 的「接线完成」——接线定义 = CI 步骤存在 **且** 超限 exit 1 可被人为制造回归验证。
3. **禁止** `manualChunks` 继续冒充惰性加载：chunk 分组 ≠ 切断静态依赖；modulepreload 是静态边的网络杠杆，断边必须以 manifest `entry.imports` 与 `index.html` modulepreload **双断言**验收。
4. setup 分级不得削弱工具面行为（注册数、Browser/Computer 槽位、restore 语义不减）。

### 1.2 维度划分（领域词，非波次命名）

| 维度 ID | 领域名 | 主问题 | 主要 90 ID |
| ------- | ------ | ------ | ---------- |
| **D-SG** | 首屏静态图断边 | catalog 静态边 + modulepreload | 07-A1、11-B1 |
| **D-CD** | catalog 物质重组 | 杂物抽屉 / zod 单点 / 门面 re-export | 11-B3、11-B5、07-A1 部分 |
| **D-AS** | 首屏可选大件后移 | highlight / hugeicons / fonts / icons barrel | 07-A3、11-B7、11-B8、11-B9、11-B4 |
| **D-GT** | 体积门禁 fail 化与接线 | 静态图/CSS/preload 盲区 + 孤岛脚本 | 07-A2、11-B2、16-P1、16-P2、11-B10 |
| **D-SU** | 壳 setup 分级 | CoreRunState 全量同步装配 | 07-B1、07-B2（弱依赖） |
| **D-NG** | 负产出与依赖卫生 | motion 死依赖 / woff / favicon / 双锁 / sideEffects | 11-B6、11-B9 部分、11-B12–B15、11-B17 |
| **D-OB** | 启动观测闭环 | startup-report × 门禁 × V 项回填 | 16-P3–P8 交叉、07-V、11-V |
| **D-DF** | 防御脚本演进 | check-* 真源、漂移、与 L0 预算 SSOT 衔接 | 16-P1/P2/P14、11-B2 |

**维度外但本方案必须声明边界的交叉**：

- 会话索引双源（07-D2）与 zustand persist 全量 sessions（08-H1）属**持久化单轨**域——本方案只在 D-SG 保证「不把 LS 索引路径重新静态焊回 entry 大图」，完整切除归持久化总案。
- Diff/worker highlight 空转（12-D1）运行时接线归 Webview/重型组件域；本方案负责 **vendor-highlight 不再进静态图**（加载面）。
- 03-I2 boot 2×N：**已由 ACT-502 修复**（07-D1），本方案不再立案，仅防回潮（禁止恢复全量 `Promise.all` 会话拉取）。

### 1.3 已建未接线清单（本视角 SSOT 登记）

| 资产 | 路径 | 「已建」证据 | 「未接线」缺口 | 归维 |
| ---- | ---- | ------------ | -------------- | ---- |
| check-startup-budget | `scripts/check-startup-budget.mjs` | 静态闭包计算完整（collectEntryGraph） | `totalBytes` 不进 warnings/errors；无 CI；无 `check:desktop` | D-GT、D-DF |
| check-dist modulepreload 打印 | `scripts/check-dist.mjs:112+` | 解析 preload | 无「⊆ 允许清单」断言 | D-GT |
| ACT-304 manualChunks 三元解构 | `vite.config.ts:782-815` | catalog/stream/transport 分组 | App/`firstRunWizardLib`/`AppGlobalDialogs`/`readiness` 静态边击穿；chunk 内物质污染 | D-SG、D-CD |
| catalog 动态 import 预留边 | manifest entry dynamicImports 含 catalog×12+ | 惰性意图在 | 静态边胜出，动态边无效化 | D-SG |
| xterm/tiptap 真 lazy | TerminalCard / Composer lazy | 430/409 KiB 不入静态图 | —（正面，禁回潮） | D-AS 防回潮 |
| highlight 源码层 lib/core | `codeHighlight.ts:13-34` | 22 语言非全量包 | 模块顶层同步注册 + optimizeDeps 全量包名 → 仍进静态图 | D-AS |
| BrowserSlot「惰性」注释 | `engine_build.rs:357-359` | 注释宣称惰性 | ToolRegistry 全量同步注册仍占 setup | D-SU |
| motion 组件族 | `ui/animated-icons/*` | 仅测试引用 | package.json 仍声明 motion；bundle 零税但 lock 税 + 回潮 | D-NG |
| EventBuffer 20 万压测 | `buffer.rs` stress_tests `#[ignore]` | 断言正确 | 不进 ci-slow（偏可观测/缓冲域，本方案只登记协同） | D-OB 协同 |
| perf::jsonl / perf::fs mmap | `perf/` | 模块在 | 生产零消费（归 IO/perf 资产域；本方案不扩） | 边界外 |

---

## 2. 依赖与逻辑顺序（纯逻辑拓扑，无工期/人员/业务优先级）

### 2.1 为何本方案重排 91 的 Layer 顺序

91 将资产与门禁置于 **Layer 7**（引擎/DB/前端热路径之后）。本方案**推翻该排序键**，理由（逻辑依赖，非「更重要」）：

1. **门禁是后续所有 Layer 的防回潮前置**：若静态图 fail 未接 CI，任何并行 Layer 在 App/vite 附近改动都可能无声重新焊入大 chunk；体积漂移在修复期即可发生且不可见。
2. **catalog 静态边是独立文件域**（前端 import 图 + vite + 少量 API 面），不依赖 PE-02/IPC 契约/DB 组提交；逻辑上可最先收敛。
3. **负产出（motion/woff/双锁）** 不阻塞任何运行时路径，却降低 lock/install/维护面，且与 D-SG 文件域部分相交，宜与断边同轮收敛，避免二次碰 `package.json`。
4. setup 分级（D-SU）与前端静态图**无文件冲突**，可在门禁骨架就位后并行；但其**验收锚点**（工具数不变、首命令可用）独立于 bundle 数字。

**重排后的逻辑层**（本方案内部）：

```text
SG0  门禁语义升级（静态图进预算模型）+ CI/check:desktop 接线骨架
     │  （先建立「回归可见」，阈值可先宽后紧；禁止长期停在纯 warn）
     ▼
SG1  首屏静态图断边（三处上游 + transport↔catalog 互边）
     │  （断边后 modulepreload 自动收缩；双断言）
     ▼
SG2  catalog 物质重组（zod / baseline JSON / surface·迁移归位 / 门面轻重拆）
     │  （可与 SG1 同 PR 串行；物质未拆则动态触达仍付 550 KiB）
     ▼
SG3  首屏可选大件后移（highlight 长尾 / iconMap 子集 / woff2-only）
     │  （依赖 SG1 后的静态图基线数字；与 SG2 文件域可并行）
     ▼
SG4  负产出切除收口（motion 删除、favicon/PWA、sideEffects、锁文件）
     │  （与 SG3 共享 package.json 时串行）
     ▼
SG5  壳 setup 分级 + 并行 init（与前端文件域不相交，可与 SG1–SG4 并行）
     ▼
SG6  门禁收紧至目标基线 + 指纹/preload 快照固化 + 观测闭环 V 回填
     ▼
SG7  防御脚本真源合一（startup-budget ∪ check-dist 预算面）与预算 SSOT 衔接
```

**并行规则**：

- SG0 骨架与 SG5 无冲突，可并行；SG0 完成前禁止宣称「门禁已 fail」。
- SG1 与 SG2 建议**同一执行单元串行**（同一概念：catalog 图与物质），拆开会导致互边断了物质仍在的假绿。
- SG3 与 SG5 并行；SG3 内部 highlight / fonts / icons 可按文件域拆分。
- SG4 若与 SG3 同碰 `package.json`/`fontStoreCatalog`，必须串行或单 Agent 合并。
- 禁止：未完成 SG0 门禁骨架就合并会扩大 entry 静态图的 PR（主控检查清单）。

### 2.2 禁止顺序反例

- 未断 `App → firstRunWizardLib → providerProfiles` 静态边，不得把静态图阈值从「现状 ~1800 软」直接砍到 900 并宣称完成。
- 未做 catalog 物质拆分，不得只把 catalog 改名或再 manualChunks 拆一刀就宣称「惰性完成」。
- 门禁接入 CI 但不带超限 exit 1（或仅 soft 永不 strict），不得计入 D-GT 完成。
- setup 分级不得用「工具延后到第一次 run 才从网络拉取」或空 Registry 冒充——首 run 必须 `ensure_tools_ready` 后工具全集可用。
- 不得为通过门禁而提高阈值或把 catalog 从静态图挪进「动态 import 但仍被 modulepreload 写出」的伪 lazy（Vite 静态边才会 preload；真 dynamic 不得出现在 entry imports）。

---

## 3. 本方案要删掉什么 / 收敛什么

> 无删除项不得空转；下列删除/收敛为**完成方式**，不是砍效果锁。

### 3.1 物理删除（负产出）

| # | 删除对象 | 证据锚点 | 替代/后继 | 验收 |
| - | -------- | -------- | --------- | ---- |
| DEL-1 | `motion` 依赖声明（`apps/crish-desktop/package.json:53`）及传递 lock 节点 | dist 无 LazyMotion 指纹；应用代码零引用 animated-icons | 产品若未来需要动画图标 → 新任务 + lazy + vendor chunk；**当前删除** | `package.json`/lock 无 motion；`knip`/grep 无 `motion/react` 生产引用；animated-icons 组件族迁出或删除并附测试处置表 |
| DEL-2 | animated-icons 四组件（仅测试引用）或整目录 | `ui/animated-icons/{Pin,PinOff,Copy,Pencil}Icon.tsx` | 测试 fixture 迁 `reference/` 或删除（主控确认陪葬测试） | 测试全绿；无死 import |
| DEL-3 | 全部 `.woff` 字体产物路径（构建期剔除） | dist 16 文件 woff 173.1 KiB；WebView2 支持 woff2 | `fontStoreCatalog` / package 入口改为 woff2-only 或 `latin-*.css` 过滤 | dist `*.woff` 计数 = 0；四族字体 FOUT 无回归 |
| DEL-4 | `check-startup-budget` 与 `check-dist` 在**体积预算**上的双真源重叠语义 | entry 520 vs check-dist 500 双锚；静态图无人管 | **单一预算真源**（见 §3.3 CONV-3）：startup-budget 承载图谱级；check-dist 承载 CSP/vendor 存在性 + 调用同一预算模块或明确分工表 | 文档 + 脚本头注释一致；CI 只跑接线后的主链 |
| DEL-5 | entry 静态边「应断未断」的三处上游 import 的**旧静态路径**（改动态/旁路后物理删除静态 import） | `firstRunWizardLib.ts:8-12`、`AppGlobalDialogs.tsx:6`、`readiness.ts:12` | 轻量 key 探测模块 + 打开时 `await import` + 注入/旁路 | 源码无静态 `from '../api/providerProfiles'` 于上述路径；manifest entry.imports 无 catalog |
| DEL-6 | catalog chunk 内非本域物质的**组内焊入**（不删功能，删错误聚合） | 指纹：ZodError / migrate / surface / baseline JSON | 各归 vendor-zod / store·session chunk / 独立懒 JSON | 指纹测试：上述串不在 catalog chunk |
| DEL-7 | index.html 无消费的 PWA/favicon 冗余链（WebView） | `index.html:5-11`；public 62.3 KB 重叠 | Tauri 图标源生成；WebView 仅保留真实引用 | dist 根清单基线；无死 manifest 链 |
| DEL-8 | 「静态图仅信息打印」的门禁分支语义 | `check-startup-budget.mjs:245-247,260-266` | totalBytes 进入预算判定 | 超限在 strict/CI 下 exit 1 |

### 3.2 路径收敛（一概念一路径）

| # | 概念 | 现路径数 | 收敛到 | 说明 |
| - | ---- | -------- | ------ | ---- |
| CONV-1 | 首屏体积预算断言 | 3（startup-budget entry 软 / check-dist 500 / chunkSizeGate 600 单块） | **图谱级预算主路径 = startup-budget（fail）**；chunkSizeGate 保留单块硬线；check-dist 保留 CSP+vendor 存在性 + entry 辅助线但与 budget 数值同源或降为登记 | 禁止第三条「只 warn 不跑」路径 |
| CONV-2 | providerProfiles 访问 | App 层静态门面 + 全域直接 import 混用 | **运行时重路径**留在 catalog chunk（设置/模型选择）；**首屏探测路径** = 轻量模块（不进 catalog） | 类型可仍从轻量 re-export，避免 App 图吸收实现 |
| CONV-3 | 预算数字存放 | BUDGET_KB env + check-dist CLI + CHUNK_SIZE_GATE_KB + 隐式 500/520/600 | **单一预算源**（前端侧 `perfBudgets` 常量或脚本共享 `scripts/perf-budgets.json`；与全局 L0-B 衔接时迁 Rust/TS SSOT） | 业务代码禁止散落第二套启动预算魔数 |
| CONV-4 | modulepreload 合法性 | 隐式=全部静态 import | **显式白名单**（允许清单文件 + check-dist/check-startup-budget 断言） | 断边后清单收缩并冻结 |
| CONV-5 | setup 就绪语义 | 「new 返回 = 全量可用」单路径 | 轻核 manage + `ensure_tools_ready` 门闩（run 路径唯一入口等待） | 禁止工具「假注册」双轨 |

### 3.3 明确不删（防误伤）

- 正面：xterm/tiptap lazy、CRP 内联 loader、bootstrap-core/full 分级、manualChunks 单块 600 KiB 门禁、无双 React、packages alias 直入。
- `modelsAutofillBaseline` **数据功能**保留，只改加载形态（独立 `import()` 或 IPC），不删 autofill 能力。
- 测试资产（vitest、manifest 快照新建后）不随死层误删。

---

## 4. 维度详案（做什么 / 删什么 / 依赖 / 文件域 / 验收）

> 模板：做什么 → 删什么 → 依赖顺序 → 文件域 → 验收（功能 + 负产出 + 五端物证）。

---

### 4.1 D-GT · 体积门禁 fail 化与接线（SG0，可最先落地骨架）

#### 做什么

1. **升级 `check-startup-budget` 预算模型**（`scripts/check-startup-budget.mjs`）：
   - 保留 entry 单文件预算（`BUDGET_KB` / `--budget-kb`，缺省 520）；
   - **新增静态图 JS 合计预算** `STATIC_GRAPH_BUDGET_KB` / `--static-graph-kb`：
     - 接线过渡期缺省建议 **1800**（现状 1709 仅留窄余量，先保证「再涨必红」）；
     - 断边+物质完成后下调至 **900**（07/11 建议目标），数字进预算源文件；
   - `totalBytes` 进入 `warnings`；`--strict`（及 CI）下进 `errors` → **exit 1**；
   - 静态图内 **禁止出现** 名单：`chat-provider-catalog`（断边验收后）；可配置 `STATIC_GRAPH_DENY` 列表；
   - 可选第二阶段：entry css 合计预算（与 check-dist 合并实现时见 D-DF）。
2. **扩展 `check-dist`**（`scripts/check-dist.mjs`）：
   - modulepreload href 集合 ⊆ 允许清单（新文件如 `scripts/startup-preload-allowlist.json` 或并入预算源）；
   - 增加 `MAX_ENTRY_CSS_KB`（建议 280 起步，断边后可再收）与可选 `MAX_DIST_CSS_KB`；
   - entry/`index-*.js` 500 KiB 硬线保留，但与 startup-budget 注释交叉引用避免双真源漂移。
3. **接线**：
   - `.github/workflows/ci.yml` `frontend-build`：在 `check-dist` 后增加  
     `node scripts/check-startup-budget.mjs --strict`（阈值经 env 或预算文件）；
   - 根 `package.json` `check:desktop` 链追加 `npm run check:startup-budget`（脚本自身在 CI 调用时强制 strict；本地可 warn 策略由 env 控制，但 **CI 路径必须 strict**）。
4. **负向回归夹具**：单测或脚本自测——构造假 manifest（entry 小 + 大静态 import）断言非 strict 可 warn、strict/CI fail。

#### 删什么

- DEL-8：静态图「仅信息、永不进 errors」逻辑。
- 不删 check-dist 的 CSP 断言（职责保留）。

#### 依赖

- 可先于断边合入（阈值 1800）；**目标 900 冻结必须在 SG1+SG2 验收数字之后**。
- 与 L0 预算 SSOT：数字文件路径在本维度先落地为 `scripts/perf-budgets.json`（或等价单一源），后续全局 SSOT 只做**迁移**不二次分叉。

#### 文件域

| 路径 | 操作 |
| ---- | ---- |
| `scripts/check-startup-budget.mjs` | 扩展 |
| `scripts/check-dist.mjs` | 扩展 preload/css |
| `scripts/perf-budgets.json`（新建）或等价 | 预算数字唯一源 |
| `scripts/startup-preload-allowlist.json`（新建，可并入上者） | preload 白名单 |
| `.github/workflows/ci.yml` | frontend-build 追加步骤 |
| `package.json`（根） | check:desktop 追加 |
| `scripts/__tests__` 或等价单测 | strict 行为 |

#### 验收

| 类 | 断言 |
| -- | ---- |
| 功能 | 有 dist 时：`--strict` 超静态图预算 exit 1；deny 名单命中 exit 1；preload 超白名单 exit 1 |
| CI | 人为在 entry 静态图塞回 catalog 或抬体积 → frontend-build 红 |
| check:desktop | 字符串包含 startup-budget；本地跑通不因无 dist 误红（无 dist 保持 warn+0 语义可保留，CI 在 build 之后必有 dist） |
| 负产出 | 静态图进 errors 的代码路径存在且被夹具覆盖；无「第三条只 warn 主路径」 |
| 五端 | 触发=CI job；传输=npm script；介质=yaml+scripts 落盘；消费=PR 门禁执行；负向=夹具+红灯演练 |

---

### 4.2 D-SG · 首屏静态图断边（SG1）

#### 做什么

1. **`firstRunWizardLib`**（`apps/crish-desktop/src/components/firstRunWizardLib.ts`）：
   - 新建轻量探测模块（如 `src/api/providerProfilesLight.ts`）：仅读 localStorage/轻量键的 `anyProfileHasKey` 等价实现，**不** import catalog 重实现；
   - `shouldShowFirstRunWizard` / `normalizeModelIds` 路径：类型外的重逻辑改 `await import('../api/providerProfiles')` 或拆「完成门闩纯 LS」与「模型规范化重路径」；
   - `App.tsx:20` 对 `shouldShowFirstRunWizard` 的调用保持同步门闩可用（LS 判定），重副作用延后。
2. **`AppGlobalDialogs`**（`src/app/AppGlobalDialogs.tsx:6`）：
   - 去掉模块顶层 `getActiveModelId/getActiveProfileId` 静态 import；向导/对话框打开分支内动态 import。
3. **`readiness.ts`**（`src/api/chat-bridge/readiness.ts:12`）——**断 transport↔catalog 互边**：
   - 将 `getActiveModelId/getActiveProfileId` 改为**注入**（由 bootstrap/上层传入 getter）或轻量旁路模块（与 profiles 存储解耦的只读快照），禁止 `chat-bridge-transport` chunk 静态 import catalog 成员；
   - 核对 `directFetchBridge` / `streamCallbacksUsage` / `slashSendPreflight` 等 hooks 路径：优先注入或动态，避免把 catalog 再从 hooks 静态拖回 entry 图（动态打开模型选择器时允许）。
4. **构建验证**：
   - `vite build` 后检查 `dist/.vite/manifest.json`：entry `imports` **不含** `chat-provider-catalog`；
   - `dist/index.html` modulepreload **不含** catalog；
   - 与 D-GT deny 名单对齐。
5. **防回潮**：`noWaterfallOrchestrator` 类测试或新单测断言「entry manifest imports ⊄ catalog」；可在 D-GT deny 中固化。

#### 删什么

- DEL-5：三处上游静态 import 的旧路径（改完即删 import，禁止双路径兼容）。
- 不删 providerProfiles 业务实现。

#### 依赖

- 强依赖 D-GT 的 deny/夹具（可同轮）；物质重组（D-CD）可紧随或同单元串行。
- 不依赖 IPC 契约变更；**不得**改 readiness 超时语义（`ENGINE_CONNECT_TIMEOUT_MS` 保持）。

#### 文件域

| 路径 | 操作 |
| ---- | ---- |
| `src/components/firstRunWizardLib.ts` | 改 |
| `src/api/providerProfilesLight.ts`（新建） | 新增轻路径 |
| `src/app/AppGlobalDialogs.tsx` | 改 |
| `src/api/chat-bridge/readiness.ts` | 改（注入/旁路） |
| 可能：`src/hooks/chat-stream/*`、`directFetchBridge.ts`、`modelVisionSupport.ts` | 仅当它们把 catalog 拖回静态图时改动态/注入 |
| `src/components/firstRunWizardLib` 相关测试 | 更新 |
| manifest/preload 快照测试 | 新增 |

#### 验收

| 类 | 断言 |
| -- | ---- |
| 功能 | 首启向导门闩、已有密钥跳过、readiness 判定、连接超时行为不变（单测+现有用例） |
| 负产出 | 旧静态 import 0 命中；路径数：App 重路径 → 轻路径收敛 |
| 构建 | entry.imports 无 catalog；preload 无 catalog；静态图显著下降（记录 KiB） |
| 五端 | 触发=App 向导/对话框；传输=动态 import 加载 catalog；介质=无新 LS 键；消费=原 providerProfiles API；负向=manifest/preload 测试 |

---

### 4.3 D-CD · catalog 物质重组（SG2）

#### 做什么

1. **zod 归位**：`vite.config.ts` manualChunks 增加 `vendor-zod`；确认 src 内唯一消费方 `services/ConfigService.ts:1` 不再把 zod 拖进 catalog；`SettingsShortcutsTab` 的 manifest imports **不含** catalog。
2. **autofill baseline**：`modelsAutofillBaselineData.json`（~59.5 KiB）改独立动态资产或 IPC；去掉对 catalog chunk 的静态焊入。
3. **surfaceRouter / session 迁移**：从 catalog 组内传递边剥离，归还 store/session 相关 chunk；切断「取 surface 而 import catalog」的构建期误伤。
4. **providerProfiles 门面轻重拆**：按 §4.2 轻模块 + 重实现拆文件；减少 `providerProfiles.ts` 宽 re-export 对 chunk 的绑架（门面可保留，但重依赖不进轻路径）。
5. **验收指纹**：重组后 catalog chunk 中 **无** `ZodError` / `import_from_localstorage` / `navigateToSurface`；体积 ≤ 新基线（期望 &lt;150 KiB，冻结后写入预算源）。

#### 删什么

- DEL-6：错误聚合边（非删功能）。
- manualChunks 中「吸收共享库」的路径组**语义修正**（不是删 catalog 分组本身）。

#### 依赖

- 强依赖 D-SG 断边后的构建基线；**建议与 D-SG 同一执行串行完成**再冻 900。
- 动工前建议一次性 `vite build --sourcemap` 归因（11 报告建议），归因构建不入库。

#### 文件域

- `vite.config.ts`（manualChunks）
- `src/services/ConfigService.ts`（若拆轻量 schema）
- `src/api/modelsAutofillBaseline.ts` + JSON 资产
- `src/api/providerProfiles.ts` / `provider-profiles/*` 拆分
- surface/迁移相关 import 边（只读分析 + 必要改 import）
- catalog 体积/指纹测试

#### 验收

| 类 | 断言 |
| -- | ---- |
| 功能 | 模型选择、设置、autofill、快捷键配置行为不变 |
| 负产出 | catalog 内非域物质 0 指纹；SettingsShortcutsTab 不依赖 catalog |
| 体积 | catalog chunk ≤ 冻结基线；静态图维持 ≤ 目标 |
| 五端 | 同 D-SG；触发端含设置页与模型选择打开时机 |

---

### 4.4 D-AS · 首屏可选大件后移（SG3）

#### 做什么

1. **vendor-highlight**：`codeHighlight.ts` 高频语言同步、长尾 `import()` 懒注册；静态图/modulepreload 无 vendor-highlight；`optimizeDeps.include` 改 `highlight.js/lib/core` 子路径（B11）。
2. **vendor-hugeicons / iconMap**：拆 `iconMap.core.ts`（首屏子集）+ 视图级分文件；SSOT 门禁（`check:icon-ssot`）同步演进。
3. **fileIcons / modelVendorCatalog 会话首开税**（B4）：
   - fileIcons 常用扩展同步 + 长尾异步；去掉 pdf base64 PNG；
   - 打断 `ChatAssistantMessageRow` → modelVendorCatalog 静态边（lazy/hook）。
4. **字体**：woff2-only（DEL-3）；latin-ext 动态化（`fontStoreCatalog.ts` 已是按族动态，需确保构建不打进 woff）。

#### 删什么

- DEL-3 woff 产物路径；
- pdf 图标内嵌 base64；
- optimizeDeps 中粗粒度 `'highlight.js'` 全量项。

#### 依赖

- 依赖 D-SG 后的静态图基线；与 D-CD 可并行（不同子系统）。
- iconMap 改动必须过 `check:icon-ssot`。

#### 文件域

- `src/api/codeHighlight.ts`、`vite.config.ts` optimizeDeps
- `src/components/ui/icons/iconMap.ts`（及拆分文件）
- `src/assets/icons/fileIcons.ts`、`modelVendorIcons.ts`、barrel `index.ts`
- `src/api/fontStoreCatalog.ts`、字体引入点
- 可能 `ChatAssistantMessageRow` / `streamStop` 的图标解析

#### 验收

| 类 | 断言 |
| -- | ---- |
| 功能 | 代码高亮语言覆盖；图标全集仍可用（懒加载后）；字体四族正常 |
| 负产出 | dist 无 `.woff`；静态图无 vendor-highlight；空会话无 modelVendorCatalog |
| 体积 | 字体总量 ≈150 KiB 量级；静态图再降并写入基线 |
| 五端 | 触发=打开代码块/设置/会话首开；传输=动态 chunk；介质=无新持久化；消费=原渲染组件；负向=文件计数+manifest |

---

### 4.5 D-NG · 负产出与依赖卫生（SG4）

#### 做什么

1. **motion**：删依赖 + 处置 animated-icons（DEL-1/2）；lockfile 更新；文档/AGENTS 不需改则不动。
2. **packages `sideEffects`**：shared-types/utils `false`；block-paper `["*.css"]` 等（B13）。
3. **锁文件**：确立 npm 单真源，删除 app 级冗余 lock（B15）——与主控仓库策略确认后执行。
4. **install 面**：文档化桌面最小 workspace install（B14，可只文档+CI 缓存说明）。
5. **Windows bundle targets / manifest 嵌入**（B12）：发布 targets 收敛与 `.vite/manifest.json` 是否进安装面——**仅在有 release 产物流水线变更权时**改；否则登记发布配置任务，不伪造已做。
6. **public 图标合并**（B17）：按 WebView 真实引用裁剪。

#### 删什么

- DEL-1/2/7；锁文件冗余；（条件）安装包冗余资产。

#### 依赖

- 与 D-AS 共享 package.json 时串行；sideEffects 改后全量测试+dist 对比。

#### 文件域

- `apps/crish-desktop/package.json`、lock
- `src/components/ui/animated-icons/**`
- `packages/*/package.json`
- `apps/crish-desktop/public/**`
- `apps/agent-workbench/src-tauri/tauri.conf.json`（若动 targets）

#### 验收

| 类 | 断言 |
| -- | ---- |
| 功能 | 全量 unit/typecheck 绿 |
| 负产出 | lock 无 motion；有效删除行数记录；测试处置清单 |
| 五端 | 介质=package.json/lock；消费=npm install；负向=grep/knip |

---

### 4.6 D-SU · 壳 setup 分级（SG5）

#### 做什么

1. **拆 `EngineHandle` 轻核 / 重注册**（`engine_build.rs` / `run/run_core.rs` / `main.rs`）：
   - 轻核：HTTP client、空/最小 ToolRegistry、事件通道、可 manage 的 CoreRunState；
   - 重注册：builtin tools、BrowserSlot、ComputerSlot 等 → `spawn` 到 runtime；
   - **`ensure_tools_ready().await` 门闩**：run/工具命令路径在重注册完成前等待（模式对齐 restore_ready）。
2. **BrowserSlot/ComputerSlot**：若仅占位，`OnceLock` 首次访问初始化（注释与实现一致，消除「注释惰性、实现同步」谎言）。
3. **并行 init（弱）**：WorkspaceRegistry / TokenStore / Auth 与 DB open 可 `join!`（07-B2）；不扩大同步段。
4. **禁止**：削弱注册列表、去掉 Computer/Browser 工具、同步 `block_on(restore)`。

#### 删什么

- setup 同步路径上的「全量注册」单路径（收敛为轻核+门闩单路径）；
- 不删注册函数本体。

#### 依赖

- 与前端维度并行；验收不依赖 bundle 数字。
- 工具行为回归依赖现有 engine/core 测试与 e2e。

#### 文件域

- `apps/agent-workbench/src-tauri/src/main.rs`
- `src/engine_build.rs`
- `src/run/run_core.rs`
- `src/core_run_commands.rs`（若 CoreRunState 构造签名变）
- 相关测试：`core_run_commands_tests.rs`、`engine_tests.rs`

#### 验收

| 类 | 断言 |
| -- | ---- |
| 功能 | 首 run 工具全集可用；注册数断言不变；restore 异步语义不变 |
| 负产出 | setup 同步段不再直接调用全量 `register_builtin_tools_with_config`（或仅轻核部分）；路径收敛为门闩单入口 |
| 运行时 | tracing `elapsed_ms`：setup 返回前同步段缩短（回填）；轻核 manage 后短窗内可 invoke `core_get_status` |
| 五端 | 触发=setup；传输=无新 IPC 契约（或仅内部）；介质=无；消费=工具路径 await 门闩；负向=测试+grep |

---

### 4.7 D-DF · 防御脚本演进与真源（SG7，可与 SG0 先做骨架）

#### 做什么

1. **职责表固化**（写入脚本头 + FULL_CHECK）：

| 脚本 | 职责 | 不负责 |
| ---- | ---- | ------ |
| check-startup-budget | 静态图/entry 图谱预算、deny 名单 | CSP |
| check-dist | CSP、vendor-tiptap/xterm 存在、preload 白名单、entry css | 与 budget 重复的第二套魔法数（应同源） |
| chunkSizeGatePlugin | 单 chunk ≤600 构建期硬线 | 图谱 |
| check:desktop | 本地全量门禁链含 startup-budget | — |

2. **与全局预算 SSOT 衔接**：启动类数字只允许出现在预算源；新增 `check-perf-budgets` 类断言时引用同一源（若全局 L0 尚未落地，本方案先建源文件并在 L0 落地时**迁移路径**而非复制第二份）。
3. **漂移防护**：
   - manifest/preload **快照测试**（断边后冻结）；
   - deny：`chat-provider-catalog`、可选 `vendor-highlight`（后移后）；
   - CI 步骤顺序：`build:desktop` → `check-dist` → `check-startup-budget --strict` → 既有 chunk-cycles。
4. **观测协同**：`crishStartupReport` 字段（静态图字节、preloadSpan）与门禁输出字段命名对齐，便于 V 回填；不在此维度实现完整 telemetry 重写。

#### 删什么

- DEL-4 双真源重叠的模糊地带（文档+代码注释级收敛）。

#### 依赖

- SG0 已做骨架；SG6 收紧阈值后本维做「真源合一」收尾。

#### 文件域

- `scripts/check-*.mjs`、`scripts/perf-budgets.json`
- `package.json`、`ci.yml`、`FULL_CHECK_COMMANDS.md`（若存在检查清单）
- 测试夹具

#### 验收

| 类 | 断言 |
| -- | ---- |
| 功能 | 职责表与实现一致；无「谁都不跑」的体积断言 |
| 负产出 | 重叠魔法数删除；脚本头声明唯一 |
| 五端 | 负向=红灯演练记录在 PR 描述（实现轮） |

---

## 5. 文件域与并行边界（防冲突总表）

| 执行单元 | 主文件域 | 可并行对象 | 互斥 |
| -------- | -------- | ---------- | ---- |
| U-GATE | scripts/check-*.mjs、budget json、ci.yml、根 package.json scripts | U-SETUP | 勿碰 App 源码 |
| U-BUNDLE-SG | App/firstRunWizard/readiness/AppGlobalDialogs/providerProfilesLight、vite manualChunks（catalog） | U-SETUP | 勿改 check-* 逻辑（只消费输出） |
| U-BUNDLE-MAT | zod/baseline/surface 边/门面拆分、vite vendor-zod | U-SETUP、U-AS | 与 U-BUNDLE-SG 最好串行 |
| U-ASSET | highlight、icons、fonts | U-SETUP | 与 U-BUNDLE* 共享 vite 时注意合并 |
| U-HYGIENE | package.json deps、animated-icons、public、sideEffects | U-SETUP | 与 U-ASSET 共享 package.json 则串行 |
| U-SETUP | src-tauri main/engine_build/run_core | 全部前端单元 | 勿碰前端 |
| U-GUARD-OBS | 快照测试、startup-report 对齐、deny 夹具 | — | 薄，可附着各单元 |

**主控派发建议（逻辑，非排期）**：首轮 U-GATE + U-SETUP + U-BUNDLE-SG；次轮 U-BUNDLE-MAT + U-ASSET；收尾 U-HYGIENE 收口 + U-GUARD-OBS 冻结。

---

## 6. 验收总表（功能 + 负产出 + 五端物证 + 发现映射）

### 6.1 功能验收（汇总）

| 门 | 通过条件 |
| -- | -------- |
| 首屏 | 冷启动静态图 ≤ 冻结预算；catalog 不在 entry 静态图/preload |
| 动态 | 打开模型选择/设置才加载 catalog；autofill JSON 懒；代码高亮按需 |
| setup | 工具全集首 run 可用；setup 同步段缩短可观测 |
| 门禁 | CI 对静态图/preload/css 超限红；check:desktop 含 budget |
| 无回归 | 向导、readiness、highlight、字体、图标功能测试绿 |

### 6.2 负产出验收（汇总）

| 项 | 量 |
| -- | -- |
| 静态 import 旧路径 | ≥3 处物理删除（wizard/dialog/readiness） |
| lock 依赖 | motion 族移除（≈4.1 MB 安装面） |
| 字体 | 16→8 文件量级（仅 woff2）；−173 KiB dist |
| 门禁路径 | 静态图仅信息路径删除；双真源重叠收敛 |
| catalog 物质 | zod/迁移/surface/JSON 出 chunk（指纹 0 命中） |
| setup | 全量同步注册路径 → 门闩单路径 |

### 6.3 五端物证（每单元 PR 必附）

| 端 | 本方向典型物证 |
| -- | -------------- |
| 触发端 | 真实 Tauri 启动 / 向导 / 设置打开 / 首开会话 |
| 传输端 | manifest imports/preload 列表 diff；无新幽灵命令 |
| 介质端 | dist 字节、lockfile、budget json 数字 |
| 消费端 | 门禁脚本在 CI 实际执行日志；ensure_tools_ready 等待路径 |
| 负向断言 | catalog 不在 entry；无 .woff；motion 0 命中；strict 红灯演练 |

### 6.4 与 90 发现 ID 映射

| 本方案维度 | 覆盖 90 ID | 备注 |
| ---------- | ---------- | ---- |
| D-SG | 07-A1、11-B1 | modulepreload 并入 B1 |
| D-CD | 11-B3、11-B5 | |
| D-AS | 07-A3、11-B4、11-B7、11-B8、11-B9、11-B11 | B11 与 B7 同 PR |
| D-GT | 07-A2、11-B2、11-B10、16-P1、16-P2 | CSS 预算并入 |
| D-SU | 07-B1、07-B2 | B3 记交叉可选 |
| D-NG | 11-B6、11-B12–B15、11-B17 | B12 条件执行 |
| D-OB | 07 运行时 V、11 V1–V8、16-P3 协同 | P3 压测主责归缓冲/CI 慢层，本方案只协同 |
| D-DF | 16-P14 真源重叠、防御表 | 与全局 L0 衔接 |
| 防回潮 | 11-P1–P8 正面；07-D1（ACT-502） | 不重复修复已修项 |
| 明确不覆盖 | 07-D2/D3/D4 持久化与水合双轨、08-H*、12-D1 运行时 worker、16 perf/ 死资产接线 | 边界外，防重复立案 |

### 6.5 关键运行时验证（V，实现后经 **4000 Tauri MCP** 生产包回填）

| ID | 项 | 判据 |
| -- | -- | ---- |
| V1 | Network：catalog 首帧 | 断边后不在首屏瀑布 |
| V2 | parse 耗时 | 静态图段缩短 |
| V3 | woff2-only | 无 FOUT 回归 |
| V5 | 会话首开增量 | X/AS 后 &lt;200 KiB 量级（基线冻结） |
| V7 | 安装包字节 | 若动 targets 后趋势下降 |

---

## 7. 与 91 主控草稿的分歧清单（独立立场）

| # | 91 取舍 | 本方案立场 | 理由 |
| - | ------- | ---------- | ---- |
| 1 | 资产/门禁 = **Layer 7**，实现波第二轮才 U-BUNDLE | **门禁骨架 + 静态图断边可为首轮/前置**；setup 与断边并行 | 防回潮门禁是并行修复的前置可见性；断边无契约阻塞 |
| 2 | U-BUNDLE 在 §16 第二轮收尾 | U-GATE 与 U-BUNDLE-SG **首轮**可并行于阻塞面/事件模型 | 文件域与 L1–L2 不相交 |
| 3 | 静态图阈值「断边完成前可先 1800 软 warning」 | 1800 即可 **fail**（strict+CI），禁止长期软；900 为断边后冻结合同 | 「软 warning + 未接 CI」= 现状病根（16-P1/P2）；先 fail 宽线再收紧 |
| 4 | check-dist 与 startup-budget「长期真源合一」语义较含糊 | **立即**职责表 + 数字同源（budget json）；合一实现可后置但魔法数不得双写 | 16-P14 |
| 5 | 91 切除登记表含 motion/woff | **升格为本方案一等负产出维度**（D-NG），含测试处置与 lock 验收 | 否则易在「性能主链」叙事下丢失 |
| 6 | 91 未强调 modulepreload 白名单与 deny 名单 | **一等验收门**（entry.imports + preload 双断言 + deny catalog） | 11-B1 证明 preload 可击穿「假 lazy」 |
| 7 | catalog 物质（B3）在 91 仅一行「杂物重组」 | 独立维度 D-CD，指纹级验收 | 不重组则断边只解决首屏，动态路径仍 550 KiB |
| 8 | setup 分级与 bundle 同塞 L7/U-BUNDLE 叙事 | 独立 U-SETUP，与前端并行，验收锚点是工具门闩非 KiB | 07-B1 文件域在 src-tauri |
| 9 | 03-I2 仍出现在部分阶段表 | 确认 **已修**，本方案零立案 | 07-D1 |
| 10 | CSS 门禁 | 明确并入 D-GT/D-DF（entry css） | 11-B10 零断言不可接受 |

---

## 8. 立即执行指令（本方案启动时的逻辑首轮）

在**不依赖** PE-02/DB 组提交/前端 memo 的前提下，文件域不相交的工作单元：

1. **U-GATE** — 静态图预算 fail + CI/`check:desktop` 接线 + preload 白名单 + 夹具  
2. **U-BUNDLE-SG** — wizard/dialog/readiness 断边 + 轻探测模块 + manifest 断言  
3. **U-SETUP** — CoreRunState 轻核 + ensure_tools_ready  
4. **U-ASSET**（可与 2 并行若无 vite 冲突；有冲突则次轮）— highlight 子路径 + woff2-only  
5. **U-BUNDLE-MAT** — 在 2 的构建验证后串行进入（zod/baseline/surface/门面）

第二轮：U-HYGIENE 收口、U-ASSET 其余、U-GUARD-OBS 冻结基线至 900、D-DF 真源表。

**完成定义（本方案域）**：E1–E7 效果锁全部物证化；负产出清单打勾；CI 红灯演练一次；与 91 分歧已在主控 92 定稿时被采纳或书面否决。

---

## 9. 附录 · 证据锚点速查

| 事实 | 锚点 |
| ---- | ---- |
| 静态图 1709.3 / catalog 550.5 / entry 497.4 | 07 §2.3、11 §3.2、materials/11 |
| modulepreload 含 catalog | materials/11 §3、dist/index.html |
| App→firstRunWizard 静态边 | `App.tsx:20`、`firstRunWizardLib.ts:8-12` |
| readiness→providerProfiles | `readiness.ts:12` |
| AppGlobalDialogs | `AppGlobalDialogs.tsx:6` |
| 门禁仅 entry、静态图信息行 | `check-startup-budget.mjs:221-247,260-266` |
| check:desktop 无 startup-budget | 根 `package.json` `check:desktop` 链 |
| CI 无 startup-budget | `.github/workflows/ci.yml` frontend-build |
| manualChunks catalog 组 | `vite.config.ts:782-795` |
| zod 单点 | `ConfigService.ts:1` |
| motion 死依赖 | `package.json:53` + animated-icons + dist 指纹无 |
| 字体双格式 | dist 16 文件；`fontStoreCatalog.ts` 动态 css |
| CoreRunState setup | `main.rs:902`、`engine_build.rs:349` |
| BrowserSlot 注释 vs 实现 | `engine_build.rs:357-359` vs 同步注册 |
| ACT-502 已修 03-I2 | 07-D1、`sessionRustDbHydrate.ts` |

---

*独立总案完。执行轮仅认主控定稿 92 + 分维详案；本文件为启动/资产/门禁维度交叉验证输入。*
