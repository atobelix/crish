# Lifecycle Hooks（进程内 Hook 平面）

| Field | Value |
|-------|-------|
| Status | B2 骨架已落地；**tool.pre / tool.post 已接入真路径**；W6-8 **context.compact.start/end observe-only**；D2-2 health-hook-pack lite 已落地 |
| 实现 | `packages/agent-runtime/src/hooks/lifecycle-hooks.ts` · `compact-lifecycle.ts` · `health-hook-pack.ts` |
| 中控 | [`docs/plans/2026-07-system-architecture-control-master-plan.md`](./plans/2026-07-system-architecture-control-master-plan.md) §6 |

---

## 1. LifecycleHookRegistry：observe / on / emit

对齐 pi 风格的三通道：

| API | 语义 | 失败影响 |
|-----|------|----------|
| **`observe(type, handler)`** | 只读观测（perf / health / telemetry） | 吞错，**不影响** agent 主路径 |
| **`on(type, handler)`** | 可参与语义（stop 建议、block 工具、改写 I/O） | 单 handler 失败吞掉，其余继续；结果顺序合并 |
| **`emit(type, payload)`** | 仅 loop / runtime 调用 | 先并行 `observe`，再顺序 `on`，返回合并后的 `LifecycleHandlerResult` |

```ts
import { LifecycleHookRegistry } from '@crish/agent-runtime';

const hooks = new LifecycleHookRegistry();

// 只读：记时序
hooks.observe('turn.end', (p) => {
  console.debug('turn', p.turnIndex, 'tools', p.toolCallCount);
});

// 可语义：建议协作停（L2）
hooks.on('turn.end', (p) => {
  if (p.toolCallCount === 0 && !p.hasPendingInput) {
    return { stop: true, reason: 'autonomy-stop' };
  }
});

// 可语义：挡工具
hooks.on('tool.pre', (p) => {
  if (p.toolName === 'dangerous') {
    return { block: true, reason: 'policy' };
  }
});
```

取消订阅：`observe` / `on` 均返回 `() => void`。

兼容：旧 `AgentHooks` 经 `adaptAgentHooks(registry, hooks)` 桥接到 v2，**不删除** ExtensionRegistry。

---

## 2. 当前事件目录（v1 最小集）

| Event | 时机 | `on` 可返回 | 用途 |
|-------|------|-------------|------|
| `turn.start` | turn 开始 | — | 观测 / 时序 |
| `turn.end` | turn 收尾 | `{ stop?, reason? }` | 自主节奏 → **L2 cooperative stop** 建议 |
| `tool.pre` | 工具执行前 | `{ block?, reason?, modifiedInput? }` | 审批 / 改写入参 |
| `tool.post` | 工具执行后 | `{ modifiedOutput?, terminate?, reason? }` | 审计 / 改写出参 / 终止 run |
| `context.compact.start` | 上下文压缩开始 | —（**observe-only**） | 时序 / telemetry / health |
| `context.compact.end` | 上下文压缩结束（成功或 abort） | —（**observe-only**） | 压缩比、时长、失败原因 |

中控逻辑目录中的 `session.*`、`context.build`、`provider.call.*`、`stream.delta`、`run.control`、`error` 等分期落地，见 master plan §6.2。

### 2.1 Context compact（W6-8，observe-only）

对齐 pi `session_before_compact` / `session_compact` 的**观测**面（conex 当前**不**实现 cancel / 自定义 compaction 注入）。

| 字段 | 说明 |
|------|------|
| 实现 | `packages/agent-runtime/src/hooks/compact-lifecycle.ts` |
| 挂载 | `ContextCompressionGate`（session-loop prepare-turn + payload-recovery 均经此 gate） |
| 流式 UI | 仍走 AgentEvent `context-compression-start` / `context-compression-end`（与 lifecycle **并存**） |

```ts
hooks.observe('context.compact.start', (p) => {
  console.debug('compact begin', p.sessionId, p.tokensBefore, p.messageCount);
});
hooks.observe('context.compact.end', (p) => {
  if (p.aborted) console.warn('compact aborted', p.error);
  else console.debug('compact ok', p.compactionId, p.tokensBefore, '→', p.tokensAfter);
});
```

原则：compact 事件**不得**用于 `block` / `stop` / `terminate`；控制意图仍走 ControlBus。

---

## 3. 与 L1 / L2 / L3 控制语义的关系

Hook **建议**控制意图；真正执行走 **ControlBus**（见 [`docs/architecture/run-control.md`](./architecture/run-control.md)）。

| 级别 | wire 名 | Hook 侧典型来源 | 效果摘要 |
|------|---------|-----------------|----------|
| **L1** | `soft_inject` | （UI 续写 / steer，非 hook 主路径） | 安全点注入，不杀 stream |
| **L2** | `cooperative_stop` | `turn.end` → `{ stop: true }`；旧 `shouldStopAfterTurn` | 当前 turn 干净收尾 |
| **L3** | `force_cancel` | 一般**不由** hook 发起；用户 Force / 系统硬停 | abort provider + tools |

原则（中控 §5.2）：

1. 默认用户 Stop = **L2**；Force / 二次确认 = **L3**。
2. AI 自主停 = 模型 end_turn + hook stop 建议 → **L2**，禁止用 L3 表达「差不多了」。
3. `tool.post.terminate` 映射旧 afterToolCall 终止语义，仍应优先落到协作路径，避免滥用硬 abort。

---

## 4. 挂载点（session-loop）

```
turn 边界 → emit('turn.start' | 'turn.end')
tool 前后 → emit('tool.pre' | 'tool.post')   // 真路径已 wire
compact  → emit('context.compact.start' | 'context.compact.end')  // gate 真路径，observe-only
安全点   → ControlBus.drainAsAction()  （L1/L2/L3）
```

**tool 调用链（session-loop 真路径）：**

```
AgentSessionLoop.makeToolExecCtx()
  → lifecycleHooks（与 turn 同一实例）
ToolExecutionCoordinator.executeSingleTool
  → handleBeforeHook: emit('tool.pre')
       · block → 跳过 execute，返回错误 ToolOutput
       · modifiedInput → 改写入参
  → runToolExecution → SingleToolExecutor.execute
  → handleExecResult / handleErrorResult: emit('tool.post')  （成功/失败均发）
       · modifiedOutput → 改写出参
       · terminate → ControlBus.requestCooperativeStop（L2）
```

默认 `ToolExecutor` 路径（无 custom executeOne）经 `createLifecycleToolMiddleware` 薄适配进 `SingleToolExecutor` hooks。

B0/B2：ControlBus 安全点 + LifecycleHookRegistry turn/tool 边界 emit；**不大改 loop 结构**。

---

## 5. Health hook pack（D2-2 lite）

内置 **observe-only** 健康信号：进程内计数，无外部进程、不参与 `block` / `stop` / `terminate`。

| API | 说明 |
|-----|------|
| `registerBuiltinHealthHooks(registry)` | 挂上 turn/tool/context.compact observe，返回 `HealthHookPack` |
| `pack.getHealthSnapshot()` | 快照：turn/tool 计数、估算 block 率、turn 时长、连续 tool error、compact start/end/abort 与 lastCompactDurationMs |
| `pack.reset()` / `pack.dispose()` | 清零 / 取消订阅 |
| `loop.getHealthSnapshot()` | `AgentSessionLoop` 构造时默认注册后的快捷入口 |

观测字段（摘要）：

| 字段 | 含义 |
|------|------|
| `turnStartCount` / `turnEndCount` | turn 边界次数 |
| `toolPreCount` / `toolPostCount` / `toolErrorCount` | 工具 pre/post/错误 |
| `toolOpenCount` / `toolBlockRate` | pre 后未 post 的数量 / 占比（完成态 ≈ block；含 in-flight） |
| `turnDurationMsAvg` / `lastTurnDurationMs` | 完成 turn 的时长 |
| `consecutiveToolErrors` / `maxConsecutiveToolErrors` | 连续 tool 错误 |
| `compactStartCount` / `compactEndCount` / `compactAbortCount` / `lastCompactDurationMs` | context.compact.* 观测（W7-1） |

```ts
import { LifecycleHookRegistry, registerBuiltinHealthHooks } from '@crish/agent-runtime';

const reg = new LifecycleHookRegistry();
const health = registerBuiltinHealthHooks(reg);
// … loop emit turn.* / tool.* …
console.debug(health.getHealthSnapshot());
```

与 desktop `controlMetrics` 分属不同进程边界：runtime 用本 pack；UI 控制面计数见 `apps/crish-desktop/src/api/controlMetrics.ts`。

---

## 6. 相关入口

| 路径 | 说明 |
|------|------|
| `packages/agent-runtime/src/hooks/lifecycle-hooks.ts` | Registry + adaptAgentHooks + createLifecycleToolMiddleware |
| `packages/agent-runtime/src/hooks/compact-lifecycle.ts` | W6-8 context.compact.start/end 类型与 emit helpers |
| `packages/agent-runtime/src/hooks/health-hook-pack.ts` | D2-2 内置 health observe pack |
| `packages/agent-runtime/src/hooks/index.ts` | 包导出 |
| `packages/agent-runtime/src/runtime-components/context-compression-gate.ts` | compact lifecycle 真路径 emit |
| `packages/agent-runtime/src/session-loop/tool-execution.ts` | tool.pre/post 真路径 |
| `packages/agent-runtime/src/session-loop/index.ts` | turn 边界 emit + 默认 health 注册 + gate 注入 lifecycle |
| `packages/agent-runtime/src/control/` | ControlBus / L0–L3 |
| `packages/shared-types/src/run-control.ts` | 协议 wire / 代号真源 |
| 中控 master plan | §5 Run 控制 · §6 Hook · §13 健康 · Round B0/B2/D2 |
