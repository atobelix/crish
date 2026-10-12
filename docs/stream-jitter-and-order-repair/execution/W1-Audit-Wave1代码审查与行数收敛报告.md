# Wave 1 代码审查、瘦身收敛与交付归档报告（Task W1-Audit）

> **战役名称**：`stream-jitter-and-order-repair`  
> **执行波次**：Wave 1 收尾审查与行数收敛（Task W1-Audit）  
> **审查范围**：W1-A（`sessionEventTimestamp.ts` / `sessionEventProjection.ts`）、W1-B（`messageOrderKey.ts` / `types.ts`）、W1-E（`sessionEviction.ts` / `sessionEvictionProbes.ts` / `sessionEviction.test.ts`）  
> **基准裁决**：`docs/stream-jitter-and-order-repair/plan-reviews/00-主控最终决断书.md`（裁决 1、裁决 2、裁决 6）与 `docs/stream-jitter-and-order-repair/01-规范-执行波通用.md`

---

## 一、完成度总结

| 检查与交付项                                                       | 状态      | 结论摘要                                                                                                                                        |
| :----------------------------------------------------------------- | :-------- | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. W1-A / W1-B / W1-E 决断书合规性审查**                         | ✅ 已完成 | 100% 符合主控决断书裁决 1（四级因果全序）、裁决 2（水合单轨与状态保活协同）、裁决 6（物理硬删除与外置拆分）                                     |
| **2. `sessionEviction.ts` 与 `sessionEvictionProbes.ts` 瘦身收敛** | ✅ 已完成 | 消除跨文件重复定义并精简冗余分支；`sessionEviction.ts` 有效行 **380 → 214**，`sessionEvictionProbes.ts` 有效行 **367 → 222**（均 $\le 330$ 行） |
| **3. `check-line-counts.mjs` 门禁验证**                            | ✅ 已完成 | 扫描 5 个目标文件：**0 Warnings, 0 Violations, 0 Hard blocks**                                                                                  |
| **4. Vitest 单元测试回归验证**                                     | ✅ 已完成 | 3 个测试套件共 **46 条测试用例 100% PASS**                                                                                                      |
| **5. Wave 1 交付归档报告落盘**                                     | ✅ 已完成 | 归档至 `docs/stream-jitter-and-order-repair/execution/W1-Audit-Wave1代码审查与行数收敛报告.md`                                                  |

---

## 二、主控最终决断书逐项合规性审查（W1-A / W1-B / W1-E）

### 2.1 W1-A 审查：事件时间戳与投影外置（`sessionEventTimestamp.ts` & `sessionEventProjection.ts`）

1. **符合裁决 1（权威时间戳源与拒绝盲目 `Date.now()`）**：
   - `apps/crish-desktop/src/api/sessionEventTimestamp.ts:59-133` 实现 `extractMessageTimestamp(inner, eventType, outerEv)`，严格按三级优先级提取：`inner.message.createdAt`（兼容 `created_at` / `message.timestamp`）$\to$ `inner.timestamp` $\to$ 外层信封 `outerEv.timestamp`。
   - `apps/crish-desktop/src/api/sessionEventTimestamp.ts:45-47, 129-132` 落地 `isHistoricalTerminalEventType` 守卫：当事件为历史终态事件（`message-end` / `message-start`）且无任何合法时间戳时，强制返回 `0`，**绝不回退 `Date.now()` 污染历史时序**；仅实时非终态事件（如 `message-delta` / `tool-start`）缺省时回退 `Date.now()`。
   - `apps/crish-desktop/src/api/sessionEventTimestamp.ts:145-193` 实现 `extractEngineSequence`，从外层信封、`payload.event` 或内层事件提取单调递增真实 `sequence`，并通过 `applyProjectedOrderMeta`（`sessionEventTimestamp.ts:235-246`）写入 `SessionMessage.engineSequence`。
   - **反退避与反过度设计核查**：全文件零 `syntheticSequence = 1000000 + eventIndex` 魔术序列号；零虚构 `message-create` 分支（仅处理真实引擎事件 `message-end`、`message-delta`、`tool-start`、`tool-end` 及 `message-start` 判别）。
2. **符合裁决 6（外置拆分与 350 行基线硬门禁）**：
   - 时间戳、序列号、信封解包与稳定 ID 辅助逻辑已完整拆离至 `apps/crish-desktop/src/api/sessionEventTimestamp.ts`（有效行 **211 行**）。
   - 主文件 `apps/crish-desktop/src/api/sessionEventProjection.ts` 有效代码行数从原 348 行压降至 **295 行**（满足 $\le 320$ 行目标，远离 350 行基线硬门禁）。

### 2.2 W1-B 审查：四级因果全序比较器（`messageOrderKey.ts` & `store/types.ts`）

1. **符合裁决 1（四级严格弱序公理与角色因果权重）**：
   - `apps/crish-desktop/src/store/messageOrderKey.ts:20-25` 扩展 `MessageOrderKey` 为 `{ seq?: number | undefined; ts: number; roleRank: number; id: string }`。
   - `apps/crish-desktop/src/store/messageOrderKey.ts:40-54` 实现 `getRoleRank` / `resolveRoleRank`，严格映射 `system=0, user=1, assistant=2, other=3`。
   - `apps/crish-desktop/src/store/messageOrderKey.ts:157-189` 实现 `compareMessageOrder`，严格执行四级全序决胜：
     $$\text{seq (缺省 MAX\_SAFE\_INTEGER)} \;\to\; \text{ts} \;\to\; \text{roleRank (0 < 1 < 2 < 3)} \;\to\; \text{compareNaturalNumericId(id)}$$
   - `apps/crish-desktop/src/store/messageOrderKey.ts:61-119` 实现 `compareNaturalNumericId`，保证 `'hyd-user-2' < 'hyd-user-10'` 自然数值升序，并在前导零等长差异时回退原始码元序以维持严格全序反对称性。
   - `apps/crish-desktop/src/store/types.ts:539-540` 在 `SessionMessage` 接口中正式补齐 `engineSequence?: number | undefined;` 类型声明。
2. **符合裁决 6（行数与纯粹性）**：
   - `apps/crish-desktop/src/store/messageOrderKey.ts` 有效代码行数为 **156 行**（上限 400 行），零外部依赖。

### 2.3 W1-E 审查与精炼瘦身：标签栏感知软驱逐与会话保活（`sessionEviction.ts` & `sessionEvictionProbes.ts`）

1. **符合裁决 2 & Review 01 采纳项 1.3（标签感知三级保活状态机）**：
   - **级别 1（`PinnedActive`）**：当前活跃聚焦会话（`activeSessionId`）或处于流式推流态的会话（`isSessionStreaming` 综合探测 `isStreaming` 标记、`message.status`、`blocks.isStreaming`、`thinkingTurns.isStreaming`、`toolCalls` 运行态、`agents` 运行态及 `useStreamingStore` 热缓冲），**绝对禁止驱逐**（`sessionEviction.ts:50-71`）。
   - **级别 2（`OpenRetained`）**：通过 `LayoutTreeStore`（`ownedChatLeaves` + `listChatLeaves`）与 `WorkspaceShellStore`（`openTabs` / `openTabIds` / `tabs` / `getActiveTab`）联动收集所有分屏可见叶与后台打开标签页，高优先级保活，彻底防止分屏邻叶会话被误清空（`sessionEvictionProbes.ts:102-157`）。
   - **级别 3（`EvictableCandidate`）**：非聚焦、非打开标签、非推流的后台已水合历史会话，在超出 `keepBudget` 时按 LRU（`lastAccessedAt` $\to$ `hydrationMeta.lastHydratedAt` $\to$ `recordSessionAccess` $\to$ `updatedAt` $\to$ `timestamp` $\to$ 末条消息时间戳）从旧到新执行软驱逐（`sessionEviction.ts:144-169`）。
   - **二次刚性防线**：`applySoftEvictionInState`（`sessionEviction.ts:210-239`）在写状态前再次校验 `activeId`、`isSessionStreaming` 与 `openTabSessionIds`，即使外部误传活跃/流式/打开标签 ID 也绝不清空其消息正文。
2. **W1-Audit 瘦身收敛根因分析与改造（`sessionEviction.ts` & `sessionEvictionProbes.ts`）**：
   - **问题诊断**：前序实现虽然创建了 `sessionEvictionProbes.ts`，但未在 `sessionEviction.ts` 中改为导入复用，导致两文件各自维护了一份重复的类型声明、模块级 `sessionAccessTimestamps` Map 与探针函数，使有效行数分别达到 380 行与 367 行（双双触发 `> 340` 行预警）。
   - **收敛改造**：
     - 在 [`sessionEvictionProbes.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionEvictionProbes.ts#L1-L263) 中统一收敛全部软驱逐类型契约与运行态探针（导出 `addOpenTabsInputToSet` 复用器，合并 `getOpenTabSessionIds`、`getActiveStreamingSessionIds` 与 `resolveSessionLruTimestamp` 中的重复分支），有效代码行从 **367 行压降至 222 行**。
     - 在 [`sessionEviction.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionEviction.ts#L1-L240) 中物理删除重复定义的探针函数、重复类型与分裂的 `sessionAccessTimestamps` Map，统一从 `./sessionEvictionProbes` 导入并 re-export（确保单一真理源 SSOT 且对外 API 100% 兼容），有效代码行从 **380 行压降至 214 行**。

---

## 三、物理删除清册核对（负产出红线验证）

| 序号  | 物理删除目标                                                                                                                             | 所在文件                                                                                                     | 核对状态与代码证据                                                                                                                                                                                  |
| :---- | :--------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | 删除盲目回退 `Date.now()` 且忽略 `message.createdAt` 的旧 `eventTimestamp(inner)` 实现                                                   | `apps/crish-desktop/src/api/sessionEventProjection.ts`                                                       | ✅ **已彻底物理切除**：原 `function eventTimestamp(inner: AnyRec \| null): number` 已从 `sessionEventProjection.ts` 删除，替换为 `sessionEventTimestamp.ts:59-133` 的权威 `extractMessageTimestamp` |
| **2** | 从 `sessionEventProjection.ts` 迁出并删除内联辅助函数（`asRec`、`resolveProjectedMessageId`、`rekeyAssistantIfStable`、内联信封解包）    | `apps/crish-desktop/src/api/sessionEventProjection.ts`                                                       | ✅ **已彻底物理切除**：全部收口至 `apps/crish-desktop/src/api/sessionEventTimestamp.ts:20-283`，主文件净减至 295 有效行                                                                             |
| **3** | 删除旧三元组 `MessageOrderKey = { seq, ts, id }` 与裸字典序回退 `a.id.localeCompare(b.id)`                                               | `apps/crish-desktop/src/store/messageOrderKey.ts`                                                            | ✅ **已彻底物理切除**：全文件无 `localeCompare`，升级为 `{ seq, ts, roleRank, id }` 四级全序与 `compareNaturalNumericId`（`messageOrderKey.ts:157-189`）                                            |
| **4** | 删除 `sessionEviction.ts` 中与 `sessionEvictionProbes.ts` 重复的 230+ 行类型与探针实现，以及 `sessionEvictionProbes.ts` 内的冗余遍历分支 | `apps/crish-desktop/src/store/sessionEviction.ts`<br>`apps/crish-desktop/src/store/sessionEvictionProbes.ts` | ✅ **已彻底物理切除**：消除双份 `sessionAccessTimestamps` Map 与重复探针函数，两文件合计净削减 **311 行有效代码**                                                                                   |

---

## 四、代码修改清单（本次 W1-Audit 范围）

1. [`apps/crish-desktop/src/store/sessionEvictionProbes.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionEvictionProbes.ts#L16-L263)：
   - 导出通用集合归并辅助函数 `addOpenTabsInputToSet`（第 102–114 行），在 `getOpenTabSessionIds` 与 `getActiveStreamingSessionIds` 中统一复用，删除手工分类遍历 `owned.tabs` / `leaf.tabs` / `explicitStreamingIds` 的冗余模板代码；
   - 将 `resolveSessionLruTimestamp`（第 240–262 行）重构为候选时间戳优先级数组遍历，保持优先级（`lastAccessedAt` $\to$ `lastHydratedAt` $\to$ `sessionAccessTimestamps` $\to$ `updatedAt` $\to$ `timestamp` $\to$ 末条消息 `timestamp`）100% 不变；
   - 紧凑化接口与多行条件表达式，有效行数由 367 行降至 **222 行**。
2. [`apps/crish-desktop/src/store/sessionEviction.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionEviction.ts#L10-L83)：
   - 物理移除与 `sessionEvictionProbes.ts` 重复的接口定义与探针函数实现，改为从 `./sessionEvictionProbes` 统一导入并全量 re-export（第 13–49 行），修复双模块各自持有独立 `sessionAccessTimestamps` Map 的潜在分裂问题；
   - 保持 `classifySessionEvictionTier`、`evaluateSessionEviction`、`planSessionsToEvict`、`findInactiveHydratedSessionIdsToEvict`、`softEvictSessionToLazyShell`、`applySoftEvictionInState` 及所有重导出 API 签名 100% 不变，有效行数由 380 行降至 **214 行**。
3. [`docs/stream-jitter-and-order-repair/execution/W1-Audit-Wave1代码审查与行数收敛报告.md`](file:///c:/Software/conex/docs/stream-jitter-and-order-repair/execution/W1-Audit-Wave1代码审查与行数收敛报告.md)：
   - 新增 Wave 1（W1-A、W1-B、W1-E）代码审查、物理删除核对与行数收敛归档报告。

---

## 五、行数预算自检前后对比

运行门禁命令：

```powershell
node scripts/check-line-counts.mjs apps/crish-desktop/src/api/sessionEventProjection.ts apps/crish-desktop/src/api/sessionEventTimestamp.ts apps/crish-desktop/src/store/messageOrderKey.ts apps/crish-desktop/src/store/sessionEviction.ts apps/crish-desktop/src/store/sessionEvictionProbes.ts
```

| 文件路径                                                | 类别与预算上限                    | 收敛前有效行 | 收敛后有效行 | 目标阈值  |          门禁状态           |
| :------------------------------------------------------ | :-------------------------------- | :----------: | :----------: | :-------: | :-------------------------: |
| `apps/crish-desktop/src/api/sessionEventProjection.ts`  | Business Logic (≤ 400 / 基线 350) | 295 (原 348) |   **295**    |   ≤ 320   | 📦 PASS（已回落类别上限内） |
| `apps/crish-desktop/src/api/sessionEventTimestamp.ts`   | Business Logic (≤ 400)            |     211      |   **211**    |   ≤ 340   |      ✅ PASS (211/400)      |
| `apps/crish-desktop/src/store/messageOrderKey.ts`       | Business Logic (≤ 400)            |     156      |   **156**    |   ≤ 340   |      ✅ PASS (156/400)      |
| `apps/crish-desktop/src/store/sessionEviction.ts`       | Business Logic (≤ 400)            |    380 ⚠️    |   **214**    | **≤ 330** | ✅ PASS (214/400, -166 行)  |
| `apps/crish-desktop/src/store/sessionEvictionProbes.ts` | Business Logic (≤ 400)            |    367 ⚠️    |   **222**    | **≤ 330** | ✅ PASS (222/400, -145 行)  |

**门禁汇总输出**：

- `Scanned: 5 files | Warnings: 0 | Violations: 0 | Hard blocks: 0`

---

## 六、测试验证结果

运行单元测试验证命令：

```powershell
npx vitest run apps/crish-desktop/src/api/sessionEventProjection.test.ts apps/crish-desktop/src/store/messageOrderKey.test.ts apps/crish-desktop/src/store/sessionEviction.test.ts
```

**实测输出证据**：

- `✓ unit apps/crish-desktop/src/store/messageOrderKey.test.ts (25 tests) 22ms`
  - 覆盖四级全序 `seq -> ts -> roleRank -> naturalNumericId`、严格弱序三大代数公理（非自反、反对称、传递性）穷举、同毫秒碰撞 User 恒先于 Assistant 魔鬼用例、12 条全零时间戳乱序重排用例。
- `✓ unit apps/crish-desktop/src/api/sessionEventProjection.test.ts (10 tests) 16ms`
  - 覆盖 `inner.message.createdAt` 权威提取、历史终态事件无时间戳返回 `0`（严禁调用 `Date.now()`）、`extractEngineSequence` 多信封形态提取、多轮对话 `U1 -> A1 -> U2 -> A2` 投影与 `mergeMessagesById` 保序。
- `✓ unit apps/crish-desktop/src/store/sessionEviction.test.ts (11 tests) 18ms`
  - 覆盖三级保活分类（`PinnedActive` / `OpenRetained` / `EvictableCandidate`）、7 种流式信号全方位保活、左右分屏与后台标签页免驱逐、`EvictableCandidate` LRU 淘汰序及 `applySoftEvictionInState` 二次刚性防线。
- **总计**：`Test Files 3 passed (3) | Tests 46 passed (46)`。
