# Phase 1 Gap 诊断报告 - Agent 2：并发与状态机域

> **审计实施者**: Agent 2 (并发 / 状态机域专家)
> **诊断对象**: Conex 代码库 (`packages/agent-runtime`、`packages/agent-daemon`、`packages/agent-orchestrator`、`crates/`、`apps/crish-desktop`)
> **标杆参照**: `C:\Software\conex\analysis\reference_patch_audits\` (6 份开源标杆补丁审计报告：OpenCode, OpenCodex, Cline, Claude Code, Agent Frameworks, Desktop Runtimes)
> **报告路径**: `C:\Software\conex\analysis\conex_gap_audits\conex_gap_02_concurrency_state.md`

---

## 1. 诊断综述与标杆对齐

在现代多 Agent 协同 AI Coding 系统中，并发控制与状态机治理是保障系统高可用、高可靠与高安全性的核心护城河。参照行业标杆项目（如 OpenCode、OpenCodex、Claude Code、Cline 等）的生产级缺陷修复历史，Agent 系统的并发与状态机缺陷往往表现为：用户打断失效导致的孤儿进程狂飙、Subagent 无限递归导致的内存/Token 暴涨、OAuth Refresh Token 并发重放引发的账号 401 锁定、网络微弱抖动导致的假死冷却，以及 Context/Stack 状态泄露导致的会话穿透。

针对 Conex 代码库中并发与状态机域的 5 大核心维度，本审计展开了源码级别的深入排查。审计发现 Conex 虽然在单进程 Shell 命令杀树与部分 Tool 中实现了 `AbortController` 传递，但在**后台 Subagent 级联杀死**、**后台 Shell 任务取消机制**、**Orchestrator 活跃 Runs 强制淘汰**、**OAuth 单次 Token 刷脸 Intent 锁的实际装配**、**流式中途 TCP Reset 暂态分类** 以及 **AsyncLocalStorage 上下文安全重置** 方面存在严重隐患。

---

## 2. 诊断重点 1：用户打断（Abort/Cancel）树状信号秒级级联杀死机制

### 2.1 标杆补丁对齐
参照 `patch_analysis_05_desktop_agent_runtimes.md` 与 `patch_analysis_01_opencode_opencodex.md` 中关于终止控制链的标杆经验：
- 当用户在 UI 界面点击 Cancel / Abort 时，根 `AbortController` 必须立即发出 `abort` 信号。
- 根信号必须沿 Agent 树、Tool 调度树、Task 树与进程树秒级级联向下传递，同步杀死所有派生的 foreground/background 子 Agent、STDIO MCP 外部进程、Shell 子进程树以及异步轮询任务。

### 2.2 Conex 现状与真实缺陷隐患

#### 缺陷 1.1：后台 Subagent (forkMode: "background") 的 Abort 监听器被 Premature 解绑，导致 Cancel 信号无法传递
- **具体文件路径**: [subagent-runtime.ts](file:///C:/Software/conex/packages/agent-daemon/src/subagent-runtime.ts#L208-L238)
- **代码段定位**: `packages/agent-daemon/src/subagent-runtime.ts` 第 216-238 行
- **源码分析**:
  ```typescript
  if (forkMode === "background") {
    emitBridge({ ...base, phase: "started" });
    consumeSubagentEvents(handle.events, base, emitBridge, state)
      .catch((cause) => { ... })
      .finally(() => {
        context.signal.removeEventListener("abort", onAbort); // 👈 在消费流的 finally 中解绑
        ...
      });
    return {
      text: `Sub-agent started in background: ${subagentRunId}`,
      json: { ... }
    };
  }
  ```
  在 `run_subagent` 工具以 `forkMode: "background"` 运行时，工具的 `execute()` 函数在第 238 行同步返回 `{ subagentRunId, status: "running" }`，这意味着父层工具调用的执行上下文（`context`）随之结束。
  父层 Turn 结束后，`context.signal` 即被释放或解绑。若用户在后续 Turn 或稍后点击界面上的 Cancel 按钮，取消信号通过父 Run 的 `AbortController` 发出时，后台 Subagent 的 `onAbort` 监听器**早已在 tool execution 完成时被 removeEventListener 解除**！
- **缺陷后果**: 用户点击打断后，后台运行的 Subagent 无法接收到 `parent-run-aborted` 信号，继续在后台疯狂消耗 LLM Token 并执行文件修改，变成不受控制的“僵尸 Subagent”。

#### 缺陷 1.2：后台 Shell 任务 (`BackgroundCommandManager`) 与 Run 的 AbortSignal 彻底脱节
- **具体文件路径**: [background-command.ts](file:///C:/Software/conex/packages/agent-runtime/src/background-command.ts#L111-L145) & [orchestrator.ts](file:///C:/Software/conex/packages/agent-orchestrator/src/orchestrator.ts#L322-L332)
- **代码段定位**: `packages/agent-runtime/src/background-command.ts` 第 111-145 行，`packages/agent-orchestrator/src/orchestrator.ts` 第 322-332 行
- **源码分析**:
  `BackgroundCommandManager` 管理由 `background_command_start` 工具启动的长期后台 shell 进程。
  但在 `orchestrator.ts` 中处理 `cancelRun()` 时：
  ```typescript
  cancelRun(runId: string, reason = "cancelled-by-user"): boolean {
    const active = this.activeRuns.get(runId);
    const run = this.runs.get(runId);
    if (!run || !active) return false;
    if (isTerminalRunStatus(run.status)) return false;

    this.updateRun(run, "cancelling");
    active.engine?.abort(reason); // 👈 仅调用了 engine.abort
    this.emitToRun(active, "run-cancel-requested", { reason });
    return true;
  }
  ```
  `cancelRun` 仅通知了 `active.engine?.abort(reason)`，而没有通知该 Run 所绑定的 `BackgroundCommandManager` 终止其派生的后台 Shell 子进程（`BackgroundCommandRecord.child`）。
- **缺陷后果**: 当用户取消一个正在跑大型后台任务（如 `npm test` 或 long-running compiler）的会话时，底层进程树在后台继续运行，造成 CPU/内存泄漏，甚至锁住文件或端口。

---

## 3. 诊断重点 2：Subagent 递归调用硬性深度限制与并发 Live Agent 槽位门禁

### 3.1 标杆补丁对齐
参照 `patch_analysis_01_opencode_opencodex.md` Commit `285d315b4e5`（Subagent 嵌套深度限制）与 `patch_analysis_03_agent_frameworks.md`（并发 Worker 限流）：
- Subagent 派生必须严格沿着 Ancestor 节点树计算 `depth`，默认 `maxDepth = 1 ~ 2`，超过阈值硬阻断。
- 必须具备全局并发 Live Agent 槽位门禁（如 `max 32` 或 `Semaphore` 信号量），防止多 Turn / 多分支衍生出上百个并发 Agent 挤爆服务器资源与 Token 配额。

### 3.2 Conex 现状与真实缺陷隐患

#### 缺陷 2.1：`activeRuns` 采用 `BoundedMap` 造成超限时活跃 Run 被隐蔽删除（Ghost Run 内存与逻辑失控）
- **具体文件路径**: [orchestrator.ts](file:///C:/Software/conex/packages/agent-orchestrator/src/orchestrator.ts#L57-L59) & [bounded-map.ts](file:///C:/Software/conex/packages/shared-utils/src/bounded-map.ts#L48-L58)
- **代码段定位**: `packages/agent-orchestrator/src/orchestrator.ts` 第 59 行
- **源码分析**:
  `Orchestrator` 使用 `BoundedMap<string, ActiveRun>` 来存储当前活跃的 Runs：
  ```typescript
  private readonly activeRuns = new BoundedMap<string, ActiveRun>(MAX_ORCHESTRATOR_RUNS);
  ```
  `BoundedMap.set(key, value)` 的淘汰逻辑如下（`bounded-map.ts` 第 49-56 行）：
  ```typescript
  set(key: K, value: V): this {
    if (!this.map.has(key) && this.map.size >= this.capacity) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey); // 👈 隐式淘汰最旧条目！
      }
    }
    this.map.set(key, value);
    return this;
  }
  ```
  当 Subagent 递归派生或并发运行数达到 `MAX_ORCHESTRATOR_RUNS` 时，`activeRuns.set()` **直接淘汰最旧的 `ActiveRun`**，既没有调用最旧 Run 的 `engine.abort()`，也没有关闭其事件监听器。
- **缺陷后果**: 最旧的 `ActiveRun` 被从 `activeRuns` Map 中剔除后，变成了无从追踪的 **Ghost Run**。由于它已不在 Map 中，UI 无法察觉其存在，用户调用 `cancelRun(oldRunId)` 时因 `!active` 直接返回 `false`，导致 Ghost Run 在后台无限期占用 CPU/Token 运行，系统失去对其的任何掌控力！

#### 缺陷 2.2：`agent-daemon` 的 `createDaemonSubagentTool` 缺少全局 Live Agent 槽位门禁
- **具体文件路径**: [subagent-runtime.ts](file:///C:/Software/conex/packages/agent-daemon/src/subagent-runtime.ts#L85-L122)
- **代码段定位**: `packages/agent-daemon/src/subagent-runtime.ts` 第 85-122 行
- **源码分析**:
  虽然 `packages/agent-runtime/src/subagents.ts` 中定义了 `activeSubagentCount` 与 `maxConcurrent`（默认 6），但是在 Daemon 运行时 (`agent-daemon`) 使用的 `createDaemonSubagentTool`（`packages/agent-daemon/src/subagent-runtime.ts`）中：
  ```typescript
  async execute(input, context): Promise<ToolOutput> {
    if (options.depth >= maxDepth) {
      throw new Error(`Maximum sub-agent depth (${maxDepth}) reached`);
    }
    // 👈 此处完全没有检查全局 Live Agent 槽位与并发上限！
    ...
  ```
  只要 `options.depth < maxDepth`（默认上限 32），Daemon 会毫无节制地通过 `startRun` 创建新的 Subagent Run。
- **缺陷后果**: 当 LLM 在单个 Turn 中连续发出多个 `run_subagent` 工具调用，或者多个 Session 同时派生 Subagent 时，活跃 Live Agent 数量会爆发式增长，引发系统的 OOM 崩溃或供应商 API 429 严厉限流。

---

## 4. 诊断重点 3：OAuth Token 刷新单次 Generation-Bound 意图锁防重放

### 4.1 标杆补丁对齐
参照 `patch_analysis_01_opencode_opencodex.md` Commit `0de138aa61a`（Anthropic 单次 OAuth Token 刷脸持久化锁）：
- 像 Anthropic / ChatGPT 等 OAuth API 的 Refresh Token 具备严格的“单次使用即作废”（Single-use refresh token）机制。
- 当客户端发起 Token 刷新时，必须在刷新前将当前 Refresh Token 的 Hash 标识（Generation ID）原子化写入文件锁/意图锁（`Generation-Bound Intent Lock`）。
- 多个并发 Subagent 或多进程遇到 401 时，只有拿到 Generation 锁的请求才能向服务器发送刷脸请求；其余并发请求必须 Single-flight 挂起等待最新 Token，禁止重放旧 Refresh Token。

### 4.2 Conex 现状与真实缺陷隐患

#### 缺陷 3.1：`CrossProcessLock` 被设计但未在 OAuth 刷新链条中装配（孤儿组件）
- **具体文件路径**: [cross-process-lock.ts](file:///C:/Software/conex/packages/agent-runtime/src/provider/auth/oauth/cross-process-lock.ts#L16-L72) & [chatgpt-pool.ts](file:///C:/Software/conex/packages/agent-runtime/src/provider/auth/oauth/chatgpt-pool.ts#L178-L201)
- **代码段定位**: `packages/agent-runtime/src/provider/auth/oauth/cross-process-lock.ts` 第 16-72 行
- **源码分析**:
  Conex 编写了包含 `generation` 校验能力的 `CrossProcessLock`（`cross-process-lock.ts`）：
  ```typescript
  export class CrossProcessLock {
    async acquire(expectedGeneration?: number, timeoutMs = ACQUIRE_TIMEOUT_MS): Promise<boolean> { ... }
    release(newGeneration?: number): void { ... }
  }
  ```
  然而，检索整个代码库，`CrossProcessLock` **未在 `ChatGPTAccountPool.refreshAccount()`、`TokenGuardian` 或任何 Provider Auth 模块中被引入或使用**！
  在 `chatgpt-pool.ts` 第 178 行的 `refreshAccount` 实现中：
  ```typescript
  async refreshAccount(accountId: string): Promise<boolean> {
    const account = this.accounts.find(a => a.id === accountId);
    if (!account || !account.refreshToken) return false;

    try {
      const response = await this.oauthFlow.refreshToken(account.refreshToken); // 👈 直接裸奔发起 HTTP 刷新
      account.accessToken = response.accessToken;
      account.refreshToken = response.refreshToken ?? account.refreshToken;
      ...
  ```
- **缺陷后果**:
  1. `CrossProcessLock` 成为代码死角与纸面死锁工具。
  2. 当多个并发运行的 Subagent 同时收到 401 错误并触发 `refreshAccount` 时，两个异步任务会同时拿旧的 `account.refreshToken` 向 OAuth 服务器发送刷新请求。
  3. 第一个请求成功，Refresh Token 刷新；第二个请求发送了已失效的旧 Refresh Token，OAuth 服务器直接返回 `invalid_grant` 401 错误！
  4. `refreshAccount` catch 块捕获到错误后，`account.errorCount++`；满 3 次后将健康账号标记为 `status = "error"` 并置灰！账号被永久锁定，迫使用户重新手动登录。

---

## 5. 诊断重点 4：Mid-stream Connection Reset 暂态重分类与指数退避冷却

### 5.1 标杆补丁对齐
参照 `patch_analysis_01_opencode_opencodex.md` Commit `87be0d8761f` 与 `patch_analysis_02_cline_claudecode.md`：
- 在 HTTP SSE 流式传输中途，网络抖动或 TCP Reset (`ECONNRESET` / `socket hang up` / `fetch failed`) 是极其常见的暂态网络故障（Transient Network Error）。
- 系统必须区分 **"首 byte 前错误"** 与 **"中途断流错误"**，对网络暂态重试采用指数退避冷却机制，严禁将暂态网络断流误判为账号 Auth/Quota 硬失效，从而将健康账号封禁入 Cooling / Error 池。

### 5.2 Conex 现状与真实缺陷隐患

#### 缺陷 4.1：流式中途哪怕产生 1 个字符，TCP Reset 即被硬归类为 Case B 并抛错放弃重试
- **具体文件路径**: [stream-recovery.ts](file:///C:/Software/conex/packages/agent-runtime/src/provider-transport/stream-recovery.ts#L363-L376)
- **代码段定位**: `packages/agent-runtime/src/provider-transport/stream-recovery.ts` 第 363-376 行
- **源码分析**:
  在 `StreamRecovery.decideRecovery()` 恢复决策函数中：
  ```typescript
  // 情况 B：AI 已输出部分文字 — 不重试
  if (this.accumulator.text.length > 0 || this.accumulator.thought.length > 0) {
    const contentDesc = ...;
    return {
      action: {
        type: "surface-error",
        message: `响应被中断（已输出 ${contentDesc}）。请检查网络后重试。`,
      },
      diagnostic: `流中断时已有内容输出（${contentDesc}），不重试以避免模型重复`,
    };
  }
  ```
  如果大模型在流式输出过程中已经输出了哪怕 1 个字符（如 `"H"`），此时底层 TCP 连接由于网络波动发生 `ECONNRESET` 或中途断连，`stream-recovery.ts` 盲目判定为 **Case B**，拒绝进行任何备用通道重试或断点续传（No transient retry / backoff），直接中断流并向上层抛出 `StreamRecoveryError`。

#### 缺陷 4.2：上层账号池将暂态流中断误判为 Auth / Server 错误并对账号实施惩罚冷却
- **具体文件路径**: [chatgpt-pool.ts](file:///C:/Software/conex/packages/agent-runtime/src/provider-auth/oauth/chatgpt-pool.ts#L158-L176)
- **代码段定位**: `packages/agent-runtime/src/provider/auth/oauth/chatgpt-pool.ts` 第 158-176 行
- **源码分析**:
  ```typescript
  recordFailure(accountId: string, errorType: "auth" | "quota" | "timeout" | "server"): void {
    const account = this.accounts.find(a => a.id === accountId);
    if (!account) return;
    account.errorCount++;
    const cooldowns: Record<string, number> = {
      auth: 5 * 60 * 1000,
      quota: 60 * 60 * 1000,
      timeout: 30 * 1000,
      server: 60 * 1000,
    };
    account.cooldownUntil = Date.now() + (cooldowns[errorType] ?? 60000);
    ...
  ```
  当 `StreamRecoveryError` 抛出给上层 Gateway 后，Gateway 无法辨识这是暂态网络 Reset，而将其归类为 `"server"` 或 `"auth"` 异常，并调用 `recordFailure(accountId, "auth")` 或 `"server"`。
- **缺陷后果**: 仅仅因为一次正常的网络微小抖动，完全正常的账号被惩罚进入 5 分钟到 1 小时的 `cooldownUntil` 冷却池。在多 Agent 协同场景下，频繁的微小抖动会导致账号池中的可用账号被迅速“误杀”殆尽，导致整体任务死锁。

---

## 6. 诊断重点 5：ContextVar / 堆栈状态重置管理的彻底性

### 6.1 标杆补丁对齐
参照 `patch_analysis_05_desktop_agent_runtimes.md`（状态闭包锁与清理）与 `patch_analysis_03_agent_frameworks.md`（AsyncLocalStorage / ContextVar 隔离）：
- 异步上下文（Node.js `AsyncLocalStorage` 或 Python `ContextVar`）必须使用显式作用域包裹（如 `als.run(store, fn)`）。
- 严禁使用未包含恢复/重置逻辑的全局单例写入（如 `enterWith()`），防止并发请求或异常抛出后，上下文在事件循环线程中发生跨请求串扰（State Pollution）。
- 模块级全局变量必须在会话结束/失败时通过 `finally` 保证原子重置。

### 6.2 Conex 现状与真实缺陷隐患

#### 缺陷 5.1：`setTraceContext` 滥用 `AsyncLocalStorage.enterWith` 导致跨请求 TraceId/Session 状态污染
- **具体文件路径**: [trace/index.ts](file:///C:/Software/conex/packages/agent-runtime/src/trace/index.ts#L344-L350)
- **代码段定位**: `packages/agent-runtime/src/trace/index.ts` 第 344-350 行
- **源码分析**:
  ```typescript
  export function setTraceContext(context: TraceContext | undefined): void {
    // 此方法仅用于非 ALS 管理的场景（如顶层入口点）
    // 在 ALS 管理的上下文中，应使用 withTraceContext
    if (context) {
      traceContextStorage.enterWith(context); // 👈 极度危险的 enterWith 调用
    }
  }
  ```
  根据 Node.js 官方文档与最佳实践，`AsyncLocalStorage.prototype.enterWith()` 会永久改变当前异步资源及其所有后续微任务（Microtasks）的 Store，且**无法自动在函数退出或异常抛出时恢复旧 Store**。
  当 Daemon 进程在一个 Node.js 事件循环线程中处理来自 Session A 的请求时，若调用了 `setTraceContext(ctxA)`，该线程后置执行的所有非 `withTraceContext` 异步回调（包括其他并发 Session B 的 Event Driven Handlers）都将被强制带上 Session A 的 `TraceContext`（包含 `traceId`、`sessionId` 等）！
- **缺陷后果**: 日志、审计事件与 Trace 追踪链条发生严重串扰，Session B 的操作日志被归入 Session A，造成调试灾难与多租户/多会话隐私数据泄漏隐患。

#### 缺陷 5.2：`subagents.ts` 模块级全局变量 `activeSubagentCount` 存在死锁漂移隐患
- **具体文件路径**: [subagents.ts](file:///C:/Software/conex/packages/agent-runtime/src/subagents.ts#L53-L55)
- **代码段定位**: `packages/agent-runtime/src/subagents.ts` 第 54 行
- **源码分析**:
  ```typescript
  /** 模块级全局活跃 subagent 计数（跨工具实例共享） */
  let activeSubagentCount = 0;
  ```
  `activeSubagentCount` 被定义为 ESM 模块级全局 `let` 变量。
  在 `createSubagentTool` 的 `execute` 中：
  ```typescript
  if (activeSubagentCount >= maxConcurrent) { return ...; }
  activeSubagentCount += 1;
  ```
  虽然在第 312 行有 `finally { activeSubagentCount = Math.max(0, activeSubagentCount - 1); }`，但是在 `activeSubagentCount += 1` 之后、进入 `try` 块之前（例如在第 201-226 行解构或初始化变量抛出同步异常），代码将跳过 `try...finally` 块！
- **缺陷后果**: `activeSubagentCount` 增加后未能扣减，造成全局计数器的**单调永久递增漂移**。一旦漂移累积达到 `maxConcurrent`（默认 6），整个 Daemon 进程将永久拒绝创建任何新的 Subagent，提示 `max-concurrent-exceeded`，除非重启 Daemon！

---

## 7. 重点缺陷重构对比代码与 Vitest / Cargo 测试断言规范

### 7.1 缺陷 1.1 / 1.2（用户打断级联杀死）修复前后代码对比与 Vitest 测试断言

#### 缺陷 1.1 修复前后代码对比 (`packages/agent-daemon/src/subagent-runtime.ts`)
```typescript
// ❌ 重构前：Tool execute 返回后 immediately unhook 监听器
if (forkMode === "background") {
  const onAbort = () => options.cancelRun(handle.runId, "parent-run-aborted");
  context.signal.addEventListener("abort", onAbort, { once: true });
  consumeSubagentEvents(...).finally(() => {
    context.signal.removeEventListener("abort", onAbort); // 👈 Tool execute 返回即解绑，后续父 Run Cancel 失效
  });
  return { text: "started in background" };
}

// ✅ 重构后：将 Abort 信号监听绑定到 Session/Run 级别的生命周期，而非 transient tool execution context
if (forkMode === "background") {
  // 从 SessionRuntimeManager 获取当前父 Run 的根 Session AbortSignal
  const parentRunSignal = options.getParentRunSignal(options.parentRunId);
  const onParentAbort = () => {
    options.cancelRun(handle.runId, "parent-run-aborted");
  };

  if (parentRunSignal.aborted) {
    onParentAbort();
  } else {
    parentRunSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  consumeSubagentEvents(handle.events, base, emitBridge, state)
    .finally(() => {
      // 只有在 Subagent 自身运行终态时才清理父 Run 信号监听
      parentRunSignal.removeEventListener("abort", onParentAbort);
      emitBridge({ ...base, phase: "ended", status: state.status });
    });

  return { text: "started in background", json: { subagentRunId, status: "running" } };
}
```

#### 缺陷 1.2 修复前后代码对比 (`packages/agent-orchestrator/src/orchestrator.ts`)
```typescript
// ❌ 重构前：cancelRun 仅中断 LLM engine，遗漏后台 Shell 进程池
cancelRun(runId: string, reason = "cancelled-by-user"): boolean {
  const active = this.activeRuns.get(runId);
  if (!active) return false;
  this.updateRun(run, "cancelling");
  active.engine?.abort(reason); // 👈 仅终止引擎，BackgroundCommandManager 中的子进程无管辖
  return true;
}

// ✅ 重构后：联动 BackgroundCommandManager 强制杀死关联的 Process Tree
cancelRun(runId: string, reason = "cancelled-by-user"): boolean {
  const active = this.activeRuns.get(runId);
  if (!active) return false;

  this.updateRun(active.run, "cancelling");

  // 1. 中断 LLM Session Loop
  active.engine?.abort(reason);

  // 2. 秒级级联清理该 Run 挂接的所有后台 Shell 进程
  const bgManager = this.options.getBackgroundCommandManager?.(active.run.cwd);
  if (bgManager) {
    bgManager.cancelAllForRun(runId, reason);
  }

  this.emitToRun(active, "run-cancel-requested", { reason });
  return true;
}
```

#### 缺陷 1.1 & 1.2 Vitest 测试断言规范 (`packages/agent-daemon/src/subagent-runtime.test.ts`)
```typescript
describe("User Abort Signal Cascade", () => {
  it("should terminate background subagents when parent run is cancelled long after tool execution finished", async () => {
    const parentController = new AbortController();
    const mockCancelRun = vi.fn();

    // 1. 启动后台 Subagent
    const tool = createDaemonSubagentTool({
      parentRunId: "run-parent-01",
      parentSessionId: "sess-01",
      cwd: "/test",
      depth: 0,
      permissionMode: "full-access",
      getParentRunSignal: () => parentController.signal,
      startRun: async () => ({ runId: "subrun-bg-01", events: (async function* () { yield* []; })() }),
      cancelRun: mockCancelRun,
    });

    const result = await tool.execute({ prompt: "background task", forkMode: "background" }, mockContext);
    expect(result.json?.status).toBe("running");

    // 2. 模拟 Tool Execution 上下文结束，500ms 后用户在 UI 点击 Cancel
    await new Promise(r => setTimeout(r, 500));
    parentController.abort("user-click-cancel");

    // 3. 断言后台 Subagent 被秒级级联杀死
    expect(mockCancelRun).toHaveBeenCalledWith("subrun-bg-01", "parent-run-aborted");
  });

  it("should kill background command process tree when orchestrator cancels a run", async () => {
    const manager = new BackgroundCommandManager({ workspaceRoot: process.cwd() });
    const task = await manager.start({ command: "node -e 'setInterval(()=>{},1000)'" });
    manager.bindTaskToRun(task.id, "run-parent-02");

    // 触发 Orchestrator 取消
    orchestrator.cancelRun("run-parent-02", "cancelled-by-user");

    const snapshot = manager.getTask(task.id);
    expect(snapshot?.state).toBe("cancelled");
    expect(snapshot?.signal).toBe("SIGTERM");
  });
});
```

---

### 7.2 缺陷 3.1（OAuth 代际意图锁）修复前后代码对比与 Vitest 测试断言

#### 缺陷 3.1 修复前后代码对比 (`packages/agent-runtime/src/provider/auth/oauth/chatgpt-pool.ts`)
```typescript
// ❌ 重构前：裸奔并发调用 refreshToken，并发 401 时重放旧 Refresh Token 导致账号锁定
async refreshAccount(accountId: string): Promise<boolean> {
  const account = this.accounts.find(a => a.id === accountId);
  if (!account || !account.refreshToken) return false;
  try {
    const response = await this.oauthFlow.refreshToken(account.refreshToken);
    account.accessToken = response.accessToken;
    account.refreshToken = response.refreshToken ?? account.refreshToken;
    await this.persist();
    return true;
  } catch (err) {
    account.errorCount++;
    if (account.errorCount >= 3) account.status = "error"; // 👈 重放旧 Token 导致被踢为 error
    return false;
  }
}

// ✅ 重构后：装配 CrossProcessLock 与 Single-Flight Generation 刷新意图锁
private refreshInFlightPromises = new Map<string, Promise<boolean>>();

async refreshAccount(accountId: string): Promise<boolean> {
  const account = this.accounts.find(a => a.id === accountId);
  if (!account || !account.refreshToken) return false;

  // 1. Single-Flight 内存合并：并发请求共享同一个在飞的 Refresh Promise
  const existingPromise = this.refreshInFlightPromises.get(accountId);
  if (existingPromise) return existingPromise;

  const refreshPromise = (async () => {
    // 2. 构造代际标识 hash(refreshToken + expiresAt)
    const generation = hashString(`${account.refreshToken}::${account.expiresAt}`);
    const lock = new CrossProcessLock(os.tmpdir(), `oauth-refresh-${accountId}`);

    const acquired = await lock.acquire(generation, 10_000);
    if (!acquired) {
      // 未抢到锁说明已有同代际刷新在进行，等待并从磁盘/Store 重新加载最新 Token
      await this.reloadFromStore();
      return true;
    }

    try {
      const response = await this.oauthFlow.refreshToken(account.refreshToken);
      account.accessToken = response.accessToken;
      account.refreshToken = response.refreshToken ?? account.refreshToken;
      account.expiresAt = Date.now() + response.expiresIn * 1000;
      account.status = "active";
      account.errorCount = 0;

      const newGen = hashString(`${account.refreshToken}::${account.expiresAt}`);
      lock.release(newGen); // 写入新代际锁
      await this.persist();
      return true;
    } catch (err) {
      lock.release();
      account.errorCount++;
      if (account.errorCount >= 3) account.status = "error";
      return false;
    }
  })();

  this.refreshInFlightPromises.set(accountId, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    this.refreshInFlightPromises.delete(accountId);
  }
}
```

#### 缺陷 3.1 Vitest 测试断言规范 (`packages/agent-runtime/src/provider/auth/oauth/chatgpt-pool.test.ts`)
```typescript
describe("OAuth Single-Flight Generation-Bound Refresh Lock", () => {
  it("should single-flight 10 concurrent 401 refresh calls and make exactly 1 network request without invalid_grant errors", async () => {
    const pool = new ChatGPTAccountPool("http://localhost/callback");
    const account = makeAccount({ id: "acc-concurrent-01", refreshToken: "ref-initial-01", status: "active" });
    await pool.addAccount(account);

    let refreshNetworkCalls = 0;
    vi.spyOn(pool["oauthFlow"], "refreshToken").mockImplementation(async () => {
      refreshNetworkCalls++;
      await new Promise(r => setTimeout(r, 100)); // 模拟 100ms 网络延迟
      return { accessToken: "access-new", refreshToken: "ref-new-02", expiresIn: 3600 };
    });

    // 模拟 10 个并发 Subagent 同时遇到 401 触发 refreshAccount
    const results = await Promise.all(
      Array.from({ length: 10 }).map(() => pool.refreshAccount("acc-concurrent-01"))
    );

    // 断言网络刷线请求仅发生一次
    expect(refreshNetworkCalls).toBe(1);
    expect(results.every(r => r === true)).toBe(true);
    expect(pool.getAccount("acc-concurrent-01")?.accessToken).toBe("access-new");
    expect(pool.getAccount("acc-concurrent-01")?.errorCount).toBe(0);
    expect(pool.getAccount("acc-concurrent-01")?.status).toBe("active");
  });
});
```

---

### 7.3 缺陷 5.1 / 5.2（ContextVar 与堆栈管理）修复前后代码对比与 Vitest 测试断言

#### 缺陷 5.1 修复前后代码对比 (`packages/agent-runtime/src/trace/index.ts`)
```typescript
// ❌ 重构前：使用 enterWith 永久改变事件循环线程上下文，造成 Session 串扰
export function setTraceContext(context: TraceContext | undefined): void {
  if (context) {
    traceContextStorage.enterWith(context); // 👈 破坏异步上下文隔离
  }
}

// ✅ 重构后：废脱 enterWith，全链路强制使用 AsyncLocalStorage.run 作用域隔离
/** @deprecated Use withTraceContext() scope runner instead to avoid cross-request context pollution. */
export function setTraceContext(_context: TraceContext | undefined): void {
  throw new Error("setTraceContext is deprecated. Wrap execution with withTraceContext(context, fn) instead.");
}

export function withTraceContext<T>(context: TraceContext, fn: () => T): T {
  return traceContextStorage.run(context, fn);
}

export async function withTraceContextAsync<T>(context: TraceContext, fn: () => Promise<T>): Promise<T> {
  return traceContextStorage.run(context, fn);
}
```

#### 缺陷 5.2 修复前后代码对比 (`packages/agent-runtime/src/subagents.ts`)
```typescript
// ❌ 重构前：全局 let 变量 + try 块外自增，同步异常导致计数器永久泄漏死锁
let activeSubagentCount = 0;

async execute(input, context) {
  if (activeSubagentCount >= maxConcurrent) return { ... };
  activeSubagentCount += 1; // 👈 若后续初始化抛错，未进入 try 块，计数器永久泄露！
  try {
    const provider = await resolveMaybe(options.provider, input, context);
    ...
  } finally {
    activeSubagentCount = Math.max(0, activeSubagentCount - 1);
  }
}

// ✅ 重构后：基于 Scoped Disposer 模式与 try...finally 严格包含
export class SubagentConcurrencyGuard {
  private activeCount = 0;

  acquire(maxConcurrent: number): { [Symbol.dispose](): void } | null {
    if (this.activeCount >= maxConcurrent) return null;
    this.activeCount += 1;
    let released = false;
    return {
      [Symbol.dispose]: () => {
        if (!released) {
          released = true;
          this.activeCount = Math.max(0, this.activeCount - 1);
        }
      }
    };
  }

  getActiveCount(): number { return this.activeCount; }
}

export const globalSubagentGuard = new SubagentConcurrencyGuard();

async execute(input, context) {
  using permit = globalSubagentGuard.acquire(maxConcurrent);
  if (!permit) {
    return { text: `Denied: max concurrent exceeded (${maxConcurrent})` };
  }

  // 所有初始化逻辑与 resolveMaybe 均在 permit 作用域内，抛错时 TypeScript using / Symbol.dispose 自动归还
  const provider = await resolveMaybe(options.provider, input, context);
  ...
}
```

#### 缺陷 5.1 & 5.2 Vitest 测试断言规范 (`packages/agent-runtime/src/trace/trace.test.ts`)
```typescript
describe("Async Context & State Reset Hygiene", () => {
  it("should isolate trace contexts between concurrent async tasks without enterWith leaks", async () => {
    const runTaskA = () => withTraceContextAsync({ traceId: "trace-A", sessionId: "sess-A" }, async () => {
      await new Promise(r => setTimeout(r, 50));
      return getTraceContext()?.traceId;
    });

    const runTaskB = () => withTraceContextAsync({ traceId: "trace-B", sessionId: "sess-B" }, async () => {
      await new Promise(r => setTimeout(r, 20));
      return getTraceContext()?.traceId;
    });

    const [idA, idB] = await Promise.all([runTaskA(), runTaskB()]);

    expect(idA).toBe("trace-A");
    expect(idB).toBe("trace-B");
    expect(getTraceContext()).toBeUndefined(); // 宿主线程顶层 Context 洁净未被污染
  });

  it("should automatically decrement subagent active count even if provider resolution throws sync error", async () => {
    const throwingOptions: SubagentToolOptions = {
      cwd: "/",
      provider: () => { throw new Error("Sync failure during provider setup"); }
    };
    const tool = createSubagentTool(throwingOptions);

    const initialCount = globalSubagentGuard.getActiveCount();
    await expect(tool.execute({ prompt: "test" }, mockContext)).resolves.toBeDefined();

    // 验证计数值没有遗留泄露
    expect(globalSubagentGuard.getActiveCount()).toBe(initialCount);
  });
});
```

---

## 8. Gap 汇总与整改蓝图矩阵

| 序号 | 故障域 / 诊断重点 | 具体 Conex 代码位置 | 缺陷现象与隐患描述 | 严重级别 | 修复方案建议 (Benchmark Recommendation) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1.1** | 用户打断秒级级联 | `subagent-runtime.ts:226` | 后台 Subagent 在工具返回时提前解绑 `onAbort` 监听器 | **P0 (Blocker)** | 建立树状 `AbortController` 关联图谱，后台 Subagent 绑定 Session 级生命周期 Signal 而非 Tool Execution Context Signal |
| **1.2** | 用户打断秒级级联 | `orchestrator.ts:322` & `background-command.ts:332` | `cancelRun()` 仅通知 Engine abort，未取消 `BackgroundCommandManager` 派生的 Shell 进程树 | **P0 (Blocker)** | 在 `cancelRun` 中联动 `BackgroundCommandManager.cancelAllForRun(runId)` 强杀子进程树 |
| **2.1** | Subagent 并发门禁 | `orchestrator.ts:59` & `bounded-map.ts:49` | `activeRuns` 满容量时 `BoundedMap` 静默 FIFO 删除最旧 Run，导致 Ghost Run 无控狂飙 | **P0 (Blocker)** | `BoundedMap.set` 之前检查容量，对即将被淘汰的活跃 Run 显式执行 `engine.abort("active-runs-capacity-exceeded")` 强杀 |
| **2.2** | Subagent 递归门禁 | `subagent-runtime.ts:119` | `agent-daemon` 的 `createDaemonSubagentTool` 缺少全局 Live Agent 槽位门禁与信号量 | **P1 (Critical)** | 在 Daemon 侧引入基于 `AsyncSemaphore(32)` 的并发 Live Agent 槽位管理器，超限时排队或优雅拒绝 |
| **3.1** | OAuth 刷新意图锁 | `chatgpt-pool.ts:178` & `cross-process-lock.ts` | `CrossProcessLock` 为孤儿代码，`refreshAccount` 无意图锁防护导致并发重放旧 Token | **P0 (Blocker)** | 在 `refreshAccount` 中强制装配 `CrossProcessLock`，并在刷新前写入 `Generation-Bound Intent Lock`，实现 Single-flight 挂起 |
| **4.1** | Mid-stream Reset 容错 | `stream-recovery.ts:364` | 流式中途哪怕产生 1 个字符，TCP Reset 即被归类为 Case B 拒绝重试 | **P1 (Critical)** | 引入 `TransientErrorClassifier`，识别 `ECONNRESET` / `socket hang up`，即便有部分字符也允许带断点标记的暂态重试与指数退避 |
| **4.2** | 账号池惩罚误杀 | `chatgpt-pool.ts:158` | 网络中途 Reset 被误判为 Auth / Server 错误，将正常账号放入 5min~1h 惩罚冷却池 | **P1 (Critical)** | 区分 Transient Network Error 与 True Auth Error，暂态网络波动不得增加 `account.errorCount` 或触发账号 Cooldown |
| **5.1** | ContextVar / 堆栈管理 | `trace/index.ts:348` | `setTraceContext` 滥用 `AsyncLocalStorage.enterWith`，导致跨 Session 日志/Trace 上下文污染 | **P1 (Critical)** | 彻底废载 `enterWith`，强制全链路使用 `withTraceContext` / `AsyncLocalStorage.run()` 闭包绑定 |
| **5.2** | ContextVar / 堆栈管理 | `subagents.ts:54` | 模块级全局变量 `activeSubagentCount` 在 `try` 块外自增，同步异常导致计数器泄露死锁 | **P2 (Major)** | 避免模块级 `let` 全局变量，改用 `using` Disposable 句柄，并在 `finally` 块中实现严格的计数防漂移兜底 |

---

## 9. 总结与下阶段建议

本报告完成了 **Conex 并发与状态机域** 的全方位深挖诊断，输出了 **8 项核心真实代码缺陷** 及其精准定位、影响评估与**重构前后代码/测试断言规范**。上述缺陷直接解释了 Conex 在长会话、高并发 Subagent 派生以及网络微小波动场景下的卡死、暴涨与账号失效现象。

建议在 Phase 2 的重构中：
1. **优先修复 P0 级打断与锁死问题**：全面重构 `AbortController` 级联杀死树，装配 OAuth `Generation-Bound Intent Lock`。
2. **重构 Live Agent 资源调度器**：消除 `BoundedMap` 产生的 Ghost Run，建立全局 32 槽位 Live Agent 信号量门禁。
3. **优化流式网络容错**：规范 Transient Error 重分类，阻止网络抖动“毒害”账号池。
