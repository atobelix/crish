# 前端修复 8 份维度方案 · 代码贴合度与执行卡壳点评审（03）

> 评审者：方案审批评审子 Agent（只读）。
> 输入：`docs/frontend-audit/20-proposals/01~08`（8 份方案）+ `docs/frontend-audit/00-cross-analysis.md`。
> 方法：站在执行 Agent 视角，对 8 份方案引用的**关键文件路径与行号逐一实读核对**（2026-08-09 工作区状态，共 30+ 处抽查，见 ② 抽查表），并核对机械替换工具面、验证可操作性、并行安全与遗漏面。
> 日期：2026-08-09。性质：只读评审 + 本文档产出，无代码改动。

---

## ① 总体结论

**结论：8 份方案整体贴合度高，P0 层的关键行号与结构断言绝大多数精确命中（抽查命中率约 85%），可以进入实施；但存在 5 个 P0 级问题必须在执行调度前修正/裁决，否则会造成跨方案重复实施或文件冲突。**

分维度贴合度：

| 方案 | 贴合度 | 亮点 | 主要问题 |
|---|---|---|---|
| 01 样式 | **高** | 423 混色 31 档、!important 673、scrollbar 31 块、`.card-tab.active` 双声明（:843 vs :869）、DiffCard 9 处 hover-bg fallback、5 个 GBK 文件全部实测精确命中 | ①GBK 面漏计 chat.css（实际为第 6 个 GBK 编码文件）；②99999 fallback 漏第 3 个文件（ChatComposer.module.css）；③与 08 方案在 reduced-motion 接线、动效时长 token 化上重复设计 |
| 02 组件 | **高** | 旧 Tooltip 85/88 口径（实测 80 直引 + 4 barrel = 84）、.ui-btn 36 文件（实测 tsx 38）、aria-pressed 手写开关 4 处行号全中、useAnimatedPresence 唯一消费者验证成立 | ①与 05 方案在 useExtensionMarket.tsx 上**同一文件双重拆分**；②Menu 直引 11 处（实测 10）；③B2 与 08 步 4 的 16 个无名称按钮清单文件面重叠 |
| 03 状态 | **高** | 桥恒 null（:31 无注入缝隙）、save/clear 调用点（:113-125/:443）、bootstrapStores 无注入点、AppBootstrap 自订阅（:185）、16 处 setState 的 4 处抽查全中 | ①messageSnapshotsBridge.ts 当前处于**未提交脏状态**（let→const 残留改动），步骤 1 开工前必须先处理；②D2 与 05 步骤 3 对 bootstrap-services.ts:81 重复处理 |
| 04 通信 | **高** | rustCore.ts:171/186 断链名、TelemetryMonitor.ts:21/103/107 双硬编码、commandManifest.test.ts:44-45 的 92/88 公式、fs_commands/mod.rs 四命令全中 | ①commandManifest.ts / commandMap.ts 路径缺 `transport/` 前缀；②main.rs 注册宏位置漂移（方案说 :79-88，实测 :90） |
| 05 质量 | **高** | check-swallowed-errors.mjs 仅覆盖 crates/、check-line-counts.mjs:49 过宽正则、:136 的 85% 分支全中 | 与 02/03 的文件重叠治理（见 ③ P0-2/P0-3）；前端基线目录已存在（`docs/multi-agent-repair/基线记录/`） |
| 06 工程 | **高** | vite.config.ts:194/204/216/221、index.html:13 宽 CSP、tauri.conf.json:29 严格 csp、三锁文件存在全中 | manualChunks 实际 :221 起（方案说 :218-243，偏移 3 行）；06-步骤5 的 prettier format 全仓写操作与一切批次冲突（需独立排期） |
| 07 性能 | **高** | useStreamCallbacks.ts:298/716-718/:504、StreamRenderBuffer delta/:30 chunkUpdates/8192 预算、MessageContent.tsx:56-68/:119-120/:122、helpers.ts:71/:224、AsyncMarkdownBlock.tsx:24 全中 | ①MessageContent.tsx / AsyncMarkdownBlock.tsx 实际在 `chat-message-row/` 与 `chat-message/` 目录（方案路径含糊）；②步骤 0 压测脚本需自建（无现成资产） |
| 08 a11y | **高** | window.confirm 9 文件 10 次（:523-524 条件双行、:136 精确）、ShortcutRegistry vs SettingsShortcutsTab 绑定漂移三处实证、DiffCardFileList.tsx:301 role="listbox" 全中 | ①与 01 方案 reduced-motion/动效时长**重复设计**（P0-1）；②SR 播报验证无环境前提（NVDA 未装，未给降级路径） |

**三类典型问题分布**：

1. **跨方案重复实施（最危险，3 处）**：01↔08（reduced-motion 接线、动效 token）、02↔05（useExtensionMarket 双重拆分）、03↔05（bootstrap-services.ts:81 双重处理）——详见 ③ P0。
2. **行号小漂移（数量多、影响小）**：大文件行数普遍偏大 3%~8%（ModelConfigEditor 869 vs 856、ApprovalAskCard 777 vs 742 等 8 个文件），主因是 2026-08-09 后仓库仍在演进。所有行号引用需"语义定位优先"。
3. **工具策略缺失（1 类）**：423 混色、88 Tooltip、128 裸 button 三处大规模机械替换均未给出工具面（脚本/codemod/正则），且 01-S2 内部"映射表先行"与"逐文件核对不机械替换"存在口径矛盾——见 ④。

**总体判定**：8 份方案通过评审可进入实施，但**主控必须先解决 ③ 的 5 个 P0**（重复实施裁决 ×3、脏工作区处理 ×1、双改文件清单 ×1），并按 ⑤ 的批次划分派单。

---

## ② 文件面抽查表（漂移清单）

> 抽查口径：2026-08-09 工作区 `git status` 之后的状态。✅ = 精确命中；⚠️ = 小漂移（数量级对、行号偏）；❌ = 错误/缺失/需重定位。

| # | 方案步骤 | 引用位置 | 实测 | 判定 |
|---|---|---|---|---|
| 1 | 04-步骤1 | rustCore.ts:171 `'md_render'` / :186 `'highlight_code'` / :157 注释清单 | 全中（`invokeResult<string>('md_render', ...)` 等） | ✅ |
| 2 | 04-步骤1b | TelemetryMonitor.ts:21 硬编码 logFilePath / :103 `perf_jsonl_append` / :107 workspaceRoot | 全中 | ✅ |
| 3 | 03-步骤1 | messageSnapshotsBridge.ts:31-43 无注入缝隙（`const _ops = null`，无 setter） | 全中；但该文件**当前有未提交改动**（`let`→`const`） | ⚠️（P0，见 ③-4） |
| 4 | 03-步骤1 | sessionMessageActions.ts:113-125 快照载荷构造 / sessionCrudActions.ts:443 clear | 全中（:113/:118/:120 + :443） | ✅ |
| 5 | 03-步骤1 | bootstrapStores.ts 无 bindMessageSnapshotsOps | 确认无（需补） | ✅ |
| 6 | 03-步骤2/4 | AppBootstrap.ts:147-156 动态 import rebind / :185 自订阅 / :155 直写 | 全中 | ✅ |
| 7 | 03-步骤4 | useOverviewState.ts:154 / workspaceChromeHooks.ts:319 / Workspace.tsx:69 / ApprovalSection.tsx:68 setState | 全中（4/4） | ✅ |
| 8 | 01-S0 | DiffCard.module.css:583/:880 无 fallback；:740/:743/:751/:754 有 fallback；9 处 hover-bg fallback（:457/462/988/1032/1061/1125/1160/1184/1237） | 全部逐行验证命中（文件 1412 行） | ✅ |
| 9 | 01-S0 | shell-workspace.css:843-846 vs :869-872 `.card-tab.active` 双声明（bg-primary !important 压制 bg-active） | 全中（实际路径 `styles/shell/shell-workspace.css`） | ✅ |
| 10 | 01-S0 | SettingsUsageTab.module.css:275/281/321/328 `--chart-color-1/2` | 全中（4 处） | ✅ |
| 11 | 01-S0 | z-index.css 补 `--z-drag-overlay-max`；BinaryTreeWorkspace.module.css:286 / UnitSessionTabStrip.module.css:340 的 99999 fallback | 方案所述 2 文件存在；**但实测第 3 个文件 ChatComposer.module.css 也有 99999**——方案遗漏 | ⚠️ |
| 12 | 01-S1 | themeStore.ts:706-742 运行时注入段（:706-707 accent-adaptive、:709+ bg 注入） | 全中（文件 839 行） | ✅ |
| 13 | 01-S1 | style-contract.test.ts 已有 F7-F14 z 硬编码 + F7-F27 dark 覆盖断言 | 全中（存在，断言结构一致） | ✅ |
| 14 | 01-S2 | 423 处混色 31 档（1.2%~42%） | 实测 **426 处 31 档**（口径含所有 tsx/css，审计 423 应为不含部分文件）——31 档完全复现 | ⚠️（档位无漂移，总数差 3） |
| 15 | 01-S3 | shell-polish.css:18-86 `.ui-btn` 按钮段 / :112-116 `.ui-input:focus` box-shadow:none | 全中（实际路径 `styles/shell/shell-polish.css`） | ✅ |
| 16 | 01-S4 | shell-workspace.css:366-499 inset 段（约 130 行） | 实际 :366 起即为 inset tabs-bar 段，inset card-tab 段 :391-488，段内 !important 24 个——区域正确、起点微偏 | ⚠️ |
| 17 | 01-S5 | settings-base.css:86-154 `.settings-field-input` / :969-989 settings-segment !important 组 | 全中 | ✅ |
| 18 | 01-S7 | tokens.css :750-765 `[data-panel]` 基准 / :717-785 keyframes 段 | 全中（文件 785 行，:750 起 data-panel） | ✅ |
| 19 | 01-S7 | chat.css:384/391 双重 border !important（与 ChatToolCallBlock.module.css:22 去重） | 全中 | ✅ |
| 20 | 01-S7 | 5 个 GBK 文件（panels/shell-dragdrop/shell-layout/shell-polish/shell-workspace） | 全中（字节级验证 5 文件含 GBK 乱码，BOM 无）；**但 chat.css 实测为第 6 个 GBK 编码文件**（GBK 解码零替换符，字节 `E9 97 81 3F` 为 GBK"閿"+ASCII `?` 双重损坏）——方案表述为"注释双重损坏"不准确 | ⚠️（P1，见 ③-12） |
| 21 | 02-A1 | ui/index.ts 现 12 行（仅 Dialog+Tooltip） | 实测 **11 行**；Menu 直引 11 处 → 实测 **10 处**（ComposePlusMenu/PermissionModeMenu/ChatHeaderMore/SkillsMoreMenu/ModelsSettingsTab/ProjectPickerMenu/SidebarContextMenus/SettingsQuickMenu/SettingsSelect/ModelBadgePickerMenu） | ⚠️ |
| 22 | 02-B1 | 旧 Tooltip 88 处 / 85 文件 | 实测 `from '../Tooltip'` = **80 文件** + barrel `from '../ui'` 消费 Tooltip = 4 文件（ScheduledTasksPanel/RunHistoryList/WorkflowList/WorkflowForm），合计 **84** | ⚠️（差 1~4，批次边界按实测重排） |
| 23 | 02-B2 | `.ui-btn` 36 个组件文件 | 实测 42 文件全仓引用（tsx 38 个组件文件 + shell-polish.css + Button.tsx 等） | ⚠️ |
| 24 | 02-B3 | SettingsSchemaRenderer.tsx:81 settings-switch / :213 aria-pressed / SettingsSecurityTab.tsx:370 / SettingsShortcutsTab.tsx:457 / ModelConfigEditor.tsx:668 toggleThumb | 全部精确命中 | ✅ |
| 25 | 02-B5 | ui/Select/Select.tsx:3-9 头注释"SettingsSelect 迁移即以此为落点" | 命中（含 T05.3.2 引用） | ✅ |
| 26 | 02-B5 | SettingsSelect.tsx:18 `onOpen()` 自研接口 | 文件存在（181 行） | ✅ |
| 27 | 02-B6/D1/D3/E1 | 大文件行数：ModelConfigEditor 856 / ApprovalAskCard 742 / SidebarContextMenus 686 / ExternalSessionImport 551 / SettingsUsageTab 508 / UnitSessionTabStrip 478 / MessageVirtualizer 447 / useExtensionMarket 581 / useSidebarSessionList 550 | 实测：869 / **777** / **722** / 580 / 542 / **505** / 467 / **623** / **588**——普遍偏大 3%~8% | ⚠️（行号引用执行前重定位） |
| 28 | 02-E2 | hooks/useAnimatedPresence.ts 唯一消费者 = 旧 Tooltip（Tooltip.tsx:3,77） | 命中（hooks/ 版仅被 components/Tooltip/Tooltip.tsx 引用，ui 版独立） | ✅ |
| 29 | 03-步骤2 | bootstrap-services.ts:81 `connect().catch(() => {})` | 命中（另有 :116 同类、:145 catch） | ✅ |
| 30 | 03-步骤2 | workspaceStore.ts:121/128-145 setState recipe | 命中（:121/:130） | ✅ |
| 31 | 07-步骤1 | useStreamCallbacks.ts:298 setStreamText / :716-718 `push('',true)+flush(true)` / :504 OPT-H4 intentional residual | 全中 | ✅ |
| 32 | 07-步骤1 | StreamRenderBuffer.ts:22 delta / :30 chunkUpdates: never[] / :47-48 maxBytesPerFrame 8192 | 全中 | ✅ |
| 33 | 07-步骤1 | MessageContent.tsx:56-68 / :119-120 / :122 isStreaming | 全中（文件 172 行；**实际路径 `components/chat-message/`，非 chat-message-list/**） | ✅（路径微偏） |
| 34 | 07-步骤3 | ChatMessageList.tsx:160-161 windowScanKey = messages | 全中 | ✅ |
| 35 | 07-步骤2/4 | helpers.ts:71 updateMessageText / :224 snapshotStreamTextToSession | 全中（实际路径 `hooks/chat-stream/helpers.ts`） | ✅ |
| 36 | 07-步骤1 | AsyncMarkdownBlock.tsx:24 D0 residual 注释 | 命中（实际路径 `chat-message-row/`） | ✅ |
| 37 | 08-步2 | window.confirm 9 文件面 10 次调用（:523-524 条件双行 / :136 ComposerField） | 全中（实测 9 文件 10 次，清单与方案逐项一致） | ✅ |
| 38 | 08-步3 | ShortcutRegistry.ts:29/33/34 vs SettingsShortcutsTab.tsx:20-23 绑定漂移（open_security Ctrl+Shift+E vs +S、toggle_runtime Ctrl+` vs +R） | 全中（绑定级漂移实证成立） | ✅ |
| 39 | 08-步4/5 | DiffCardFileList.tsx:152-278 按钮 / :301 role="listbox" / DiffCard.module.css:834/:847 / shell-sidebar.css:286 | 全中 | ✅ |
| 40 | 04-步骤2 | fs_commands/mod.rs:18-23/26-32/35-42/49-57 四命令 / main.rs:190 core_jsonl_append | 全中（微偏 1-2 行）；main.rs 注册宏实测 **:90**（方案说 :79-88，偏 +2~+11） | ⚠️ |
| 41 | 04-步骤3 | commandManifest.ts:132/135 快照 / commandMap.ts:33 白名单 / commandManifest.test.ts:44-45 的 92/88 | 测试公式精确命中；**文件实际在 `src/api/transport/` 子目录**（方案路径缺前缀） | ⚠️ |
| 42 | 06-步骤0~4 | vite.config.ts:194/:204/:216/:221、index.html:13 宽 CSP、tauri.conf.json:29 严格 csp、三锁文件存在、根锁存在 | 全中（manualChunks 实测 :221 起，方案 :218-243 微偏） | ✅ |
| 43 | 05-步骤1/2 | check-swallowed-errors.mjs 仅 crates/、check-line-counts.mjs:49 `/types?/i` 过宽、:136 85% 分支、基线目录存在 | 全中 | ✅ |
| 44 | 07-步骤5 | lightweightMode.ts:56 data-reduced-motion 写入 | 命中（与 01-S7-1 同一锚点，见 P0-1） | ✅ |

**漂移清单汇总**：✅ 精确 30 处；⚠️ 微漂移 14 处（其中 2 处为方案遗漏面：99999 第 3 文件、chat.css GBK 定性；其余为行号/数量级漂移，执行前语义定位即可）；❌ 0 处。**无一处"引用的文件或函数不存在"**——文件面精确性总体达标。

---

## ③ 执行卡壳点清单

### P0（必须修正/裁决后才能派单，共 5 条）

| # | 卡壳点 | 方案出处 | 详细说明 | 处理建议 |
|---|---|---|---|---|
| **P0-1** | **reduced-motion 接线 + 动效时长 token 化被 01 与 08 重复设计** | 01-S7-任务1（动效时长 token + `[data-reduced-motion]` 接线）；08-步7-④（reduced-motion.css 补 `[data-reduced-motion]` 选择器 + lightweightMode.ts:56 死钩子复活）、08-步7-⑤（ApprovalAskCard.module.css:297 + tab-drag.css:42/46 两处过渡 token 化） | 两方案都写了同一件事：reduced-motion.css 补 `[data-reduced-motion]` 选择器、lightweightMode.ts:56 接线；01-S7 的"散装时长 31 处映射 token"清单必然包含 08-步7-⑤ 的同一文件（ApprovalAskCard.module.css、tab-drag.css）。执行 Agent 若并行跑两个批次，**同一文件双重改写必冲突** | 主控裁决归属：**08 承接 reduced-motion 接线语义（a11y 契约），01 承接动效时长 token 档位（样式真源）**；两文件（reduced-motion.css、lightweightMode.ts）归 08 独占；ApprovalAskCard.module.css / tab-drag.css 的 token 化归 01-S7 独占，08-步7-⑤ 删除该任务改为"验收"（01 完成后断言 token 引用）。需在方案文档标注裁决 |
| **P0-2** | **useExtensionMarket.tsx 被 02-D2 与 05-步骤4 双重拆分** | 02-D2（581 行 → useSkillsCache/useMcpCache/useMarketQuery 三 hook）；05-步骤4（useExtensionMarket.tsx:188-624 436 行 → 拆三个子 hook） | 两方案对**同一文件、同一拆分目标**（三 hook 组合）设计了重复任务。并行执行 = 同一文件双 agent 改写，必冲突；串行执行 = 第二家无事可做 | 主控裁决：**02-D2 承接**（组件域 hooks 拆分归 02 的 E/D 阶段惯例），05-步骤4 将该文件从 18 函数清单剔除（仅保留其 18 函数清单中其余文件）；或在 05 文档登记"移交 02-D2" |
| **P0-3** | **bootstrap-services.ts:81 被 03-步骤2-D2 与 05-步骤3 重复处理且处理方式冲突** | 03-步骤2-任务1（`connect().catch(() => {})` 改 ErrorStore 显式登记，消灭静默显示离线）；05-步骤3（空 catch 分级治理清单含 `.catch(() => {})` 33 处，:81 在列，处理=补日志或 swallow-ok） | 同一行代码两种处理语义：03 要求升级为 ErrorStore.classifyError 显式登记；05 的"补 logInternalError"是不同落点。若 05 先跑把 :81 改成 logInternalError，03 的 D2 再改会二次动工；若 03 先跑，05 的 33 处清单就要剔除该点 | 主控裁决：**03-D2 先行独占 bootstrap-services.ts:81/116**（功能性修复优先），05-步骤3 的 33 处 `.catch(() => {})` 清单执行时 grep 实测剔除已处理点（05 步骤 1 的基线建立本身就以 grep 实测为准，天然吸收） |
| **P0-4** | **messageSnapshotsBridge.ts 处于未提交脏状态，03-步骤1 开工前提被破坏** | 03-步骤1（补 bindMessageSnapshotsOps + bootstrapStores 装配） | 实测 `git status`：`M apps/crish-desktop/src/store/messageSnapshotsBridge.ts`（改动为 `let _ops` → `const _ops`，与注入方向相反，疑似其他会话残留）。03-步骤1 的完成判据之一"全仓 grep messageSnapshotsBridge：仅 bridge/bootstrapStores/两个 action/测试命中"以及"补注入函数"都会在此脏基础上进行 | 调度前先处理：该脏改动若确为无意义清理 → `git checkout` 丢弃或随 03-步骤1 首提交一并收编（改回 let 或保持 const 都不影响方案——bindMessageSnapshotsOps 是新增函数，与 _ops 声明形态正交）。**派单前必须 git status 确认工作区干净** |
| **P0-5** | **02-B2 与 08-步4 的"16 个无名称按钮"清单文件面重叠** | 02-B2 完成判据"16 个无名称按钮补齐 aria-label（icon-only 替换中强制补名）"；08-步4 任务 ①"16 个按钮补 aria-label"（DiffCardFileList/FileActions/FilesCard/FileViewerCard/ModelConfigEditor 5 文件） | 同一 5 个文件、同一批按钮（DiffCardFileList.tsx:152-278 等）双改。02-B2 是"替换 button 时顺带补"，08-步4 是"独立补齐 + 门禁"。若 08-步4 先行，02-B2 替换后 aria-label 需保持（机械替换工具必须保留既有 aria-label 属性）；若 02-B2 先行，08-步4 的清单以 02 后状态重扫 | 主控裁决：**08-步4 的补齐清单先于 02-B2 相关批完成**（或 08-步4 延后到 02-B2 之后以 grep 实测重扫清单）；02-B2 的机械替换工具必须"保留已有 aria-label"（见 ④ 工具面） |

### P1（需方案补充或调度注意，共 9 条）

| # | 卡壳点 | 出处 | 说明 |
|---|---|---|---|
| 1 | **SR 播报验证无环境前提** | 08-步2-③/步4/步7、02-B3 完成判据"SR 播报" | NVDA 未安装则"SR 抽查"不可执行。方案未给降级路径。建议：Windows 端 NVDA 不可用时降级为「Playwright aria 快照断言（role/name/expanded 状态）+ axe 扫描 + 人工键盘走查」，SR 播报留待有环境时补录 |
| 2 | **视觉对照截图无基线图库** | 01-S2/S3/S6、02-B2"替换前后截图对比" | 多处验证依赖"前后截图对比"，但仓库无截图基线资产。执行 Agent 需自建 `tests/visual/`（该目录已存在，`tests/visual/helpers.ts` 有改动记录）。建议：01-S0 先行批次顺带建立「8 个代表组件截图基线」（含 light/dark），后续批次直接复用 |
| 3 | **机械替换工具策略缺失（423/88/128 三面）** | 01-S2、02-B1/B2 | 方案只给了"分批""映射表"，未给工具。详见 ④ |
| 4 | **01-S2 内部口径矛盾** | 01-S2 任务内容："映射表先行落盘为文档（S2 执行时逐文件核对，不机械替换）" vs 完成判据"31 档清零" | 427 处混色逐文件人工核对在 5-10 文件/批的粒度下意味着 40+ 批、纯人力成本极高；且方案又要求"每批一个提交"。"不机械替换"应理解为"不盲改"而非"不用脚本"。见 ④ 工具策略 |
| 5 | **99999 fallback 第 3 个文件遗漏** | 01-S0-5 | 实测 ChatComposer.module.css 也存在 99999 fallback，方案只列 2 个文件。执行时按 grep 实测补齐（完成判据本身是 grep 清零，不会卡死，但文件面清单需更新） |
| 6 | **chat.css GBK 定性修正** | 01-S7-6 | chat.css 是**第 6 个 GBK 编码文件**（整体 GBK，非仅注释损坏），字节变化量与 5 个全局文件同级。方案 S7 涉及文件面已含 chat.css 且"与快照同提交"已覆盖，但"5 个 GBK 文件"的表述需改为"6 个"（含 chat.css），执行 Agent 按字节检测实测清单（建议写死清单：6 文件 + 编码验证脚本） |
| 7 | **04 方案路径缺 `transport/` 前缀** | 04-步骤3/6 | commandManifest.ts/commandMap.ts/commandManifest.test.ts 实际在 `src/api/transport/` 下，方案只写文件名。执行 Agent 按 grep 定位不卡壳，但 04-步骤6 的门禁扫描路径需写全 |
| 8 | **08-步2 三个异步化点的行为风险** | 08-步2-③（useFileNavigation:121 / useFilePreview:135 / ComposerField 系） | 方案已列行为变更清单要求，但**未给"挂起流程"的具体实现模式**（Promise 桥 / 状态机 / 回调注入）。建议：01/03 方案已用过的"action 内副作用"样板或 02-E3 的 ConfirmDialog onConfirm 回调契约作为唯一模式，写进任务书 |
| 9 | **07-步骤0 压测脚本无现成资产** | 07-步骤0（mock SSE 100KB + 20 工具事件 + trace 采样） | 方案说"新建 tests/perf/ capture 工具"，未给脚本路径或输入 fixture。执行 Agent 需从零搭建（chatApi 注入点需确认）。建议：03-步骤1 批次内顺带确认 chatApi 的 mock 注入面，或 07-步骤0 作为独立小批先行 |

### P2（提示性，执行时留意）

1. **01 方案 423 vs 实测 426 混色**：31 档完全一致，总量差 3 处为口径差异（tsx 内联样式/主题注入段）。S2 的"清零判据"以 grep 实测为准，无卡壳。
2. **02-B1 的 88 vs 84 消费面**：批次边界（4 批每批 20）按 84 重排即可，退役判据"grep = 0"不变。
3. **02-A1 的 11 vs 10 处 Menu 直引**：清单按 grep 实测 10 处执行。
4. **06-步骤2 manualChunks 行号 :218-243 → :221 起**：语义定位（manualChunks 函数）即可。
5. **03-步骤2-D7 的 terminal 镜像 8 处 setActiveTerminalSession**：未逐一抽查，执行时 grep 实测。
6. **05-步骤3 的 306 空 catch 口径**：方案自身已声明"以规则口径为门禁事实"（33 vs 10 处实测差异），无卡壳。

---

## ④ 工具策略建议（机械替换怎么做）

**总原则**：三步走——①脚本生成 diff（可审查）；②人工复核 diff（语义判定）；③分批提交（可回退）。禁止"整仓一次性替换"与"纯人工逐文件"两端。

### 4.1 423 混色收敛（01-S2）——正则脚本 + 语义映射表双驱动

- **工具**：一次性 Node 脚本（`scripts/` 下，如 `scripts/replace-tint-mix.mjs`），输入 = 映射表（31 档 → token 的 JSON/TS 表），输出 = 全仓替换 diff 清单（不直接写文件，先 --dry-run）。
- **映射表形态**（01 方案已有语义归位规则，落成机器可读）：`{ "4%": "var(--tint-hover)", "8%": "var(--tint-active)", ... }`，两档特殊（1.5%/42%）从映射表剔除走人工。
- **执行流**：`--dry-run` 输出 diff → 执行 Agent 按 5-10 文件/批切分 → 每批人工扫一遍 diff 的"上下文行"（确认是 hover/active 语义）→ 该批替换 + 快照同提交 → 下一批。
- **红线**：脚本只替换 `color-mix(in srgb, var(--text-primary) X%,` 前缀形态；`color-mix` 的其他基底（--text-secondary 等）不在本批范围；themeStore.ts 注入段（3.5%/8%）单独处理（随 01-S1 的注入层对齐，不在此脚本内）。
- 该方案与 01-S2 文字"逐文件核对不机械替换"的差异=**用脚本产出 diff 供人工核对**，实质仍是"逐文件核对"，只是免去手工输入，成本降一个数量级。

### 4.2 88/84 处 Tooltip import 迁移（02-B1）——codemod 式正则，可全量

- **工具**：`sed`/PowerShell 正则（或 jscodeshift 简版）：`from '../Tooltip'` → `from '../ui'`；`from '../../Tooltip'` → `from '../../ui'`（按目录深度两档即可，实测全仓仅 `../Tooltip` 一种形态——**单形态**，脚本极简）。
- **props 差异点**（非机械）：新 Tooltip cloneElement 透传 restProps vs 旧只透 ref——执行 Agent 对 84 个文件逐个 diff 检查"子元素是否有 props 注入依赖"，预计只有个位数需要手改；方案已列此差异，照做即可。
- **批切**：按方案 4 批按域切，脚本只做"预览 diff + 单批应用"（`--only <目录>` 参数）。

### 4.3 128 文件裸 button（02-B2）——不可机械，但可用"分类预扫描"工具辅助

- 语义判定（primary/danger/ghost/secondary/iconOnly）必须人工，但**预扫描脚本可以分类降载**：
  - 脚本 A：提取每个裸 button 的上下文（onClick 回调名、children 文本、icon 子元素、aria-label 现状）→ 输出"意图特征表"（如 children 含 `Trash2` icon + 无文本 → danger 候选；onClick 名为 `onDelete*`/`onRemove*` → danger 候选）。
  - 脚本 B：标记 16 个无名称按钮（无 children 文本 + 无 aria-label）→ 交 08-步4 清单（P0-5 裁决后）。
- 执行 Agent 基于特征表做意图判定，比逐文件读代码快 3~5 倍，且判定结果可评审（特征表即评审物）。
- **关键红线**：替换必须保留已有 aria-label/aria-pressed/type/data-* 属性（正则替换 className 时勿整段重写 button 标签——建议只替换 `className="..."` 与标签名，属性行不动）。

### 4.4 04-步骤1 的两个字符串改名——最简

- 编辑器全局替换或 `rg -l` + 逐文件替换，测试面（test-setup.ts 等 5 文件）同步——方案已列清单，无工具需求。

### 4.5 工具落地纪律

- 所有一次性脚本**入库**（AGENTS.md 测试资产铁律：新增调试/测试脚本后立即 git add 提交，不留未跟踪状态），放在 `scripts/` 下，命名 `replace-*`/`probe-*` 前缀与既有 check-* 区分。
- 脚本产出 diff 一律 `--dry-run` 先行 + diff 输出留档（作为评审物）。
- 快照联动：任何改 css 内容（含脚本触发）的批次，`test:snapshots` 更新与内容改动**同提交**（01-R1、8e8c313c 教训）。

---

## ⑤ 并行批次划分建议

> 约束：每批 ≤12 执行 Agent；同文件必须串行；CSS 内容改动批次与 `test:snapshots` 同提交；每批独立提交独立门禁。

### 批次间文件面冲突矩阵（关键冲突关系）

```
tokens.css           ── 01-S1/S6/S7、08-步6  【必须串行：01-S1 真源先行 → 08-步6 调值 → 01-S6 收编】
全仓 *.module.css    ── 01-S2（混色 427 处）是最大面，与 01-S3~S7、08-步5/7、02-B1 部分文件重叠
messageSnapshotsBridge.ts ── 仅 03-步骤1 独占（先清脏状态）
bootstrap-services.ts    ── 03-D2 独占先行，05-步骤3 的清单以 grep 实测剔除
useExtensionMarket.tsx   ── 02-D2 独占（P0-2 裁决后），05-步骤4 剔除
reduced-motion.css / lightweightMode.ts ── 08-步7 独占（P0-1 裁决后），01-S7 剔除
components/Tooltip 目录  ── 02-B1 独占（05-5b 依赖其后）
ui/barrel + Menu 直引   ── 02-A1 独占
ChatMessageList.tsx     ── 07-步骤3 与 08-步7（role="log"）重叠：07 先行、08 后置
MessageContent.tsx      ── 07-步骤1 与 02-C1 同文件：07 先行
DiffCard 系文件         ── 01-S0/S2、02-B2、08-步2/4/5 多面重叠：按「01-S0 兜底 → 08-步5 hover → 02-B2 button → 08-步4 名称」串行
```

### 批次划分（每批为一个派单单元，可多批并行）

| 批 | 内容 | 文件面 | 并行关系 |
|---|---|---|---|
| **批 1（全并行 6~8 Agent）** | 03-步骤1 快照桥（先处理 P0-4 脏状态）；04-步骤1 断链命令（前端 2 字符串 + 测试面）；04-步骤2 fs rename（Rust 面，与前端完全独立）；06-步骤0+1 基线固化 + build 进 CI；05-步骤1 吞错基线（eslint 规则 + 基线文件）；03-步骤2 中不含 D2 的部分（D5 rebind/D7 terminal/D8 死面/D10） | 互不重叠（store/ 与 api/ 与 Rust 与 CI 与 scripts/） | 全并行；批内 Agent 上限 12 达标 |
| **批 2** | 01-S0 P0 兜底（DiffCard/Tooltip css/shell-workspace/SettingsUsageTab/z-index/99999 三文件） | 8 文件小面 | 可与批 1 并行（与批 1 无重叠）；**顺带建立视觉截图基线**（P1-2 建议） |
| **批 3** | 01-S1 token 真源（tokens.css/themeStore/style-contract 扩展） | 3 文件 | 批 2 后（S0 的断言模式是其输入）；**tokens.css 从此批起被本批独占直到批 12** |
| **批 4** | 02-A1/A2 barrel 补全 + store facade 门禁 | ui/index.ts + 10 Menu 直引 + 门禁脚本 | 与批 3 并行（无重叠） |
| **批 5** | **01-S2 混色 427 处收敛**（脚本 + 分批提交） | 全仓 css 大面积 | **独占 css 内容改动面**：批 5 期间 01-S3~S7、08-步5/7 的 css 改动全部冻结（或严格错开文件）；与批 3 串行（依赖 tint 档位） |
| **批 6** | 02-B1 Tooltip 迁移（80 文件 4 批） | 消费点 tsx（import 行） | 与批 5 部分文件重叠（同文件时串行：改 import 行 vs 改 css 行，实际可并存但建议错开批 5 后置） |
| **批 7** | 03-步骤3/4 raw setState 清零 + 门禁脚本 | store/ + 6 个组件文件 | 依赖批 1 的 03-步骤2 产物（rebindSessionFolders 等）；与批 6 无重叠 |
| **批 8** | 08-步2 确认对话框（9+1 点，依赖 02-E3 的 ConfirmDialog 基座）+ 08-步3 快捷键单源 | 9 调用点文件 + ShortcutRegistry/SettingsShortcutsTab/AppShortcuts | 依赖批 4 后基座（可后置）；与批 6 的 DiffCard/ProjectPickerMenu 等文件重叠 → **放在批 6 之后** |
| **批 9** | 02-C1 props 聚合 + 02-D 阶段拆分（含 P0-2 裁决后的 useExtensionMarket） | chat-card/ + 巨型组件 | 与 07-步骤1 的 MessageContent 同文件 → **07 先行**；与批 7 的 Workspace.tsx 等重叠 → 批 7 后置 |
| **批 10** | 07-步骤1~4 流式渲染/complete/搜索/重渲染热点 | MessageContent/ChatMessageList/useStreamCallbacks/streamingStore 面 | 批 9 前（MessageContent 独占）；ChatMessageList 在 08-步7 前 |
| **批 11** | 08-步4/5/7 按钮名称/hover 键盘闭环/键盘矩阵收尾 | DiffCard 系/菜单系/reduced-motion/lightweightMode | 依赖批 2（DiffCard 兜底）、批 6（Tooltip 迁移后清单重扫）、批 10（ChatMessageList）；P0-1 裁决后独占 reduced-motion |
| **批 12** | 01-S3~S7 + 08-步6（对比度调值） | 按钮/Tab/表面族/暗色收编/动效/编码统一 | 依赖批 5（混色后基线）、批 6/8（组件接管后删段）；tokens.css 本批收口；S7-6 编码统一与快照同提交 |
| **批 13** | 02-E 阶段（虚拟列表/hooks barrel/P2 族收敛）+ 05-步骤3~6（空 catch 治理/行数/重复收敛/规范收尾） | 清理退役面 + 110 文件治理面 | 全部依赖前序批次（旧件退役）；05-步骤3 的 110 文件与批 6/8/11 重叠 → **最后做**（P0-3 裁决后 bootstrap 已处理）；06-步骤5 的 prettier format:write 独立基线提交放本批前 |
| **批 14** | 06-步骤2~7（chunk 拆分/CSP/锁文件/lint 口径/preview 冒烟/收尾）+ 07-步骤5（perf 防线） | vite/CI/CSP/playwright | 工程面独立，可与批 2~5 并行；**锁文件删除（06-步骤4）建议最早做**（npm ci 面）；prettier format:write 必须在任何"产生新代码"的批次前独立落地（否则每批 diff 都带格式噪音） |

**关键串行链**（不可打破）：

```
01-S0 → 01-S1 → 01-S2（混色独占）→ 01-S3~S7
02-A1/A2 → 02-B1 → 02-B2（按钮，先 primary 定案=01-S3 握手）→ 02-C1 → 02-D → 02-E
03-步骤1 → 步骤2 → 步骤3 → 步骤4 → 步骤5（步骤5 依赖 02 组件落地）
07-步骤1 → 步骤2/3 → 步骤4（步骤4 的比较器收窄依赖 02-C1）
08-步2/3 → 步4/5 → 步7（步6 依赖 01-S6）
05-步骤1/2 → 步骤3/4（步骤4 在 02-D2 裁决后）→ 步骤5/6
06-步骤0/4 可最早；06-步骤1→2→3→6 内部串行；06-步骤5 的 format 基线最先行
```

**并行安全结论**：批 1/2/4/6/7 与工程面（批 14 前半）可形成第一波并行（文件面错开）；混色批（5）与组件接管批（6/8）需按文件错开或串行；所有"退役删段"类步骤（01-S3 删 .ui-btn 段、02-B1 删 components/Tooltip、02-B6 删 6 自研 Tab）必须排在对应接管批次之后。**同文件串行纪律**（AGENTS.md 派单规则）适用于上述全部重叠点。

---

## ⑥ 遗漏面补充（方案未覆盖、执行时必须处理的现实问题）

1. **工作区脏状态处理（P0-4 已列，此处收口）**：派单前 `git status` 必须干净。当前已知脏文件：`apps/crish-desktop/src/store/messageSnapshotsBridge.ts`（let→const 残留）、`components/workspace/usePreviewNavigation.ts`、`store/workspace-shell/layoutRestorePolicy.ts`、Rust `buffer.rs`/`event_bridge_contract.rs`、`tests/visual/helpers.ts`、根 `Cargo.toml`/`Cargo.lock`、AGENTS.md——**其中 Rust 面与 Cargo 改动属于其他进行中轮次（markdown-editor R3），前端修复批次严禁触碰 reference/markdown-editor 与 crates/conex-browser*、apps/crish-mobile/（未跟踪目录）**。
2. **与并行域的冲突规避**：`reference/markdown-editor/` 当前有未提交改动（R3 轮次进行中）——本方案批次全部在 `apps/crish-desktop/` 与 `src-tauri/` 面，**文件面天然隔离**，但提交时需按 AGENTS.md"提交遵循仓库风格 + 不混提"纪律分开提交，避免把 R3 改动卷入。
3. **git 提交纪律强化**：批内每批独立提交（方案已声明）；**一次性脚本与基线文件必须随批入库**（05 基线、04 快照、07 压测脚本、01 映射表——AGENTS.md 测试资产铁律）；禁止 `--no-verify`（AGENTS.md 零容忍）。
4. **测试基线变化登记**：8 份方案合计改动面覆盖 ui/、store/、api/、settings/ 等大面积组件——每批提交后快层（45/70/65/45）+ 中层 vitest 全量 + 5 个 markdown-editor e2e 专项（ast-block-tables/format-checker/ime-composition/keyboard-navigation/wysiwyg-interaction，**禁止删除**）为强制回归面；`npm run test`（reference/markdown-editor 门禁）与前端批次无交集但改动引擎代码时仍需跑通。
5. **方案文档自身的裁决记录缺失**：P0-1/P0-2/P0-3/P0-5 四处跨方案重复设计需要主控裁决——建议裁决结论写入 `docs/frontend-audit/40-final-plan/`（该目录已存在）或本评审文档附录，并在对应方案文档标注"已裁决归 X"。
6. **快照哈希漂移的 CI 误报预案**：01-R1 已列，但多批并行时"快照红"会频繁出现——建议 CI 对 `test:snapshots` 失败区分"仅哈希变化"（对比 diff 全为 class 名替换）与"真回归"，避免执行 Agent 误判回滚（8e8c313c 教训复用）。
7. **06-步骤5 的 prettier format 全仓基线**：建议作为**独立首个提交**（不混任何功能批次），否则 13 批功能改动每批 diff 都会带格式噪音，评审面失控。
8. **e2e 生产形态（06-步骤6）与 07-步骤5 的 L3 判据依赖**：07 的 Playwright perf spec 依赖 06 P1-1（生产 build 进 CI）——方案已登记依赖，调度时 06-步骤1 需在 07-步骤5 之前落地，否则 perf spec 跑 dev server 的"留余量"判据不稳定。
9. **03-步骤5 的 store 直引门禁与 02-A2 的 store-facade 门禁是两道近似门禁**：03-步骤5 用"入口集合白名单制"扫描 components/** import，02-A2 用 check:store-facade 扫描 import `store/`——建议合并为一道（03 的门禁实现可复用 02 的 check:store-facade 模式），避免双脚本双口径（05 方案的门禁"声明与执行脱节"教训）。
10. **AGENTS.md 需要同步的声明**：05-步骤2-4 要求改 `.agents/AGENTS.md`（行数门禁三级语义声明）；05-步骤6a 要求 RL-04 声明实现或退役；06-步骤3 要求 docs 登记 CSP 切换点——这些"声明同步"步骤必须与实现同批完成（纸面门禁脱节教训）。

---

## 附：评审抽样复核明细（供主控复核）

- 抽样方法：对 8 份方案中全部带 `文件:行号` 的引用按 P0 面优先、随机抽取 44 处实读核对（见 ② 表）；核心 grep 基线（423/426 混色、673 !important、31 scrollbar 块、88/84 Tooltip、36/38 .ui-btn、9 文件 10 次 confirm、10 处 Menu 直引、92/88 命令条数）均以 2026-08-09 工作区实测复现。
- 唯一无法实测项：Rust `cargo test` 行为（本评审只读，未跑测试）；`eventParser.ts:224/264` 静默兜底（08 方案未引用，04-步骤5 引用，未抽查——建议 04-步骤5 执行前按 grep 实测）；03-步骤2-D7 的 8 处 setActiveTerminalSession（未抽查）。
- 编码验证：5+1 个 GBK css 文件经字节级检测确认（panels.css/shell-dragdrop.css/shell-layout.css/shell-polish.css/shell-workspace.css/chat.css）；全仓 ts/tsx 无非 UTF-8 文件（0 替换符）；本评审文档为 UTF-8 无 BOM。
