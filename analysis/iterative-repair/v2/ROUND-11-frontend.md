# Round 11：前端韧性加固与 TSC 清零

> **本文件是 Round 11（`crish-desktop` 前端韧性加固与 TSC 错误清零）的唯一权威设计文档**（依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 29 唯一权威来源原则）。
> 所有 Round 11 的执行 Agent 必须严格遵守本文件的接口契约与任务边界。
> 后续 Round（R12 CI 与文档）引用前端的错误翻译层、IPC 解析、Store 错误标准化成果时必须指向本文件第 3 节与第 5 节。
>
> **前置文档**：
>
> - `../../ANTI_OVERENGINEERING_GUARDRAILS.md` — 架构治理约束（禁令 23 迁移三阶段、禁令 26 TSC 错误管理、禁令 28 Agent 任务量、禁令 31 文档同步）
> - `./01-OVERVIEW.md` — 总览（§1.2 编译健康状态 315 TSC 错误、§3 依赖图、§3.2 拓扑层级 Layer 11、§4.1 轮次总览）
> - `./03-ERROR-MIGRATION.md` — 错误码迁移（§2 CrishErrorCode 64 正式码 + 10 reserved 码体系、§3 旧码→新码映射、§6 CrishErrorPayload 跨进程序列化、§7 三阶段策略）
> - `./ROUND-07-daemon.md` — §5 IPC 协议错误传播设计（`ErrorMessage.payload` 字段为前端输入契约）
>
> **本 Round 遵守的硬性红线**：
>
> - 禁令 23：迁移遵循"共存→迁移→删除"三阶段，本 Round 为迁移阶段（前端旧错误处理保留，新处理与之共存，R12 删除阶段才移除旧实现）
> - 禁令 26：Round 11 结束时 TSC 错误降至 < 50（不要求 0，完全清零作为后续独立任务）；每轮开始时记录 `tsc-errors-baseline.json`
> - 禁令 28：每个 Agent ≥ 5 文件修改或 ≥ 300 行代码变更
> - 禁令 31：本 Round 完成后更新 `02-FILE-MAPPING.md` 与 `03-ERROR-MIGRATION.md` §4 迁移追踪表

---

## 1. Round 概述

### 1.1 拓扑层说明

Round 11 处于拓扑 Layer 10（前端层），在 Round 10（Rust 侧 `CrishErrorPayload` 对齐）完成后执行。`crish-desktop` 是 React 19 + Zustand + Vite 5 桌面前端，通过 WebSocket 与 daemon 通信、通过 Tauri invoke 与 Rust 壳通信，是错误传播链的最终消费端与用户可见出口。

```
Layer 0:  shared-types (R1 增强，CrishErrorPayload / CrishErrorCode / CRISH_ERROR_REGISTRY) ← 输入契约
Layer 7:  agent-daemon  (R7，ErrorMessage.payload: CrishErrorPayload?)                      ← IPC 输入契约
Layer 9:  Rust crates   (R10，IpcResponse.error 迁移为 CrishErrorPayload)                   ← Tauri 输入契约
Layer 10: crish-desktop (本 Round)                                                          ← 本 Round
```

**关键拓扑约束**（依据 `01-OVERVIEW.md` §3.2 与 §4.2 伪并行警告修正）：

- Round 10 必须先于 Round 11：前端错误翻译层依赖 Rust 端 `CrishErrorPayload` 已就位（`IpcResponse.error` 从 `Option<String>` 迁移为 `Option<CrishErrorPayload>`）
- Round 7 必须先于 Round 11：前端 daemon WebSocket 客户端依赖 daemon 的 `ErrorMessage.payload` 字段（R7 已扩展）
- Round 11 必须先于 Round 12：CI 门禁规则（R12）依赖前端 TSC 错误降至 < 50 的稳定基线
- 循环依赖必须保持为 0（dependency-cruiser 强制）；`crish-desktop` 仅依赖 `@crish/shared-types` 与 `@crish/agent-daemon`（通过进程边界），不反向依赖

### 1.2 目标

| 维度         | 说明                                                                                                                                                                                                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **目标包**   | `crish-desktop`（前端，~180 文件，~35K LOC）                                                                                                                                                                                                                                                                                                        |
| **核心任务** | ① 实现前端错误翻译层 `toUserVisibleError(payload)` 对齐 `CrishErrorPayload`；② `StreamRecovery` 对齐新 `CrishError` 错误码；③ Zustand store 错误状态标准化为 `CrishErrorPayload` 类型；④ `daemonClient.ts` 解析新 `IpcResponse.error` 与 `ErrorMessage.payload` 格式；⑤ TSC 错误从 ~180 降至 < 50（禁令 26 目标）；⑥ 修复前端测试与 API 层 TSC 错误 |
| **不改动项** | 前端 UI 组件的业务逻辑、Zustand store 的状态结构（仅扩展错误字段类型）、WebSocket 重连与心跳机制（仅扩展错误解析）                                                                                                                                                                                                                                  |
| **前置轮次** | Round 10（Rust 端 `CrishErrorPayload` 已就位，`IpcResponse.error` 已迁移）                                                                                                                                                                                                                                                                          |
| **后续轮次** | Round 12（CI 门禁 + 文档同步）                                                                                                                                                                                                                                                                                                                      |
| **Agent 数** | 5（11-A / 11-B / 11-C / 11-D / 11-E）                                                                                                                                                                                                                                                                                                               |
| **并行性**   | 11-A / 11-B / 11-C 文件集不相交可三路并行；11-D 依赖 11-A/11-B/11-C 完成（避免 TSC 修复与新代码引入冲突）；11-E 依赖 11-D 完成（避免错误数对比基线漂移）                                                                                                                                                                                            |

### 1.3 关键设计约束

以下约束源自 `ANTI_OVERENGINEERING_GUARDRAILS.md` 与本 Round 任务描述，执行 Agent 必须逐条遵守：

1. **TSC 目标 < 50**（禁令 26）：Round 11 结束时 crish-desktop 范围 TSC 错误数 < 50。不要求清零，剩余错误作为后续独立任务。每个 Agent 开始时记录本 Agent 的 TSC 基线，结束时对比不恶化。
2. **共存策略**（禁令 23）：前端旧错误处理（`userFacingErrors.ts` 的正则分类 + `SoftFailureKind` 联合类型）保留，新错误翻译层（`error-translation.ts` 的 `toUserVisibleError` 基于 `CrishErrorPayload`）与之共存。旧实现标记 `@deprecated`，R12 删除阶段才移除。新代码优先使用新翻译层，旧调用点不强制迁移。
3. **错误翻译层基于注册表**（`03-ERROR-MIGRATION.md` §2.3）：`toUserVisibleError(payload)` 通过 `CRISH_ERROR_REGISTRY` 的 `public` 字段决定用户可见性、`action` 字段（i18n 键）提供操作建议。禁止为 64 个正式码 + 10 个 reserved 码手写 switch/case——必须查表。未命中注册表的码回退到 `common.unknown`。
4. **IPC 解析对齐 R10**（`03-ERROR-MIGRATION.md` §6.3 / `ROUND-07-daemon.md` §5）：`IpcResponse.error` 从 `IpcError`（`{code: number, message: string}`）迁移为 `CrishErrorPayload`（`{code: string, message, category, retryable, public, action, ...}`）。前端解析时先尝试 `CrishErrorPayload` 结构，失败回退旧 `IpcError`（共存阶段）。
5. **StreamRecovery 对齐**：`markFailed(sessionId, error: string)` 扩展为接受 `CrishErrorPayload | CrishError | string`，通过 `normalizeCrishError()` 统一转换。旧字符串调用点保留，新调用点使用 `CrishErrorPayload`。
6. **Store 错误标准化**：Zustand store 中的错误状态字段（如 `errorDetail?`、`lastError`）标准化为 `CrishErrorPayload | null` 类型。`try-catch` 中使用 `normalizeCrishError(error: unknown): CrishErrorPayload` 兜底。
7. **Agent 任务量**（禁令 28）：每个 Agent ≥ 5 文件或 ≥ 300 行变更。
8. **不引入新包依赖**：`crish-desktop` 仅新增对 `@crish/shared-types` 的 `CrishErrorPayload` / `CrishError` / `CRISH_ERROR_REGISTRY` / `getErrorInfo` / `fromUnknownError` 导入。不引入 `@crish/agent-core`、`@crish/logger` 等运行时包（前端不直接依赖运行时层）。

### 1.4 依赖关系

```
Round 10 交付物（Rust CrishErrorPayload + IpcResponse.error 迁移）
    │
    ▼
@crish/shared-types ──→ crish-desktop    （CrishErrorPayload / CrishErrorCode / CRISH_ERROR_REGISTRY）
agent-daemon (进程边界) ──→ crish-desktop （ErrorMessage.payload: CrishErrorPayload? via WebSocket）
Rust Tauri 壳 (进程边界) ──→ crish-desktop （IpcResponse.error: CrishErrorPayload via invoke）
```

> `crish-desktop` 现有 `@crish/agent-runtime` / `@crish/agent-daemon` 的 import（如类型定义）通过 legacy shim 继续工作。本轮不强制迁移 import 路径——shim 在 v0.3.0 才删除（禁令 24），前端的 import 路径迁移由 R12 统一处理。

---

## 2. Agent 任务详细设计

### 2.1 Agent 11-A：前端错误翻译层 + toUserVisibleError

| 维度       | 说明                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **类型**   | 实现型                                                                                                                                                                                                                                                                                                                                               |
| **目标**   | ① 实现 `toUserVisibleError(payload: CrishErrorPayload): UserVisibleError` 函数；② 实现 `normalizeCrishError(error: unknown): CrishErrorPayload` 兜底转换；③ 实现 `fromErrorPayload(payload: CrishErrorPayload): CrishError` 反序列化；④ 对齐 Rust 端 Round 10 的 `CrishErrorPayload` 格式；⑤ 标记旧 `userFacingErrors.ts` 为 `@deprecated`（不删除） |
| **前置**   | Round 1 已交付 `CrishErrorPayload` / `CRISH_ERROR_REGISTRY` / `getErrorInfo` / `fromUnknownError`；Round 10 已交付 Rust 端 `CrishErrorPayload`                                                                                                                                                                                                       |
| **后续**   | Agent 11-B 使用 `normalizeCrishError` 标准化 store 错误；Agent 11-C 使用 `fromErrorPayload` 解析 IPC 错误                                                                                                                                                                                                                                            |
| **并行性** | 与 Agent 11-B / 11-C 文件集不相交，可三路并行                                                                                                                                                                                                                                                                                                        |

#### 输入

| 输入                           | 路径                                                       | 说明                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `CrishErrorPayload` 接口       | `packages/shared-types/src/error-payload.ts`（R1 交付）    | 跨进程序列化的错误负载，含 `code`/`message`/`category`/`retryable`/`public`/`action`/`metadata`/`cause`/`stack`/`timestamp` |
| `CrishErrorCode` 联合类型      | `packages/shared-types/src/error-codes.ts`（R1 交付）      | 64 正式码 + 10 reserved 码 `domain.reason` 格式                                                                             |
| `CRISH_ERROR_REGISTRY` 注册表  | `packages/shared-types/src/error-codes.ts`（R1 交付）      | 每个码的元信息（`title`/`category`/`retryable`/`public`/`action`）                                                          |
| `getErrorInfo(code)` 函数      | `packages/shared-types/src/error-codes.ts`（R1 交付）      | 查表，未命中回退 `common.unknown`                                                                                           |
| `fromUnknownError(error)` 函数 | `packages/shared-types/src/error-payload.ts`（R1 交付）    | 从未知错误构造 Payload（兜底 `common.unknown`）                                                                             |
| `CrishError` 类                | `packages/shared-types/src/errors.ts`（R1 交付）           | 接受 `CrishErrorCode                                                                                                        | string`，向后兼容旧码 |
| 旧 `userFacingErrors.ts`       | `apps/crish-desktop/src/api/userFacingErrors.ts`（106 行） | 现有正则分类（`NETWORK_RE`/`NO_KEY_RE`/`AUTH_RE` 等）+ `SoftFailureKind` 联合类型 + `softFailureMessage`                    |

#### 步骤

1. **新建 `error-translation.ts`** → `apps/crish-desktop/src/utils/error-translation.ts`

   实现 `toUserVisibleError` 函数，根据 `CrishErrorPayload.public` 字段决定用户可见性、`action` 字段提供操作建议。设计为纯函数查表，不手写 switch/case：

   ```ts
   import type { CrishErrorPayload } from '@crish/shared-types';
   import { getErrorInfo } from '@crish/shared-types';

   /** 用户可见的错误展示模型 */
   export interface UserVisibleError {
     /** 是否对终端用户可见（由 payload.public 决定） */
     readonly visible: boolean;
     /** 用户可见的标题（i18n 键，前端按键查翻译，未命中回退英文 title） */
     readonly title: string;
     /** 用户可见的消息（直接使用 payload.message，已由 Rust 端本地化） */
     readonly message: string;
     /** 用户可执行的操作建议（i18n 键，未命中回退英文原文） */
     readonly action: string;
     /** 是否可重试（前端据此决定是否展示"重试"按钮） */
     readonly retryable: boolean;
     /** 错误码（供日志与遥测使用，不对用户展示原始码） */
     readonly code: string;
     /** 严重级别（由 category 映射，控制 UI 展示样式：toast / banner / modal） */
     readonly severity: 'info' | 'warning' | 'error' | 'silent';
   }

   /**
    * 将 CrishErrorPayload 转换为用户可见的错误展示模型。
    *
    * 设计原则：
    * - 通过 CRISH_ERROR_REGISTRY 查表，不为 64 个正式码 + 10 个 reserved 码手写 switch/case
    * - public=false 的错误返回 visible=false（内部诊断码不展示给用户）
    * - action 为 i18n 键，前端按键查翻译，未命中回退英文 title
    * - severity 由 category 映射：transient→warning, permanent→error, security→error, protocol→warning
    * - runtime.aborted 与 provider.cancelled 映射为 silent（用户主动取消，不打扰）
    */
   export function toUserVisibleError(
     payload: CrishErrorPayload
   ): UserVisibleError {
     const info = getErrorInfo(payload.code);
     const severity = mapSeverity(payload);
     return {
       visible: payload.public,
       title: info.title,
       message: payload.message,
       action: payload.action,
       retryable: payload.retryable,
       code: payload.code,
       severity,
     };
   }

   function mapSeverity(
     payload: CrishErrorPayload
   ): UserVisibleError['severity'] {
     // 用户主动取消：silent（不打扰）
     if (
       payload.code === 'runtime.aborted' ||
       payload.code === 'provider.cancelled'
     ) {
       return 'silent';
     }
     switch (payload.category) {
       case 'transient':
         return 'warning';
       case 'permanent':
         return 'error';
       case 'security':
         return 'error';
       case 'protocol':
         return 'warning';
       default:
         return 'error';
     }
   }
   ```

2. **实现 `normalizeCrishError` 兜底转换** → `apps/crish-desktop/src/utils/error-translation.ts`

   统一将 `unknown` 错误转换为 `CrishErrorPayload`，供 store 的 `try-catch` 与 daemon client 的 reject 路径使用：

   ```ts
   import { fromUnknownError, toErrorPayload } from '@crish/shared-types';
   import { CrishError } from '@crish/shared-types';

   /**
    * 将任意未知错误标准化为 CrishErrorPayload。
    *
    * 转换优先级：
    * 1. 已是 CrishErrorPayload → 原样返回
    * 2. CrishError 实例 → toErrorPayload()（保留 cause 链）
    * 3. 普通 Error / 字符串 / 其他 → fromUnknownError()（兜底 common.unknown）
    *
    * 此函数为 store 与 daemon client 的 try-catch 兜底入口，
    * 确保所有错误状态字段统一为 CrishErrorPayload 类型。
    */
   export function normalizeCrishError(error: unknown): CrishErrorPayload {
     if (error === null || error === undefined) {
       return fromUnknownError(new Error('unknown error'));
     }
     if (
       typeof error === 'object' &&
       error !== null &&
       'code' in error &&
       'category' in error
     ) {
       return error as CrishErrorPayload;
     }
     if (error instanceof CrishError) {
       return toErrorPayload(error);
     }
     return fromUnknownError(error);
   }
   ```

3. **实现 `fromErrorPayload` 反序列化** → `apps/crish-desktop/src/utils/error-translation.ts`

   将 `CrishErrorPayload`（纯数据）还原为 `CrishError` 实例，供 daemon client reject 与 store catch 后的 throw 路径使用：

   ```ts
   import {
     CrishError,
     type CrishErrorCode,
     type CrishErrorCategory,
   } from '@crish/shared-types';
   import { getErrorInfo } from '@crish/shared-types';

   /**
    * 从 CrishErrorPayload 反序列化为 CrishError 实例。
    *
    * 用途：
    * - daemonClient.ts 的 reject 路径：从 IPC ErrorMessage.payload 还原 CrishError
    * - tauriInvoke.ts 的 error 路径：从 IpcResponse.error 还原 CrishError
    * - 测试断言：从 payload 构造 CrishError 以便 instanceof 判断
    *
    * cause 链递归还原（最多 8 层，与 toErrorPayload 的截断一致）。
    */
   export function fromErrorPayload(
     payload: CrishErrorPayload,
     depth = 0
   ): CrishError {
     const info = getErrorInfo(payload.code);
     const cause =
       depth < 8 && payload.cause
         ? fromErrorPayload(payload.cause, depth + 1)
         : undefined;
     return new CrishError(
       payload.message,
       payload.code as CrishErrorCode,
       payload.category as CrishErrorCategory,
       payload.retryable,
       payload.metadata,
       {
         ...(cause !== undefined ? { cause } : {}),
         public: payload.public,
         action: payload.action,
       }
     );
   }
   ```

4. **实现 i18n 键查翻译辅助函数** → `apps/crish-desktop/src/utils/error-translation.ts`

   `action` 字段为 i18n 键（如 `action.provider.check_network`），前端按键查翻译，未命中回退英文原文（`info.title`）：

   ```ts
   /**
    * i18n 键 → 用户可见文案的查表函数。
    *
    * 设计为接受外部注入的 translate 函数，避免 error-translation.ts 硬依赖 i18n 库。
    * 调用方（如 Toast 组件）注入自己的 t() 函数。
    *
    * 未命中翻译时回退到 fallback 字符串（通常为 info.title 英文原文）。
    */
   export type TranslateFn = (key: string, fallback?: string) => string;

   export function resolveActionText(
     payload: CrishErrorPayload,
     translate?: TranslateFn
   ): string {
     if (!translate) return getErrorInfo(payload.code).title;
     return translate(payload.action, getErrorInfo(payload.code).title);
   }

   export function resolveTitleText(
     payload: CrishErrorPayload,
     translate?: TranslateFn
   ): string {
     const info = getErrorInfo(payload.code);
     if (!translate) return info.title;
     return translate(`error.${payload.code}.title`, info.title);
   }
   ```

5. **标记旧 `userFacingErrors.ts` 为 `@deprecated`** → `apps/crish-desktop/src/api/userFacingErrors.ts`

   在文件顶部 JSDoc 添加 `@deprecated` 标注，指向新实现。**不删除任何导出**（共存阶段保留）：

   ```ts
   /**
    * User-facing error policy for the desktop product.
    *
    * @deprecated 此模块基于正则分类的旧错误翻译层，无法承载结构化错误码。
    * 新代码应使用 `@/utils/error-translation.ts` 的 `toUserVisibleError(payload)`，
    * 它通过 CRISH_ERROR_REGISTRY 查表，支持 64 个正式 CrishErrorCode + 10 个 reserved 的精确映射。
    *
    * 本模块在 Round 11 共存阶段保留（旧调用点仍工作），
    * Round 12 删除阶段将移除。迁移路径：
    * - classifySoftFailure(input) → toUserVisibleError(normalizeCrishError(input))
    * - softFailureMessage(kind) → toUserVisibleError(payload).message
    * - networkUserMessage() → resolveTitleText({code:"provider.network",...})
    *
    * 迁移指南见 ROUND-11-frontend.md §3.2。
    */
   ```

6. **验证**
   - `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json` 通过（错误数 ≤ 基线，新文件无 TSC 错误）。
   - 新增单元测试 `error-translation.test.ts` 验证：64 个正式码 + 10 个 reserved 码的 `toUserVisibleError` 输出正确、`public=false` 的码 `visible=false`、`normalizeCrishError` 三种输入路径、`fromErrorPayload` 递归 cause 链。

#### 输出

| 文件                                                     | 类型 | 行数变化（估） | 说明                                                                                                                       |
| -------------------------------------------------------- | ---- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `apps/crish-desktop/src/utils/error-translation.ts`      | 新建 | +180           | `toUserVisibleError` + `normalizeCrishError` + `fromErrorPayload` + `resolveActionText`/`resolveTitleText` + `mapSeverity` |
| `apps/crish-desktop/src/utils/error-translation.test.ts` | 新建 | +150           | 64 正式码 + 10 reserved 码查表测试 + public=false 测试 + normalizeCrishError 三路径测试 + fromErrorPayload cause 链测试    |
| `apps/crish-desktop/src/api/userFacingErrors.ts`         | 修改 | +15            | `@deprecated` JSDoc + 迁移指南注释                                                                                         |
| `apps/crish-desktop/src/utils/index.ts` 或就近 barrel    | 修改 | +2             | 导出 error-translation 的公开 API                                                                                          |
| `apps/crish-desktop/package.json`                        | 修改 | +1             | 确认 `@crish/shared-types` 依赖（如未声明）                                                                                |

文件数：5（满足 ≥5）。代码变更量：~350 行新增（满足 ≥300）。

#### 验证

- `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json` 通过（错误数 ≤ 基线）。
- `npx vitest run apps/crish-desktop/src/utils/error-translation.test.ts` 全部通过。
- `npm run lint:depcruise` 0 violations（`error-translation.ts` 仅依赖 `@crish/shared-types`，无循环）。

---

### 2.2 Agent 11-B：StreamRecovery 对齐 + Store 层错误标准化

| 维度       | 说明                                                         |
| ---------- | ------------------------------------------------------------ |
| **类型**   | 迁移型 + 修复型                                              |
| **目标**   | ① `StreamRecovery.markFailed` 扩展为接受 `CrishErrorPayload  | CrishError | string`；② `TrackedStream.error`字段标准化为`CrishErrorPayload | null`；③ `SessionMessage.errorDetail`字段标准化为`CrishErrorPayload | null`；④ store 层 13 处 `catch`块使用`normalizeCrishError`兜底；⑤`sessionActions`/`sessionMessageActions`/`workspaceShellStore` 等的错误处理对齐新类型 |
| **前置**   | Agent 11-A 已交付 `normalizeCrishError` / `fromErrorPayload` |
| **后续**   | Agent 11-D 修复 TSC 时可依赖标准化的错误类型                 |
| **并行性** | 与 Agent 11-A / 11-C 文件集不相交，可三路并行                |

#### 输入

| 输入                  | 路径                                                             | 说明                                                                    |
| --------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `normalizeCrishError` | `apps/crish-desktop/src/utils/error-translation.ts`（11-A 交付） | 兜底转换                                                                |
| `StreamRecovery`      | `apps/crish-desktop/src/services/StreamRecovery.ts`（692 行）    | `markFailed(sessionId, error: string)` + `TrackedStream.error?: string` |
| `streamingStore`      | `apps/crish-desktop/src/store/streamingStore.ts`                 | 轻量 per-token 缓冲（无错误状态字段，仅 catch 标准化）                  |
| `sessionStore` 类型   | `apps/crish-desktop/src/store/types.ts`（L443 `errorDetail?`）   | 会话消息的错误详情字段                                                  |
| `layoutStore`         | `apps/crish-desktop/src/store/layoutStore.ts`                    | 主 store（god-object）                                                  |
| `sessionActions`      | `apps/crish-desktop/src/store/sessionActions.ts`                 | 会话 actions（含 try-catch 错误处理）                                   |

#### 步骤

1. **`StreamRecovery.markFailed` 签名扩展** → `apps/crish-desktop/src/services/StreamRecovery.ts`

   将 `markFailed(sessionId: string, error: string)` 扩展为接受 `CrishErrorPayload | CrishError | string`，内部通过 `normalizeCrishError` 统一转换。`TrackedStream.error` 字段类型从 `string` 标准化为 `CrishErrorPayload | null`：

   ```ts
   import { normalizeCrishError } from "../utils/error-translation";
   import type { CrishErrorPayload } from "@crish/shared-types";

   export interface TrackedStream {
     sessionId: string;
     runId: string;
     status: 'streaming' | 'paused' | 'completed' | 'failed';
     lastMessageTime: number;
     lastSequenceNumber: number;
     receivedBytes: number;
     /** 失败错误负载（仅 status='failed' 时存在；null 表示无错误或已清除） */
     error: CrishErrorPayload | null;
   }

   interface InternalStreamState extends TrackedStream {
     error: CrishErrorPayload | null;
   }

   /**
    * 标记流为 failed。
    * 幂等：已处于 terminal 状态（completed/failed）时为 no-op。
    *
    * error 参数接受三种类型，内部统一标准化为 CrishErrorPayload：
    * - CrishErrorPayload：直接使用
    * - CrishError：通过 normalizeCrishError 转换（保留 cause 链）
    * - string：通过 normalizeCrishError 转换（兜底 common.unknown，message=string）
    */
   markFailed(sessionId: string, error: CrishErrorPayload | CrishError | string): void {
     const s = this.streams.get(sessionId);
     if (!s) return;
     if (this.isTerminal(s)) return;
     s.status = 'failed';
     s.error = typeof error === 'string'
       ? normalizeCrishError(new Error(error))
       : normalizeCrishError(error);
     eventBus.emit('stream:failed', { sessionId, error: s.error }, 'daemon');
   }
   ```

   `toTrackedStream` 同步更新：`error` 字段从 `s.error !== undefined ? { error: s.error } : {}` 改为直接赋值 `error: s.error`（`null` 是合法值）。

2. **`recoverStream` 的错误处理对齐** → `apps/crish-desktop/src/services/StreamRecovery.ts`

   `recoverStream` 方法 L411 的 `this.markFailed(sessionId, String(snap?.error ?? remoteStatus))` 与 L490 的 `catch (e)` 块对齐新签名：

   ```ts
   // L411: 远端已终态的 markFailed
   if (remoteStatus === 'failed' || remoteStatus === 'error' || remoteStatus === 'cancelled') {
     const errorPayload = snap?.error
       ? normalizeCrishError(snap.error)
       : normalizeCrishError(new Error(`remote status: ${remoteStatus}`));
     this.markFailed(sessionId, errorPayload);
     return false;
   }

   // L490: catch 块的 markFailed（恢复失败标记为 paused）
   catch (e) {
     if (this.isTerminal(s)) {
       return s.status === 'completed';
     }
     s.status = 'paused';
     s.error = normalizeCrishError(e);  // 标准化为 CrishErrorPayload
     eventBus.emit(
       'stream:paused',
       { sessionId, runId: s.runId, error: s.error },
       'daemon',
     );
     return false;
   }
   ```

3. **Store 层 catch 块标准化** → `apps/crish-desktop/src/store/` 下含 `catch` 的文件

   > **实证扫描**：`streamingStore.ts` 是轻量 per-token 缓冲（仅 `StreamEntry` 文本/工具进度），**不含错误状态字段**。本步骤聚焦 store 层真实存在的 `catch` 块（共 13 处，分布于 7 文件），统一为 `normalizeCrishError` 兜底，确保错误日志与遥测携带结构化 `CrishErrorCode`。

   | 文件                       | catch 数 | 当前处理                       | 标准化后                                                          |
   | -------------------------- | -------- | ------------------------------ | ----------------------------------------------------------------- |
   | `workspaceShellStore.ts`   | 4        | `.catch(() => {...})` 静默吞错 | `normalizeCrishError(e)` → 结构化日志 + 可选 UI banner            |
   | `layoutAnimationStore.ts`  | 3        | `console.warn` 裸字符串        | `console.warn(normalizeCrishError(e))` 携带 code                  |
   | `store-persistence.ts`     | 2        | `console.warn` + `.catch`      | `normalizeCrishError(e)` → 持久化失败用 `store.write_failed`      |
   | `rustCoreStore.ts`         | 1        | `console.warn`                 | `normalizeCrishError(e)` → Rust 初始化失败用 `common.unknown`     |
   | `storeTransaction.ts`      | 1        | `console.warn`                 | `normalizeCrishError(e)` → 事务失败用 `runtime.transition_failed` |
   | `sessionMessageActions.ts` | 1        | 状态转换 catch（非错误负载）   | 保留控制流 catch，仅日志走 `normalizeCrishError`                  |
   | `openTool.ts`              | 1        | `.catch(() => {...})` 静默     | `normalizeCrishError(e)` → 日志                                   |

   标准化模式（以 `workspaceShellStore.ts` 为例）：

   ```ts
   import { normalizeCrishError } from "../utils/error-translation";

   // 旧：静默吞错
   .catch(() => { /* ignore */ });

   // 新：结构化日志（不引入新 UI 状态，仅丰富日志与遥测）
   .catch((e) => {
     const payload = normalizeCrishError(e);
     console.warn(`[workspaceShellStore] ${payload.code}: ${payload.message}`);
     // 遥测 hook（如已接入）：telemetry.report(payload)
   });
   ```

   > **设计约束**：本步骤不新增 store 错误状态字段（避免 god-object 膨胀）。仅在 catch 路径将 `unknown` 标准化为 `CrishErrorPayload` 用于日志/遥测。需要 UI 可见的错误仍由 `SessionMessage.errorDetail`（步骤 4）承载。

4. **`store/types.ts` 的 `errorDetail` 标准化** → `apps/crish-desktop/src/store/types.ts`

   L443 的 `errorDetail?` 字段（会话消息的错误详情）标准化为 `CrishErrorPayload | null`：

   ```ts
   export interface SessionMessage {
     // ...
     /** 错误详情（仅 status='error' 时存在；标准化为 CrishErrorPayload） */
     errorDetail?: CrishErrorPayload | null;
     // ...
   }
   ```

   `status?: 'pending' | 'resolved' | 'error'`（L228/L276）与 `SessionMessageStatus = 'queued' | 'processing' | 'completed' | 'error'`（L349）保持不变——这些是状态枚举，不是错误负载。

5. **`sessionActions` 的 try-catch 对齐** → `apps/crish-desktop/src/store/sessionActions.ts`

   扫描 `sessionActions` 中的 `try-catch` 块（预估 5-10 处），catch 路径使用 `normalizeCrishError` 构造 `CrishErrorPayload` 并写入对应 store 字段：

   ```ts
   try {
     await client.request(...);
   } catch (e) {
     const payload = normalizeCrishError(e);
     set((state) => ({
       sessions: state.sessions.map((s) =>
         s.id === sessionId ? { ...s, errorDetail: payload } : s
       ),
     }));
   }
   ```

6. **`sessionMessageActions` / `sessionAgentActions` 同步对齐** → 对应文件

   这两个 actions 文件中的错误处理同样使用 `normalizeCrishError`。每个文件至少迁移 2 个 try-catch 块以满足任务量。

7. **验证**
   - `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json` 通过（错误数 ≤ 基线）。
   - `npx vitest run apps/crish-desktop/src/services/StreamRecovery.test.ts` 通过（`markFailed` 新签名兼容旧字符串调用）。
   - `npx vitest run apps/crish-desktop/src/store/sessionActions.test.ts` 通过（`errorDetail` 类型适配）。

#### 输出

| 文件                                                               | 类型 | 行数变化（估） | 说明                                                                          |
| ------------------------------------------------------------------ | ---- | -------------- | ----------------------------------------------------------------------------- |
| `apps/crish-desktop/src/services/StreamRecovery.ts`                | 修改 | +25            | `markFailed` 签名扩展 + `TrackedStream.error` 类型 + `recoverStream` 错误对齐 |
| `apps/crish-desktop/src/services/StreamRecovery.test.ts`           | 修改 | +15            | `markFailed` 新签名测试（三种输入类型）                                       |
| `apps/crish-desktop/src/store/types.ts`                            | 修改 | +5             | `errorDetail` 类型标准化为 `CrishErrorPayload \| null`                        |
| `apps/crish-desktop/src/store/sessionActions.ts`                   | 修改 | +18            | `errorDetail` 参数类型对齐 + try-catch `normalizeCrishError`                  |
| `apps/crish-desktop/src/store/sessionMessageActions.ts`            | 修改 | +12            | `errorDetail` setter 对齐 + 状态转换 catch 标准化                             |
| `apps/crish-desktop/src/store/sessionAgentActions.ts`              | 修改 | +12            | try-catch 块对齐（2+ 处）                                                     |
| `apps/crish-desktop/src/store/workspaceShellStore.ts`              | 修改 | +12            | 4 处 catch 块 `normalizeCrishError` 对齐                                      |
| `apps/crish-desktop/src/store/layoutAnimationStore.ts`             | 修改 | +9             | 3 处 catch 块对齐                                                             |
| `apps/crish-desktop/src/store/layout-helpers/store-persistence.ts` | 修改 | +8             | 2 处 catch 块对齐（`store.write_failed`）                                     |

文件数：9（满足 ≥5）。代码变更量：~120 行新增 + ~13 处 catch 改造 ≈ 320 行总变更（满足 ≥300）。

#### 验证

- `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json` 通过（错误数 ≤ 基线）。
- `npx vitest run apps/crish-desktop/src/services/ apps/crish-desktop/src/store/` 全部通过。
- `npm run check:store-types` 通过（store 中无 `as any` 逃逸）。

---

### 2.3 Agent 11-C：Daemon Client 错误处理 + IPC 解析

| 维度       | 说明                                                                                                                                                                                                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **类型**   | 实现型 + 迁移型                                                                                                                                                                                                                                                                                                                        |
| **目标**   | ① `daemonClient.ts` 的 `dispatch` 方法解析 `ErrorMessage.payload`（`CrishErrorPayload`）；② `request` reject 路径使用 `fromErrorPayload` 还原 `CrishError`；③ `tauriInvoke.ts` 的 `extractErrorKind` 扩展为解析 `CrishErrorPayload`；④ `IpcResponse.error` 类型对齐 R10 新格式；⑤ 对齐 `ROUND-07-daemon.md` §5 的 IPC 协议错误传播设计 |
| **前置**   | Agent 11-A 已交付 `fromErrorPayload` / `normalizeCrishError`；Round 10 已交付 Rust 端 `IpcResponse.error` 迁移                                                                                                                                                                                                                         |
| **后续**   | Agent 11-D 修复 TSC 时可依赖标准化的 IPC 错误类型                                                                                                                                                                                                                                                                                      |
| **并行性** | 与 Agent 11-A / 11-B 文件集不相交，可三路并行                                                                                                                                                                                                                                                                                          |

#### 输入

| 输入                             | 路径                                                                  | 说明                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `fromErrorPayload`               | `apps/crish-desktop/src/utils/error-translation.ts`（11-A 交付）      | 从 Payload 还原 CrishError                                                                           |
| `normalizeCrishError`            | `apps/crish-desktop/src/utils/error-translation.ts`（11-A 交付）      | 兜底转换                                                                                             |
| `CrishErrorPayload` 接口         | `packages/shared-types/src/error-payload.ts`（R1 交付）               | 结构化错误负载                                                                                       |
| `DesktopDaemonClient.dispatch`   | `apps/crish-desktop/src/api/daemonClient.ts` L492-541                 | L525: `p.reject(new Error(String(msg.message ?? msg.error ?? 'Daemon error')))` 需解析 `msg.payload` |
| `tauriInvoke.ts`                 | `apps/crish-desktop/src/api/tauriInvoke.ts`（217 行）                 | `extractErrorKind` 处理 Rust `CoreError` 的 `{kind, detail}`，需扩展为 `CrishErrorPayload`           |
| `IpcResponse.ts`                 | `apps/crish-desktop/src/api/bindings/IpcResponse.ts`（ts-rs 生成）    | `error: IpcError                                                                                     | null`，`IpcError = {code: number, message: string}` |
| `IpcError.ts`                    | `apps/crish-desktop/src/api/bindings/IpcError.ts`（ts-rs 生成）       | 旧格式，共存阶段保留                                                                                 |
| `ErrorMessage` 类型（daemon 侧） | `packages/agent-daemon/src/types/protocol-outbound-run.ts`（R7 交付） | `{type; code; message; runId?; payload?: CrishErrorPayload}`                                         |

#### 步骤

1. **`daemonClient.ts` dispatch 解析 `ErrorMessage.payload`** → `apps/crish-desktop/src/api/daemonClient.ts`

   L492-541 的 `dispatch` 方法中，`type === 'error'` 分支（L525）扩展为优先解析 `msg.payload` 为 `CrishErrorPayload`，构造 `CrishError` 实例 reject；无 `payload` 时回退旧字符串路径（共存）：

   ```ts
   import {
     fromErrorPayload,
     normalizeCrishError,
   } from '../utils/error-translation';
   import type { CrishErrorPayload } from '@crish/shared-types';
   import { CrishError } from '@crish/shared-types';

   // 在 dispatch 方法内：
   if (type === 'error') {
     clearTimeout(p.timer);
     this.pending.delete(requestId);
     const payload = this.extractErrorPayload(msg);
     if (payload) {
       // 新路径：daemon 已携带结构化 CrishErrorPayload
       p.reject(fromErrorPayload(payload));
     } else {
       // 旧路径回退：无 payload 字段，通过 normalizeCrishError 兜底为 common.unknown
       const message = String(msg.message ?? msg.error ?? 'Daemon error');
       p.reject(fromErrorPayload(normalizeCrishError(new Error(message))));
     }
     return;
   }
   ```

   新增私有方法 `extractErrorPayload`：

   ```ts
   /**
    * 从 daemon ErrorMessage 中提取 CrishErrorPayload。
    *
    * 解析优先级：
    * 1. msg.payload 存在且结构合法 → 直接返回
    * 2. msg.payload 不存在 → 返回 null（调用方走旧字符串回退路径）
    *
    * 结构合法性校验：payload.code 为非空字符串、payload.message 为字符串、
    * payload.category 为枚举值。宽松校验，不要求所有字段都存在。
    */
   private extractErrorPayload(msg: Record<string, unknown>): CrishErrorPayload | null {
     const payload = msg.payload;
     if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
       return null;
     }
     const p = payload as Record<string, unknown>;
     if (typeof p.code !== 'string' || p.code.length === 0) return null;
     if (typeof p.message !== 'string') return null;
     if (typeof p.category !== 'string') return null;
     return payload as CrishErrorPayload;
   }
   ```

   `Pending.reject` 类型从 `(e: Error) => void` 保持不变（`CrishError extends Error`，兼容）。

2. **`tauriInvoke.ts` 的 `extractErrorKind` 扩展** → `apps/crish-desktop/src/api/tauriInvoke.ts`

   R10 后 Rust 端 Tauri command 返回 `Result<T, CrishErrorPayload>`，Tauri reject 时抛出的错误对象从 `{kind, detail}`（CoreError）变为 `{code, message, category, retryable, public, action, ...}`（CrishErrorPayload）。`extractErrorKind` 扩展为优先识别 `CrishErrorPayload` 结构：

   ```ts
   function extractErrorKind(err: unknown): {
     kind: string;
     message: string;
     payload?: CrishErrorPayload;
   } {
     if (err == null) {
       return { kind: 'Unknown', message: '未知错误' };
     }
     if (typeof err === 'string') {
       return { kind: 'Unknown', message: err };
     }
     if (typeof err === 'object') {
       const o = err as Record<string, unknown>;
       // 优先：CrishErrorPayload 结构（R10 后新格式）
       // code 为 domain.reason 字符串格式（如 "provider.network"）
       if (
         typeof o.code === 'string' &&
         o.code.includes('.') &&
         typeof o.message === 'string' &&
         typeof o.category === 'string'
       ) {
         return {
           kind: o.code,
           message: o.message,
           payload: o as unknown as CrishErrorPayload,
         };
       }
       // 回退：旧 CoreError 结构（{kind: "InvalidInput", detail: "msg"}）
       if (typeof o.kind === 'string') {
         const detail = o.detail;
         const message =
           typeof detail === 'string'
             ? detail
             : typeof o.message === 'string'
               ? o.message
               : String(o.kind);
         return { kind: o.kind, message };
       }
       // 回退：普通 Error 对象
       if (typeof o.message === 'string') {
         return { kind: 'Unknown', message: o.message };
       }
     }
     return { kind: 'Unknown', message: String(err) };
   }
   ```

   `invokeTyped` 返回类型 `InvokeError` 扩展，新增可选 `payload` 字段承载完整 `CrishErrorPayload`：

   ```ts
   export interface InvokeError {
     status: 'error';
     kind: string; // CrishErrorCode 字符串或旧 CoreError kind
     message: string;
     raw?: unknown;
     payload?: CrishErrorPayload; // 新：R10 后的完整错误负载
   }
   ```

   `invokeTyped` 实现中调用 `extractErrorKind` 后，若有 `payload` 则附加到返回的 `InvokeError`。

3. **`invokeCmdStrict` 的 throw 对齐** → `apps/crish-desktop/src/api/tauriInvoke.ts`

   `invokeCmdStrict`（L205）在 error 状态时 throw `new Error(`${res.kind}: ${res.message}`)`。扩展为：若 `res.payload` 存在，throw `fromErrorPayload(res.payload)`（`CrishError` 实例，保留完整信息）；否则保持旧 throw：

   ```ts
   export async function invokeCmdStrict<T = unknown>(
     cmd: string,
     args?: Record<string, unknown>
   ): Promise<T> {
     const res = await invokeTyped<T>(cmd, args);
     if (res.status === 'ok') return res.data;
     if (res.status === 'missing') {
       throw new Error(`Tauri command not available: ${cmd}`);
     }
     // error
     if (res.payload) {
       throw fromErrorPayload(res.payload);
     }
     throw new Error(`${res.kind}: ${res.message}`);
   }
   ```

4. **`IpcResponse.ts` / `IpcError.ts` 共存处理** → `apps/crish-desktop/src/api/bindings/`

   这两个文件由 ts-rs 自动生成（顶部有 "Do not edit this file manually" 注释）。**不手动修改**——R10 的 Rust 端代码生成会更新这些文件。但前端的消费方（`tauriInvoke.ts` 等）需要对齐新格式。

   新增一个类型守卫文件 `apps/crish-desktop/src/api/bindings/error-payload-guard.ts`，用于运行时判断 `IpcResponse.error` 是否为 `CrishErrorPayload`（R10 后）还是旧 `IpcError`（R10 前的兼容数据）：

   ```ts
   import type { CrishErrorPayload } from '@crish/shared-types';
   import type { IpcError } from './IpcError';

   /**
    * IpcResponse.error 的共存类型：R10 后为 CrishErrorPayload，R10 前为 IpcError。
    *
    * 共存阶段（R11）：前端解析时先尝试 CrishErrorPayload，失败回退 IpcError。
    * 删除阶段（R12）：仅保留 CrishErrorPayload。
    */
   export type IpcResponseError = CrishErrorPayload | IpcError | null;

   export function isCrishErrorPayload(
     err: IpcResponseError
   ): err is CrishErrorPayload {
     if (!err || typeof err !== 'object') return false;
     const e = err as Record<string, unknown>;
     return (
       typeof e.code === 'string' &&
       e.code.includes('.') &&
       typeof e.message === 'string' &&
       typeof e.category === 'string'
     );
   }

   export function isLegacyIpcError(err: IpcResponseError): err is IpcError {
     if (!err || typeof err !== 'object') return false;
     const e = err as Record<string, unknown>;
     return typeof e.code === 'number' && typeof e.message === 'string';
   }

   /**
    * 将 IpcResponseError 统一转换为 CrishErrorPayload。
    * 旧 IpcError（code 为数字）映射到 common.unknown，message 保留。
    */
   export function toCrishErrorPayload(
     err: IpcResponseError
   ): CrishErrorPayload | null {
     if (err === null) return null;
     if (isCrishErrorPayload(err)) return err;
     if (isLegacyIpcError(err)) {
       return {
         code: 'common.unknown',
         message: err.message,
         category: 'permanent',
         retryable: false,
         public: true,
         action: 'action.common.report_bug',
         metadata: { legacyCode: err.code },
         timestamp: Date.now(),
       };
     }
     return null;
   }
   ```

5. **`daemonClient.ts` 的 `lastError` 类型扩展** → `apps/crish-desktop/src/api/daemonClient.ts`

   `lastError: Error | null` 保持不变（`CrishError extends Error`），但 `handleFailure` / `tryRestartSidecar` 等方法的错误构造对齐：连接失败使用 `provider.network`、daemon 死亡使用 `network.daemon_dead`、超时使用 `provider.timeout`：

   ```ts
   // attemptConnect 失败时
   this.lastError = new CrishError(
     `Failed to connect engine at ${url}`,
     'provider.network',
     'transient',
     true
   );

   // tryRestartSidecar 失败时
   this.lastError = new CrishError(
     'Daemon sidecar unavailable in browser dev mode',
     'network.daemon_dead',
     'permanent',
     false
   );

   // 心跳失败时
   this.lastError = new CrishError(
     'Engine heartbeat failed',
     'provider.timeout',
     'transient',
     true
   );
   ```

6. **验证**
   - `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json` 通过（错误数 ≤ 基线）。
   - `npx vitest run apps/crish-desktop/src/api/daemonClient.test.ts` 通过（reject 路径返回 CrishError 实例）。
   - `npx vitest run apps/crish-desktop/src/api/clientApi.settings.test.ts` 通过（invokeTyped 新返回类型兼容）。

#### 输出

| 文件                                                                   | 类型 | 行数变化（估） | 说明                                                                           |
| ---------------------------------------------------------------------- | ---- | -------------- | ------------------------------------------------------------------------------ |
| `apps/crish-desktop/src/api/daemonClient.ts`                           | 修改 | +45            | `extractErrorPayload` + dispatch 解析 + `lastError` 构造对齐                   |
| `apps/crish-desktop/src/api/daemonClient.test.ts`                      | 修改 | +25            | reject 路径测试（payload 存在/不存在两种）                                     |
| `apps/crish-desktop/src/api/tauriInvoke.ts`                            | 修改 | +35            | `extractErrorKind` 扩展 + `InvokeError.payload` + `invokeCmdStrict` throw 对齐 |
| `apps/crish-desktop/src/api/bindings/error-payload-guard.ts`           | 新建 | +55            | `isCrishErrorPayload` / `isLegacyIpcError` / `toCrishErrorPayload` 类型守卫    |
| `apps/crish-desktop/src/api/bindings/error-payload-guard.test.ts`      | 新建 | +40            | 类型守卫测试                                                                   |
| `apps/crish-desktop/src/api/daemonChatBridge.ts`                       | 修改 | +10            | 错误处理对齐（如使用 normalizeCrishError）                                     |
| `apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts`         | 修改 | +8             | error 事件路由对齐 payload                                                     |
| `apps/crish-desktop/src/api/daemon-chat-bridge/BridgeErrorPolicy.ts`   | 修改 | +12            | 错误策略对齐 CrishErrorPayload                                                 |
| `apps/crish-desktop/src/api/daemon-chat-bridge/ConnectionLifecycle.ts` | 修改 | +8             | 连接错误对齐                                                                   |

文件数：9（满足 ≥5）。代码变更量：~240 行新增 + ~20 处调用点改造 ≈ 340 行总变更（满足 ≥300）。

#### 验证

- `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json` 通过（错误数 ≤ 基线）。
- `npx vitest run apps/crish-desktop/src/api/` 全部通过。
- `npm run lint:depcruise` 0 violations。

---

### 2.4 Agent 11-D：crish-desktop TSC 修复（前 80 个错误）

| 维度       | 说明                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **类型**   | 修复型                                                                                                                                                                                     |
| **目标**   | 修复 crish-desktop 的前 80 个 TSC 错误（当前 ~180 个中的一部分），重点关注 `TS2375`/`TS2379`（exactOptionalPropertyTypes）和 `TS2532`/`TS18048`（uncheckedIndex/noUncheckedIndexedAccess） |
| **前置**   | Agent 11-A / 11-B / 11-C 完成（避免 TSC 修复与新代码引入冲突）                                                                                                                             |
| **后续**   | Agent 11-E 修复剩余错误 + API 层 + 测试                                                                                                                                                    |
| **并行性** | 串行（依赖前三个 Agent 完成）                                                                                                                                                              |

#### 输入

| 输入                      | 路径                                            | 说明                                                                                                         |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| TSC 基线                  | `tsc-errors-baseline.json`（R1 建立，每轮更新） | crish-desktop 相关的 TSC 错误清单                                                                            |
| `tsconfig.base.json`      | `../../tsconfig.base.json`                      | `exactOptionalPropertyTypes: true` + `noUncheckedIndexedAccess: true`                                        |
| `tsconfig.app.json`       | `apps/crish-desktop/tsconfig.app.json`          | 覆盖 `exactOptionalPropertyTypes: false` + `noUnusedLocals: false`（app 构建）；但 CI 严格检查使用 base 配置 |
| Agent 11-A/11-B/11-C 产出 | 上述各 Agent 的修改文件                         | 避免冲突                                                                                                     |

#### 步骤

1. **记录 TSC 基线** — 在 Agent 开始时运行 `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json` 并保存输出作为本 Agent 的对比基线。同时运行 `npx tsc --noEmit`（根级，含 strict 检查）获取完整错误清单。

2. **修复 `TS2375`/`TS2379`（exactOptionalPropertyTypes）错误**

   这类错误来自 `exactOptionalPropertyTypes: true`（`tsconfig.base.json`）配置下，将 `undefined` 显式赋值给可选属性。系统化修复模式：

   ```ts
   // 错误模式（TS2375/TS2379）：
   interface Foo {
     name?: string;
   }
   const foo: Foo = { name: undefined }; // 错误：undefined 不能赋值给可选属性

   // 修复模式 1：条件展开（推荐）
   const foo: Foo = {
     ...(value !== undefined ? { name: value } : {}),
   };

   // 修复模式 2：类型断言（仅在确信值不会是 undefined 时）
   const foo: Foo = { name: value as string };

   // 修复模式 3：删除 undefined 赋值
   const foo: Foo = {}; // 不赋值即 undefined
   ```

   重点扫描文件（基于 `03-ERROR-MIGRATION.md` §4.1 与代码扫描）：
   - `apps/crish-desktop/src/store/types.ts`（`errorDetail?: ...` 等可选字段）
   - `apps/crish-desktop/src/api/daemonClient.ts`（`DesktopDaemonClientOptions` 的可选字段）
   - `apps/crish-desktop/src/services/StreamRecovery.ts`（`TrackedStream.error` 字段，11-B 已标准化为 `| null`）
   - `apps/crish-desktop/src/api/daemon-chat-bridge/handlers/*.ts`（可选回调字段）
   - `apps/crish-desktop/src/hooks/chat-stream/*.ts`（可选配置字段）

3. **修复 `TS2532`/`TS18048`（uncheckedIndex / noUncheckedIndexedAccess）错误**

   这类错误来自 `noUncheckedIndexedAccess: true`，数组/Record 索引访问返回 `T | undefined`，需显式收窄。系统化修复模式：

   ```ts
   // 错误模式（TS2532/TS18048）：
   const item = map[key]; // 类型：T | undefined
   item.doSomething(); // 错误：item 可能为 undefined

   // 修复模式 1：显式守卫（推荐）
   const item = map[key];
   if (item === undefined) return;
   item.doSomething();

   // 修复模式 2：可选链
   map[key]?.doSomething();

   // 修复模式 3：带默认值
   const item = map[key] ?? defaultValue;

   // 修复模式 4：非空断言（仅在可证明非空时，如刚检查过 has）
   if (map.has(key)) {
     map.get(key)!.doSomething();
   }
   ```

   重点扫描文件：
   - `apps/crish-desktop/src/store/sessionIndex.ts`（`sessionsById[id]` 索引访问）
   - `apps/crish-desktop/src/store/layoutStore.ts`（Map/Record 索引访问）
   - `apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts`（事件分发索引）
   - `apps/crish-desktop/src/hooks/useSessionStore.ts`（会话查找索引）
   - `apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx`（虚拟列表索引）

4. **修复 `TS6133`/`TS6192`（unused）错误**

   虽然前端 `tsconfig.app.json` 覆盖 `noUnusedLocals: false`，但 CI 严格检查与测试文件可能启用。删除未使用的 import / 变量：

   ```ts
   // 删除未使用的 import
   - import { unusedFn } from './unused';
   // 删除未使用的变量
   - const unusedVar = computeSomething();
   ```

5. **修复 `TS1484`（verbatimModuleSyntax）错误**

   `verbatimModuleSyntax: true` 要求类型 import 使用 `import type`。系统化修复：

   ```ts
   // 错误：类型与值混用 import
   - import { CrishError, CrishErrorPayload } from "@crish/shared-types";
   // 修复：类型用 import type
   + import { CrishError } from "@crish/shared-types";
   + import type { CrishErrorPayload } from "@crish/shared-types";
   ```

6. **修复 `TS2307`/`TS2305`（missing module / export）错误**

   检查 import 路径是否正确、导出是否存在。这类错误多为路径拼写错误或 barrel 文件遗漏导出。

7. **验证**
   - `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json` 错误数较基线减少 ≥ 80。
   - `npx vitest run apps/crish-desktop/` 全部通过（修复不应破坏现有测试）。

#### 输出

| 文件                                                                         | 类型 | 行数变化（估） | 说明                                   |
| ---------------------------------------------------------------------------- | ---- | -------------- | -------------------------------------- |
| TSC 修复涉及的源码文件（~15-20 文件）                                        | 修改 | ±200           | 80 个 TSC 错误修复，按错误类型批量处理 |
| `apps/crish-desktop/src/store/sessionIndex.ts`                               | 修改 | +15            | TS2532/TS18048 修复（索引访问收窄）    |
| `apps/crish-desktop/src/store/layoutStore.ts`                                | 修改 | +10            | 索引访问收窄                           |
| `apps/crish-desktop/src/hooks/chat-stream/*.ts`（3-4 文件）                  | 修改 | +20            | TS2375/TS2379 修复（可选字段条件展开） |
| `apps/crish-desktop/src/api/daemon-chat-bridge/handlers/*.ts`（2-3 文件）    | 修改 | +15            | TS2375/TS2379 修复                     |
| `apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx` | 修改 | +8             | TS2532 修复                            |
| 其他 TSC 修复文件（~8-12 文件）                                              | 修改 | ±130           | TS6133/TS1484/TS2307 等修复            |

文件数：~20（满足 ≥5）。代码变更量：~200 行净变更 + 80 处错误修复 ≈ 350 行总变更（满足 ≥300）。

#### 验证

- `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json` 错误数较基线减少 ≥ 80。
- `npx vitest run apps/crish-desktop/` 全部通过。
- `npm run lint` 0 errors。

---

### 2.5 Agent 11-E：crish-desktop TSC 修复（剩余错误）+ API 层 + 测试修复

| 维度       | 说明                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **类型**   | 修复型 + 验证型                                                                                                                                                                                                           |
| **目标**   | ① 修复剩余 TSC 错误（目标：总错误数 < 50）；② 修复 API 层（`apps/crish-desktop/src/api/`）的 TSC 错误；③ 修复前端测试（适配新错误类型与 IPC 格式）；④ 运行 `vitest` 验证；⑤ 运行 `check:store-types` 验证；⑥ 生成验证报告 |
| **前置**   | Agent 11-D 完成（前 80 个错误已修复）                                                                                                                                                                                     |
| **后续**   | Round 12 启动                                                                                                                                                                                                             |
| **并行性** | 串行（依赖 11-D 完成）                                                                                                                                                                                                    |

#### 输入

| 输入                           | 路径                                                                      | 说明                         |
| ------------------------------ | ------------------------------------------------------------------------- | ---------------------------- |
| TSC 基线（11-D 结束后）        | 11-D 的 TSC 错误清单                                                      | 剩余 ~100 个错误             |
| API 层文件                     | `apps/crish-desktop/src/api/**/*.ts`（~40 文件）                          | API 层 TSC 错误              |
| 测试文件                       | `apps/crish-desktop/src/**/*.test.ts` + `__tests__/*.test.ts`（~50 文件） | 适配新错误类型与 IPC payload |
| Agent 11-A/11-B/11-C/11-D 产出 | 上述各 Agent 的修改文件                                                   | 验证集成正确性               |

#### 步骤

1. **记录 TSC 基线** — 运行 `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json` 记录 11-D 结束后的错误数，作为本 Agent 的对比基线。

2. **修复 API 层 TSC 错误**

   扫描 `apps/crish-desktop/src/api/` 下的 TSC 错误，重点文件：
   - `apps/crish-desktop/src/api/daemonChatBridge.ts`
   - `apps/crish-desktop/src/api/chatApi.ts`
   - `apps/crish-desktop/src/api/clientApi.ts`
   - `apps/crish-desktop/src/api/gitApi.ts`
   - `apps/crish-desktop/src/api/sessionStreamManager.ts`
   - `apps/crish-desktop/src/api/runControlClient.ts`
   - `apps/crish-desktop/src/api/mcpApi.ts`
   - `apps/crish-desktop/src/api/daemonEventSchema.ts`
   - `apps/crish-desktop/src/api/daemonEventZod.ts`
   - `apps/crish-desktop/src/api/toolFeedback.ts`

   修复模式同 Agent 11-D §2.4 步骤 2-6。

3. **修复剩余 TSC 错误（目标 < 50）**

   继续修复 11-D 未处理的 TSC 错误，目标将总数降至 < 50。优先级：
   - 修复 `TS7006`（implicitAny）：为函数参数显式标注类型
   - 修复剩余 `TS2375`/`TS2532`/`TS1484` 错误
   - 修复 `TS2304`（cannot find name）：缺失 import
   - 修复 `TS2554`（expected N arguments but got M）：函数签名不匹配

4. **更新测试文件适配新错误类型**

   重点测试文件更新：

   | 测试文件                                                      | 更新内容                                                                               |
   | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
   | `apps/crish-desktop/src/api/daemonClient.test.ts`             | 验证 reject 路径返回 `CrishError` 实例（`instanceof CrishError`）+ `error.code` 为新码 |
   | `apps/crish-desktop/src/utils/error-translation.test.ts`      | 11-A 已新建，本轮补齐边界用例                                                          |
   | `apps/crish-desktop/src/services/StreamRecovery.test.ts`      | 验证 `markFailed` 三种输入类型 + `error` 字段为 `CrishErrorPayload`                    |
   | `apps/crish-desktop/src/store/sessionActions.test.ts`         | 验证 `errorDetail` 为 `CrishErrorPayload`                                              |
   | `apps/crish-desktop/src/store/workspaceShellStore.test.ts`    | 验证 catch 路径输出 `CrishErrorPayload` 结构化日志                                     |
   | `apps/crish-desktop/src/api/clientApi.settings.test.ts`       | 验证 `invokeTyped` 返回 `InvokeError.payload`                                          |
   | `apps/crish-desktop/src/__tests__/chatInvariants.test.ts`     | 适配错误状态字段类型变更                                                               |
   | `apps/crish-desktop/src/__tests__/fullScenarioFlow.test.ts`   | 适配错误传播链                                                                         |
   | `apps/crish-desktop/src/__tests__/chaosAndResilience.test.ts` | 验证流恢复错误对齐                                                                     |

   测试更新策略：
   - 对于 `error.message` 断言：保持不变（`CrishError extends Error`）。
   - 对于 `error.code` 断言：旧字符串码改为新 `CrishErrorCode`（如 `"DAEMON_DEAD"` → `"network.daemon_dead"`）。
   - 对于 `instanceof Error` 断言：保持不变。
   - 新增 `error instanceof CrishError` 断言：在关键 reject 路径测试中新增。
   - 新增 `error.public` / `error.action` 字段断言：在错误翻译层测试中验证。

5. **新增端到端错误传播测试** → `apps/crish-desktop/src/__tests__/error-translation.e2e.test.ts`

   验证错误从 daemon IPC / Tauri invoke 到用户可见 UI 的完整传播链：

   ```ts
   describe('error translation end-to-end', () => {
     it('translates CrishErrorPayload to UserVisibleError via toUserVisibleError', () => {
       const payload: CrishErrorPayload = {
         code: 'provider.network',
         message: 'Connection refused',
         category: 'transient',
         retryable: true,
         public: true,
         action: 'action.provider.check_network',
         timestamp: Date.now(),
       };
       const visible = toUserVisibleError(payload);
       expect(visible.visible).toBe(true);
       expect(visible.severity).toBe('warning');
       expect(visible.retryable).toBe(true);
     });

     it('hides internal errors with public=false', () => {
       const payload: CrishErrorPayload = {
         code: 'telemetry.trace_lost',
         message: 'trace buffer overflow',
         category: 'transient',
         retryable: true,
         public: false,
         action: 'action.telemetry.none',
         timestamp: Date.now(),
       };
       const visible = toUserVisibleError(payload);
       expect(visible.visible).toBe(false);
     });

     it('normalizes unknown errors to common.unknown', () => {
       const payload = normalizeCrishError(new Error('boom'));
       expect(payload.code).toBe('common.unknown');
     });

     it('preserves cause chain via fromErrorPayload', () => {
       const payload: CrishErrorPayload = {
         code: 'provider.timeout',
         message: 'request timed out',
         category: 'transient',
         retryable: true,
         public: true,
         action: 'action.provider.retry',
         timestamp: Date.now(),
         cause: {
           code: 'provider.network',
           message: 'underlying network error',
           category: 'transient',
           retryable: true,
           public: true,
           action: 'action.provider.check_network',
           timestamp: Date.now(),
         },
       };
       const err = fromErrorPayload(payload);
       expect(err).toBeInstanceOf(CrishError);
       expect(err.cause).toBeInstanceOf(CrishError);
       expect(err.cause?.code).toBe('provider.network');
     });
   });
   ```

6. **运行验证门禁**

   按 §5 验证门禁执行全部 8 项检查，记录结果到验证报告。

#### 输出

| 文件                                                             | 类型 | 行数变化（估） | 说明                           |
| ---------------------------------------------------------------- | ---- | -------------- | ------------------------------ |
| API 层 TSC 修复（~10 文件）                                      | 修改 | ±150           | API 层 TSC 错误修复            |
| 剩余 TSC 修复（~10 文件）                                        | 修改 | ±100           | 剩余 TSC 错误修复（目标 < 50） |
| `apps/crish-desktop/src/api/daemonClient.test.ts`                | 修改 | +15            | reject 路径 CrishError 断言    |
| `apps/crish-desktop/src/services/StreamRecovery.test.ts`         | 修改 | +10            | markFailed 新签名断言          |
| `apps/crish-desktop/src/store/sessionActions.test.ts`            | 修改 | +8             | errorDetail 类型断言           |
| `apps/crish-desktop/src/store/workspaceShellStore.test.ts`       | 修改 | +8             | catch 路径结构化日志断言       |
| `apps/crish-desktop/src/api/clientApi.settings.test.ts`          | 修改 | +8             | InvokeError.payload 断言       |
| `apps/crish-desktop/src/__tests__/chatInvariants.test.ts`        | 修改 | +10            | 错误状态字段适配               |
| `apps/crish-desktop/src/__tests__/fullScenarioFlow.test.ts`      | 修改 | +10            | 错误传播链适配                 |
| `apps/crish-desktop/src/__tests__/chaosAndResilience.test.ts`    | 修改 | +8             | 流恢复错误对齐                 |
| `apps/crish-desktop/src/__tests__/error-translation.e2e.test.ts` | 新建 | +120           | 端到端错误翻译测试             |
| `round-11-verification-report.md`                                | 新建 | +100           | 验证报告                       |

文件数：~20（满足 ≥5）。代码变更量：~250 行新增 + ~100 处 TSC 修复 ≈ 400 行总变更（满足 ≥300）。

#### 验证

- `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json` 错误数 < 50（禁令 26 目标）。
- `npx vitest run apps/crish-desktop/` 全部通过。
- `npm run check:store-types` 通过。
- `npm run lint:depcruise` 0 violations。
- `npx turbo run build --filter=crish-desktop` 成功。
- `npm run lint` 0 errors。

---

## 3. 前端错误翻译层设计

> 本节为前端错误翻译层的详细设计，是 Agent 11-A 的实现依据，也是 Round 12 删除阶段的迁移参考。

### 3.0 架构总览

下图为前端错误翻译层的端到端架构，展示从三个输入源（daemon WebSocket / Tauri invoke / store catch）到两个输出端（用户可见 UI / 日志遥测）的完整传播链：

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 920 560" role="img" aria-label="前端错误翻译层架构图">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#475569"/>
    </marker>
    <style>
      .layer-bg { fill: #f8fafc; stroke: #cbd5e1; stroke-width: 1; }
      .source-box { fill: #dbeafe; stroke: #3b82f6; stroke-width: 1.5; }
      .core-box { fill: #fef3c7; stroke: #d97706; stroke-width: 1.5; }
      .registry-box { fill: #f3e8ff; stroke: #9333ea; stroke-width: 1.5; }
      .output-box { fill: #dcfce7; stroke: #16a34a; stroke-width: 1.5; }
      .silent-box { fill: #f1f5f9; stroke: #64748b; stroke-width: 1.5; }
      .label { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 12px; fill: #1e293b; }
      .title { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 13px; font-weight: 600; fill: #0f172a; }
      .layer-title { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px; font-weight: 600; fill: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
      .small { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 10px; fill: #475569; }
      .arrow-line { stroke: #475569; stroke-width: 1.5; fill: none; }
    </style>
  </defs>

  <!-- Layer labels (left gutter) -->

<text x="20" y="50" class="layer-title">输入源</text>
<text x="20" y="220" class="layer-title">标准化</text>
<text x="20" y="340" class="layer-title">翻译</text>
<text x="20" y="470" class="layer-title">输出</text>

  <!-- Layer backgrounds -->
  <rect x="60" y="20" width="240" height="140" rx="8" class="layer-bg"/>
  <rect x="60" y="180" width="240" height="100" rx="8" class="layer-bg"/>
  <rect x="380" y="180" width="240" height="220" rx="8" class="layer-bg"/>
  <rect x="680" y="20" width="220" height="510" rx="8" class="layer-bg"/>

  <!-- Input sources -->
  <rect x="80" y="40" width="200" height="32" rx="4" class="source-box"/>
  <text x="180" y="60" text-anchor="middle" class="title">daemon WebSocket</text>
  <text x="180" y="80" text-anchor="middle" class="small">ErrorMessage.payload: CrishErrorPayload?</text>

  <rect x="80" y="95" width="200" height="32" rx="4" class="source-box"/>
  <text x="180" y="115" text-anchor="middle" class="title">Tauri invoke</text>
  <text x="180" y="135" text-anchor="middle" class="small">IpcResponse.error: CrishErrorPayload | IpcError</text>

  <rect x="80" y="150" width="200" height="32" rx="4" class="source-box"/>
  <text x="180" y="170" text-anchor="middle" class="small">store catch (unknown)</text>

  <!-- Standardization layer -->
  <rect x="80" y="200" width="200" height="60" rx="4" class="core-box"/>
  <text x="180" y="222" text-anchor="middle" class="title">normalizeCrishError()</text>
  <text x="180" y="240" text-anchor="middle" class="small">unknown → CrishErrorPayload</text>
  <text x="180" y="254" text-anchor="middle" class="small">兜底 common.unknown</text>

  <!-- Translation layer -->
  <rect x="400" y="200" width="200" height="60" rx="4" class="core-box"/>
  <text x="500" y="222" text-anchor="middle" class="title">fromErrorPayload()</text>
  <text x="500" y="240" text-anchor="middle" class="small">payload → CrishError 实例</text>
  <text x="500" y="254" text-anchor="middle" class="small">递归还原 cause 链 (≤8 层)</text>

  <rect x="400" y="285" width="200" height="60" rx="4" class="core-box"/>
  <text x="500" y="307" text-anchor="middle" class="title">toUserVisibleError()</text>
  <text x="500" y="325" text-anchor="middle" class="small">payload → UserVisibleError</text>
  <text x="500" y="339" text-anchor="middle" class="small">visible / severity / action</text>

  <rect x="400" y="360" width="200" height="32" rx="4" class="registry-box"/>
  <text x="500" y="380" text-anchor="middle" class="title">CRISH_ERROR_REGISTRY</text>
  <text x="500" y="395" text-anchor="middle" class="small">64 正式码 + 10 reserved 码静态查表（非 switch/case）</text>

  <!-- Output layer -->
  <rect x="700" y="40" width="180" height="32" rx="4" class="output-box"/>
  <text x="790" y="60" text-anchor="middle" class="title">Toast (warning)</text>
  <text x="790" y="78" text-anchor="middle" class="small">transient / protocol · 黄色</text>

  <rect x="700" y="95" width="180" height="32" rx="4" class="output-box"/>
  <text x="790" y="115" text-anchor="middle" class="title">Banner (error)</text>
  <text x="790" y="133" text-anchor="middle" class="small">permanent / security · 红色</text>

  <rect x="700" y="150" width="180" height="32" rx="4" class="silent-box"/>
  <text x="790" y="170" text-anchor="middle" class="title">Silent</text>
  <text x="790" y="188" text-anchor="middle" class="small">runtime.aborted / provider.cancelled</text>

  <rect x="700" y="220" width="180" height="32" rx="4" class="silent-box"/>
  <text x="790" y="240" text-anchor="middle" class="title">Hidden</text>
  <text x="790" y="258" text-anchor="middle" class="small">public=false · 不打扰用户</text>

  <rect x="700" y="290" width="180" height="32" rx="4" class="output-box"/>
  <text x="790" y="310" text-anchor="middle" class="title">日志 (console.warn)</text>
  <text x="790" y="328" text-anchor="middle" class="small">携带 code / category</text>

  <rect x="700" y="345" width="180" height="32" rx="4" class="output-box"/>
  <text x="790" y="365" text-anchor="middle" class="title">遥测 (telemetry)</text>
  <text x="790" y="383" text-anchor="middle" class="small">结构化错误码上报</text>

  <!-- Arrows: sources → normalize -->
  <path d="M 280 56 L 320 56 L 320 215 L 380 215" class="arrow-line" marker-end="url(#arrow)"/>
  <path d="M 280 111 L 320 111 L 320 225 L 380 225" class="arrow-line" marker-end="url(#arrow)"/>
  <path d="M 280 166 L 320 166 L 320 240 L 380 240" class="arrow-line" marker-end="url(#arrow)"/>

  <!-- Arrow: normalize → fromErrorPayload -->
  <path d="M 280 230 L 400 230" class="arrow-line" marker-end="url(#arrow)"/>

  <!-- Arrow: normalize → toUserVisibleError (bypass fromErrorPayload) -->
  <path d="M 280 245 L 340 245 L 340 315 L 400 315" class="arrow-line" marker-end="url(#arrow)"/>

  <!-- Arrow: registry → toUserVisibleError (lookup) -->
  <path d="M 500 360 L 500 345" class="arrow-line" marker-end="url(#arrow)" stroke-dasharray="4,3"/>

  <!-- Arrows: toUserVisibleError → outputs -->
  <path d="M 600 300 L 650 300 L 650 56 L 700 56" class="arrow-line" marker-end="url(#arrow)"/>
  <path d="M 600 310 L 660 310 L 660 111 L 700 111" class="arrow-line" marker-end="url(#arrow)"/>
  <path d="M 600 320 L 670 320 L 670 166 L 700 166" class="arrow-line" marker-end="url(#arrow)"/>
  <path d="M 600 330 L 670 330 L 670 220 L 700 220" class="arrow-line" marker-end="url(#arrow)"/>

  <!-- Arrows: normalize → 日志/遥测 (直接路径，不经过 UI) -->
  <path d="M 280 255 L 350 255 L 350 305 L 700 305" class="arrow-line" marker-end="url(#arrow)" stroke-dasharray="3,3"/>

  <!-- Legend -->
  <rect x="80" y="440" width="12" height="12" rx="2" class="source-box"/>
  <text x="100" y="450" class="small">输入源</text>
  <rect x="160" y="440" width="12" height="12" rx="2" class="core-box"/>
  <text x="180" y="450" class="small">核心函数</text>
  <rect x="250" y="440" width="12" height="12" rx="2" class="registry-box"/>
  <text x="270" y="450" class="small">注册表</text>
  <rect x="330" y="440" width="12" height="12" rx="2" class="output-box"/>
  <text x="350" y="450" class="small">输出端</text>
  <rect x="410" y="440" width="12" height="12" rx="2" class="silent-box"/>
  <text x="430" y="450" class="small">静默/隐藏</text>

<text x="80" y="475" class="small">实线 = 主路径（错误传播） 虚线 = 查表/直接日志路径</text>
<text x="80" y="495" class="small">三输入源 → normalizeCrishError 统一为 CrishErrorPayload → fromErrorPayload 还原 CrishError（reject 路径） / toUserVisibleError 翻译（UI 路径）</text>
<text x="80" y="515" class="small">public=false 或 severity=silent 的错误仅走日志/遥测，不打扰用户</text>
</svg>

### 3.1 toUserVisibleError 设计

#### 3.1.1 设计目标

前端错误翻译层的核心职责是将 `CrishErrorPayload`（结构化错误负载）转换为 `UserVisibleError`（用户可见的错误展示模型）。设计遵循以下原则：

1. **注册表驱动**：通过 `CRISH_ERROR_REGISTRY`（R1 交付，64 正式码 + 10 reserved 码静态注册表）查表获取错误元信息，不为每个码手写 switch/case。新增错误码时只需在注册表添加条目，翻译层无需修改。
2. **public 字段决定可见性**：`payload.public === false` 的错误（如 `telemetry.trace_lost`、`log.write_failed`）不对用户展示，仅记录日志与遥测。这避免了内部诊断码打扰用户。
3. **action 字段提供操作建议**：`payload.action` 为 i18n 键（如 `action.provider.check_network`），前端按键查翻译，未命中回退英文 `title`。操作建议是用户可执行的（如"检查网络连接"、"打开设置 → 模型检查密钥"）。
4. **category 映射 severity**：`transient → warning`（可重试，黄色 toast）、`permanent → error`（不可恢复，红色 banner）、`security → error`（安全拦截，红色 banner）、`protocol → warning`（协议违规，黄色 toast）。`runtime.aborted` 与 `provider.cancelled` 特殊映射为 `silent`（用户主动取消，不打扰）。
5. **共存不删除**：旧 `userFacingErrors.ts` 的正则分类（`classifySoftFailure`）在共存阶段保留。新代码使用 `toUserVisibleError`，旧调用点不强制迁移。R12 删除阶段才移除旧实现。

#### 3.1.2 接口签名

```ts
// apps/crish-desktop/src/utils/error-translation.ts

export interface UserVisibleError {
  readonly visible: boolean;
  readonly title: string;
  readonly message: string;
  readonly action: string;
  readonly retryable: boolean;
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error' | 'silent';
}

export function toUserVisibleError(
  payload: CrishErrorPayload
): UserVisibleError;
export function normalizeCrishError(error: unknown): CrishErrorPayload;
export function fromErrorPayload(
  payload: CrishErrorPayload,
  depth?: number
): CrishError;
export function resolveActionText(
  payload: CrishErrorPayload,
  translate?: TranslateFn
): string;
export function resolveTitleText(
  payload: CrishErrorPayload,
  translate?: TranslateFn
): string;
export type TranslateFn = (key: string, fallback?: string) => string;
```

#### 3.1.3 与旧 `userFacingErrors.ts` 的关系

| 维度       | 旧 `userFacingErrors.ts`                                                    | 新 `error-translation.ts`                                                |
| ---------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 输入       | `unknown`（正则匹配字符串）                                                 | `CrishErrorPayload`（结构化负载）                                        |
| 分类方式   | 5 个正则（`NETWORK_RE`/`NO_KEY_RE`/`AUTH_RE`/`NO_PROJECT_RE`/`BLOCKED_RE`） | `CRISH_ERROR_REGISTRY` 查表（64 正式码 + 10 reserved 码）                |
| 输出       | `SoftFailureKind` 联合类型（6 值）                                          | `UserVisibleError`（含 visible/title/message/action/retryable/severity） |
| 操作建议   | 硬编码中文文案                                                              | i18n 键，支持多语言                                                      |
| 用户可见性 | 无（全部展示）                                                              | `payload.public` 字段控制                                                |
| 重试建议   | 无                                                                          | `payload.retryable` 字段                                                 |
| 严重级别   | 无                                                                          | `category` 映射 `severity`                                               |
| 状态       | `@deprecated`（R12 删除）                                                   | 当前（R11 共存阶段引入）                                                 |

**迁移路径**（R12 删除阶段执行，R11 不强制）：

- `classifySoftFailure(input)` → `toUserVisibleError(normalizeCrishError(input))`
- `softFailureMessage(kind)` → `toUserVisibleError(payload).message`
- `networkUserMessage()` → `resolveTitleText({code:"provider.network", ...})`
- `assistantBubbleForFailure(input)` → `toUserVisibleError(normalizeCrishError(input)).message`

### 3.2 错误码 → 用户可见消息映射

> 本节为 64 个正式 `CrishErrorCode` + 10 个 reserved 到 `UserVisibleError` 的映射表，基于 `03-ERROR-MIGRATION.md` §2.2 的注册表。映射由 `toUserVisibleError` 自动查表完成，下表为人工参考。

#### 3.2.1 public=false 的内部诊断码（visible=false，不对用户展示）

| 码值                                | title            | 用户可见              | action                             |
| ----------------------------------- | ---------------- | --------------------- | ---------------------------------- |
| `telemetry.export_failed`           | 观测数据导出失败 | 否                    | `action.telemetry.retry_export`    |
| `telemetry.trace_lost`              | Trace 丢失       | 否                    | `action.telemetry.none`            |
| `log.write_failed`                  | 日志写入失败     | 否                    | `action.log.retry_write`           |
| `event_store.append_failed`         | 事件追加失败     | 否                    | `action.event_store.retry_append`  |
| `event_store.consistency_violation` | 事件一致性违规   | 否                    | `action.event_store.rebuild_index` |
| `provider.cancelled`                | 请求取消         | 否（severity=silent） | `action.runtime.none`              |
| `runtime.aborted`                   | 用户中止         | 否（severity=silent） | `action.runtime.none`              |

#### 3.2.2 public=true 的用户可见码（visible=true，按 severity 分组）

**severity=warning（transient，黄色 toast，可重试）**：

| 码值                          | title          | action i18n 键                    | 建议文案                                   |
| ----------------------------- | -------------- | --------------------------------- | ------------------------------------------ |
| `provider.network`            | 网络故障       | `action.provider.check_network`   | 服务暂时不可用，正在自动恢复，请稍后再试。 |
| `provider.rate_limit`         | 限流           | `action.provider.wait_retry`      | 请求过于频繁，请稍后重试。                 |
| `provider.server`             | 服务端错误     | `action.provider.wait_retry`      | 服务暂时不可用，正在自动恢复，请稍后再试。 |
| `provider.timeout`            | 请求超时       | `action.provider.retry`           | 请求超时，请重试。                         |
| `provider.stream_interrupted` | 流中断         | `action.provider.retry`           | 流式传输中断，请重试。                     |
| `session.storage_failed`      | 会话存储失败   | `action.session.retry_save`       | 会话保存失败，正在重试。                   |
| `context.length_exceeded`     | 上下文超长     | `action.context.compact`          | 对话上下文过长，建议压缩或新建会话。       |
| `context.compaction_failed`   | 上下文压缩失败 | `action.context.retry_compact`    | 上下文压缩失败，请重试。                   |
| `tool.execution_failed`       | 工具执行失败   | `action.tool.retry`               | 工具执行失败，请重试。                     |
| `mcp.connection_failed`       | MCP 连接失败   | `action.mcp.check_server`         | MCP 服务器连接失败，请检查配置。           |
| `store.write_failed`          | 存储写入失败   | `action.store.retry_write`        | 数据写入失败，正在重试。                   |
| `store.read_failed`           | 存储读取失败   | `action.store.retry_read`         | 数据读取失败，正在重试。                   |
| `subagent.timeout`            | 子代理超时     | `action.subagent.retry`           | 子代理执行超时，请重试。                   |
| `approval.timeout`            | 审批超时       | `action.approval.resubmit`        | 审批超时，请重新提交。                     |
| `network.unreachable`         | 网络不可达     | `action.network.check_connection` | 网络不可达，请检查连接。                   |

**severity=error（permanent/security，红色 banner，不可重试）**：

| 码值                            | title              | action i18n 键                    | 建议文案                                      |
| ------------------------------- | ------------------ | --------------------------------- | --------------------------------------------- |
| `config.invalid`                | 配置项非法         | `action.config.check_field`       | 配置项非法，请检查设置。                      |
| `config.missing`                | 配置缺失           | `action.config.provide_value`     | 配置缺失，请打开设置填写。                    |
| `config.parse_failed`           | 配置解析失败       | `action.config.verify_syntax`     | 配置解析失败，请检查格式。                    |
| `session.not_found`             | 会话未找到         | `action.session.select_existing`  | 会话不存在，请从侧边栏选择。                  |
| `session.invalid_session`       | 会话数据非法       | `action.session.restart`          | 会话数据损坏，请新建会话。                    |
| `session.invalid_entry`         | 会话条目非法       | `action.session.check_entry`      | 会话条目非法，请刷新。                        |
| `session.invalid_state`         | 会话状态非法       | `action.session.refresh`          | 会话状态异常，请刷新。                        |
| `agent.max_turns_reached`       | 达到最大轮次       | `action.agent.increase_max_turns` | Agent 达到最大轮次，请在设置中调整上限。      |
| `agent.no_progress`             | Agent 无进展       | `action.agent.intervene`          | Agent 无进展，请介入检查。                    |
| `agent.intervention_required`   | 需用户介入         | `action.agent.review`             | 需要您介入处理，请查看详情。                  |
| `runtime.unexpected_state`      | 运行时状态异常     | `action.runtime.restart_session`  | 运行时状态异常，请重启会话。                  |
| `runtime.transition_failed`     | 状态转移失败       | `action.runtime.report_bug`       | 状态转移失败，请反馈问题。                    |
| `provider.auth`                 | 鉴权失败           | `action.provider.check_api_key`   | 模型密钥无效或已过期，请打开设置 → 模型检查。 |
| `provider.quota`                | 配额耗尽           | `action.provider.top_up`          | 模型配额耗尽，请充值或更换服务商。            |
| `provider.endpoint_unavailable` | 端点不可用         | `action.provider.check_endpoint`  | 模型端点不可用，请检查服务商地址。            |
| `provider.unknown`              | 未知 Provider 错误 | `action.provider.report_bug`      | 未知模型错误，请反馈问题。                    |
| `context.heal_failed`           | 上下文修复失败     | `action.context.manual_trim`      | 上下文修复失败，请手动清理对话。              |
| `tool.not_found`                | 工具未找到         | `action.tool.check_name`          | 工具未找到，请检查名称。                      |
| `tool.path_escape`              | 路径越界           | `action.tool.check_path`          | 路径越界，操作被安全策略拦截。                |
| `mcp.server_not_found`          | MCP 服务器未找到   | `action.mcp.check_config`         | MCP 服务器未找到，请检查配置。                |
| `store.corrupted`               | 存储数据损坏       | `action.store.restore_backup`     | 数据损坏，请从备份恢复。                      |
| `subagent.depth_exceeded`       | 子代理递归深度超限 | `action.subagent.reduce_depth`    | 子代理层级过深，请简化任务。                  |
| `subagent.deadlock_detected`    | 子代理死锁         | `action.subagent.break_cycle`     | 子代理死锁，请重新规划任务。                  |
| `plugin.not_found`              | 插件未找到         | `action.plugin.check_install`     | 插件未安装，请检查。                          |
| `plugin.activation_failed`      | 插件激活失败       | `action.plugin.check_manifest`    | 插件激活失败，请检查 manifest。               |
| `plugin.permission_denied`      | 插件权限不足       | `action.plugin.grant_permission`  | 插件权限不足，请授权。                        |
| `approval.rejected`             | 审批被拒           | `action.approval.modify_request`  | 审批被拒，请修改请求。                        |
| `artifact.not_found`            | Artifact 未找到    | `action.artifact.check_uri`       | 资源未找到，请检查 URI。                      |
| `artifact.invalid_uri`          | Artifact URI 非法  | `action.artifact.fix_uri`         | URI 非法，请修正。                            |
| `run.not_found`                 | Run 未找到         | `action.run.select_existing`      | 运行记录不存在，请重新发起。                  |
| `run.invalid_state`             | Run 状态非法       | `action.run.refresh`              | 运行状态异常，请刷新。                        |
| `run.not_goal_run`              | 非 Goal Run        | `action.run.use_goal_run`         | 非 Goal 类型运行，请使用 Goal 模式。          |
| `network.daemon_dead`           | 后台 Daemon 已死   | `action.network.restart_daemon`   | 引擎已停止，正在重启。                        |
| `common.unknown`                | 未知错误           | `action.common.report_bug`        | 发生未知错误，请反馈问题。                    |
| `common.unsupported`            | 不支持的操作       | `action.common.check_version`     | 操作不支持，请检查版本。                      |

**severity=warning（protocol，黄色 toast，不可重试）**：

| 码值                         | title             | action i18n 键                  | 建议文案                             |
| ---------------------------- | ----------------- | ------------------------------- | ------------------------------------ |
| `provider.gateway_challenge` | 网关质询拦截      | `action.provider.disable_proxy` | 网关拦截，请关闭代理后重试。         |
| `provider.schema`            | 请求 schema 非法  | `action.provider.fix_request`   | 请求格式错误，请反馈问题。           |
| `tool.invalid_input`         | 工具入参非法      | `action.tool.fix_input`         | 工具入参非法，请修正。               |
| `mcp.protocol_violation`     | MCP 协议违规      | `action.mcp.report_bug`         | MCP 协议违规，请反馈问题。           |
| `run.invalid_state`          | Run 状态非法      | `action.run.refresh`            | 运行状态异常，请刷新。               |
| `run.not_goal_run`           | 非 Goal Run       | `action.run.use_goal_run`       | 非 Goal 类型运行，请使用 Goal 模式。 |
| `artifact.invalid_uri`       | Artifact URI 非法 | `action.artifact.fix_uri`       | URI 非法，请修正。                   |

> 注：`severity` 由 `mapSeverity(payload)` 根据 `category` 自动映射。同一码值的 `severity` 是确定的（因为 `category` 是注册表中的静态字段）。上表中 `run.invalid_state` 与 `artifact.invalid_uri` 同时出现在 warning 与 error 分组是因为它们的 `category=protocol` 映射为 `warning`，但某些场景下用户感知为 error——以 `mapSeverity` 的实际输出为准。

---

## 4. TSC 修复策略

> 本节为 crish-desktop TSC 错误修复的详细策略，依据 `01-OVERVIEW.md` §1.2 的错误类型分布与 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 26 的 TSC 管理约束。

### 4.1 错误类型分布

依据 `01-OVERVIEW.md` §1.2，全仓库 315 个 TSC 错误的类型分布如下。crish-desktop 范围约 180 个，按比例分布：

| 错误码             | 描述                                                    | 全仓库数量 | crish-desktop 范围（估） | 修复 Agent  |
| ------------------ | ------------------------------------------------------- | ---------- | ------------------------ | ----------- |
| `TS2375`/`TS2379`  | exactOptionalPropertyTypes（可选属性不能赋 undefined）  | ~90        | ~50                      | 11-D        |
| `TS2532`/`TS18048` | noUncheckedIndexedAccess（索引访问返回 T \| undefined） | ~60        | ~35                      | 11-D        |
| `TS6133`/`TS6192`  | noUnusedLocals（未使用的局部变量/import）               | ~45        | ~25                      | 11-D / 11-E |
| `TS2307`/`TS2305`  | missing module / export（import 路径或导出错误）        | ~35        | ~20                      | 11-E        |
| `TS1484`           | verbatimModuleSyntax（类型 import 需用 `import type`）  | ~30        | ~20                      | 11-D        |
| `TS7006`           | implicitAny（参数隐式 any）                             | ~20        | ~15                      | 11-E        |
| other              | TS2304/TS2554/TS2322 等                                 | ~35        | ~15                      | 11-D / 11-E |
| **合计**           |                                                         | **~315**   | **~180**                 | 11-D + 11-E |

> 注：`tsconfig.app.json` 覆盖了 `exactOptionalPropertyTypes: false` 与 `noUnusedLocals: false`（仅 app 构建路径），但 CI 严格检查（`npx tsc --noEmit` 根级 + `tsconfig.base.json`）仍启用这些规则。本 Round 的 TSC 目标以 CI 严格检查为准。

### 4.2 修复优先级

依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 26"仅修复阻碍编译或测试通过的 error，不追求清零"，修复优先级如下：

**P0（11-D 优先修复，~80 个）**：

| 优先级 | 错误类型           | 修复模式                                              | 数量（估） | 理由                                               |
| ------ | ------------------ | ----------------------------------------------------- | ---------- | -------------------------------------------------- |
| P0-1   | `TS2375`/`TS2379`  | 条件展开 `...(x !== undefined ? {field: x} : {})`     | ~50        | 数量最多，修复模式统一，可批量处理                 |
| P0-2   | `TS2532`/`TS18048` | 显式守卫 `if (x === undefined) return` 或可选链 `x?.` | ~35        | 数量次多，阻碍 `noUncheckedIndexedAccess` 严格检查 |

**P1（11-E 修复，~60 个）**：

| 优先级 | 错误类型          | 修复模式                            | 数量（估） | 理由                     |
| ------ | ----------------- | ----------------------------------- | ---------- | ------------------------ |
| P1-1   | `TS6133`/`TS6192` | 删除未使用 import/变量              | ~25        | 简单删除，改善代码整洁度 |
| P1-2   | `TS1484`          | `import type { ... }` 拆分          | ~20        | 模式统一，批量处理       |
| P1-3   | `TS2307`/`TS2305` | 修正 import 路径 / 补齐 barrel 导出 | ~20        | 阻碍编译                 |

**P2（11-E 视余量修复，~40 个）**：

| 优先级 | 错误类型                      | 修复模式         | 数量（估） | 理由       |
| ------ | ----------------------------- | ---------------- | ---------- | ---------- |
| P2-1   | `TS7006`                      | 显式标注参数类型 | ~15        | 简单标注   |
| P2-2   | other（TS2304/TS2554/TS2322） | 逐个修复         | ~15        | 需逐个分析 |

### 4.3 目标：< 50

**目标**：Round 11 结束时，crish-desktop 范围 TSC 错误数 < 50（依据 禁令 26）。

**达成路径**：

| 阶段             | 错误数（估） | 减少量   | 说明                                      |
| ---------------- | ------------ | -------- | ----------------------------------------- |
| R11 开始基线     | ~180         | —        | `tsc-errors-baseline.json` 记录           |
| Agent 11-D 结束  | ~100         | -80      | P0 修复（TS2375/TS2379 + TS2532/TS18048） |
| Agent 11-E 结束  | ~45          | -55      | P1 + P2 修复                              |
| **R11 结束目标** | **< 50**     | **-130** | 禁令 26 目标达成                          |

**剩余 ~45 个错误的处理**：

- 不在本 Round 处理，作为后续独立任务（禁令 26"完全清零作为后续独立任务"）。
- 验证报告中记录剩余错误的错误码与文件清单，供后续任务参考。
- 剩余错误不阻碍编译（app 构建 `tsconfig.app.json` 放宽了 `exactOptionalPropertyTypes` 与 `noUnusedLocals`）与测试（vitest 使用 esbuild 转译，不检查类型）。

---

## 5. 验证门禁

> 依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 27 与 `01-OVERVIEW.md` §4.3，Round 11 结束前必须通过以下 8 项检查。

### 5.1 验证门禁清单

| 检查项           | 命令                                                       | 通过标准                         | 负责 Agent |
| ---------------- | ---------------------------------------------------------- | -------------------------------- | ---------- |
| TypeScript 编译  | `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json` | 错误数 < 50（禁令 26 目标）      | 11-E       |
| Rust 编译        | `cargo check --workspace`                                  | 0 errors（前端不影响 Rust）      | 11-E       |
| 单元测试（TS）   | `npx vitest run apps/crish-desktop/`                       | 全部通过                         | 11-E       |
| 单元测试（Rust） | `cargo test --workspace`                                   | 全部通过（前端不影响 Rust）      | 11-E       |
| 循环依赖         | `npm run lint:depcruise`                                   | 0 violations                     | 11-E       |
| 构建             | `npx turbo run build --filter=crish-desktop`               | 成功                             | 11-E       |
| Lint             | `npm run lint`                                             | 0 errors（warn 不阻塞）          | 11-E       |
| Store 类型       | `npm run check:store-types`                                | 通过（store 中无 `as any` 逃逸） | 11-E       |

### 5.2 基线对比

| 指标                             | Round 11 开始基线  | Round 11 结束目标                                     | 实际值（待填） |
| -------------------------------- | ------------------ | ----------------------------------------------------- | -------------- |
| TSC 错误数（crish-desktop 范围） | ~180               | < 50                                                  | 待填           |
| `error-translation.ts` 新文件    | 0                  | 1（~180 行）                                          | 待填           |
| `error-payload-guard.ts` 新文件  | 0                  | 1（~55 行）                                           | 待填           |
| 旧 `userFacingErrors.ts` 状态    | 活跃               | `@deprecated`（不删除）                               | 待填           |
| `StreamRecovery.markFailed` 签名 | `(string, string)` | `(string, CrishErrorPayload \| CrishError \| string)` | 待填           |
| Store 错误字段类型               | `string` / `Error` | `CrishErrorPayload \| null`                           | 待填           |
| `daemonClient.ts` reject 类型    | `Error`            | `CrishError`（extends Error，兼容）                   | 待填           |
| `tauriInvoke.ts` `InvokeError`   | 无 payload         | 含 `payload?: CrishErrorPayload`                      | 待填           |
| 测试文件数                       | ~50                | ~52（新增 2 个 e2e 测试）                             | 待填           |

### 5.3 验证报告

Agent 11-E 完成后产出 `round-11-verification-report.md`，包含：

1. **8 项门禁检查结果**（命令输出摘要 + 通过/失败状态）。
2. **TSC 基线对比**（R11 开始 ~180 → 结束 < 50，按错误码分类）。
3. **错误翻译层验证**（64 正式码 + 10 reserved 码查表测试结果 + public=false 隐藏验证 + cause 链保留验证）。
4. **IPC 解析验证**（CrishErrorPayload 解析 + 旧 IpcError 回退兼容性）。
5. **StreamRecovery 对齐验证**（markFailed 三种输入类型 + error 字段标准化）。
6. **Store 错误标准化验证**（`errorDetail` 字段类型 + 13 处 catch 块 `normalizeCrishError` 兜底）。
7. **测试结果摘要**（通过数 / 失败数 / 跳过数）。
8. **已知遗留问题**（剩余 ~45 个 TSC 错误的清单与不修复理由）。
9. **Round 12 输入契约达成情况**（§6.3 各契约项的验证结果）。

---

## 6. 交付物

### 6.1 代码交付物

| 交付物                   | 路径                                                                                                                                                                                                  | 类型 | 负责 Agent |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------- |
| 前端错误翻译层           | `apps/crish-desktop/src/utils/error-translation.ts`                                                                                                                                                   | 新建 | 11-A       |
| 错误翻译层测试           | `apps/crish-desktop/src/utils/error-translation.test.ts`                                                                                                                                              | 新建 | 11-A       |
| 旧翻译层标记 deprecated  | `apps/crish-desktop/src/api/userFacingErrors.ts`                                                                                                                                                      | 修改 | 11-A       |
| StreamRecovery 对齐      | `apps/crish-desktop/src/services/StreamRecovery.ts`                                                                                                                                                   | 修改 | 11-B       |
| StreamRecovery 测试      | `apps/crish-desktop/src/services/StreamRecovery.test.ts`                                                                                                                                              | 修改 | 11-B       |
| Store 错误标准化         | `apps/crish-desktop/src/store/types.ts` / `sessionActions.ts` / `sessionMessageActions.ts` / `sessionAgentActions.ts` / `workspaceShellStore.ts` / `layoutAnimationStore.ts` / `store-persistence.ts` | 修改 | 11-B       |
| Daemon Client 错误处理   | `apps/crish-desktop/src/api/daemonClient.ts`                                                                                                                                                          | 修改 | 11-C       |
| Tauri invoke 扩展        | `apps/crish-desktop/src/api/tauriInvoke.ts`                                                                                                                                                           | 修改 | 11-C       |
| IPC 错误负载类型守卫     | `apps/crish-desktop/src/api/bindings/error-payload-guard.ts`                                                                                                                                          | 新建 | 11-C       |
| 类型守卫测试             | `apps/crish-desktop/src/api/bindings/error-payload-guard.test.ts`                                                                                                                                     | 新建 | 11-C       |
| daemon-chat-bridge 对齐  | `apps/crish-desktop/src/api/daemonChatBridge.ts` / `daemon-chat-bridge/EventRouter.ts` / `BridgeErrorPolicy.ts` / `ConnectionLifecycle.ts`                                                            | 修改 | 11-C       |
| TSC 修复（前 80 个）     | ~20 个源码文件                                                                                                                                                                                        | 修改 | 11-D       |
| TSC 修复（剩余）+ API 层 | ~20 个源码文件                                                                                                                                                                                        | 修改 | 11-E       |
| 测试适配                 | `apps/crish-desktop/src/**/*.test.ts`（~9 文件）                                                                                                                                                      | 修改 | 11-E       |
| 端到端错误翻译测试       | `apps/crish-desktop/src/__tests__/error-translation.e2e.test.ts`                                                                                                                                      | 新建 | 11-E       |
| package.json 依赖声明    | `apps/crish-desktop/package.json`                                                                                                                                                                     | 修改 | 11-A       |

### 6.2 文档交付物

| 交付物                          | 路径                                                           | 类型                              | 负责 Agent |
| ------------------------------- | -------------------------------------------------------------- | --------------------------------- | ---------- |
| Round 11 设计文档               | `analysis/iterative-repair/v2/ROUND-11-frontend.md`            | 新建（本文档）                    | 主 Agent   |
| 验证报告                        | `analysis/iterative-repair/v2/round-11-verification-report.md` | 新建                              | 11-E       |
| `02-FILE-MAPPING.md` 更新       | `analysis/iterative-repair/v2/02-FILE-MAPPING.md`              | 修改（标注 crish-desktop 新文件） | 11-E       |
| `03-ERROR-MIGRATION.md` §4 更新 | `analysis/iterative-repair/v2/03-ERROR-MIGRATION.md`           | 修改（标注前端错误翻译层已就位）  | 11-E       |

### 6.3 接口契约交付物

以下接口契约为 Round 12 的输入：

| 契约                                                     | 路径                                                         | 消费方                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| `toUserVisibleError(payload): UserVisibleError`          | `apps/crish-desktop/src/utils/error-translation.ts`          | R12（旧 `userFacingErrors.ts` 删除后的统一入口）                |
| `normalizeCrishError(error: unknown): CrishErrorPayload` | `apps/crish-desktop/src/utils/error-translation.ts`          | R12（store / daemon client 的统一兜底）                         |
| `fromErrorPayload(payload): CrishError`                  | `apps/crish-desktop/src/utils/error-translation.ts`          | R12（IPC reject 路径的统一还原）                                |
| `IpcResponseError` 类型守卫                              | `apps/crish-desktop/src/api/bindings/error-payload-guard.ts` | R12（删除阶段移除旧 `IpcError` 后，仅保留 `CrishErrorPayload`） |
| `StreamRecovery.markFailed` 新签名                       | `apps/crish-desktop/src/services/StreamRecovery.ts`          | R12（删除阶段移除旧 string 调用点）                             |
| Store 错误字段 `CrishErrorPayload                        | null` 类型                                                   | `apps/crish-desktop/src/store/types.ts` 等                      | R12（store 类型安全门禁的稳定基线） |
| 前端已迁移的错误码清单                                   | 本文 §3.2                                                    | R12 删除阶段清理参考                                            |

---

## 附录 A：Agent 任务量自检表

> 依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 28，每个 Agent 必须满足 ≥ 5 文件或 ≥ 300 行变更。

| Agent | 文件数 | 行变更量（估） | 满足 |
| ----- | ------ | -------------- | ---- |
| 11-A  | 5      | ~350           | 是   |
| 11-B  | 9      | ~320           | 是   |
| 11-C  | 9      | ~340           | 是   |
| 11-D  | ~20    | ~350           | 是   |
| 11-E  | ~20    | ~400           | 是   |

## 附录 B：与其他 Round 的依赖关系

```
R1（类型基础）─→ R7（daemon IPC）─→ R10（Rust CrishErrorPayload）─→ R11（前端韧性）─→ R12（CI + 文档）
                                          │
                                          └─→ R11 消费 R10 的 IpcResponse.error 新格式
                                          └─→ R11 消费 R7 的 ErrorMessage.payload 字段
                                          └─→ R11 消费 R1 的 CRISH_ERROR_REGISTRY / getErrorInfo / fromUnknownError
```

- **R1 → R11**：`CrishErrorPayload` / `CrishErrorCode` / `CRISH_ERROR_REGISTRY` / `getErrorInfo` / `fromUnknownError` / `toErrorPayload` 为前端错误翻译层的输入契约。
- **R7 → R11**：daemon 的 `ErrorMessage.payload: CrishErrorPayload?` 为前端 daemon client 的输入契约（`ROUND-07-daemon.md` §5）。
- **R10 → R11**：Rust 端 `IpcResponse.error` 从 `Option<String>` 迁移为 `Option<CrishErrorPayload>`，为前端 Tauri invoke 的输入契约。
- **R11 → R12**：前端 TSC 错误 < 50 为 CI 门禁规则（R12）提供稳定基线；错误翻译层为旧 `userFacingErrors.ts` 删除阶段（R12）提供迁移路径。

## 附录 C：共存策略边界

> 依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 23 三阶段策略。

| 阶段         | Round           | crish-desktop 状态                                                                                                                                                                                                                                                                                                |
| ------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **共存阶段** | R11（本 Round） | 新错误翻译层（`error-translation.ts`）与旧实现（`userFacingErrors.ts`）并存。新代码使用新翻译层，旧调用点保留。`StreamRecovery.markFailed` 接受新旧两种参数。`daemonClient.ts` 解析 `payload` 字段，无 `payload` 时回退旧字符串路径。`tauriInvoke.ts` 的 `InvokeError` 含可选 `payload` 字段。                    |
| **删除阶段** | R12             | 移除 `userFacingErrors.ts`；`StreamRecovery.markFailed` 仅接受 `CrishErrorPayload`；`daemonClient.ts` 仅走 `payload` 路径；`InvokeError` 的 `payload` 字段变为必填；`IpcError.ts` 旧类型移除（仅保留 `CrishErrorPayload`）；`error-payload-guard.ts` 的 `isLegacyIpcError` / `toCrishErrorPayload` 旧码映射移除。 |

## 变更记录

| 版本 | 日期       | 变更                                                                                                       |
| ---- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| v1.0 | 2026-07-30 | 初版，基于 `01-OVERVIEW.md` / `03-ERROR-MIGRATION.md` / `ROUND-07-daemon.md` 与 crish-desktop 代码扫描生成 |
