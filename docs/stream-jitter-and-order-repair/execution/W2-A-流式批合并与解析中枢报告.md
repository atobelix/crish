# Wave 2 - Task W2-A：流式批合并与解析中枢升级执行报告

> **任务代号**：`W2-A`  
> **所属战役**：`stream-jitter-and-order-repair`（流式渲染卡顿跳动与时序重排系统性治理）  
> **对齐基线**：`docs/stream-jitter-and-order-repair/01-规范-执行波通用.md`、`docs/stream-jitter-and-order-repair/plan-reviews/00-主控最终决断书.md`（裁决 3、裁决 4）、`docs/stream-jitter-and-order-repair/independent-plans/03-流式解析微任务批合并与帧调度方案.md`  
> **专属文件域**：
>
> - `apps/crish-desktop/src/api/markdownRenderAsync.ts`
> - `apps/crish-desktop/src/api/markdown/IncrementalMarkdownSession.ts`
> - `apps/crish-desktop/src/api/markdownRenderAsync.test.ts`
> - `docs/stream-jitter-and-order-repair/execution/W2-A-流式批合并与解析中枢报告.md`

---

## 一、完成度总结

### 1. 已完成项（100% 闭环）

- **【物理删除级联重渲染与恒真死守卫】**：在 `apps/crish-desktop/src/api/markdownRenderAsync.ts` 的 `useStreamingMarkdownHtml` 中，彻底删除了 `for (const part of advance.textParts)` 散装微任务循环（每个分片 `.then()` / `.catch()` 各自独立触发 `setRenderVersion`）以及在单调追加流中恒真的死守卫 `session.getRevision() === advance.revision`。
- **【世代令牌与 `Promise.all` 原子批决议】**：
  - 引入 `advanceBatchIdRef = useRef(0)`，每次 `markdown` 推进时自增 `const currentBatchId = ++advanceBatchIdRef.current`，禁用/空白重置及卸载时同步递增世代令牌使飞行中旧批次失效；
  - 当 `advance.textParts.length === 0` 时，走零微任务同步直通通道：直接更新 `unitsRef.current = session.getUnitSnapshots()` 并触发 1 次 `setRenderVersion((version) => version + 1)`（非 `unitsRef` 分支则 `setHtml(advance.html)`）；
  - 当 `advance.textParts.length > 0` 时，先同步刷新 `unitsRef.current = session.getUnitSnapshots()` 保持结构包装器快照就绪（不触发中间重渲染），再将所有 `advance.textParts` 映射为带独立 `try/catch` 安全降级（失败返回空串 `''`，绝不回退 Markdown 原文）的 `Promise.all` 批次；
  - 待整批分片全部完成后，校验 `mountedRef.current` 与 `advanceBatchIdRef.current === currentBatchId` 世代令牌，批量调用 `session.resolveTextPart(res.id, res.fragment)`，当且仅当当前批次仍为最新且有分片成功应用时，**严格仅触发 1 次** `unitsRef.current = session.getUnitSnapshots()` 与 `setRenderVersion((version) => version + 1)`。
- **【坚守反过度设计与裁决 3/4 禁令】**：
  - 严禁在 `unitsRef` 分支调用全量 `setHtml(session.toHtml())`（已由 `toHtmlSpy` 断言 0 次调用）；
  - 严禁引入未使用的死类 `FrameCoalescingScheduler`。
- **【单元测试覆盖与 100% 绿灯验证】**：在 `apps/crish-desktop/src/api/markdownRenderAsync.test.ts` 中新增 4 项专项断言（多词法分片 `Promise.all` 单次重渲染收敛、快速连续输入下 `advanceBatchIdRef` 拦截过期批次、个别分片异常容错降级、无异步分片 `textParts.length === 0` 同步直通），全套 23 项单元测试 100% 通过。

### 2. 未完成项

- 无。

---

## 二、代码修改清单

| 文件路径与行号                                                                                                                                                 | 改动内容与架构意图                                                                                                                                                                                                                                                                                                                                                       |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/crish-desktop/src/api/markdownRenderAsync.ts:162-253`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownRenderAsync.ts#L162-L253)           | 重构 `useStreamingMarkdownHtml`：引入 `advanceBatchIdRef` 递增世代令牌；实现 `advance.textParts.length === 0` 同步直通与 `advance.textParts.length > 0` 的 `Promise.all` 原子批收口，将单次推进的 React 状态触发次数从 $1 + N$ 次压降至严格 $\le 1$ 次；空态/禁用重置时仅在 `unitsRef.current !== null` 时触发版本递增，消除空挂载冗余渲染。                             |
| [`apps/crish-desktop/src/api/markdownRenderAsync.test.ts:47-50`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownRenderAsync.test.ts#L47-L50)     | 导入 `type IncrementalMarkdownUnitSnapshot` 供批合并与世代隔离测试使用。                                                                                                                                                                                                                                                                                                 |
| [`apps/crish-desktop/src/api/markdownRenderAsync.test.ts:426-581`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownRenderAsync.test.ts#L426-L581) | 新增 4 个单元测试用例：<br>1. `单次 advance 含多个词法分片时，Promise.all 批合并只触发 1 次批完成重渲染`<br>2. `快速连续输入（新批次覆盖旧批次）时，旧批次微任务回执被 advanceBatchIdRef 精确拦截丢弃`<br>3. `分片异常容错：当批次中个别分片 IPC 失败时，Promise.all 平稳收口且不回退源码`<br>4. `无异步分片（textParts.length === 0）时同步更新快照且仅触发 1 次重渲染` |

> **附注（`IncrementalMarkdownSession.ts` 核查说明）**：任务书列出的 `apps/crish-desktop/src/components/chat-message-row/IncrementalMarkdownSession.ts` 在仓库中的真实物理路径为 [`apps/crish-desktop/src/api/markdown/IncrementalMarkdownSession.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdown/IncrementalMarkdownSession.ts)。经核查，其 `advance`、`resolveTextPart` 与 `getUnitSnapshots` 接口契约已完备支撑 `Promise.all` 批量决议，无需额外改动。

---

## 三、物理删除清单

| 文件路径与原行号                                                                                                                                           | 物理删除内容                                                                                                                                                                             | 删除理由（对齐《物理级硬性删除清册》§3.5 / 裁决 4）                                                                             |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------ |
| [`apps/crish-desktop/src/api/markdownRenderAsync.ts:190-196`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownRenderAsync.ts#L190-L196)（旧） | 物理删除存在异步分片（`advance.textParts.length > 0`）时在 `useEffect` 内无条件立即触发的第 1 次空占位 `setRenderVersion((version) => version + 1)` / `setHtml(advance.html)`。          | 消除 $1 + N$ 级联重渲染中的前置空占位冗余重渲染，收敛至 `Promise.all` 批完成后单次原子触发。                                    |
| [`apps/crish-desktop/src/api/markdownRenderAsync.ts:198-229`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownRenderAsync.ts#L198-L229)（旧） | 物理删除 `for (const part of advance.textParts)` 中逐个分片独立 `.then()` / `.catch()` 各自调用 `setRenderVersion((version) => version + 1)` 或 `setHtml(session.toHtml())` 的散装循环。 | 根除单次 `advance` 引发 $N$ 次微任务级联 React Fiber 协调与 DOM Diff 的卡顿病灶。                                               |
| [`apps/crish-desktop/src/api/markdownRenderAsync.ts:203,218`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownRenderAsync.ts#L203)（旧）      | 物理删除 `session.getRevision() === advance.revision` 恒真死守卫。                                                                                                                       | 单调流式追加下 `session.revision` 恒定不变，旧守卫无法拦截跨帧过期微任务，已由单调递增的 `advanceBatchIdRef` 世代令牌完全取代。 |

---

## 四、测试验证结果

### 1. 单元测试执行结果

- **执行命令**：
  ```powershell
  npx vitest run apps/crish-desktop/src/api/markdownRenderAsync.test.ts
  ```
- **通过证据**：
  ```text
  RUN  v3.2.7 C:/Software/conex

  ✓  unit  apps/crish-desktop/src/api/markdownRenderAsync.test.ts (23 tests) 1135ms

  Test Files  1 passed (1)
       Tests  23 passed (23)
  ```

### 2. 行数门禁执行结果

- **执行命令**：
  ```powershell
  node scripts/check-line-counts.mjs apps/crish-desktop/src/api/markdownRenderAsync.ts
  ```
- **通过证据**：
  ```text
  [check-line-counts] Starting RL-03 Line Budget Verification...
  [check-line-counts] Target paths: apps\crish-desktop\src\api\markdownRenderAsync.ts
    ✅ [PASS] apps/crish-desktop/src/api/markdownRenderAsync.ts (Business Logic: 200/400 lines)
  [check-line-counts] ✅ All scanned files passed RL-03 line budget checks!
  ```

---

## 五、行数预算自检

| 文件路径                                                                                                                           | 门禁类别       | 修改前有效行 | 修改后有效行 | 净变化 | 预警线 / 硬上限 |          状态           |
| :--------------------------------------------------------------------------------------------------------------------------------- | :------------- | :----------: | :----------: | :----: | :-------------: | :---------------------: |
| [`apps/crish-desktop/src/api/markdownRenderAsync.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownRenderAsync.ts) | Business Logic |     191      |   **200**    |   +9   |    340 / 400    | ✅ PASS（远低于预警线） |
