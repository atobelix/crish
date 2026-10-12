# Wave 1 - Task W1-D：会话水合单轨状态机与防死锁审计与交付报告

> **任务代号**：`W1-D`  
> **所属战役**：`stream-jitter-and-order-repair`（流式渲染卡顿跳动与时序重排系统性治理）  
> **责任角色**：会话水合与并发时序审计专家（Subagent W1-D）  
> **对齐基准**：
>
> - `docs/stream-jitter-and-order-repair/01-规范-执行波通用.md`
> - `docs/stream-jitter-and-order-repair/plan-reviews/00-主控最终决断书.md`（裁决 2【水合主路径单轨收敛】、Review 04 采纳项 4.1【重大死锁 C1 修复】、Review 03 采纳项 3.4【空会话卫语句】）
> - 根目录 `AGENTS.md`（反退避、立体验证、提交权归主控、pwsh7、UTF-8 无 BOM）  
>   **专属文件域**：
> - 核心审查文件：`apps/crish-desktop/src/store/sessionActivateHydrate.ts`
> - 测试验证文件：`apps/crish-desktop/src/store/sessionActivateHydrate.test.ts`
> - 交付报告文件：`docs/stream-jitter-and-order-repair/execution/W1-D-会话水合单轨状态机与防死锁报告.md`

---

## 一、完成度总览

| 检查与验收项                   |     状态     | 关键指标 / 结论证据                                                                                                                        |
| :----------------------------- | :----------: | :----------------------------------------------------------------------------------------------------------------------------------------- |
| **1. C1 令牌死锁消除核验**     | ✅ 100% 通过 | `inFlightHydrations.has(sessionId)` 命中时复用现有 Promise 返回，坚决杜绝自增 `token`；A -> B -> A 高频切换零死锁、零假死、零丢正文        |
| **2. 会话水合卫语句收敛核验**  | ✅ 100% 通过 | 严格落实 `messagesHydrated === true && (messages.length > 0                                                                                |     | hydratedFromEngine === true)` 提前退出，真实空会话单次水合即收敛，杜绝无限死循环拉取 |
| **3. 本地优先两级瀑布流水合**  | ✅ 100% 通过 | Phase 1 本地 SQLite 恢复非空消息原地落地并直接退出，彻底阻断远程引擎事件重放对本地因果序的冲刷；Phase 2 仅在本地为空时回退引擎并双置标志位 |
| **4. 单轨状态机架构收敛**      | ✅ 100% 通过 | 彻底清退历史双头调度器草案，唯一合法入口收口至 `sessionActivateHydrate.ts:triggerSessionMessageHydrateIfNeeded`，严格落实主控裁决 2        |
| **5. RL-03 行数预算门禁验证**  | ✅ 100% 通过 | 有效代码行 **149 行**（上限 400 行，预警线 340 行），行数预算占比仅 37.25%，零 Warning，零 Violation，零 Hard block                        |
| **6. Vitest 单元测试立体回归** | ✅ 100% 通过 | `sessionActivateHydrate.test.ts` 覆盖 9 项专项测试用例，**9/9 100% PASS**（耗时 206ms）                                                    |

---

## 二、问题背景与主控裁决落地

### 2.1 历史病灶剖析

在重构前与分维方案编制初期，会话水合机制存在三大结构性缺陷：

1. **双头调度器漂移**：Plan 09 曾构想新建独立的 `sessionHydrationCoordinator.ts`，与既有的 `sessionActivateHydrate.ts` 产生架构重叠，违背单一真理源（SSOT）原则。
2. **C1 令牌与飞行合并致命对抗（Deadlock Defect C1）**：在防并发与防竞态设计中，`bumpSessionToken` 放在了 `inFlight` 检查之前。用户在快速连续切换（如 $A \to B \to A$）或双击标签时，第二次调用自增了会话令牌，却直接复用了第一次启动的 Promise；当底层慢 IO 返回时，闭包内的旧令牌与全局已被自增的新令牌不匹配，导致结果被判定为“陈旧响应”而直接丢弃。会话永久卡死在骨架屏/空白态，无法自愈。
3. **真实空会话死循环拉取**：历史卫语句仅以 `messages.length > 0` 作为已水合依据。对于新创建后未发言、或引擎实际无历史消息的真实合法空会话，每次激活主视口均判定为“未水合”，反复触发底层 SQLite 与引擎 IPC 重拉风暴。
4. **引擎重放冲刷本地因果序**：水合流程未能严格划分存储权威层级，导致本地已经由 SQLite 按严格全序恢复的消息，被引擎事件重放（`hydrateSessionMessagesFromEngine`）盲目冲刷，引发时序震荡与闪烁。

### 2.2 主控决断书刚性要求

依据 `docs/stream-jitter-and-order-repair/plan-reviews/00-主控最终决断书.md`：

- **裁决 2【水合主路径单轨收敛】**：统一收口至 `sessionActivateHydrate.ts`，严禁新建第二调度器；修复 `inFlightMap` 与 `token` 竞态导致的永久骨架屏死锁；修复空会话死循环。
- **Review 04 采纳项 4.1（重大死锁 C1 修复）**：将 `bumpSessionToken` 移至 `inFlight` 未命中分支之后，保证每个启动的真实异步任务与其令牌严格一一映射。
- **Review 03 采纳项 3.4（空会话卫语句）**：必须以 `messagesHydrated === true` 结合 `hydratedFromEngine === true` 作为标志，允许空会话合法收敛。

---

## 三、C1 死锁状态机推演与根治方案

### 3.1 死锁发生的离散时序推演（Defect C1 Trace）

```
[时间轴推演：修复前的致命对抗]
t0: 用户激活会话 A (Tab A)
    ├── bumpSessionToken('sess-A') -> token = 1
    ├── inFlightMap 检查: 未命中
    ├── 启动 task_1 (闭包持有 token=1)
    └── inFlightMap.set('sess-A', task_1)

t1 (t0 + 15ms): 用户快速切至 Tab B 后立即切回 Tab A (A -> B -> A)
    ├── bumpSessionToken('sess-A') -> token = 2  <-- 致命错误：无条件自增！
    ├── inFlightMap 检查: 命中 task_1!
    └── 直接返回 task_1 (Promise Coalescing 复用)

t2 (t0 + 50ms): task_1 底层 SQLite IO 返回，执行提交前校验
    ├── isSessionTokenCurrent('sess-A', token_in_closure)
    │     token_in_closure = 1
    │     global_token_map('sess-A') = 2
    │     1 === 2 => FALSE!
    ├── 判定为陈旧响应，直接 return 退出，拒绝落盘！
    └── 【死锁形成】：会话 A 状态永久停留在未完成水合，界面永久呈现骨架屏白屏！
```

**对抗本质**：Promise 合并复用（Coalescing）的语义是“共享同一异步计算”，而无条件自增世代令牌（Generation Invalidation）的语义是“使既有异步计算作废”。两者在逻辑上发生了无法自洽的致命对抗。

### 3.2 形式化根治方案（C1 Remediation）

在 [`sessionActivateHydrate.ts:85-98`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionActivateHydrate.ts#L85-L98) 中，严格确立**“飞行任务优先复用，新任务才领令牌”**的数学不变量：

```typescript
// 1. 优先命中飞行中任务：直接复用已有 Promise，严禁提前自增 token！
if (inFlightHydrations.has(sessionId)) {
  return inFlightHydrations.get(sessionId)!;
}

const sess = getSessionById(get(), sessionId);
if (!sess || shouldSkipSessionHydrate(sess)) {
  return Promise.resolve();
}

// 2. 仅在真正新建水合任务时，才领新一代令牌
bumpHydrateGeneration();
const token = bumpSessionHydrateToken(sessionId);
```

#### 数学自洽性证明：

1. **单调性与单任务单令牌**：对任意一次异步 IO 任务 $\mathcal{T}_i$，其被创建的瞬间分配唯一令牌 $\tau_i = \text{bumpSessionHydrateToken}(S)$。
2. **共享一致性**：若后续调用发生在 $\mathcal{T}_i$ 执行期间（$t \in [t_{\text{start}}, t_{\text{end}}]$），直接复用 $\mathcal{T}_i$，由于复用分支不执行 `bumpSessionHydrateToken`，映射表中该会话的最新令牌仍然恒等于 $\tau_i$。
3. **合法提交保证**：当 $\mathcal{T}_i$ 完成并执行 `isSessionHydrateTokenCurrent(S, \tau_i)` 校验时，$\tau_{\text{current}} = \tau_i$ 恒成立（$\mathbf{true}$），计算结果 $100\%$ 安全提交至 Store。
4. **生命周期闭合**：在 `task.finally`（第 191-195 行）中，仅当 `inFlightHydrations.get(sessionId) === task` 时原子删除任务，杜绝并发竞争删除，彻底消除了永久骨架屏死锁。

---

## 四、本地优先（Local SQLite First）双级瀑布流水合状态机

### 4.1 状态转移拓扑

水合引擎采用严格的两级优先级瀑布流模型：

```
                    triggerSessionMessageHydrateIfNeeded(sessionId)
                                         │
                                         ▼
                             [卫语句: shouldSkip?]
                              ├── 是 ──> 立即退出 (0 IO)
                              └── 否
                                 │
                                 ▼
                     [inFlightHydrations 命中?]
                      ├── 是 ──> 直接返回在途 Promise (不增 token)
                      └── 否
                         │
                         ▼
             领新令牌 token = bumpSessionHydrateToken(id)
                         │
                         ▼
        ┌─────────────────────────────────────────────────┐
        │ Phase 1: Local SQLite First (本地权威恢复)       │
        │ ensureSessionBodyHydrated(sessionId)            │
        └────────────────────────┬────────────────────────┘
                                 │
                   [localLoaded.messages > 0 ?]
                    ├── 是 ──> 1. mergeMessagesById 合入 Store
                    │          2. 置 messagesHydrated = true
                    │          3. 触发 maybeAutoTitleSession
                    │          4. 立即 RETURN (单轨截断，绝不触发引擎重放!)
                    │
                    └── 否 (本地暂无消息)
                       │
                       ▼
        ┌─────────────────────────────────────────────────┐
        │ Phase 2: Engine Fallback (引擎事件重放兜底)      │
        │ 条件: local.messages == 0 && !hydratedFromEngine│
        │ hydrateSessionMessagesFromEngine(sessionId)     │
        └────────────────────────┬────────────────────────┘
                                 │
                   [Engine Replay 成功决议]
                    ├── 合入引擎消息
                    ├── 更新 engineCursor & engineLastRunId
                    ├── 权威置位 messagesHydrated = true
                    └── 权威置位 hydratedFromEngine = true (防空会话死循环)
```

### 4.2 卫语句与真实空会话防死循环收敛证明

在 [`sessionActivateHydrate.ts:65-71`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionActivateHydrate.ts#L65-L71) 中：

```typescript
function shouldSkipSessionHydrate(sess: SessionState): boolean {
  const hasMessages = Array.isArray(sess.messages) && sess.messages.length > 0;
  if (
    sess.messagesHydrated === true &&
    (hasMessages || sess.hydratedFromEngine === true)
  ) {
    return true;
  }
  return (
    sess.messagesHydrated !== false &&
    (hasMessages || sess.hydratedFromEngine === true)
  );
}
```

#### 逻辑覆盖表：

| 会话物理状态               | `messages.length` | `messagesHydrated` | `hydratedFromEngine` | `shouldSkip` 判定 | 运行时行为                           |
| :------------------------- | :---------------: | :----------------: | :------------------: | :---------------: | :----------------------------------- |
| **未激活历史懒壳**         |        $0$        |      `false`       |     `undefined`      | $\mathbf{false}$  | 放行水合流程（先查 SQLite）          |
| **SQLite 命中消息**        |       $> 0$       |       `true`       |     `undefined`      |  $\mathbf{true}$  | 跳过水合，0 重复 IO                  |
| **真实空会话（已水合）**   |        $0$        |       `true`       |        `true`        |  $\mathbf{true}$  | **成功收敛**：跳过水合，杜绝死循环！ |
| **内存新会话（带初始词）** |       $> 0$       |    `undefined`     |     `undefined`      |  $\mathbf{true}$  | 兼容直建态，不发起多余水合           |
| **内存刚创建纯空会话**     |        $0$        |    `undefined`     |     `undefined`      | $\mathbf{false}$  | 首次放行，经历 Phase 1/2 后收敛置位  |

---

## 五、代码审查与实现清单核对

### 5.1 核心实现审查（`sessionActivateHydrate.ts`）

| 行号范围                                                                                                  | 审查点               | 代码证据与实现意图                                                                                                                                                               |    合规判定     |
| :-------------------------------------------------------------------------------------------------------- | :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------: |
| [`L28-L58`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionActivateHydrate.ts#L28-L58)     | 任务与令牌状态池     | `inFlightHydrations`（Map）与 `sessionHydrateTokens`（Map）模块级闭包封装，导出 `__resetSessionHydrateStateForTests` 供用例间严格重置。                                          |     ✅ 合规     |
| [`L65-L71`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionActivateHydrate.ts#L65-L71)     | 卫语句逻辑           | `shouldSkipSessionHydrate` 严密联合 `messagesHydrated`、`hasMessages` 与 `hydratedFromEngine`，彻底解决空会话无法收敛的问题。                                                    |     ✅ 合规     |
| [`L85-L89`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionActivateHydrate.ts#L85-L89)     | **C1 死锁根治点**    | `if (inFlightHydrations.has(sessionId)) return inFlightHydrations.get(sessionId)!;` 命中时直接返回原 Promise，复用分支**绝对不自增 token**。                                     | ✅ **核心达标** |
| [`L96-L98`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionActivateHydrate.ts#L96-L98)     | 令牌派发点           | 仅在确认需新建异步任务后，调用 `bumpHydrateGeneration()` 与 `bumpSessionHydrateToken(sessionId)`，保证单任务与单令牌单射。                                                       |     ✅ 合规     |
| [`L111-L138`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionActivateHydrate.ts#L111-L138) | **Phase 1 本地单轨** | `ensureSessionBodyHydrated` 恢复消息；命中 `messages.length > 0` 时合并入 Store 并置 `messagesHydrated = true` 后**直接 return**，严格截断后续引擎重放。                         | ✅ **核心达标** |
| [`L140-L183`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionActivateHydrate.ts#L140-L183) | **Phase 2 引擎兜底** | 仅在 `localLoaded.messages.length === 0 && !hydratedFromEngine` 时触发 `hydrateSessionMessagesFromEngine`；完成后双置 `messagesHydrated = true` 与 `hydratedFromEngine = true`。 | ✅ **核心达标** |
| [`L191-L195`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionActivateHydrate.ts#L191-L195) | 飞行任务安全清理     | `finally` 块中通过引用比对 `inFlightHydrations.get(sessionId) === task` 实施精准清理，防止后发任务被误删。                                                                       |     ✅ 合规     |

### 5.2 外围连通与入口单一真理源核查

经全仓交叉检索：

1. **`setActiveSessionId`**（[`apps/crish-desktop/src/store/sessionCrudActions.ts:191`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionCrudActions.ts#L191)）：激活会话时唯一调用 `triggerSessionMessageHydrateIfNeeded(nextId, get, set)`。
2. **`deleteSession`**（[`apps/crish-desktop/src/store/sessionCrudActions.ts:400`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionCrudActions.ts#L400)）：删除当前会话导致焦点转移时，触发新会话水合。
3. **`sessionStore.ts` 包装器**（[`apps/crish-desktop/src/store/sessionStore.ts:304-310`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionStore.ts#L304-L310)）：对外暴露 Store 绑定的统一函数，底层原样透传。
4. **无分裂调度器**：全仓不存在任何 `sessionHydrationCoordinator.ts`，100% 达成主控裁决 2。

---

## 六、物理删除清册与反过度设计核对

| 序号  | 规范要求删除/禁止项                                      |  审查结果   | 证据与定位                                                                          |
| :---: | :------------------------------------------------------- | :---------: | :---------------------------------------------------------------------------------- |
| **1** | **禁止新建 `sessionHydrationCoordinator.ts` 第二调度器** | ✅ 完美遵从 | 检索磁盘与 Git 工作区，该多余文件不存在，全部逻辑收敛于 `sessionActivateHydrate.ts` |
| **2** | **物理切除复用分支中的 `bumpSessionToken` 调用**         | ✅ 完美遵从 | `inFlightHydrations.has` 分支仅单行 `return`，自增逻辑已物理移入未命中分支后        |
| **3** | **切除本地命中后的无条件引擎重放**                       | ✅ 完美遵从 | Phase 1 本地非空命中处存在显式 `return;`，消除盲目重放冲刷                          |
| **4** | **禁止使用 `setTimeout` 延迟补丁回避竞态**               | ✅ 完美遵从 | 全文件零 `setTimeout` / `setInterval`，完全基于 Promise 拓扑与离散代际令牌管理      |

---

## 七、代码行数预算与门禁自检

依照仓库规范 `scripts/check-line-counts.mjs`（业务逻辑类文件上限 400 行、预警线 340 行）：

### 7.1 执行门禁扫描

- **执行命令**：
  ```powershell
  node scripts/check-line-counts.mjs apps/crish-desktop/src/store/sessionActivateHydrate.ts
  ```
- **门禁控制台输出证据**：
  ```text
  [check-line-counts] Starting RL-03 Line Budget Verification...
  [check-line-counts] Target paths: apps\crish-desktop\src\store\sessionActivateHydrate.ts
  [check-line-counts] Baseline: docs/multi-agent-repair/基线记录/frontend-line-counts-baseline.md（--update 显式维护）
    ✅ [PASS] apps/crish-desktop/src/store/sessionActivateHydrate.ts (Business Logic: 149/400 lines)

  [check-line-counts] Summary:
    Scanned: 1 files
    Warnings: 0
    Violations: 0
    Hard blocks: 0
    Baselined (存量登记): 0

  [check-line-counts] ✅ All scanned files passed RL-03 line budget checks!
  ```

### 7.2 行数预算数据对比

- **业务逻辑有效代码行数**：**149 行**
- **行数预算硬上限**：400 行
- **预警安全线**：340 行
- **预算冗余空间**：剩余 251 行（有效行仅占预算的 $37.25\%$）
- **结论**：极度精炼克制，架构收敛干净，远低于上限。

---

## 八、测试用例矩阵与通过证据

测试套件 [`apps/crish-desktop/src/store/sessionActivateHydrate.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionActivateHydrate.test.ts) 设计了完整的 9 大测试用例，覆盖单轨水合与防死锁所有核心路径：

### 8.1 测试用例矩阵

| 序号  | 测试用例名称                                                                                 | 核心验证逻辑与断言                                                                                                                                           |  对应决断要求   |
| :---: | :------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------: |
| **1** | `needsEngineMessageHydrate: true only when empty messages and not yet hydrated`              | 验证纯逻辑工具函数对空会话、非空会话、已水合会话的判定真值表                                                                                                 |   基础卫语句    |
| **2** | `activate empty remote shell merges daemon messages into sessions[] and sessionsById`        | 激活未水合远程懒壳，Phase 2 成功拉回消息，验证同引用落盘及 `messagesHydrated=true`                                                                           |  完整流程闭环   |
| **3** | `does not re-fetch when already hydratedFromEngine with empty messages`                      | 真实空会话在标记 `hydratedFromEngine=true` 后，再次激活 0 次调用底层 IO                                                                                      | 防死循环卫语句  |
| **4** | `truncated hydrate（分页超限截断）：会话置 hydrateTruncated=true`                            | 引擎拉取触碰分页截断上限时，标记诊断属性供前端上报感知                                                                                                       |    分页容灾     |
| **5** | `完整 hydrate（分页拉全）：无截断标记 → 既有 hydrateTruncated 标记被清除`                    | 再次拉取拉全后，诊断标记被正确重置清除                                                                                                                       |    状态自愈     |
| **6** | `does not fetch when local messages already present`                                         | 本地已有消息的活跃会话激活时，直接短路跳过，零 IO 开销                                                                                                       |  内存直通守卫   |
| **7** | `Phase 1 SQLite 命中：直接从本地 SQLite 恢复权威消息与 agents，绝对不再触发远程引擎重放冲刷` | **核心用例**：Phase 1 返回消息后，断言 `ensureBodyMock` 被调用 1 次，`hydrateMock` **0 次调用（not.toHaveBeenCalled）**，再次激活零 IO                       |  本地优先单轨   |
| **8** | `Phase 1 SQLite 为空时自动回退 Phase 2 引擎水合，且真实空会话水合后收敛不再重复拉取`         | **核心用例**：Phase 1 返回空，回退 Phase 2 引擎拉取；引擎亦返回空后同时打上两枚标记，二次激活 0 次重拉                                                       |   空会话收敛    |
| **9** | `C1 死锁修复：A -> B -> A 高频切换复用 inFlight Promise，不自增 token、不误杀在途水合`       | **核心死锁验证**：会话 A 飞行中快速切 B 又切回 A；断言 `flightA2 === flightA1`，token 保持为 1，慢 IO 返回后 A 成功落入 Store 未被误杀，最终 A、B 均正确水合 | **C1 消除决断** |

### 8.2 Vitest 运行控制台实测证据

- **执行命令**：
  ```powershell
  npx vitest run apps/crish-desktop/src/store/sessionActivateHydrate.test.ts
  ```
- **实际输出**：
  ```text
   RUN  v3.2.7 C:/Software/conex

   ✓  unit  apps/crish-desktop/src/store/sessionActivateHydrate.test.ts (9 tests) 206ms

   Test Files  1 passed (1)
        Tests  9 passed (9)
     Start at  23:08:47
     Duration  9.72s (transform 4.78s, setup 810ms, collect 5.46s, tests 206ms, environment 0ms, prepare 193ms)
  ```

---

## 九、总结与交付确认

1. **交付物状态**：
   - `apps/crish-desktop/src/store/sessionActivateHydrate.ts` 与 `apps/crish-desktop/src/store/sessionActivateHydrate.test.ts` 代码与测试完备且经受充分验证；
   - 交付报告 `docs/stream-jitter-and-order-repair/execution/W1-D-会话水合单轨状态机与防死锁报告.md` 已正式落盘。
2. **纪律遵从**：
   - 严格遵循 `AGENTS.md`：本次任务**零 Git 提交**，所有产出均保留在工作区等待主控统一使用 `git commit --only <paths>` 收口；
   - 严格限定于专属文件域，零越界修改他人文件；
   - 彻底消除了 C1 永久死锁与空会话死循环，全面达成主控决断书裁决 2 与 DoD 标准。
