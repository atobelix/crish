# 并发时序与状态机专项评审报告

> **评审编号**：`REVIEW-04`  
> **所属战役**：`stream-jitter-and-order-repair`（流式渲染卡顿跳动与时序重排系统性治理）  
> **责任角色**：并发时序与状态机评审专家  
> **审查对象**：`00-总方案.md` 及独立详案 `01` 至 `09`（重点聚焦 `01-消息因果时序与水合单轨方案`、`02-Markdown封口过渡与零塌陷方案`、`03-流式解析微任务批合并与帧调度方案`、`04-虚拟滚动测高与吸底手势解耦方案`、`09-会话切换与标签页懒水合状态机方案`）  
> **基线规范**：对齐 `docs/agent-roles/general_task/三原则.md`、根 `AGENTS.md`、`.agents/LOGIC_PLAN_NO_RETREAT.md` 与 `ANTI_OVERENGINEERING_GUARDRAILS.md`

---

## 一、评审概述与核心审查定位

本次专项评审的使命，是以严格的**离散数学状态机理论**、**并发时序因果序（Lamport Causal Ordering）**以及**微任务事件循环（Event Loop）模型**为工具，对流式重构方案中涉及多线程、异步微任务、高频用户交互与极端网络/IO 扰动下的各层设计进行严苛的闭环审计。

经深度推演，总方案与 01~09 分维详案展现了卓越的架构洞察力，精准命中了既有系统的核心病灶（时序倒置、封口白屏塌陷、微任务风暴、吸底死锁）。但在多状态机交叉重叠、极端取消（Abort）、高频切 Tab 飞行合并（Promise Coalescing）以及超高吐字率背压场景下，方案中存在**两处高危潜在死锁/假死缺陷**与**两处关键时序穿透风险**，必须在工程落地前完成拓扑修补。

---

## 二、状态跃迁数学自洽性与有限状态机（FSM）闭包证明

### 2.1 MarkdownBlockItem 四态生命周期模型的形式化定义与证明

#### 2.1.1 状态空间定义

在 `02-Markdown封口过渡与零塌陷方案.md` 与 `MarkdownBlockItem.tsx` 中，单个 Markdown 块被抽象为离散状态机 $\mathcal{M}_{\text{block}} = \langle \mathcal{S}, \Sigma, \delta, s_0, \mathcal{F} \rangle$：

$$\mathcal{S} = \{ \text{COLD\_SEALED}, \text{ACTIVE}, \text{SEALING\_PENDING}, \text{SEALED\_STABLE} \}$$

- **初始状态集** $s_0$：
  - 历史会话加载：$s_0 = \text{COLD\_SEALED}$（`isSealed = true && !isStreaming` 且无历史流式快照）；
  - 新流式消息发起：$s_0 = \text{ACTIVE}$（`isStreaming = true && isLast = true && !isSealed`）。
- **终态集** $\mathcal{F}$：
  - $\mathcal{F} = \{ \text{SEALED\_STABLE} \}$（权威 Worker/Rust HTML 已渲染且进入 `React.memo` 冻结态）。

#### 2.1.2 状态判定谓词体系

组件通过以下派生布尔表达式确定当前物理状态：

1. $\text{IsActiveTail} \iff \text{isStreaming} \land \text{isLast} \land \neg\text{isSealed}$
2. $\text{HasAuthHtml} \iff \text{Boolean}(\text{sealedHtml}) \lor \text{Boolean}(\text{cachedHtml})$
3. $\text{HasSnapshot} \iff \text{Boolean}(\text{lockedUnitsRef.current}) \land \text{lockedUnitsRef.current.length} > 0$
4. $\text{IsSealingTransition} \iff \text{isSealed} \land \neg\text{HasAuthHtml} \land \text{HasSnapshot}$

当前状态判定函数 $f_{\text{state}}: \text{Props} \times \text{Refs} \to \mathcal{S}$ 为：

$$ f_{\text{state}} = \begin{cases}
\text{ACTIVE}, & \text{若 } \text{IsActiveTail} \\
\text{SEALED\_STABLE}, & \text{若 } \text{isSealed} \land \text{HasAuthHtml} \\
\text{SEALING\_PENDING}, & \text{若 } \text{IsSealingTransition} \\
\text{COLD\_SEALED}, & \text{若 } \text{isSealed} \land \neg\text{HasAuthHtml} \land \neg\text{HasSnapshot}
\end{cases}$$

---

### 2.2 状态转移矩阵与异常边界拓扑分析

我们构建输入事件集合 $\Sigma$：
- $e_1 = \text{TokenDelta}$：流式追加文本 token；
- $e_2 = \text{SealBlock}$：块封口触发（`isSealed = true` 或新块产生变为非末尾）；
- $e_3 = \text{WorkerResolve}$：Worker/Rust 权威编译完成（`sealedHtml` 就绪）；
- $e_4 = \text{WorkerFail}$：Worker 编译抛出异常或超时；
- $e_5 = \text{AbortStream}$：用户点击停止或网络中断（`isStreaming \to false` 但块尚未正常封口）；
- $e_6 = \text{Regenerate}$：重新生成（`text` 被完全替换为全新内容）。

#### 完整状态转移矩阵表（State Transition Matrix）

| 当前状态 ($S$) | 事件 ($e$) | 转移条件 / 守卫 | 下一状态 ($S'$) | DOM 行为与渲染输出契约 | 安全性判定 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`ACTIVE`** | $e_1$ (TokenDelta) | `isActiveTail === true` | `ACTIVE` | 增量单元推进，`lockedUnitsRef` 持续跟随更新 | 稳定 |
| **`ACTIVE`** | $e_2$ (SealBlock) | `hasAuth === false` | `SEALING_PENDING` | 锁定上一帧 `lockedUnitsRef`，下发高保真 DOM，绝对禁止下发 `""` | 稳定无缝 |
| **`ACTIVE`** | $e_2$ (SealBlock) | `hasAuth === true` (命中缓存) | `SEALED_STABLE` | 跳过过渡期，原地 patch DOM，清空锁存器 | 闭合快速 |
| **`ACTIVE`** | **$e_5$ (AbortStream)** | **`isSealed === false`** | **【严重死锁点 C2】** | **`isActiveTail \to false` 且 `isSealed \to false`，状态陷入悬空！** | **漏洞（详见下文）** |
| **`ACTIVE`** | $e_6$ (Regenerate) | `text` 完全不匹配 | `ACTIVE` (重置) | 需清空锁存器并重新初始化 | 需补全清理 |
| **`SEALING_PENDING`** | $e_3$ (WorkerResolve) | `sealedHtml` 非空 | `SEALED_STABLE` | 原地属性/结构补全（高亮上色），零 DOM 销毁 | 理想稳态 |
| **`SEALING_PENDING`** | $e_4$ (WorkerFail) | `failed === true` | `SEALED_STABLE` (降级) | 永续锁定 `lockedHtmlRef`，绝不回退源码或白屏 | 容灾可靠 |
| **`SEALING_PENDING`** | $e_5$ (AbortStream) | 流式终止 | `SEALING_PENDING` | 维持等待 Worker 或保持快照稳态 | 闭合 |
| **`SEALING_PENDING`** | $e_1$ (TokenDelta) | 非法逆序到达 | `SEALING_PENDING` | 丢弃晚到 token，不重开 ACTIVE | 幂等保护 |
| **`COLD_SEALED`** | $e_3$ (WorkerResolve) | `sealedHtml` 非空 | `SEALED_STABLE` | 移除骨架占位，插入权威节点 | 正常 |
| **`COLD_SEALED`** | $e_4$ (WorkerFail) | 编译失败 | `SEALED_STABLE` (降级) | 显示优雅降级文本 | 正常 |
| **`SEALED_STABLE`** | $\forall e$ | 终态 | `SEALED_STABLE` | `React.memo` 永久短路拦截，0 开销 | 闭合终态 |

---

### 2.3 核心死锁穿透一：取消生成（Abort）导致的状态机悬空与派生塌陷

#### 漏洞深度穿透（Defect C2）
在 `MarkdownBlockItem.tsx` 现有方案中，派生渲染变量为：
```typescript
const isActiveTail = isStreaming && isLast && !isSealed;
...
const isSealingTransition = isSealed && !hasAuthoritativeHtml && Boolean(lockedUnitsRef.current);

const effectiveIncrementalUnits = isActiveTail
  ? streamingUnitsRef.current
  : isSealingTransition
    ? lockedUnitsRef.current
    : undefined;

const effectiveHtml = shouldRenderStreamingTable
  ? ''
  : hasAuthoritativeHtml
    ? authoritativeHtml
    : isSealingTransition
      ? lockedHtmlRef.current
      : (isActiveTail ? liveHtml : '');
```

**竞态时序推演**：
1. 消息处于流式输出最后一帧，当前块处于 `ACTIVE` 状态，`isStreaming = true`，`isLast = true`，`isSealed = false`；
2. 用户点击“停止生成（Stop）”按钮，或者引擎检测到取消指令；
3. `isStreaming` 立即置为 `false`。**但请注意：此时上层 `useStreamingBlocks` 可能尚未将该块标记为 `isSealed = true`**（甚至在中止场景下，该块永远不会收到 `isSealed = true` 属性变更）；
4. 计算派生属性：
   - `isActiveTail = false && isLast && !isSealed` $\implies \mathbf{false}$；
   - `isSealingTransition = false && ...` $\implies \mathbf{false}$；
   - `effectiveIncrementalUnits` $\implies \mathbf{undefined}$；
   - `effectiveHtml = (false ? liveHtml : '')` $\implies \mathbf{''}$（空串！）；
5. 结果：组件向下游 `ReconciledMarkdownHtml` 下发了 `incrementalUnits = undefined` 且 `html = ""`！
6. 虽然方案 02 在 `ReconciledMarkdownHtml` 中增加了零塌陷防御锁（`if (!html.trim() && container.childNodes.length > 0) return;`），拦截了 DOM 节点的即刻删除，**但上层 React 虚拟 DOM 树的状态机已经陷入了未定义的“既非流式、又非封口、数据为空”的幽灵态（Phantom State）**！
7. 一旦此时用户发生视口滚动触发虚拟滚动重挂载（Unmount/Remount），`container.childNodes` 初始为空，防御锁失效，整段已经输出的文字将瞬间变成空白，且无法恢复！

#### 形式化修复方案（Mandatory Fix C2）
必须在 `MarkdownBlockItem` 内部建立**“流式终止即隐式封口（Implicit Sealing on Stream Termination）”**的数学封闭律：
$$\text{IsEffectiveSealed} \iff \text{isSealed} \lor (\neg\text{isStreaming} \land \text{Boolean}(\text{lockedUnitsRef.current}))$$
派生条件修正为：
```typescript
// 1. 显式封口 或 流式已经终止但留有流式快照资产
const isEffectivelySealed = isSealed || (!isStreaming && Boolean(lockedUnitsRef.current));

// 2. 封口挂起态守卫全面覆盖中止场景
const isSealingTransition =
  isEffectivelySealed && !hasAuthoritativeHtml && Boolean(lockedUnitsRef.current);
```
当流式被 Abort 且未收到权威编译结果时，组件确定性进入 `SEALING_PENDING` 态并永久锁定 `lockedUnitsRef`，直至组件正常销毁，确保在任何重挂载与中止场景下数据永不丢失。

---

### 2.4 会话懒水合五态离散模型与 Tab 高频切换互斥性

在 `09-会话切换与标签页懒水合状态机方案.md` 中，会话水合状态空间形式化定义为：
$$\mathcal{S}_{\text{hyd}} = \{ \text{Shell\_Lazy}, \text{Hydrating\_LocalDb}, \text{Fallback\_Engine}, \text{Hydrated\_Ready}, \text{Degraded\_Error} \}$$

#### 高频切换 10 个 Tab 时的状态机互斥性验证
设用户在 $100\text{ms}$ 内以 $10\text{ms}$ 间隔连续切换 10 个 Tab：
$$\sigma = \langle T_1, T_2, T_3, \dots, T_{10} \rangle$$
设 $G_k$ 为触发切换至 $T_k$ 时派发的全局令牌，满足严格全序单调自增：
$$1 \le G_1 < G_2 < \dots < G_{10}$$

#### 状态互斥性断言验证：
1. **主视口唯一性（Viewport Exclusivity）**：
   在任意物理时刻 $t$，屏幕当前主视口呈现的会话内容状态机 $S_{\text{active}}(t)$ 必须且仅能绑定到拥有最新全局令牌的会话：
   $$\text{Session}(\text{Viewport}) \equiv T_k \iff G_k = \max(\{ G_i \mid i \in [1, 10] \})$$
   - 证明：当 $T_1$ 的慢异步 IO 迟至 $t = 200\text{ms}$ 返回时，其闭包捕获的 $G_1 = 1$。
   - 守卫函数 `isHydrateGenerationCurrent(G_1)` 执行比较：$1 === 10 \implies \mathbf{false}$。
   - $T_1$ 的结果被完全剥夺主视口更新权，主视口强一致性保持，得证。

2. **存储态无脏写（Store Non-Interference）**：
   每个会话独立拥有专属的会话请求令牌 $S^{(k)}_{\text{token}}$。
   若用户在 $T_1 \to T_2 \to T_1$ 之间来回横跳：
   - 第一次进入 $T_1$ 赋予 $S^{(1)}_1 = 1$；
   - 第二次进入 $T_1$ 赋予 $S^{(1)}_2 = 2$；
   - 慢响应 $S^{(1)}_1$ 到达时，校验 $1 === 2 \implies \mathbf{false}$，抛弃陈旧响应，得证。

---

## 三、世代令牌（Generation Token）与竞态防御体系审查

### 3.1 `advanceBatchIdRef` 微任务决议拦截有效性证明

#### 3.1.1 审查对象
`03-流式解析微任务批合并与帧调度方案.md` 第 394-468 行所设计的 `advanceBatchIdRef` 世代守卫。

#### 3.1.2 异步时序因果序证明
设组件在时间轴上产生两次连续推进：$\text{advance}_A$ 与 $\text{advance}_B$，满足物理时序 $t(A) < t(B)$。
- 在 $\text{advance}_A$ 发生时：
  $$\text{batchId}_A = ++\text{advanceBatchIdRef.current} = n$$
  分发异步微任务批 $\mathcal{P}_A = \text{Promise.all}([p_{A1}, p_{A2}, \dots])$。
- 在 $\mathcal{P}_A$ 处于网络/Worker 运算期间（In-Flight），文本进一步推进，触发 $\text{advance}_B$：
  $$\text{batchId}_B = ++\text{advanceBatchIdRef.current} = n + 1$$
  分发异步微任务批 $\mathcal{P}_B$。
- **场景 1：$\mathcal{P}_A$ 滞后决议（Stale Resolution）**
  当 $\mathcal{P}_A$ resolve 时，执行微任务检查：
  ```typescript
  const isLatest = advanceBatchIdRef.current === currentBatchId;
  ```
  代入得：$\text{advanceBatchIdRef.current} = n + 1$，$\text{currentBatchId} = n$。
  $n + 1 === n \implies \mathbf{false}$！
  $\text{isLatest}$ 严格为 `false`。
  后续 `if (isLatest && anyResolved)` 阻断分支执行，**旧批次向 React 派发的 `setRenderVersion` / `setHtml` 被 $100\%$ 原子过滤**。
- **场景 2：组件在 $\mathcal{P}_A$ 决议前卸载（Unmount Race）**
  组件卸载触发 cleanup 函数：
  ```typescript
  mountedRef.current = false;
  advanceBatchIdRef.current += 1;
  ```
  当 $\mathcal{P}_A$ resolve 进入微任务回调时：
  第一道门禁：`if (!mountedRef.current) return;` 立即短路退出。
  彻底杜绝 React "Can't perform a React state update on an unmounted component" 警告与内存泄漏。

#### 3.1.3 隐患发现与建议（Optimization R2）
在 Plan 03 的代码实现中：
```typescript
void Promise.all(partPromises).then((results) => {
  if (!mountedRef.current) return;
  const isLatest = advanceBatchIdRef.current === currentBatchId;

  // 隐患点：无论是否最新，先执行 resolveTextPart
  let anyResolved = false;
  for (const res of results) {
    if (session.resolveTextPart(res.id, res.fragment)) {
      anyResolved = true;
    }
  }
  ...
});
```
**时序风险分析**：
虽然 `setRenderVersion` 被拦截，但 `session.resolveTextPart` 仍然被执行。
如果在这两批之间发生过 `session.reset()`（例如由于非前缀变更重写），底层的结构投影已被清空；虽然 `resolveTextPart` 内部可能做过键存在性校验，但允许过时的旧批次结果写入活跃 `session` 在代数上是不纯净的。
**修复建议**：应严格将 `session.resolveTextPart` 的执行收拢在 `if (isLatest)` 守卫内部；对于已被废弃的批次，无需向 `session` 回填数据。

---

### 3.2 `performProgrammaticScroll` 令牌在用户物理输入时的 Capture 销毁证明

#### 3.2.1 审查对象
`04-虚拟滚动测高与吸底手势解耦方案.md` 与 `MessageVirtualizer.tsx` 中的程序滚动豁免令牌与手势解耦机制。

#### 3.2.2 Capture 阶段原子销毁证明
在浏览器 DOM 事件模型规范中，原生事件流严格分为三个阶段：
$$\text{Capture Phase} \xrightarrow{\text{到达 Target}} \text{Target Phase} \xrightarrow{\text{回溯冒泡}} \text{Bubble Phase}$$

```
[原生硬件输入事件: wheel / touchstart / pointerdown]
                     │
                     ▼ (Window -> Document -> Container)
    ┌────────────────────────────────────────────────────────┐
    │ 1. Container Capture 阶段监听器 (Passive: true)          │
    │    - handleWheel / handleTouchStart / handlePointerDown│
    └────────────────────────┬───────────────────────────────┘
                             │ 同步执行 (Sync JavaScript Stack)
                             ▼
    ┌────────────────────────────────────────────────────────┐
    │ 2. 原子作废程序滚动豁免权:                               │
    │    programmaticStateRef.current.active = false;        │
    │    programmaticStateRef.current.token++;               │
    │    bumpGestureEpoch();                                 │
    └────────────────────────┬───────────────────────────────┘
                             │
                             ▼
    ┌────────────────────────────────────────────────────────┐
    │ 3. 浏览器内部 Blink 引擎滚动管道派发原生 scroll 事件      │
    │    - useVirtualScroll.onScroll(e) 触发                 │
    └────────────────────────┬───────────────────────────────┘
                             │ 校验条件
                             ▼
    ┌────────────────────────────────────────────────────────┐
    │ 4. 判定 isProgrammaticMatch:                           │
    │    prog.active (已被置为 false!) === true -> FALSE!     │
    │    -> 100% 确定为物理手势接管，绝对不会误判为程序滚动!      │
    └────────────────────────────────────────────────────────┘
```
**数学证明结论**：
由于硬件输入监听器挂载于容器的 **Capture 捕获阶段**，其在 JavaScript 调用栈上的执行时机**严格在任何后续 `scroll` 事件被调度派发之前**。因此，`programmaticStateRef.current.active` 的撤销操作与硬件输入产生因果全序锁定：
$$t(\text{Active} \to \text{false}) < t(\text{onScroll}(\text{Native}))$$
任何伴随硬件输入产生的后续滚动事件，其 `isProgrammaticMatch` 恒为 `false`，物理手势判定 $100\%$ 具备原子排他性。

#### 3.2.3 关键时序穿透漏洞发现（Defect C3）
在 Plan 04 第 246-251 行中，定义了自动失效哨兵：
```typescript
// 哨兵：在当前微任务与单帧 rAF 后自动失效，杜绝永久滞留
requestAnimationFrame(() => {
  if (programmaticStateRef.current.token === nextToken) {
    programmaticStateRef.current.active = false;
    programmaticStateRef.current.targetScrollTop = null;
  }
});
```
**极端竞态分析**：
在 Chromium (Blink) 渲染架构中，JavaScript 赋值 `container.scrollTop = maxScroll` 后，原生 `scroll` 事件的实际派发时机取决于排版树脏标记：
- 若属于异步平滑滚动或帧末延迟合并，原生 `scroll` 事件可能在 **下一物理帧的 rAF 之后** 方才抵达 `onScroll` 回调！
- 若在 `scroll` 事件抵达前，上述 `requestAnimationFrame` 哨兵先行执行，则 `active` 被过早重置为 `false`；
- 当滞后的原生程序吸底 `scroll` 事件终于到达时，`prog.active` 已为 `false`，系统**误将其判定为用户物理手势，再次触发 `bumpGestureEpoch()` 激活 100ms 冻结**！
- 恶性循环再次重现！

**必须改修复案（Mandatory Fix C3）**：
不能仅依赖单帧 rAF 粗暴清除，必须采用**“事件消费自销毁 + 双帧兜底安全超时（Consume-or-Timeout）”**双重保险契约：
1. **单次事件消费（Once-Consumption）**：当 `onScroll` 命中 `isProgrammaticMatch` 且亚像素比对成功后，立即在 `onScroll` 内部将 `active` 置为 `false`（程序滚动事件通常恰好派发 1 次）；
2. **延迟双帧兜底（Double-rAF Guard）**：仅在目标元素本就处于底部未产生位移、因而未触发任何 `scroll` 事件时，由延迟至至少两帧（`doubleRaf`）的计时器兜底清除非激活状态，杜绝单帧抖动早泄。

---

### 3.3 核心死锁穿透二：`inFlightMap` 与 `sessionToken` 冲突导致的永久骨架屏死锁

#### 3.3.1 漏洞深度穿透（Defect C1）
在 `09-会话切换与标签页懒水合状态机方案.md` 第 370-410 行与第 493-497 行中，为了防止并发请求风暴与竞态，分别设计了两个独立机制：
- 机制 1：**会话级单调递增令牌 `sessionRequestTokenMap`**（防竞态）；
- 机制 2：**飞行中 Promise 合并器 `inFlightMap`**（防重复请求）。

**死锁执行序列推演（Deadlock Trace）**：
```typescript
// coordinateSessionHydration 关键流程节选：
const sessionToken = bumpSessionToken(sessionId); // [Step 1: 每次触发无条件 bump]

const flightKey = `${sessionId}`;
if (inFlightMap.has(flightKey)) {
  return inFlightMap.get(flightKey);              // [Step 2: 飞行中直接复用 Promise]
}

const task = (async () => {
  ...
  // Phase 3: 提交校验
  if (!isSessionTokenCurrent(sessionId, sessionToken)) {
    return; // [Step 3: 校验 sessionToken 是否匹配]
  }
  set(draft => { ... s.hydrationStatus = 'Hydrated_Ready'; });
})();
```

设用户进行如下完全合法的日常交互操作（高频切换或双击）：
1. $t = 0\text{ms}$：用户点击会话 $S_A$，调用 `coordinateSessionHydration(S_A)`；
   - `sessionToken` 被自增为 **$1$**；
   - 任务启动，闭包内部固化 `sessionToken = 1`；
   - 任务被登记入 `inFlightMap.set('S_A', task_1)`；
2. $t = 15\text{ms}$：用户误触或快速切换到旁边会话后又立刻切回 $S_A$（或者短时间内再次点击了 $S_A$ 标签）；
   - 再次调用 `coordinateSessionHydration(S_A)`；
   - **Step 1 执行**：`sessionToken` 再次自增为 **$2$**；
   - **Step 2 执行**：`inFlightMap.has('S_A')` 命中！代码直接返回了飞行中的 `task_1`！
3. $t = 40\text{ms}$：`task_1` 的 SQLite 读取完成，进入 Step 3 校验：
   - `isSessionTokenCurrent('S_A', sessionToken)`：
     - 当前闭包中的 `sessionToken` 是 **$1$**；
     - 全局映射表中 `'S_A'` 的最新值已被 Step 1 更新为 **$2$**；
     - 比较结果：$1 === 2 \implies \mathbf{false}$！
4. **灾难发生**：
   - `task_1` 判定当前响应已过期，**直接 `return` 退出**！
   - 没有任何后续任务被调度（因为二次点击复用了 `task_1`）；
   - 会话 $S_A$ 的状态被永久冻结在 `Hydrating_LocalDb`（或外壳态）；
   - **前端界面表现为永久白屏 / 永远停留在骨架屏骨架动画，用户再也无法打开该会话**！

#### 3.3.2 形式化修复方案（Mandatory Fix C1）
**根因诊断**：
Promise Coalescing（合并复用）与 Generation Invalidation（世代作废）在语义上发生了致命对抗。复用 Promise 意味着共享同一次异步计算，但自增 Token 却单方面废黜了该次计算的合法性。

**数学自洽的解决方案**：
在存在飞行中任务时，**禁止自增请求令牌，而是直接共享当前飞行任务关联的活跃令牌**：
```typescript
/** 触发带状态机与双源优先级的会话正文水合 */
export async function coordinateSessionHydration(
  sessionId: string,
  get: SessionStoreGet,
  set: SessionImmerSet,
  options?: { isExplicitSwitch?: boolean }
): Promise<void> {
  if (!sessionId || sessionId.startsWith('__draft_')) return;

  const globalToken = options?.isExplicitSwitch ? bumpHydrateGeneration() : -1;

  // 核心修正：若当前会话已有任务在飞行中，直接复用其 Promise，严禁提前 bumpToken！
  const flightKey = sessionId;
  if (inFlightMap.has(flightKey)) {
    return inFlightMap.get(flightKey);
  }

  // 无飞行任务时，正式开启新一代请求，领新令牌
  const sessionToken = bumpSessionToken(sessionId);

  const task = (async () => {
    ...
  })().finally(() => {
    inFlightMap.delete(flightKey);
  });

  inFlightMap.set(flightKey, task);
  return task;
}
```
通过将 `bumpSessionToken` 移入 `inFlightMap` 未命中分支之后，保证每个真实启动的异步任务与唯一的 `sessionToken` 严格一一对应，彻底消除假死锁。

---

## 四、极端竞态与高吞吐压力测试模型

### 4.1 100 tokens/s 超高吐字率下的排队论模型

#### 4.1.1 参数标定
- **文本到达率（Arrival Rate）**：
  $$\lambda = 100 \text{ tokens/s} = 0.1 \text{ tokens/ms} \quad (\text{平均到达间隔 } T_{\text{arr}} = 10\text{ms})$$
- **Worker/Rust 解析延迟（Service Time）**：
  $$S = 50\text{ms} \implies \mu = \frac{1}{50\text{ms}} = 0.02 \text{ jobs/ms}$$
- **交通强度（Traffic Intensity）**：
  $$\rho = \frac{\lambda}{\mu} = \frac{0.1}{0.02} = 5.0 \gg 1.0$$

在经典排队论中，当 $\rho > 1$ 时，若系统采取无缓冲或无丢弃的单分发模型，排队队长 $L_q(t)$ 将随时间线性发散：
$$L_q(t) \sim (\lambda - \mu)t = 0.08 t \quad (\text{每秒钟积压 } 80 \text{ 个未完成解析任务})$$
这将导致浏览器主线程与 Web Worker 线程池在数秒内耗尽内存崩溃。

---

### 4.2 本套方案的多级背压吸收机制有效性审查

审查总方案与分维详案在这一极端工况下的实际运作管道：

```
[IPC / SSE Chunks (100 tokens/s, 每 10ms 灌入)]
                       │
                       ▼
┌────────────────────────────────────────────────────────┐
│ Level 1: StreamRenderBuffer (物理帧吸收级)              │
│  - 脉冲时钟: requestAnimationFrame (16.6ms @60Hz)      │
│  - 降频比: 100 次/s 灌入 -> 刚性收敛至 <= 60 次/s 派发   │
│  - 帧预算约束: 6ms / 1024 chars 超额切分下一帧          │
└──────────────────────┬─────────────────────────────────┘
                       │ onFrame (每 16.6ms 派发 1 次)
                       ▼
┌────────────────────────────────────────────────────────┐
│ Level 3: IncrementalBlockSplitter (块级隔离级)         │
│  - 历史块 memo 冻结，仅尾块草稿消费 delta                │
│  - Worker 编译仅对尾块未封口片段执行 (通常 < 300 字符)    │
└──────────────────────┬─────────────────────────────────┘
                       │
                       ▼
┌────────────────────────────────────────────────────────┐
│ Level 4: useStreamingMarkdownHtml (原子批与世代丢弃级)  │
│  - advanceBatchIdRef 世代流水号                        │
│  - 第 k 帧在 50ms 后返回时，批次已更新为 k+3           │
│  - 自动丢弃 k 帧的 React 重渲染 (Drop Stale Render)    │
└────────────────────────────────────────────────────────┘
```

#### 背压吸收效能评估：
1. **输入频率削峰**：`StreamRenderBuffer` 成功将 100Hz 的网络输入削峰为 60Hz 的稳定物理帧脉冲；
2. **React 渲染保底**：`advanceBatchIdRef` 成功将陈旧帧的 React 状态更新过滤掉，界面重渲染频率始终不超过物理刷新率（$\le 60\text{FPS}$）；
3. **计算复杂度收敛**：尾块隔离将计算负荷限制在常数上界 $O(1)$。

---

### 4.3 潜在的 Worker 线程池饥饿隐患与防御方案（Optimization R1）

#### 遗留隐患分析：
尽管 React 渲染层通过 `advanceBatchIdRef` 丢弃了过期回执，但**派发给 Web Worker / Rust 的异步解析任务本身并未在底层被取消**！
在 100 tokens/s 极端吐字下，虽然 UI 只渲染最新的帧，但 Worker 依然在后台苦苦计算已经被丢弃的第 $k-1$、$k-2$ 帧历史分片。这会导致 Worker 线程队列积压，使得最新第 $k+3$ 帧的解析延迟进一步恶化。

#### 建议改优化方案（Optimization R1）：
在 `markdownRenderAsync.ts` 或 Web Worker 通信通道中引入**带世代令牌的任务丢弃机制（Worker Request Coalescing）**：
```typescript
interface WorkerMarkdownTask {
  requestId: number;
  batchId: number;
  markdown: string;
}
```
当 Worker 消息队列中积压了多个同一块的解析任务时，Worker 在取出任务处理前比对当前最大 `batchId`：若发现队列中有更新的同组件批次，直接跳过旧任务并返回空结果，释放 CPU 算力给最新帧，实现真正的全链路算力背压。

---

## 五、对各详案的具体修正建议与对齐检查

| 详案文档 | 涉及模块 | 当前方案设计 | 评审发现的时序/状态机问题 | 修正意见与修改位置 |
| :--- | :--- | :--- | :--- | :--- |
| **01-消息因果时序** | `sessionActivateHydrate.ts` | 引入 `bumpHydrateGeneration` 与 `isHydrateGenerationCurrent` | 缺乏会话级请求令牌，高频 $A \to B \to A$ 时仅凭全局令牌无法阻断内部游标倒流 | 必须与 09 案的 `sessionRequestTokenMap` 深度对齐，形成双层 Token 校验闭环。 |
| **02-Markdown封口** | `MarkdownBlockItem.tsx` | 四态机切换，`isSealingTransition = isSealed && !hasAuth && lockedUnits` | 用户点击 Stop 导致流式中断（Abort）时，`isSealed` 为 `false` 且 `isStreaming` 为 `false`，状态悬空导致文字瞬间塌陷为 `""`（**缺陷 C2**） | 落地“隐式封口”规则：`isEffectivelySealed = isSealed \|\| (!isStreaming && lockedUnits)`。见 §2.3。 |
| **03-微任务批合并** | `markdownRenderAsync.ts` | `advanceBatchIdRef` 批收口，`Promise.all` 决议前不论是否最新均执行 `resolveTextPart` | 过期旧分片回填底层 `session` 可能污染新批次的词法状态 | 将 `session.resolveTextPart` 移入 `if (isLatest)` 守卫内执行。见 §3.1.3。 |
| **04-虚拟滚动解耦** | `useVirtualScroll.ts` | `performProgrammaticScroll` 使用单帧 rAF 哨兵清空 `active = false` | Chromium 滚动事件若延迟超过 1 帧派发，哨兵早泄将导致程序吸底被误判为物理手势（**缺陷 C3**） | 改造为“单次事件命中自销毁 + 双帧兜底（doubleRaf）超时”。见 §3.2.3。 |
| **09-懒水合状态机** | `sessionHydrationCoordinator.ts` | 同时使用 `inFlightMap` 与 `bumpSessionToken` | 二次点击复用飞行 Promise 时，由于 Token 已被自增，导致 Promise 返回时被判定过期而直接丢弃，陷入永久骨架屏死锁（**缺陷 C1**） | 调整执行顺序：命中 `inFlightMap` 时直接返回，仅在未命中启动新任务时自增 `sessionToken`。见 §3.3.2。 |

---

## 六、评审结论汇总清单（给主控）

遵循 `docs/agent-roles/general_task/三原则.md`，给出明确、客观、不可妥协的工程裁决清单：

### 1. 必须改（Critical Deficiencies — 阻断级工程缺陷）

1. **【必须改 C1】修复懒水合协调器中 `inFlightMap` 与 `sessionToken` 对抗导致的永久骨架屏死锁**
   - **位置**：`apps/crish-desktop/src/store/sessionHydrationCoordinator.ts`（详案 09 §4.3）；
   - **根因**：高频点击同会话时，复用飞行 Promise 但 Token 已自增，导致任务完成时被误判过期抛弃；
   - **整改要求**：将 `bumpSessionToken(sessionId)` 移至 `inFlightMap.has()` 检查之后，仅在真正派发新 I/O 任务时领号。

2. **【必须改 C2】补全 MarkdownBlockItem 在取消流式（Abort）时的状态机闭包，杜绝白屏**
   - **位置**：`apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx`（详案 02 §4.2）；
   - **根因**：用户点击停止使 `isStreaming \to false`，但 `isSealed` 仍为 `false`，派生 `effectiveHtml` 算为 `""`；
   - **整改要求**：引入 `isEffectivelySealed = isSealed || (!isStreaming && Boolean(lockedUnitsRef.current))`，使中断会话平滑进入快照锁存保护。

3. **【必须改 C3】加固 `performProgrammaticScroll` 令牌生命周期，防止单帧哨兵早泄引发手势误判**
   - **位置**：`apps/crish-desktop/src/hooks/useVirtualScroll.ts`（详案 04 §3.3）；
   - **根因**：单帧 rAF 哨兵在 Chromium 延迟派发 `scroll` 事件时会提前失效，将程序滚动误判为手势；
   - **整改要求**：建立“匹配事件消费即销毁 + 延迟双帧（doubleRaf）兜底超时”的健壮状态机。

---

### 2. 建议改（Architectural Enhancements — 提升极端鲁棒性）

1. **【建议改 R1】在 Web Worker 语法解析通道增加批次丢弃协议（Backpressure Coalescing）**
   - **位置**：`apps/crish-desktop/src/workers/markdownWorker.ts` 及调用层（详案 03 §4.1）；
   - **理由**：在 100 tokens/s 极端压力下，主动丢弃 Worker 积压队列中的陈旧批次任务，避免 Worker 线程池算力饥饿。

2. **【建议改 R2】隔离过期异步分片对 `IncrementalMarkdownSession` 内部状态的回填**
   - **位置**：`apps/crish-desktop/src/api/markdownRenderAsync.ts`（详案 03 §5.1）；
   - **理由**：仅当批次令牌最新时才执行 `session.resolveTextPart`，保证 AST 纯净性。

3. **【建议改 R3】会话完全重写（Regenerate）时显式重置 MarkdownBlockItem 锁存器**
   - **位置**：`apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx`（详案 02 §4.2）；
   - **理由**：当输入文本非前缀增长而是完全改变时，显式释放旧的 `lockedUnitsRef`，杜绝旧文本幽灵快照。

4. **【建议改 R4】引擎事件投影写回 SQLite 前增加会话存活校验**
   - **位置**：`apps/crish-desktop/src/store/sessionHydrationCoordinator.ts`（详案 09 §4.3）；
   - **理由**：在 `saveSessionBody` 异步落库前检查会话是否已被用户删除，杜绝孤儿/僵尸数据残留。

---

### 3. 可接受风险（Accepted Trade-offs — 架构可控妥协）

1. **【可接受风险 A1】语法高亮到达稳态时的子像素级高度微差（$< 1\text{px}$）**
   - **说明**：Worker 编译完成注入 Prism/Highlight.js 标签后，字体行高在某些系统字体下可能产生 $<1\text{px}$ 亚像素变动；
   - **裁决**：外层容器已设置 `line-height` 与盒模型固定，此差异不会引发虚拟滚动列表跳变，收益大于代价，属于可接受物理微调。

2. **【可接受风险 A2】极速切 Tab 时本地 SQLite 内存数据可能暂未包含未落盘的流式尾巴**
   - **说明**：Phase 1 优先水合本地 SQLite 保证了 1~3ms 极速秒开；若上一个会话有刚刚生成的几个 token 尚未写入 SQLite，会在进入前台后由引擎事件流增量对账补齐；
   - **裁决**：优先保障切 Tab 的零感知极速切换体验，数据最终一致性由增量对账闭环覆盖。
$$
