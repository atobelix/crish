# 子计划 01：Layer A — 共享基础设施 (Foundation & Safety Primitives)

> **层级编号**：Layer A（Round 1，系统修复的初始根节点，无前置依赖）
> **建议 Agent 数量**：5–6 个（互不交叉修改同一文件）
> **涉及维度**：D1（架构耦合与单一职责）、D3（逻辑重复）、D4（并发安全与状态突变）、D5（IPC 边界与 API 契约脆弱性）
> **下游依赖方**：Layer B (Rust Core)、Layer C (Runtime Engine)、Layer E (State & API)、Layer H (Tool Hook Chain)、Layer J (Testing Infrastructure)——它们都直接消费本层输出的类型定义与工具函数
> 
> **本层与其它层的交叉引用**：A-3（async-mutex 修复）是 Layer C1（C1-12 stream-recovery AsyncMutex 修复）的前置条件。A-1（workbench-contract 拆分）的输出被 Layer D 消费（D-1 标记为已由 A-1 完成），Layer D 不再重复此任务。

---

## 一、层级目标

Layer A 的核心使命是建立全局类型安全与共享原语基础。具体而言：

1. 将 3002 行的上帝契约文件 `workbench-contract.ts` 拆分为领域模块，消除跨越 Plan Document、Daemon Session、Sidecar、Provider、Rewind 等完全无关领域的类型定义混杂问题。
2. 修复 `async-mutex.ts` 中的 `AbortSignal` 监听器泄漏和递归 `release()` 导致的 V8 Call Stack Overflow 崩溃。
3. 收敛散落在 `scripts/qa/` 目录下 4 个 QA 脚本中 100% 重复的 `safeParseJsonObject` 函数。
4. 审计并规范化 Rust 端 Serde `#[serde(rename_all)]` 注解，消除 camelCase/kebab-case 混用导致的 TS 端字段静默丢失为 `undefined` 的隐患。
5. 为 Tauri IPC 边界引入 Zod 运行时校验层，在 TS 端为所有 `invoke()` 调用提供 `parseOrThrow()` 断言。

---

## 二、任务总表

| 任务 ID | 目标文件 / 模块 | 当前行数 | 核心问题 | 修复策略 | 来源维度 | 分配 Agent |
|---------|----------------|---------|---------|---------|---------|-----------|
| A-1 | `apps/agent-workbench/src/shared/workbench-contract.ts` | 3,002 | 上帝契约文件，混合 7 个完全不同的领域 DTO | 按领域拆分为 7 个子模块 + 1 个 barrel index | D1, D5 | Agent A1 |
| A-2 | `packages/shared-types/src/` | 13 文件 | 与 workbench-contract 存在类型概念重叠（如 JsonPrimitive/JsonValue/JsonObject 的重复定义） | 统一单源类型定义，消除 workbench-contract 中的重复类型别名 | D1, D3 | Agent A2 |
| A-3 | `packages/shared-utils/src/async-mutex.ts` | 189 | AbortSignal 监听器泄漏 + 递归 release 爆栈 | 修复信号清理逻辑与队列微任务化 | D4 | Agent A3 |
| A-4 | `scripts/qa/*.mjs` (4 个文件) | 各约 300 行 | `safeParseJsonObject` 在 4 个脚本中 100% 复制粘贴 ($S=1.00$) | 提取到 `scripts/qa/utils/json-helper.mjs` 并统一引入 | D3 | Agent A4 |
| A-5 | Rust Serde 注解审计 (跨多个 `.rs` 文件) | — | `host_openers.rs` 中 camelCase 与 kebab-case 混用，TS 端字段解析不一致 | 统一为 camelCase 或建立显式映射文档 | D5 | Agent A5 |
| A-6 | 新建 IPC 运行时校验层 | [NEW] | Tauri `invoke()` 调用无运行时类型校验，反序列化静默失败 | 引入 Zod schema 校验 | D5 | Agent A5 |

---

## 三、任务 A-1：workbench-contract.ts 领域拆分

### 3.1 问题现状深度分析

[workbench-contract.ts](file:///c:/Software/conex/apps/agent-workbench/src/shared/workbench-contract.ts) 是整个 Workbench 应用中最大的单一类型定义文件，包含 3,002 行代码。通过对文件内容的逐段审查，可以明确识别出以下 **7 个完全独立的业务领域**，它们之间几乎没有结构性依赖关系，仅通过 `WorkbenchJsonObject` / `WorkbenchJsonValue` / `WorkbenchJsonPrimitive` 这 3 个基础类型产生松散耦合：

| 领域编号 | 领域名称 | 行号范围（约） | 核心 Type/Interface 数量 | 代表性类型 |
|---------|---------|-------------|----------------------|-----------|
| D1 | JSON 基础类型 | L1–L8 | 3 个 type | `WorkbenchJsonPrimitive`, `WorkbenchJsonValue`, `WorkbenchJsonObject` |
| D2 | Plan Document（计划文档） | L10–L275 | ~30 个 type/interface | `WorkbenchPlanDocument`, `WorkbenchPlanStep`, `WorkbenchCreatePlanDocumentRequest` |
| D3 | Approval & Normalized Event（审批与事件规范化） | L276–L312 | ~5 个 type/interface | `WorkbenchApprovalMetadata`, `WorkbenchNormalizedEvent`, `WorkbenchNormalizedApprovalRequest` |
| D4 | Daemon Session/Run/Event（Daemon 会话、运行、事件） | L313–L590 | ~40 个 type/interface | `DaemonSessionRecord`, `DaemonRunRecord`, `DaemonOrchestratorEvent`, `DaemonPendingInputRecord` |
| D5 | Session Tree & Conversation Rewind（会话树与倒带） | L592–L1081 | ~35 个 type/interface | `WorkbenchSessionTreeEntry`, `WorkbenchConversationRewindRequest`, `WorkbenchConversationRewindPlan` |
| D6 | Provider/MCP/Lifecycle/Status（供应商、MCP、生命周期） | L1082–L1252 | ~25 个 type/interface | `DaemonProviderStatusSnapshot`, `DaemonMcpStatusSnapshot`, `DaemonLifecycleSnapshot`, `DaemonStatusResponse` |
| D7 | Task Snapshot/Workbench UI（任务快照与工作台 UI 类型） | L1254–L3002 | ~100+ 个 type/interface | `DaemonTaskSnapshot`, `WorkbenchRunState`, `WorkbenchProject`, Sidecar 类型, 配置类型, 所有 Guard 函数等 |

### 3.2 领域 D1 的特殊处理：JSON 基础类型去重

`workbench-contract.ts` 在 L1-L8 定义了：
```typescript
export type WorkbenchJsonPrimitive = string | number | boolean | null;
export type WorkbenchJsonValue = WorkbenchJsonPrimitive | WorkbenchJsonValue[] | { [key: string]: WorkbenchJsonValue };
export type WorkbenchJsonObject = { [key: string]: WorkbenchJsonValue };
```

而 `packages/shared-types/src/primitive-types.ts` 中已经定义了完全等价的：
```typescript
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = ...;
export type JsonObject = { [key: string]: JsonValue };
```

**修复方案**：删除 `workbench-contract.ts` 中的 `WorkbenchJsonPrimitive`/`WorkbenchJsonValue`/`WorkbenchJsonObject`，在所有拆分后的子模块中统一使用 `@conex/shared-types` 中的 `JsonPrimitive`/`JsonValue`/`JsonObject`。对于已有的外部消费者（如 `apps/crish-desktop`），通过 barrel index 重新导出带有 `Workbench` 前缀的类型别名，确保 100% 向后兼容：

```typescript
// workbench-contract/index.ts 中的向后兼容导出
import type { JsonPrimitive, JsonValue, JsonObject } from "@conex/shared-types";
/** @deprecated 请直接使用 @conex/shared-types 中的 JsonPrimitive */
export type WorkbenchJsonPrimitive = JsonPrimitive;
/** @deprecated 请直接使用 @conex/shared-types 中的 JsonValue */
export type WorkbenchJsonValue = JsonValue;
/** @deprecated 请直接使用 @conex/shared-types 中的 JsonObject */
export type WorkbenchJsonObject = JsonObject;
```

### 3.3 目标文件结构

拆分后的目录结构：

```
apps/agent-workbench/src/shared/workbench-contract/
├── index.ts                          # barrel 重新导出所有子模块（向后兼容）
├── plan-document.ts                  # 领域 D2：Plan Document 相关全部类型
├── approval.ts                       # 领域 D3：Approval & NormalizedEvent
├── daemon-session.ts                 # 领域 D4：Daemon Session/Run/Event/PendingInput
├── conversation-rewind.ts            # 领域 D5：Session Tree & Conversation Rewind
├── daemon-status.ts                  # 领域 D6：Provider/MCP/Lifecycle/Status
├── task-snapshot.ts                  # 领域 D7a：DaemonTaskSnapshot 及其子类型
├── workbench-ui.ts                   # 领域 D7b：WorkbenchRunState, Plan, Evidence, Change, Health, Metrics
├── sidecar.ts                        # 领域 D7c：Sidecar 相关 IPC 类型与事件
├── config.ts                         # 领域 D7d：WorkbenchConfig, Theme, AutoApproval 等配置类型
└── guards.ts                         # 所有 type guard 函数（isWorkbenchRecord, isWorkbenchSessionActionReceipt 等）
```

### 3.4 拆分操作的逐步指引

**Step 1：创建目录结构**
```bash
mkdir -p apps/agent-workbench/src/shared/workbench-contract
```

**Step 2：逐领域提取类型定义**

以领域 D2（Plan Document）为例，提取 L10-L275 的全部内容到 `plan-document.ts`：

```typescript
// apps/agent-workbench/src/shared/workbench-contract/plan-document.ts

import type { JsonObject, JsonValue } from "@conex/shared-types";

export type WorkbenchPlanDocumentStatus =
  | "draft"
  | "aligning"
  | "ready"
  | "in_progress"
  | "blocked"
  | "completed"
  | "archived";

export type WorkbenchPlanStepStatus = "pending" | "in_progress" | "completed" | "blocked" | "skipped";
export type WorkbenchPlanQuestionStatus = "open" | "answered" | "resolved" | "deferred";
// ... (L10-L275 的全部类型定义，将 WorkbenchJsonObject 替换为 JsonObject)
```

**Step 3：处理跨领域依赖**

少数类型存在跨领域引用。例如 `DaemonRunEventsResponse`（领域 D4）引用了 `DaemonTaskSnapshot`（领域 D7a）。处理方式：

```typescript
// daemon-session.ts 中
import type { DaemonTaskSnapshot } from "./task-snapshot";

export interface DaemonRunEventsResponse {
  // ...
  snapshot?: DaemonTaskSnapshot;
}
```

**Step 4：创建 barrel index.ts**

```typescript
// apps/agent-workbench/src/shared/workbench-contract/index.ts
// 100% 向后兼容的重新导出

// JSON 基础类型（向后兼容别名）
import type { JsonPrimitive, JsonValue, JsonObject } from "@conex/shared-types";
/** @deprecated 请直接使用 @conex/shared-types */
export type WorkbenchJsonPrimitive = JsonPrimitive;
/** @deprecated */
export type WorkbenchJsonValue = JsonValue;
/** @deprecated */
export type WorkbenchJsonObject = JsonObject;

// 领域子模块全量导出
export * from "./plan-document";
export * from "./approval";
export * from "./daemon-session";
export * from "./conversation-rewind";
export * from "./daemon-status";
export * from "./task-snapshot";
export * from "./workbench-ui";
export * from "./sidecar";
export * from "./config";
export * from "./guards";
```

**Step 5：删除原始 workbench-contract.ts 并替换为 barrel**

将 `apps/agent-workbench/src/shared/workbench-contract.ts` 替换为：
```typescript
// 此文件已拆分为 workbench-contract/ 目录下的子模块。
// 保留此文件作为重新导出入口，确保现有 import 路径不受影响。
export * from "./workbench-contract/index";
```

### 3.5 质量门槛

- 拆分后每个子模块文件 **不超过 500 行**（若领域 D7 超出，继续拆分为 D7a/D7b/D7c/D7d）。
- 所有现有的 `import { ... } from "@/shared/workbench-contract"` 或相对路径导入**零修改即可编译通过**。
- 运行 `npx tsc --noEmit` 零新增错误。

### 3.6 验证命令

```bash
# 编译验证
cd apps/agent-workbench && npx tsc --noEmit

# 验证所有导出仍然可达（在项目根目录）
npx tsc --noEmit -p tsconfig.json

# 验证拆分后无循环引用
npx madge --circular apps/agent-workbench/src/shared/workbench-contract/
```

### 3.7 消费者影响评估

需要搜索项目中所有导入 `workbench-contract` 的文件：

```bash
grep -rn "workbench-contract" --include="*.ts" --include="*.tsx" apps/ packages/ | grep "import"
```

由于 barrel index 保持了完全一致的导出签名，消费者无需修改任何 import 路径。但 Agent 必须在拆分完成后验证上述 grep 命中的每一个文件都能编译通过。

---

## 四、任务 A-2：shared-types 类型去重与规范化

### 4.1 问题现状

`packages/shared-types/src/` 包含 13 个文件，通过 [index.ts](file:///c:/Software/conex/packages/shared-types/src/index.ts) 集中导出。当前存在以下问题：

1. **与 workbench-contract 的概念重叠**：
   - `shared-types` 定义了 `JsonPrimitive`, `JsonValue`, `JsonObject`（在 `primitive-types.ts`）
   - `workbench-contract.ts` 在 L3-L8 重新定义了 `WorkbenchJsonPrimitive`, `WorkbenchJsonValue`, `WorkbenchJsonObject`，内容 100% 相同
   - `shared-types` 定义了 `SessionStatus`, `RunStatus`, `RunOutcome`（在 `orchestration.ts`）
   - `workbench-contract.ts` 在 L313-L340 重新定义了 `DaemonSessionStatus`, `DaemonRunStatus`, `DaemonRunOutcome`，语义高度重叠但字面值略有差异

2. **命名前缀不统一**：部分类型以 `Crish` 为前缀（如 `CrishError`, `CrishProviderCredentialMode`），部分无前缀。

### 4.2 修复操作

**Step 1：在 shared-types 中建立 JSON 基础类型的唯一来源**

确认 `packages/shared-types/src/primitive-types.ts` 是 `JsonPrimitive`/`JsonValue`/`JsonObject` 的唯一定义位置。在 A-1 完成后，`workbench-contract` 的各子模块将直接引用此处。

**Step 2：审计 orchestration.ts 与 workbench-contract 的语义映射**

创建类型映射文档，记录 `shared-types` 中的 `SessionStatus` 与 `workbench-contract` 中的 `DaemonSessionStatus` 之间的关系：

| shared-types | workbench-contract | 是否一致 | 处理方式 |
|---|---|---|---|
| `SessionStatus = "open" \| "closed" \| "archived"` | `DaemonSessionStatus = "open" \| "closed" \| "archived"` | ✅ 完全一致 | `DaemonSessionStatus` 改为 `type DaemonSessionStatus = SessionStatus` |
| `RunStatus` | `DaemonRunStatus` | ⚠️ 略有差异 | 保留两套，在文档中标注映射关系 |

**Step 3：清理 shared-types 内部的未使用导出**

运行 TypeScript 编译器诊断查找未被任何包消费的类型：
```bash
# 在 monorepo 根目录
npx ts-prune -p packages/shared-types/tsconfig.json
```

### 4.3 质量门槛

- 无 `any` 类型包装残留。
- 每个类型文件不超过 300 行。
- `npm run build --filter=@conex/shared-types` 零错误。

---

## 五、任务 A-3：async-mutex.ts 安全修复

### 5.1 问题现状深度分析

[async-mutex.ts](file:///c:/Software/conex/packages/shared-utils/src/async-mutex.ts) 共 189 行，包含 `AsyncMutex`（L28-L105）和 `AsyncSemaphore`（L112-L188）两个类。通过逐行审查，发现以下两个严重缺陷：

#### 缺陷 1：递归 `release()` 导致 Call Stack Overflow（L94-L104 & L178-L187）

**代码现场**（`AsyncMutex.release`, L94-L104）：
```typescript
private release(): void {
  if (!this.locked) return;
  const next = this.queue.shift();
  if (next) {
    next.cleanup?.();
    next.waiter();  // ← 关键：waiter() 内部可能再次调用 this.release()
  } else {
    this.locked = false;
  }
}
```

**崩溃链条**：当 500 个并发 Task 排队获取锁，且其中 499 个的 `AbortSignal` 已被 abort 时：
1. Task 1 完成，调用 `release()`
2. `release()` shift 出 Task 2，执行 `next.waiter()`
3. `waiter()` 执行到 L70：`if (signal?.aborted)` 为 true
4. L72：`this.release()` 被**同步递归调用**
5. 重复步骤 2-4 共 498 次
6. V8 默认调用栈约 10,000-15,000 帧，500 个 Task 即可触发 `RangeError: Maximum call stack size exceeded`

**影响范围**：`AsyncSemaphore.release()`（L178-L187）具有完全相同的代码结构，存在同样的递归爆栈风险。

#### 缺陷 2：AbortSignal 监听器泄漏（条件性）

**代码现场**（L79-L91）：
```typescript
if (signal) {
  const onAbort = () => {
    const idx = this.queue.indexOf(entry);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      reject(new Error("AbortError: mutex acquire aborted while waiting"));
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  entry.cleanup = () => signal.removeEventListener("abort", onAbort);
}
```

**分析**：此处代码已经正确设置了 `entry.cleanup`，且在 `release()` 中通过 `next.cleanup?.()` 调用了清理函数。**但是**，存在一个边界条件泄漏路径：

- 当 `onAbort` 回调触发时（Signal 被 abort），它通过 `this.queue.splice(idx, 1)` 将 entry 从队列中移除
- 此时 `entry.cleanup` **没有被调用**——因为 cleanup 只在 `release()` -> `next.cleanup?.()` 路径中被调用
- 由于使用了 `{ once: true }`，`addEventListener` 自身会在第一次触发后自动移除监听器
- **所以这里实际上没有泄漏**——`{ once: true }` 起到了保护作用

然而，如果 entry 通过 `release()` 路径被正常消费，`next.cleanup?.()` 会调用 `signal.removeEventListener`，但此时 `onAbort` 监听器已经通过 `{ once: true }` 规则在 abort 时自行移除，或者根本未触发过。**这两条路径是安全的**。

**结论**：AbortSignal 泄漏在当前实现中**已被 `{ once: true }` 正确防护**。但递归爆栈是一个严重的、可复现的崩溃 Bug。

### 5.2 修复方案

#### 修复 1：将递归 `release()` 改为微任务队列调度

核心思路：当 `waiter()` 内部检测到 signal 已 abort 时，不再同步调用 `this.release()`，改为使用 `queueMicrotask` 将 release 推入微任务队列，打断同步递归链。

**AsyncMutex.release 修复后完整代码**：
```typescript
private release(): void {
  if (!this.locked) return;
  const next = this.queue.shift();
  if (next) {
    next.cleanup?.();
    next.waiter();
  } else {
    this.locked = false;
  }
}
```

**AsyncMutex.acquire 中 waiter 的修复**（L69-L77）：
```typescript
// 修复前（L69-L77）：
waiter: () => {
  if (signal?.aborted) {
    reject(new Error("AbortError: mutex acquire aborted while waiting"));
    this.release();  // ← 同步递归！
    return;
  }
  this.locked = true;
  resolve(() => this.release());
},

// 修复后：
waiter: () => {
  if (signal?.aborted) {
    reject(new Error("AbortError: mutex acquire aborted while waiting"));
    // 使用 queueMicrotask 打断同步递归，防止 500+ 个 aborted task 导致栈溢出
    queueMicrotask(() => this.release());
    return;
  }
  this.locked = true;
  resolve(() => this.release());
},
```

**AsyncSemaphore.acquire 中 waiter 的同等修复**（L153-L161）：
```typescript
// 修复前（L153-L161）：
waiter: () => {
  if (signal?.aborted) {
    reject(new Error("AbortError: semaphore acquire aborted while waiting"));
    this.release();  // ← 同步递归！
    return;
  }
  this.active += 1;
  resolve(() => this.release());
},

// 修复后：
waiter: () => {
  if (signal?.aborted) {
    reject(new Error("AbortError: semaphore acquire aborted while waiting"));
    queueMicrotask(() => this.release());
    return;
  }
  this.active += 1;
  resolve(() => this.release());
},
```

### 5.3 新增测试用例

在 [async-mutex.test.ts](file:///c:/Software/conex/packages/shared-utils/src/async-mutex.test.ts) 中添加：

```typescript
describe("AsyncMutex recursive release stack overflow", () => {
  it("should not stack overflow when 500 aborted tasks are queued", async () => {
    const mutex = new AsyncMutex();
    const controller = new AbortController();

    // 先让锁被持有
    const firstRelease = await mutex.acquire();

    // 排队 500 个 aborted task
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 500; i++) {
      promises.push(
        mutex.acquire(controller.signal).catch(() => {/* expected abort */})
      );
    }

    // Abort 所有排队中的 task
    controller.abort();

    // 等待一个 tick 让 abort 处理完成
    await new Promise(resolve => setTimeout(resolve, 10));

    // 释放第一个锁——这会触发队列中 aborted task 的连锁 release
    // 修复前此处会抛出 RangeError: Maximum call stack size exceeded
    expect(() => firstRelease()).not.toThrow();

    // 等待所有 promise settled
    await Promise.allSettled(promises);

    // 锁应该已经被正确释放
    expect(mutex.isLocked).toBe(false);
  });
});

describe("AsyncSemaphore recursive release stack overflow", () => {
  it("should not stack overflow when 500 aborted tasks are queued", async () => {
    const semaphore = new AsyncSemaphore(1);
    const controller = new AbortController();

    const firstRelease = await semaphore.acquire();

    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 500; i++) {
      promises.push(
        semaphore.acquire(controller.signal).catch(() => {})
      );
    }

    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(() => firstRelease()).not.toThrow();
    await Promise.allSettled(promises);

    expect(semaphore.activeCount).toBe(0);
  });
});
```

### 5.4 质量门槛

- 通过上述新增测试用例（500 个并发 abort 不爆栈）。
- 通过现有全部测试：`npm run test --filter=@conex/shared-utils`。
- 无 TypeScript 编译错误。

### 5.5 验证命令

```bash
cd packages/shared-utils
npx vitest run src/async-mutex.test.ts
npx tsc --noEmit
```

---

## 六、任务 A-4：QA 脚本 `safeParseJsonObject` 去重

### 6.1 问题现状

以下 4 个 QA 脚本中包含 100% 相同的 `safeParseJsonObject` 函数定义：

| 文件路径 | 定义行号 | 使用行号 |
|---------|---------|---------|
| `scripts/qa/runDeepMultiToolChainEngine.mjs` | L84 | L203 |
| `scripts/qa/runEndlessLongHorizonAgentEngine.mjs` | L12 | L270 |
| `scripts/qa/runHeavyMultiAgentCodebaseAnalysis.mjs` | L84 | L281 |
| `scripts/qa/runLongHorizonSingleSessionAgent.mjs` | L85 | L275 |

函数体完全一致（$S = 1.00$）：
```javascript
function safeParseJsonObject(str) {
  if (typeof str !== 'string') return {};
  try {
    const parsed = JSON.parse(str);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
```

### 6.2 修复方案

**Step 1：创建共享工具模块**

```javascript
// scripts/qa/utils/json-helper.mjs

/**
 * 安全解析 JSON 字符串为纯对象。
 * 解析失败、非对象、数组等情况均返回空对象 {}。
 *
 * @param {unknown} str - 待解析的字符串输入
 * @returns {Record<string, any>} 解析成功返回对象，否则返回 {}
 */
export function safeParseJsonObject(str) {
  if (typeof str !== 'string' || str.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(str);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
```

> 注意：此处增加了 `str.trim().length === 0` 检查，增强了对空白字符串的防御。

**Step 2：在 4 个 QA 脚本中删除局部定义，统一引入**

对每个脚本执行以下变更：

```javascript
// 删除脚本内的 function safeParseJsonObject(str) { ... } 定义

// 在文件顶部添加导入
import { safeParseJsonObject } from './utils/json-helper.mjs';
```

具体操作清单：

| 文件 | 操作 | 删除行 | 新增导入位置 |
|-----|------|-------|------------|
| `runDeepMultiToolChainEngine.mjs` | 删除 L84-L90 的函数定义 | L84-L90 | L1 附近 |
| `runEndlessLongHorizonAgentEngine.mjs` | 删除 L12-L18 的函数定义 | L12-L18 | L1 附近 |
| `runHeavyMultiAgentCodebaseAnalysis.mjs` | 删除 L84-L90 的函数定义 | L84-L90 | L1 附近 |
| `runLongHorizonSingleSessionAgent.mjs` | 删除 L85-L91 的函数定义 | L85-L91 | L1 附近 |

### 6.3 验证命令

```bash
# 验证每个脚本能被 Node.js 正确解析（语法层面）
node --check scripts/qa/runDeepMultiToolChainEngine.mjs
node --check scripts/qa/runEndlessLongHorizonAgentEngine.mjs
node --check scripts/qa/runHeavyMultiAgentCodebaseAnalysis.mjs
node --check scripts/qa/runLongHorizonSingleSessionAgent.mjs

# 确认 utils/json-helper.mjs 自身可正确导入
node -e "import('./scripts/qa/utils/json-helper.mjs').then(m => console.log(typeof m.safeParseJsonObject))"
```

---

## 七、任务 A-5：Rust Serde 命名规范审计

### 7.1 问题现状

通过对项目中所有 `#[serde(rename_all = ...)]` 注解的全量扫描，发现以下不一致模式：

| 文件 | 注解值 | 出现次数 | 是否一致 |
|-----|-------|---------|---------|
| `cli_bridge.rs` | `"camelCase"` | 2 | ✅ |
| `commands.rs` | `"camelCase"` | 1 | ✅ |
| `core_commands.rs` | `"camelCase"` | 3 | ✅ |
| `fs_commands.rs` | `"camelCase"` | 6 | ✅ |
| **`host_openers.rs`** | **混用 `"camelCase"` 和 `"kebab-case"`** | **camelCase: 4, kebab-case: 4** | ❌ **不一致** |
| `process.rs` | `"camelCase"` | 4 | ✅ |
| `sidecar/types.rs` | 混用 `"camelCase"` 和 `"kebab-case"` | camelCase: 5, kebab-case: 2 | ⚠️ |
| `perf/*.rs` | `"camelCase"` | 全部 | ✅ |

### 7.2 风险分析：`host_openers.rs` 的 kebab-case 泄漏

以 `host_openers.rs` L13 为例：
```rust
#[serde(rename_all = "kebab-case")]
pub enum HostOpenerTarget {
    Terminal,
    FileManager,
    DefaultBrowser,
}
```

序列化后生成 `"terminal"`, `"file-manager"`, `"default-browser"`。

而 TS 端若使用 `target.fileManager` 去读取，将得到 `undefined`，因为 JSON 中的 key 是 `"file-manager"`（kebab-case）而非 `"fileManager"`（camelCase）。

### 7.3 修复方案

**策略选择**：由于 `host_openers.rs` 的 `kebab-case` 枚举值已经在 IPC 协议中被使用，直接更改为 `camelCase` 会破坏前端已有的解析逻辑。因此采用**文档化 + 防御性校验**策略：

1. **创建 IPC 命名映射文档**：在 `apps/agent-workbench/src/shared/` 目录下创建 `ipc-naming-conventions.md`，记录每个 Rust 结构体的 Serde 命名规则，作为 TS 端开发者的参考。

2. **对于新增结构体**：强制要求使用 `#[serde(rename_all = "camelCase")]`。

3. **对于已有的 kebab-case 结构体**：在 TS 端创建显式的类型映射，确保消费者不会因命名不一致而静默丢失数据。

### 7.4 操作清单

| 操作 | 文件 | 详情 |
|-----|------|------|
| 审计 | `host_openers.rs` L13, L20, L67, L85 | 记录 4 个 kebab-case 结构体/枚举的字段映射 |
| 审计 | `sidecar/types.rs` L107, L124 | 记录 2 个 kebab-case 结构体的字段映射 |
| 新建 | `ipc-naming-conventions.md` | 全量命名映射文档 |
| 验证 | 所有 `.rs` 文件 | 确认无遗漏的缺失 `rename_all` 注解 |

### 7.5 缺失 `rename_all` 注解的结构体搜索

需要搜索所有包含 `#[derive(Serialize)]` 或 `#[derive(Deserialize)]` 但**没有** `#[serde(rename_all)]` 的结构体：

```bash
# 查找所有 derive Serialize/Deserialize 的结构体
grep -rn "derive.*Serialize" --include="*.rs" apps/agent-workbench/src-tauri/src/ | grep -v "rename_all"
```

Agent 必须执行此搜索，并对所有未标注 `rename_all` 的结构体添加 `#[serde(rename_all = "camelCase")]`（除非有特殊理由使用其他命名）。

---

## 八、任务 A-6：IPC 运行时校验层（Zod）

### 8.1 问题现状

当前项目中所有 Tauri IPC 调用均为无类型校验的裸 `invoke()`：

```typescript
// 当前的反模式（散落在 apps/crish-desktop 和 apps/agent-workbench 中）
const result = await invoke("sidecar_send_query", { connectionId, query });
// result 类型为 unknown，开发者通过 as 断言强转为目标类型
const typed = result as SidecarQueryResponse;
```

风险：如果 Rust 端修改了结构体字段（重命名/删除/新增），TS 端的 `as` 断言不会在编译时或运行时给出任何报错，数据静默丢失。

### 8.2 修复方案

**阶段 1：为高频 IPC 命令创建 Zod schema**

选择项目中最频繁使用的 10 个 IPC 命令，为它们的请求参数和响应结构分别创建 Zod schema。

**目标命令清单**（按优先级排列）：

| 命令名 | 请求参数 | 响应结构 | 调用方 |
|--------|---------|---------|-------|
| `sidecar_send_query` | `{ connectionId, query }` | `{ id, success, data?, error? }` | daemonClient.ts |
| `workbench_list_sessions` | `{ filter? }` | `{ sessions: SessionSummary[] }` | sessionActions.ts |
| `workbench_run_task` | `{ sessionId, taskDef }` | `{ runId, status }` | daemonChatBridge.ts |
| `workbench_cancel_run` | `{ runId }` | `{ success }` | useChatStream.ts |
| `workbench_approve_tool_call` | `{ runId, toolCallId }` | `{ success }` | ChatCard.tsx |
| `workbench_update_config` | `{ key, value }` | `{ success }` | SettingsPanel.tsx |
| `workbench_list_plans` | `{ sessionId }` | `{ plans: PlanSummary[] }` | PlanPanel.tsx |
| `workbench_session_events` | `{ sessionId, cursor? }` | `{ events, nextCursor? }` | sessionPersistence.ts |
| `workbench_connection_status` | — | `{ connected, daemonVersion }` | App.tsx |
| `workbench_open_host_target` | `{ target, targetType }` | `{ success }` | host_openers 桥接 |

```typescript
// packages/shared-types/src/validators/ipc-schemas.ts [NEW]

import { z } from "zod";

// ---- Sidecar 查询响应 ----
export const SidecarQueryResponseSchema = z.object({
  id: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type SidecarQueryResponse = z.infer<typeof SidecarQueryResponseSchema>;

// ---- 更多 schema... ----
```

**阶段 2：创建类型安全的 invoke 包装器**

```typescript
// packages/shared-types/src/validators/typed-invoke.ts [NEW]

import type { ZodSchema } from "zod";

/**
 * 类型安全的 Tauri invoke 包装器。
 * 在运行时通过 Zod schema 校验 IPC 响应结构，
 * 确保任何 Rust 端的结构变更不会静默丢失数据。
 */
export function createTypedInvoke(invoke: (cmd: string, args?: unknown) => Promise<unknown>) {
  return async function typedInvoke<T>(
    command: string,
    args: Record<string, unknown> | undefined,
    responseSchema: ZodSchema<T>,
  ): Promise<T> {
    const raw = await invoke(command, args);
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) {
      console.error(
        `[IPC Schema Violation] Command "${command}" returned unexpected shape:`,
        parsed.error.format(),
      );
      throw new Error(`IPC response validation failed for "${command}": ${parsed.error.message}`);
    }
    return parsed.data;
  };
}
```

### 8.3 注意事项

- **Zod 作为可选依赖**：在 Layer A 阶段，仅为 `shared-types` 添加 `zod` 作为 `devDependencies`（用于类型推断），`peerDependencies`（运行时由消费者提供）。
- **渐进式迁移**：不要求在 Layer A 完成时将所有 `invoke` 调用都迁移为 `typedInvoke`，仅要求基础设施（schema + 包装器）就位，实际迁移在 Layer E 中完成。

### 8.4 验证命令

```bash
cd packages/shared-types
npm install zod --save-dev
npx tsc --noEmit
npx vitest run  # 如有 schema 测试
```

---

## 九、多 Agent 并行分配方案

### 9.1 Agent 划分与互斥边界

```
┌─────────────────────────────────────────────────────────────┐
│                    Round 1: Layer A                          │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Agent A1    │  │  Agent A2    │  │  Agent A3    │      │
│  │  contract.ts │  │  shared-     │  │  async-      │      │
│  │  拆分        │  │  types 去重  │  │  mutex 修复  │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                             │
│  ┌──────────────┐  ┌──────────────────────────────┐        │
│  │  Agent A4    │  │  Agent A5                     │        │
│  │  QA 脚本     │  │  Serde 审计 + Zod 校验层     │        │
│  │  去重        │  │                               │        │
│  └──────────────┘  └──────────────────────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

### 9.2 Agent 任务指令卡

#### Agent A1：Workbench Contract 领域拆分

- **输入文件**：`apps/agent-workbench/src/shared/workbench-contract.ts` (3002 行)
- **输出**：`apps/agent-workbench/src/shared/workbench-contract/` 目录（7-10 个子模块 + barrel index）
- **关键约束**：
  - 每个子模块 ≤ 500 行
  - barrel index 保持 100% 向后兼容导出
  - 将 `WorkbenchJsonPrimitive`/`WorkbenchJsonValue`/`WorkbenchJsonObject` 改为从 `@conex/shared-types` 导入的 `JsonPrimitive`/`JsonValue`/`JsonObject` 的 deprecated 别名
  - 运行 `npx tsc --noEmit` 零新增错误
  - 运行 `npx madge --circular` 零循环引用
- **不得修改的文件**：`packages/shared-types/`（由 Agent A2 负责）、`packages/shared-utils/`（由 Agent A3 负责）

#### Agent A2：Shared Types 规范化

- **输入文件**：`packages/shared-types/src/` (13 个文件)
- **输出**：清理后的 shared-types 包
- **关键约束**：
  - 确认 `primitive-types.ts` 中的 JSON 基础类型为全局唯一来源
  - 消除与 workbench-contract 的概念重叠类型（建立映射文档）
  - 运行 `npm run build --filter=@conex/shared-types` 零错误
- **不得修改的文件**：`workbench-contract.ts`（由 Agent A1 负责）

#### Agent A3：AsyncMutex/AsyncSemaphore 安全修复

- **输入文件**：`packages/shared-utils/src/async-mutex.ts` (189 行)，`packages/shared-utils/src/async-mutex.test.ts`
- **输出**：修复后的 async-mutex.ts + 新增测试用例
- **关键修改**：
  - `AsyncMutex.acquire` L72：`this.release()` → `queueMicrotask(() => this.release())`
  - `AsyncSemaphore.acquire` L156：`this.release()` → `queueMicrotask(() => this.release())`
  - 新增 500 个并发 abort 的压力测试
- **不得修改的文件**：任何 `shared-types` 或 `workbench-contract` 文件

#### Agent A4：QA 脚本 safeParseJsonObject 去重

- **输入文件**：`scripts/qa/` 下的 4 个 `.mjs` 文件
- **输出**：新建 `scripts/qa/utils/json-helper.mjs`，4 个脚本中删除局部定义并统一引入
- **关键约束**：
  - 每个修改后的脚本能通过 `node --check` 语法验证
  - 函数签名保持不变，不引入任何行为变更
- **不得修改的文件**：任何 TypeScript 源文件或 Rust 文件

#### Agent A5：Serde 审计（只读）+ IPC Zod 校验层

- **输入**：所有 `apps/agent-workbench/src-tauri/src/**/*.rs` 文件（**只读审计**，不修改 Rust 代码）
- **输出 1**：`ipc-naming-conventions.md` 命名映射文档 + Serde 审计报告
- **输出 2**：`packages/shared-types/src/validators/ipc-schemas.ts` 和 `typed-invoke.ts` [NEW]
- **关键约束**：
  - 审计所有 `#[derive(Serialize)]` / `#[derive(Deserialize)]` 结构体的 `rename_all` 注解
  - **只做只读审计**，不修改任何 `*.rs` 文件；缺少 `rename_all` 的结构体在审计报告中列出，实际修改交由 Layer B（B-5 或 B-11）中的 Rust Agent 执行
  - 不修改已有的 `kebab-case` 注解（避免协议破坏），仅记录到映射文档
  - Zod 仅作为 devDependencies 引入
- **不得修改的文件**：所有 `*.rs` 文件（只读审计仅输出报告，不做修改）、`async-mutex.ts`、`workbench-contract.ts`、QA 脚本

---

## 十、验收标准总表

| 编号 | 检查项 | 验证方式 | 通过条件 |
|-----|--------|---------|---------|
| V-1 | `workbench-contract.ts` 已被拆分 | `wc -l apps/agent-workbench/src/shared/workbench-contract/*.ts` | 原文件不再存在或仅为 barrel 重导出；每个子模块 ≤ 500 行 |
| V-2 | 零 import 路径破坏 | `npx tsc --noEmit` (项目全局) | 零新增编译错误 |
| V-3 | 零循环引用 | `npx madge --circular apps/agent-workbench/src/shared/workbench-contract/` | 零循环 |
| V-4 | async-mutex 爆栈修复 | `npx vitest run src/async-mutex.test.ts` | 500 个并发 abort 测试通过 |
| V-5 | async-mutex 现有测试 | `npm run test --filter=@conex/shared-utils` | 全部通过 |
| V-6 | QA 脚本去重 | `grep -rn "function safeParseJsonObject" scripts/qa/` | 仅在 `utils/json-helper.mjs` 中出现 1 次 |
| V-7 | Serde 审计 | `grep -rn "derive.*Serialize" --include="*.rs" apps/agent-workbench/src-tauri/` 与 `grep "rename_all"` 交叉比对 | 所有结构体均有 rename_all 或在映射文档中有说明 |
| V-8 | Zod 校验层编译 | `npx tsc --noEmit -p packages/shared-types/tsconfig.json` | 零错误 |
| V-9 | 全局构建 | `npm run build` | 零新增错误 |
| V-10 | Lint 通过 | `npm run lint` + `cargo clippy` | 零新增 warning |

---

## 十一、风险与缓解

| 风险 | 概率 | 影响 | 缓解策略 |
|-----|------|------|---------|
| workbench-contract 拆分导致消费者 import 路径破坏 | 中 | 高 | barrel index 保持与原文件完全一致的导出签名；Agent A1 必须在拆分后对所有消费者运行编译验证 |
| async-mutex queueMicrotask 延迟影响锁公平性 | 低 | 中 | 仅在 signal 已 aborted 时使用 queueMicrotask（正常路径不变）；添加测试验证锁的 FIFO 顺序不受影响 |
| Serde rename_all 变更导致 IPC 协议破坏 | 高 | 高 | 严禁修改已有的 kebab-case 注解；仅对**缺失注解的新结构体**添加 camelCase |
| Zod 依赖增加 shared-types 的包体积 | 低 | 低 | Zod 仅作为 devDependencies + peerDependencies，不打入生产 bundle |
| Agent A1 与 Agent A2 在 JSON 基础类型上产生冲突 | 中 | 中 | Agent A2 先完成 shared-types 的规范化，Agent A1 在 A2 完成后再执行 barrel index 中的 deprecated 别名声明 |

### 执行顺序建议

```
A3 (async-mutex 修复) ─── 独立，可立即启动
A4 (QA 脚本去重) ──────── 独立，可立即启动
A5 (Serde 审计 + Zod) ─── 独立，可立即启动
A2 (shared-types 规范) ── 独立，可立即启动
A1 (contract 拆分) ────── 依赖 A2 完成后启动（需要确认 JsonPrimitive 的导入路径）
```

即 A2/A3/A4/A5 可完全并行，A1 在 A2 完成后启动。总耗时 = max(A2, A3, A4, A5) + A1。
