# CODEBASE-02：前端与 packages 现状审计（子代理 A2）

- 审计日期：2026-08-08
- 审计范围：`apps/crish-desktop/src`（1027 个文件）、`packages/` 五包 + plugin-import-claude-codex/test-utils、缓存优化前端面、状态管理分层、死代码/未接线面、前端健康门禁
- 审计方式：静态盘点 + 全量门禁实测（typecheck / vitest 快层+中层 / eslint）+ git 提交溯源（897f8389 knip、01ef652b P2-7、3eb3a417 closure、37153189 并行批次）

---

## 1. 规模盘点

### 1.1 apps/crish-desktop/src

- 文件总数：**1027**（含测试；`.test.*` 约占 40%）。
- 目录：`api`（150+ 源文件，核心业务层）/ `components` / `store` / `hooks` / `utils` / `constants` / `styles` / `workers` / `dev` / `__tests__` / `app` / `services`。
- 体量头部（按行数，非测试）：

| 文件 | 行数 | 职责 |
|---|---|---|
| `api/pricingStore.ts` | 1457（实际 1603） | 四指标定价目录 + 估算（本审计重点域） |
| `store/layout-tree/operations.ts` | 1015 | 二叉树布局操作 |
| `api/session-persistence/sessionRustDb.ts` | 1115 | SQLite 会话持久化（含 usage 回放） |
| `api/modelCatalog.ts` | 949 | 模型目录 v2（窗口/能力位，价格不覆盖） |
| `api/tool-presentation/toolCardPresenter.ts` | 894 | 工具卡展示 |
| `api/chat-bridge/handlers/eventParser.ts` | 843 | 引擎事件宽容归一 |
| `api/chat-bridge/handlers/taskEventHandlers.ts` | 403 | 任务域事件 |

### 1.2 packages/

| 包 | 源文件数 | 行数 | 备注 |
|---|---|---|---|
| shared-types | 44 | 7535 | 含 `generated/engine`（T6 生成事件联合 + parser）、cache-metrics 契约、validators |
| shared-utils | 68 | 9920 | 含 bench/cache/file 子域；`computeCacheMetrics` 未找到独立导出（前端用本地等效，见 §2.1） |
| plugin-sdk | 39 | 7577 | registry/manifest/skills/tools |
| plugin-import-claude-codex | 16 | 2075 | 导入器 |
| test-utils | 5 | 212 | 轻量 |

**注意**：`packages/logger` 与 `packages/telemetry` **无 src 目录**（未落地或已并入他处）——若任务书仍期望这两个包存在，属于文档/现实偏差，需主 Agent 确认。

### 1.3 store 数量与分层

zustand `create()` 独立实例（生产代码，排除测试）：

- **god store**：`layoutStore.ts`（sessions[]/messages/agents/chrome/legacy workspace 切片）
- **域 store（T11 拆分，独立实例）**：`terminalStore` / `workerStore` / `permissionStore` / `settingsStore`
- **sibling store**：`workspace-shell/workspaceShellStore`（TabSurface/dock）、`layout-tree/layoutTreeStore`（二叉树几何）
- **辅助 store**：`layoutAnimationStore`、`streamingStore`（per-token 轻量缓冲）
- **事件域 store（api 层）**：`chat-bridge/handlers/cacheEventsStore`、`securityAuditStore`、`components/workspace/flowDagStore`
- **DEAD**：`rustCoreStore`（0 调用点，见 §4）

facade 层（非独立实例）：`sessionStore` / `workspaceStore` / `settingsUiStore` 均为 layoutStore 别名；读入口统一 `storeAccess.ts`。分层文档 `store/README.md` 与现状一致（T11 后 4 域独立，session/workspace 未拆，符合路线）。

**结论**：未见「新的重复状态源」。cacheEventsStore 与 settingsStore.tokenUsage、usageStore（localStorage）职责正交：事件累计 vs 遥测权威 vs 历史桶。唯一需留意：`RuntimePanel` 整表订阅 `useCacheEventsStore()`（无 selector，见 §6 P2-4）。

---

## 2. 我们域（缓存优化）健康度 —— 深挖

### 2.1 消息级缓存指标链路（T-47/T-48/R6-D5）——**接线完整，全绿**

数据链：`message-end` → `eventParser` 宽容归一 → `dispatch.onMessageEnd` → `messageHandlers.ts:148` 调 `computeCacheMetricsFromUsage(msg.metadata)` → `attachCacheMetricsToStoreMessage`（messageHandlers.ts:24-54，**经 sessions[] 写入**，绕开 autoIndex 覆盖陷阱）→ `SessionMessage.cacheMetrics` → `CacheMetricsBadge`（ChatAssistantMessageRow.tsx:231）。

- `cacheMetricsCompute.ts`（112 行）为无环依赖纯函数：breakdown 优先 → usage 派生 → Included 兜底（T-45 75% 口径）；C15 null 语义全链路一致（null = 隐藏而非 0%）。
- 持久化回放：`sessionRustDb.ts` 写入面 `messageUsageToJson`（182-199，inputTotal → promptTokens 权威映射）、回读面 `cacheStateFromUsageJson`（263-316）、localStorage 回退路径（438-466）；测试 `sessionRustDbCacheReplay.test.tsx`（415 行，写入/回读/端到端/LS 四面）。**usage_json 列 v5 迁移已确认在 Rust 侧存在**（测试头注释核对结论）。
- 徽标回放末端测试直连 `CacheMetricsBadge`（sessionRustDbCacheReplay.test.tsx:424-449）——徽标消费回放派生 metrics 已被测试锁定。

### 2.2 会话级缓存面板链路（P5 S3/S7，T-48）——**接线完整**

`cache-stats-updated` / `cache-waste-alert` / `cold-cache-warning` 三事件：
- eventParser 已注册（缓存测量域事件归一）→ `dispatch.ts:107-109` 注册真实 handler → `cacheEventHandlers.ts`（runId 信封注入解析）→ `cacheEventsStore.ts`（跨 run 累计 `accumulateRunStats` + 预警 3 条去重 + 冷缓存每 run 一次 `tickColdCheck`）。
- 组件末端：`RuntimePanel.tsx:53,147-151` 订阅 store 并渲染 `SessionCacheStatsPanel`（stats/alerts/coldHint 三通道）；冷缓存 tick（RuntimePanel.tsx:62-69，1s 间隔）。
- 测试：`cacheEventsStore.test.ts`（10）、`SessionCacheStatsPanel.test.tsx`（重建于 3eb3a417，编码事故后）、`CacheMetricsBadge.test.tsx`（同）。快层实测全绿。

### 2.3 四指标定价（pricingStore.ts v4，125 键消费）——**实现完整，但两处未接线**

- 目录表 `CATALOG_CACHE_RATES`：**123 个键**（任务书「125 键」口径差异：123 条目 + 双币种/别名折抵），御十家全量绝对四价，数据源注释指向 `docs/cache-optimization/10-model-catalog-v2/04-master-model-list.md`。
- 回退链 `resolve4dPrices`（1398-1462）：运行时快照 → 目录绝对价 → 用户扩展字段 → 全局乘数；TTL 1h 档（Anthropic）；币种不折算（CNY 返回人民币金额，函数名 Usd 为遗留）。
- 消费面：`useStreamCallbacks.ts`（run 收尾 4D 估算 `estimateCostUsd4d`/`estimateSavingsUsd`，4D/2D 选择器 `pickUsageCostEstimators` 纯函数）+ `SettingsUsageTab`（用户价表 2D 编辑）+ `useRuntimePanelData`/`OverviewCard`（2D 估算）。
- **问题**：
  - **catalog_get 未接线**：`commandManifest.ts:151` 已登记 `catalog_get`，但**全前端无任何生产调用**；`applyCatalogCacheSnapshot` 仅被测试引用。运行时快照回退链第 1 级实际不可达（快照永远为 null）→ 定价恒走静态表/用户价表。
  - **saveCachePriceOpts / saveCacheTtlMode 无生产消费**：乘数与 TTL 档的持久化函数只有测试覆盖，UI 无入口（SettingsUsageTab 仅 2D 编辑，无 4D 扩展字段/乘数/TTL 编辑）。

### 2.4 S1 tool-update 后（cacheMetricsCompute/messageHandlers 消费）

- `tool-update` 在 eventParser.ts:486-495 注册（宽容归一 `ToolProgressUpdate`），dispatch 表 `onToolUpdate`（toolHandlers.ts:25-30）为**显式空实现**（tool-update 暂无 UI 落地）。与任务书「S1 tool-update 后」的预期一致：缓存指标不依赖 tool-update，走 message-end metadata。
- `dispatch.test.ts`（3）存在，缓存三事件 + tool-update 全键覆盖无回归。

### 2.5 与并行 UI 改动的交叉影响 —— **无破坏**

- **knip 897f8389**（2026-08-08 17:33）：改动集中在 agent-workbench shared 域（26 unused exports + 5 duplicate exports）；crish-desktop 侧仅 `skillsApi.ts`（tryInvokeTauri → invokeCmd 别名）、`OverviewQuickActions`/`OverviewStats`（删 import）、`DevHealthOverlay`（删 2 行）。**未触及缓存域任何文件**。
- **P2-7 UI 修复 01ef652b**（15:07）：Dialog/Menu/Tooltip/Input/Select/FileTreeView 等 26 文件；缓存组件（CacheMetricsBadge/SessionCacheStatsPanel/RuntimePanel）不在改动列表。
- **3eb3a417 closure**：CacheMetricsBadge/SessionCacheStatsPanel 测试在编码事故后重建，当前快层全绿。
- 工作区未提交 diff 中 `pricingStore.ts` 仅 1 行（`resolveCatalogEntry` 去掉 export，knip 收敛中）——无功能影响。

---

## 3. 状态管理现状

| Store | 职责 | 状态 |
|---|---|---|
| layoutStore（god） | sessions/messages/agents/chrome/legacy workspace | 正常；T11 未拆 session/workspace（路线内） |
| terminalStore / workerStore / permissionStore / settingsStore | 终端缓冲 / worker 生命周期 / 权限三态 / 设置+遥测 | 正常，独立实例 |
| workspaceShellStore / layoutTreeStore | TabSurface+dock / 二叉树几何 | 正常 sibling |
| streamingStore | per-token 流缓冲（不动 sessionStore 消息数组） | 正常 |
| layoutAnimationStore | 拖拽/缩放动画相位 | 正常 |
| cacheEventsStore（api 层） | 缓存三事件跨 run 累计 | 正常（§2.2） |
| securityAuditStore / flowDagStore | 安全审计 / 编排图 | 正常 |
| rustCoreStore | DEAD（§4） | 待删 |

**重复状态源检查**：无。cacheEventsStore 的 runStats 与 settingsStore.tokenUsage/usageStore 语义正交（事件累计 vs 遥测权威 vs 历史桶），不构成双写冲突。

---

## 4. 死代码 / 未接线面

| 面 | 位置 | 判定 |
|---|---|---|
| `useRustCoreStore` | rustCoreStore.ts:47 + store/index.ts:174 导出 | **DEAD 确认**：全仓 0 消费点（仅定义+导出），A2 P2-6 标注属实；R7 按 fetchLatestModels 模式复核删除 |
| `fetchLatestModels` | clientApi.ts:822 | DEAD formal（HONEST-HIDE 返回 []），已标注 |
| `getProviders` / `updateProviderKey` / `updateProviderModels` | clientApi.ts:800-819 | DEAD formal，同批 |
| cron/mcp 域 clientApi stub | clientApi.ts:828-853 | 显式不可用（T03.7），已标注 @removeWhen |
| `applyCatalogCacheSnapshot` | pricingStore.ts:1220 | **未接线（新增发现）**：0 生产调用，catalog_get 快照链第 1 级不可达（§2.3） |
| `saveCachePriceOpts` / `saveCacheTtlMode` | pricingStore.ts:1553/1595 | 未接线（仅测试），无 UI 入口 |
| `store-initializers` | store/layout-helpers/ | **非死代码**：仍被 layoutStore/settingsStore/workerStore/layout-core-actions 消费 |
| `markdownRenderAsync` | api/markdownRenderAsync.ts | **非死代码**：AsyncMarkdownBlock/FilePreview/chat-stream helpers 引用 |
| `streamState.ts` | chat-bridge/handlers/streamState.ts | 半死代码：`cleanupStreamState` + `StreamState` 仍在用，但 **7 个 unused imports**（StreamCallbacks/formatRunFailureForUi/recordStreamDiag/assistantBubbleForFailure/classifySoftFailure/logInternalError/softFailureMessage），eslint 全量报错源头之一 |

---

## 5. 前端健康（实测）

### 5.1 typecheck —— **全绿 EXIT=0**

`npm run typecheck`（crish-desktop app+node / agent-workbench / shared-types / shared-utils 五 project）无错误输出。

### 5.2 vitest —— **快层 355 文件 5341 用例全绿；全量（含 integration + native-smoke）368 文件 5383 用例全绿**

实测两次：`--project=unit` 355/5341 全绿；`npx vitest run` 全量 368/5383 全绿（含 integration 四目录 + L3 进程冒烟 2/2）。

**任务书提及的「~8 个失败（snapshots/visual/markdownRenderAsync 等）」逐一归因：不存在（已全绿）**：
- `markdownRenderAsync.test.ts`（10 tests）——通过
- `MessageSnapshots.test.ts`（14 tests）——通过
- `tests/snapshots/`（AppErrorBoundary/ChatToolCallBlock/ToastStack 3 文件 + .snap）——通过
- `TiptapVisualRedline.test.ts`（13 tests）——通过
- 其余 visual/键盘面（Menu.position 13、Tooltip 8、SessionCacheStatsPanel、CacheMetricsBadge）——全部通过

即：任务书描述的失败集在当前 HEAD 上已被 3eb3a417（closure 批量修复）/01ef652b（P2-7）等批次清零，**快层+中层全绿状态与 AGENTS.md「R3 实测 37/37 + 77/77 全绿」一致**。

### 5.3 reference/markdown-editor 门禁 —— **⚠ 偶发 12/20 文件失败（需关注，非稳定复现）**

首次运行 `npm test`（vitest 4.1.10 + vite 8.2.1 + @vitejs/plugin-react 6.0.5，独立 node_modules）时 **12/20 测试文件失败**：全部因 `src/core/EditorStore.ts` transform 报 `[PARSE_ERROR] Expected a semicolon...`（vite:oxc 插件 405:15）。随后连续 **13+ 次全量重跑全绿**（22 文件 / 119 用例），单文件跑、--maxWorkers=1、清 .vite 缓存均无法复现。

排查结论：
- `tsc --noEmit` 通过；`transformWithOxc` 直调（各种 option 组合）通过；`createVitest().vite.environments.ssr.transformRequest` 通过。
- 复现线索：plugin-react 的 `jsxRefreshInclude` 默认 `/\.[tj]sx?$/` 命中 .ts 文件；vite 8.2.1 `getModifiedOxcTransformOptions`（node.js:4135-4140）在 refresh 开启 + `lang="js"` 时强制以 JS 模式解析 TS 文件 → PARSE_ERROR。直接复现 `{lang:'js'}` 可得到同类错误（Expected `,` or `}`）。
- **判定**：工具链（vitest4/vite8/plugin-react6 组合）的间歇性 transform 竞态，非源码语法问题；但首跑曾红是事实，**建议在门禁处观察/固定 workers 数量**（P2-6）。
- 该目录 src 处于 37153189 并行批次大幅重写后（+1596/-539），src 与 tests 均已入库（137/83 文件跟踪，符合 AGENTS.md 铁律）。

### 5.4 eslint —— **22 problems（19 errors + 3 warnings）基线**

`npx eslint apps/crish-desktop/src` 实测：19 errors + 3 warnings。主要归属：
- `streamState.ts` 7 个 unused imports（§4）
- `store/types.ts` 3 个 unused type（CronTargetSession/CronJobStatus/SessionMessageInput）
- 测试文件 unused（MessageVirtualizer.memo.test.tsx fireEvent/act、useSkillsSettingsState.test.tsx React、BgTaskActions.test.tsx sendStub、composerTypes.ts React）
- `usePreviewNavigation.ts` HIST_PANEL_ID unused
- 3 warnings：TiptapEditorField useMemo deps、TiptapSlashMenu any、AgentTeamBoard react-refresh

---

## 6. 问题清单

### P0（门禁破坏/数据错误）—— 无

当前快层/中层/typecheck 全绿，无 P0。

### P1（功能面缺失/未接线，影响产品承诺）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| P1-1 | **catalog_get 运行时快照未接线**：四价回退链第 1 级不可达，前端恒用静态表/用户价表；catalog_get 已登记命令但 0 调用 | commandManifest.ts:151；pricingStore.ts:1220 `applyCatalogCacheSnapshot` 0 生产引用 | 在会话激活/设置页初始化处调用 catalog_get → applyCatalogCacheSnapshot |
| P1-2 | **乘数/TTL 档 UI 缺失**：saveCachePriceOpts/saveCacheTtlMode 无 UI 入口，用户无法编辑缓存费率偏好 | pricingStore.ts:1553/1595 仅测试引用；SettingsUsageTab 仅 2D 输入/输出编辑 | 设置·用量页补 4D 扩展字段/乘数/TTL 编辑（或确认产品层有意延后） |

### P2（代码卫生/基线）

| # | 问题 | 证据 |
|---|---|---|
| P2-1 | `useRustCoreStore` DEAD（0 调用点）仍在 barrel 导出，R7 删除计划挂起 | rustCoreStore.ts:47、store/index.ts:174 |
| P2-2 | `streamState.ts` 7 个 unused imports（eslint 最大单文件错误源） | streamState.ts:1-9 |
| P2-3 | `store/types.ts` 3 个 unused type；`usePreviewNavigation.ts` HIST_PANEL_ID unused | store/types.ts:126/129/417 |
| P2-4 | RuntimePanel 整表订阅 `useCacheEventsStore()`（无 selector），任何 store 变更触发整个面板重渲染 | RuntimePanel.tsx:53 |
| P2-5 | 工作区 67 个未提交文件（api 层大批 knip/收敛中：mcpClient.ts 删除、rustCore.ts -65 等）——并行开发进行中，非问题但需提交收口 | `git status --short` |
| P2-6 | reference/markdown-editor 门禁首跑曾 12/20 红（偶发 transform 竞态，13+ 次重跑全绿）——建议固定 workers 或记录为已知 flake | §5.3 |
| P2-7 | eslint 19 errors + 3 warnings 基线（d82f7468 曾声明 eslint 251→0，现已回潮） | §5.4 |
| P2-8 | clientApi DEAD formal 四函数 + cron/mcp stub 五函数待按 @removeWhen 清理 | clientApi.ts:800-853 |

---

## 7. 最值得关注 5 项

1. **catalog_get 快照链未接线（P1-1）**：运行时目录快照是四价回退链第 1 级，前端 0 调用导致静态表成为事实最高优先级——「服务端价格更新不能反映到前端」的架构断层，应最先补接线。
2. **乘数/TTL 设置 UI 缺失（P1-2）**：pricingStore 已具备完整持久化能力（saveCachePriceOpts/saveCacheTtlMode），但设置页只有 2D 价编辑，用户无法配置缓存费率偏好。
3. **缓存前端面整体健康**：消息级指标（T-47/T-48/R6-D5）与会话级面板（P5 S3/S7）接线完整、快层全绿、回放链有端到端测试——这是四路并行开发中少有的「无回归」域，可作为并行协作参照。
4. **eslint 回潮（P2-7）**：d82f7468 声称 251→0，当前 19 errors + 3 warnings；其中 streamState.ts 7 个 unused 集中在缓存域代码上，说明 knip/eslint 收敛的自动化门禁（如果存在）未在 CI 强制执行。
5. **reference/markdown-editor 偶发 12/20 红（P2-6）**：首跑红一次后 13+ 次全绿，根因指向 vitest4/vite8/plugin-react6 的 oxc lang="js" 竞态；该目录是用户测试资产（AGENTS.md 铁律），需在门禁侧固定 workers 防 CI 偶发。

---

## 附：验证命令与结果

```bash
npm run typecheck                      # EXIT=0，五 project 全绿
npx vitest run --project=unit          # 355 files / 5341 tests passed
npx vitest run                         # 368 files / 5383 tests passed（含 integration + native-smoke 2/2）
npx eslint apps/crish-desktop/src      # 22 problems（19 errors + 3 warnings）
# reference/markdown-editor
npm test                               # 首跑 12/20 FAIL（EditorStore.ts transform）→ 后续 13+ 次全绿 22/22
git show 897f8389 --stat               # knip：agent-workbench 26 unused + 5 duplicate；crish-desktop 4 文件轻触
git show 01ef652b --stat               # P2-7 UI：26 文件，未触缓存域
```
