# DEEPCHECK-02：前端消费域深查（缓存方案前端面）

- 日期：2026-08-09
- 角色：前端消费域深查子代理 D2（只读分析）
- 范围：缓存方案前端面（四指标定价 / 徽标面板 / 事件消费 / 回放）的 8 项疑点逐项核验
- 方法：读代码（生产调用点 / 测试 / manifest / 配置）+ 实跑 e2e（cache-metrics + cache-telemetry，9/9 绿）
- 前置基线：`docs/feature-gap-analysis/audits/CODEBASE-02-frontend.md`（此前审计结论：catalog_get 未接线、TTL/乘数无 UI）

## 结论总览

| 编号 | 疑点 | 结论 | 严重度 |
|---|---|---|---|
| 1 | catalog_get 快照链未接线 | **成立**（快照恒 null，回退链第 1 级不可达） | 🔴 高 |
| 2 | 缓存配置 UI 缺失（TTL 5m/1h 切换、乘数编辑） | **成立**（函数存在、0 生产消费、0 UI 入口） | 🟡 中 |
| 3 | 预警 UI 真实渲染（cold-cache-hint / cache-waste-alerts） | **不成立**（链路完整 + 测试钉死 + e2e 实测 9/9 绿） | — |
| 4 | run 级成本展示（T-40 run_usage + T-47 透出） | **部分**（数据面/估算面完整，UI 为模型级汇总，无 run 级明细） | 🟡 低 |
| 5 | Pcr/Pcw 回退链顺序与 null 语义 | **部分**（顺序正确；1h 档逻辑活着但无切换入口，恒 5m） | 🟡 低 |
| 6 | 消息级徽标回放链路 | **不成立**（实时 + 回放链路完整、测试端到端覆盖；无截图级验证） | — |
| 7 | 多模型模式 / 子 agent 模型选择（REQ-D03） | **不成立**（用户已裁决不做，仅扩展点预留且已落地） | — |
| 8 | e2e 缓存 spec 稳定性 | **不成立**（实测 9/9 全绿；端口复用风险有限、有配置兜底） | — |

成立 2 项、部分 2 项、不成立 4 项。最严重：**疑点 1（catalog_get 运行时快照断链）**——Rust 目录真源与前端定价完全脱钩。

## 逐项证据

### 1. catalog_get 快照链未接线 —— 成立 🔴

**Rust 侧实现完备**（`apps/agent-workbench/src-tauri/src/catalog_commands.rs`）：
- `catalog_get`（:43-50）：返回版本号 + 全量条目（camelCase wire），`ModelCatalog::bundled()` 初始化（main.rs setup）；
- `catalog_refresh`（:58-71）：合并前端扫描结果，仅窗口/能力位、**不覆盖价格**，变更版本号 +1；
- 单测 2 个（:78-108）：快照携带版本号与内置条目（deepseek-v4-flash input 0.14）、合并后版本号反映变更。

**前端侧只有"登记 + 消费函数"，无生产调用**：
- `commandManifest.ts:151` 登记 `catalog_get`（仅 manifest 白名单，无调用）；
- `pricingStore.ts:1220` `applyCatalogCacheSnapshot` 实现完整（版本号失效语义 :1227），**生产引用 = 0**（仅 `pricingStore.test.ts:474` 测试引用）；
- 全前端 `invoke` 调用面核验：`daemonClient.ts` 仅 run_task/cancel/approve/deny 四个命令；`tauriInvoke.ts` 为通用封装；**无任何 `invoke('catalog_get')`**；
- `modelCatalog.ts:840` 的 `catalog_refresh` 调用（`scanProviderModels`）**同样无生产调用点**（唯一引用在 `useModelProfilesState.test.tsx:32` 的 mock 里）。

**影响**：`catalogSnapshot` 恒为 null → `resolve4dPrices`（pricingStore.ts:1401-1418）永远取不到 `source='snapshot'`，定价恒走 静态表/用户价表/乘数。Rust 目录真源（未来动态价、扫描合并结果）**无法传导到前端**；两端存在双份价格数据且无同步机制。与 CODEBASE-02 §2.3（P1-1）结论一致，**至今未修复**。

**修复方向**：会话激活/应用启动时一次性 `invoke('catalog_get')` → `applyCatalogCacheSnapshot`（版本号幂等，天然安全）；`scanProviderModels` 的 UI 触发点补接（模型配置页保存时上送）。

### 2. 缓存配置 UI 缺失 —— 成立 🟡

- `saveCacheTtlMode`（pricingStore.ts:1595）、`loadCacheTtlMode`（:1581）、`saveCachePriceOpts`（:1553）全仓库 grep：**仅 pricingStore.ts 本体与测试引用，0 个生产 tsx/ts 调用**；
- 设置页核验：`SettingsUsageTab.tsx` 仅有 2D 价格编辑（`pricingModal` :209，价格表 input/output 编辑）+ T-48 模型级缓存只读列（:455-487）；无 TTL 切换、无乘数编辑；
- 影响：Anthropic 写价恒走 5m 档（1h 档不可达，见疑点 5）；缓存费率偏好不可配置。用户层功能缺口（产品层是否"有意延后"需确认）。

**修复方向**：设置·用量页补 TTL 档切换（5m/1h）与乘数编辑入口；或显式文档化"延后"决策。

### 3. 预警 UI 真实渲染 —— 不成立（链路完整、已钉死、已实测）

- **渲染路径**：`dispatch.ts:107-109` 注册三事件 → `cacheEventHandlers.ts`（onCacheStatsUpdated / onCacheWasteAlert / onColdCacheWarning，runId 信封兜底）→ `cacheEventsStore.ts`（累计 runStats + 预警去重保留 3 条 + 冷缓存每 run 一次）→ `RuntimePanel.tsx:53` `useCacheEventsStore()` + 1s 冷缓存 tick（:62-69）→ `SessionCacheStatsPanel.tsx`（`cold-cache-hint` :64、`cache-waste-alerts` :70）。
- **测试钉死**：`SessionCacheStatsPanel.test.tsx`（cold-cache-hint 含 '1,200'、cache-waste-alerts 含 '500'）、`cacheEventsStore.test.ts`（累计/去重/tick 语义）。
- **e2e 实测**：本次实跑 `cache-metrics.spec.ts`（4 用例）+ `cache-telemetry.spec.ts`（5 用例）＝ **9/9 全绿（22.0s）**，含：浪费审计归因（用例② zero-read + $0.0312、用例⑤ model-switch）、冷缓存预警（用例③：tick 触发 + 每 run 一次断言 + 2.5s 不复现观察）。

### 4. run 级成本展示 —— 部分 🟡

- **Rust 真实实现**：T-40 `CoreRunState::run_usage`（`core_run_commands.rs:1564-1589`，get_run_usage 读 runs 表 v5 列 + save_run_usage 落库 :2630，测试 :5180-5202）；T-47 透出 cache 字段（`core_query_commands.rs:343-388` run_usage_from_cache_stats，测试 :924-969，camelCase wire）。
- **前端消费**：`fetchRunSnapshotUsage`（sessionEventHydrate.ts:495）→ `useStreamCallbacks.ts:800` 真实调用：`pickUsageCostEstimators`（T-47 4D 消费 :808-819）→ `accumulateTokenUsage` → `tokenUsage.cacheRead/cacheWrite/savedCost`。
- **UI 展示**：`SettingsUsageTab.tsx:455-487` 模型使用分布新增缓存列（命中率 C9 口径 / 读 tokens / 省 savedCost，`model-cache-meta-<model>` testid）；`RuntimePanel.tsx:121-142` 用量区段仍只有 输入/输出/费用。
- **缺口**：无 **run 级** 逐条列表/明细（只有模型级汇总 + 面板级累计）；RuntimePanel 用量区段未展示缓存行。
- 结论：数据面与估算面完整，展示面为"模型级汇总"——算部分成立。

### 5. Pcr/Pcw 回退链正确性 —— 部分（顺序正确，1h 档无切换入口）🟡

**回退链代码核验**（`resolve4dPrices`，pricingStore.ts:1398-1462）：
- 输入/输出价：用户价表 `hit` → 目录 `entry` → null（不估算）——无乘数兜底（合理，任务书裁决）；
- 缓存读价：快照 `snap`（source='snapshot'）→ 目录 `entry.cacheReadPerMTok`（catalog）→ 用户 `hit.cacheReadPerMTok`（user）→ `inputPerMTok × cacheReadMultiplier`（multiplier，source 默认值 :1411）；
- 缓存写价：快照 → 目录（`cacheWriteFree→0`、`ttlMode==='1h'` 时用 `cacheWritePerMTok1h`，:1438-1443）→ 用户 → 乘数；
- **null 语义**：`resolve4dPrices` 返回 null → `estimateCostUsd4d` 返回 0（不估算，:1486）；`resolveCatalogCachePrices`（:1243-1259）取不到 → null 回退下级。
- 顺序与 null 语义**均正确**（与任务书 §3 一致；source 以写价来源为准的注释语义 :1428 吻合实现）。
- **1h 档消费方**：`loadCacheTtlMode` 被 `resolve4dPrices:1409` 消费（估算链活着，`estimateCostUsd4d` 有生产消费方 = useStreamCallbacks.ts:796-819）；但 `saveCacheTtlMode` 0 生产调用 → **恒 5m，1h 档代码路径不可达**（测试 :456-466 仅测试内切换）。
- 结论：链本身正确；缺口即疑点 2 的 UI 入口。

### 6. 消息级徽标回放链路 —— 不成立（链路完整）

- **实时链路**：`message-end` → `messageHandlers.ts:148-152`（computeCacheMetricsFromUsage → attachCacheMetricsToStoreMessage 挂 `SessionMessage.cacheMetrics`）→ `ChatAssistantMessageRow.tsx:231` `<CacheMetricsBadge metrics={msg.cacheMetrics?.metrics ?? null}>`（badge 本身 :24-37，null → 隐藏）。
- **回放链路（A3 修复后）**：`sessionRustDb.ts:313-316`（usage_json 回读 → `cacheStateFromUsageJson` 派生 cacheMetrics，守卫白名单不携带该字段）；localStorage 回退路径 :438-466 保留整条 JSON。
- **测试**：`sessionRustDbCacheReplay.test.tsx` 端到端用例（persist → 假库落盘 → hydrateSessionsFromRust 完整回放出 cacheMetrics → badge 数据源，:266-328；含 sanitizeMessagesForHydrate 不丢字段 :300、坏形状不挂载 :390）；`messageHandlers.cache.test.ts`（message-end 挂载 + null 语义）。
- **截图级验证**：无视觉回归基建（`tests/visual` 目录不存在，`apps/crish-desktop/playwright.config.ts` 引用的 testDir 未就位）；e2e 文本断言充分（badge 75%/9,000/未命中态），截图级为增强项非缺陷。

### 7. 多模型模式 / 子 agent 模型选择 —— 不成立（用户已裁决不做）

- **REQ-D03 继承语义**：天然满足（全局单例配置，`config/provider.rs` 解析链）。
- **多模型模式**：已决策**不做**——`docs/feature-gap-analysis/plans/00-总方案与轮次编排.md:702`（T-D-10）、`03-D多Agent调度方案.md:689-691`（不实现开关、不做 per-run 覆盖、不暴露 UI）；仅预留 `SubagentSpawnRequest.model_override: Option<String>` 扩展点。
- **扩展点已落地**：`agent-tools/src/tools/subagent.rs:331`（定义字段）、:705（请求字段），全构造点显式 None + 编译器强制断言测试（:1701-1702、:1939、:2772）；`conex-db` 明确不落库（schema.rs:120、agents.rs:34）。
- 结论：非缺陷；若未来产品意愿变化，仅需在预留字段上加逻辑，不改形状。

### 8. e2e 缓存 spec 稳定性 —— 不成立（实测全绿）

- **本次实测**（根 `playwright.config.ts`，workers=4）：cache-metrics 4/4 + cache-telemetry 5/5 = **9/9 绿（22.0s）**，无 flaky 信号。
- **端口分配**：crish dev server → **5174**（webServer :61，自动拉起 + `reuseExistingServer: true`，180s 就绪双保险）；markdown-editor → **5173**（:71，仅供 5 个 markdown-editor 专项 spec）。缓存两 spec 走 5174 + mock-engine 注入，**与 5173 无耦合**。
- **端口复用风险**：`reuseExistingServer: true` 下若本地已有陈旧 dev server 占用 5174/5173，会复用到旧代码（连接非预期实例）；固定端口在多 Playwright 实例并发时互抢。CI 单实例无碍，本地需保证端口干净。
- 影响：低；已有配置级兜底（url 健康检查 + 180s 余量），实测稳定。

## 修复优先级建议

| 优先级 | 事项 | 工作量 | 说明 |
|---|---|---|---|
| P0 | catalog_get 快照链接线（疑点 1） | 小 | 启动/会话激活拉取一次快照；CODEBASE-02 P1-1 遗留至今 |
| P1 | TTL 档 / 乘数 UI 入口（疑点 2、5） | 中 | 或显式确认产品层"延后"决策 |
| P2 | run 级明细展示（疑点 4） | 中 | 数据面已齐，纯 UI 增强 |
| — | 预警/徽标/回放/多模型（疑点 3、6、7） | 0 | 链路完整，无需动作（多模型为已裁决范围） |
