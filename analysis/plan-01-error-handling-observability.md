# Crish 错误处理与可观测性方案

> 基于 Codex CLI（OpenAI）、Pi（π，Earendil Works）、Kimi Code（Moonshot AI）三个项目的错误处理与可观测性最佳实践，为 Crish 设计一套系统性方案。

---

## 目录

- [1. 错误类型系统（TypeScript 端）](#1-错误类型系统typescript-端)
- [2. 错误处理模式](#2-错误处理模式)
- [3. 日志系统（TypeScript 端）](#3-日志系统typescript-端)
- [4. Telemetry/可观测性（TypeScript 端）](#4-telemetry可观测性typescript-端)
- [5. Rust 侧错误处理](#5-rust-侧错误处理)
- [6. 错误展示策略](#6-错误展示策略)
- [7. 实施文件结构](#7-实施文件结构)
- [8. 迁移步骤](#8-迁移步骤)

---

## 1. 错误类型系统（TypeScript 端）

### 1.1 统一错误基类：`CrishError`

**文件：** `packages/shared-types/src/errors/classes.ts`

借鉴 KimiCode 的 `KimiError` 设计：单一错误类，通过 `code` 字段区分，而非类层次结构。

```typescript
import type { CrishErrorCode } from './codes';

export interface CrishErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
  readonly retryable?: boolean;
  readonly public?: boolean;
}

export class CrishError extends Error {
  readonly code: CrishErrorCode;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;
  readonly retryable: boolean;
  readonly public: boolean;

  constructor(
    code: CrishErrorCode,
    message: string,
    options: CrishErrorOptions = {}
  ) {
    super(message);
    this.name = 'CrishError';
    this.code = code;
    this.details = options.details;
    this.cause = options.cause;
    this.retryable = options.retryable ?? false;
    this.public = options.public ?? true;
  }
}
```

### 1.2 分域错误码

**文件：** `packages/shared-types/src/errors/codes.ts`

借鉴 KimiCode 的 `domain.reason` 格式，覆盖 Crish 的完整领域。

```typescript
export const ErrorCodes = {
  // ===== 配置域 =====
  CONFIG_INVALID: 'config.invalid',
  CONFIG_PROVIDER_NOT_FOUND: 'config.provider_not_found',
  CONFIG_MODEL_NOT_FOUND: 'config.model_not_found',

  // ===== 会话域 =====
  SESSION_NOT_FOUND: 'session.not_found',
  SESSION_ALREADY_EXISTS: 'session.already_exists',
  SESSION_ID_INVALID: 'session.id_invalid',
  SESSION_STATE_INVALID: 'session.state_invalid',
  SESSION_CLOSED: 'session.closed',
  SESSION_FORK_ACTIVE_TURN: 'session.fork_active_turn',
  SESSION_PERMISSION_MODE_INVALID: 'session.permission_mode_invalid',

  // ===== Agent 域 =====
  AGENT_NOT_FOUND: 'agent.not_found',
  AGENT_BUSY: 'agent.busy',
  AGENT_INTERNAL_DIED: 'agent.internal_died',

  // ===== 运行时域 =====
  RUNTIME_INIT_FAILED: 'runtime.init_failed',
  RUNTIME_INVALID_STATE: 'runtime.invalid_state',
  RUNTIME_INVALID_ARGUMENT: 'runtime.invalid_argument',
  RUNTIME_TIMEOUT: 'runtime.timeout',

  // ===== Provider 域 =====
  PROVIDER_API_ERROR: 'provider.api_error',
  PROVIDER_RATE_LIMIT: 'provider.rate_limit',
  PROVIDER_AUTH_ERROR: 'provider.auth_error',
  PROVIDER_CONNECTION_ERROR: 'provider.connection_error',
  PROVIDER_FILTERED: 'provider.filtered',
  PROVIDER_STREAM_FAILED: 'provider.stream_failed',
  PROVIDER_SERVER_OVERLOADED: 'provider.server_overloaded',
  PROVIDER_QUOTA_EXCEEDED: 'provider.quota_exceeded',

  // ===== 上下文域 =====
  CONTEXT_OVERFLOW: 'context.overflow',
  CONTEXT_COMPACTION_FAILED: 'context.compaction_failed',
  CONTEXT_COMPACTION_UNABLE: 'context.compaction_unable',

  // ===== 工具执行域 =====
  TOOL_EXECUTION_FAILED: 'tool.execution_failed',
  TOOL_NOT_FOUND: 'tool.not_found',
  TOOL_OUTPUT_BUDGET_EXCEEDED: 'tool.output_budget_exceeded',
  TOOL_PERMISSION_DENIED: 'tool.permission_denied',

  // ===== MCP 域 =====
  MCP_SERVER_NOT_FOUND: 'mcp.server_not_found',
  MCP_SERVER_DISABLED: 'mcp.server_disabled',
  MCP_STARTUP_FAILED: 'mcp.startup_failed',
  MCP_TOOL_NAME_COLLISION: 'mcp.tool_name_collision',

  // ===== 存储域 =====
  STORE_WRITE_FAILED: 'store.write_failed',
  STORE_READ_FAILED: 'store.read_failed',
  STORE_NOT_FOUND: 'store.not_found',

  // ===== 观测域 =====
  TELEMETRY_SEND_FAILED: 'telemetry.send_failed',
  LOG_WRITE_FAILED: 'log.write_failed',

  // ===== 通用域 =====
  CANCELLED: 'cancelled',
  NOT_IMPLEMENTED: 'not_implemented',
  INTERNAL: 'internal',
} as const;

export type CrishErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
```

### 1.3 错误元信息注册表

**文件：** `packages/shared-types/src/errors/info.ts`

每个错误码关联 `retryable`、`public`、`action` 元信息，同时定义用户可见性。

```typescript
import { ErrorCodes, type CrishErrorCode } from './codes';

export interface CrishErrorInfo {
  readonly title: string;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action?: string;
}

export const CRISH_ERROR_INFO: Record<CrishErrorCode, CrishErrorInfo> = {
  'config.invalid': {
    title: '配置无效',
    retryable: false,
    public: true,
    action: '检查 config.toml 和 provider/model 设置。',
  },
  'config.provider_not_found': {
    title: 'Provider 不存在',
    retryable: false,
    public: true,
    action: '检查配置中的 provider 名称。',
  },
  'config.model_not_found': {
    title: 'Model 不存在',
    retryable: false,
    public: true,
    action: '检查配置中的 model 名称。',
  },

  'session.not_found': {
    title: '会话未找到',
    retryable: false,
    public: true,
    action: '检查会话 ID 或列出可用会话。',
  },
  'session.already_exists': {
    title: '会话已存在',
    retryable: false,
    public: true,
    action: '使用不同的会话 ID 或先移除现有会话。',
  },
  'session.id_invalid': {
    title: '会话 ID 无效',
    retryable: false,
    public: true,
    action: '使用不包含路径遍历字符的会话 ID。',
  },
  'session.state_invalid': {
    title: '会话状态无效',
    retryable: false,
    public: false,
  },
  'session.closed': {
    title: '会话已关闭',
    retryable: false,
    public: true,
    action: '创建一个新会话。',
  },
  'session.fork_active_turn': {
    title: '无法在活跃轮次中分叉会话',
    retryable: true,
    public: true,
    action: '等待活跃轮次完成后再分叉。',
  },
  'session.permission_mode_invalid': {
    title: '权限模式无效',
    retryable: false,
    public: true,
    action: '使用：yolo / manual / auto。',
  },

  'agent.not_found': {
    title: 'Agent 未找到',
    retryable: false,
    public: true,
    action: '检查 agent ID。',
  },
  'agent.busy': {
    title: 'Agent 正忙',
    retryable: true,
    public: true,
    action: '等待当前轮次完成后再试。',
  },
  'agent.internal_died': {
    title: 'Agent 内部错误',
    retryable: false,
    public: false,
  },

  'runtime.init_failed': {
    title: '运行时初始化失败',
    retryable: false,
    public: false,
  },
  'runtime.invalid_state': {
    title: '运行时状态无效',
    retryable: false,
    public: true,
    action: '检查操作顺序或重新启动。',
  },
  'runtime.invalid_argument': {
    title: '参数无效',
    retryable: false,
    public: true,
    action: '检查输入参数是否符合 API 契约。',
  },
  'runtime.timeout': {
    title: '请求超时',
    retryable: true,
    public: true,
    action: '检查网络连接后重试。',
  },

  'provider.api_error': {
    title: 'Provider API 错误',
    retryable: false,
    public: true,
    action: '查看 details.statusCode / details.requestId；检查 provider 状态。',
  },
  'provider.rate_limit': {
    title: 'Provider 限流',
    retryable: true,
    public: true,
    action: '延迟后重试或降低请求频率。',
  },
  'provider.auth_error': {
    title: 'Provider 认证错误',
    retryable: false,
    public: true,
    action: '重新认证 provider。',
  },
  'provider.connection_error': {
    title: 'Provider 连接错误',
    retryable: true,
    public: true,
    action: '检查网络连接后重试。',
  },
  'provider.filtered': {
    title: 'Provider 过滤响应',
    retryable: false,
    public: true,
    action: '修改提示词或模型配置以避免安全过滤。',
  },
  'provider.stream_failed': {
    title: 'Provider 流连接失败',
    retryable: true,
    public: true,
    action: '检查网络连接后重试。',
  },
  'provider.server_overloaded': {
    title: 'Provider 服务器过载',
    retryable: true,
    public: true,
    action: '稍后重试或选择其他模型。',
  },
  'provider.quota_exceeded': {
    title: 'Provider 配额超限',
    retryable: false,
    public: true,
    action: '检查用量限制或升级套餐。',
  },

  'context.overflow': {
    title: '上下文窗口溢出',
    retryable: true,
    public: true,
    action: '压缩对话或开始新会话。',
  },
  'context.compaction_failed': {
    title: '上下文压缩失败',
    retryable: false,
    public: true,
    action: '查看日志并考虑增大压缩限制。',
  },
  'context.compaction_unable': {
    title: '无法压缩上下文',
    retryable: false,
    public: true,
    action: '当前历史记录没有可压缩的前缀。',
  },

  'tool.execution_failed': {
    title: '工具执行失败',
    retryable: true,
    public: true,
    action: '查看工具输出详情。',
  },
  'tool.not_found': {
    title: '工具未找到',
    retryable: false,
    public: true,
    action: '检查工具名称。',
  },
  'tool.output_budget_exceeded': {
    title: '工具输出超预算',
    retryable: false,
    public: false,
  },
  'tool.permission_denied': {
    title: '工具权限被拒绝',
    retryable: false,
    public: true,
    action: '检查权限策略。',
  },

  'mcp.server_not_found': {
    title: 'MCP 服务器未找到',
    retryable: false,
    public: true,
    action: '列出配置的 MCP 服务器并检查请求的名称。',
  },
  'mcp.server_disabled': {
    title: 'MCP 服务器已禁用',
    retryable: false,
    public: true,
    action: '在配置中启用 MCP 服务器条目。',
  },
  'mcp.startup_failed': {
    title: 'MCP 服务器启动失败',
    retryable: true,
    public: true,
    action: '查看 MCP 服务器日志或调用 reconnect。',
  },
  'mcp.tool_name_collision': {
    title: 'MCP 工具名冲突',
    retryable: false,
    public: true,
    action: '重命名冲突的 MCP 工具或服务器。',
  },

  'store.write_failed': {
    title: '存储写入失败',
    retryable: true,
    public: true,
    action: '检查磁盘空间和权限。',
  },
  'store.read_failed': {
    title: '存储读取失败',
    retryable: true,
    public: false,
  },
  'store.not_found': {
    title: '存储项未找到',
    retryable: false,
    public: true,
    action: '检查存储路径或 ID。',
  },

  'telemetry.send_failed': {
    title: '遥测发送失败',
    retryable: false,
    public: false,
  },
  'log.write_failed': {
    title: '日志写入失败',
    retryable: false,
    public: false,
  },

  cancelled: {
    title: '操作已取消',
    retryable: true,
    public: true,
    action: '如有必要重新提交请求。',
  },
  not_implemented: {
    title: '未实现',
    retryable: false,
    public: true,
    action: '此功能尚未实现。',
  },
  internal: {
    title: '内部错误',
    retryable: false,
    public: true,
    action: '查看日志或提交诊断信息报告问题。',
  },
};

export function getErrorInfo(code: CrishErrorCode): CrishErrorInfo {
  return CRISH_ERROR_INFO[code] ?? CRISH_ERROR_INFO['internal'];
}
```

### 1.4 `CrishResult<T, E>` 代数数据类型

**文件：** `packages/shared-types/src/errors/result.ts`

借鉴 Pi 的 `Result<TValue, TError>` 设计，结合 KimiCode 的序列化能力。

```typescript
import { CrishError } from './classes';
import type { CrishErrorCode } from './codes';
import { makeErrorPayload, type CrishErrorPayload } from './serialize';
import { CrishErrorInfo } from './info';

export type CrishResult<TValue, TError = CrishError> =
  { ok: true; value: TValue } | { ok: false; error: TError };

export function ok<TValue, TError>(value: TValue): CrishResult<TValue, TError> {
  return { ok: true, value };
}

export function err<TValue, TError>(
  error: TError
): CrishResult<TValue, TError> {
  return { ok: false, error };
}

export function getOrThrow<TValue, TError>(
  result: CrishResult<TValue, TError>
): TValue {
  if (!result.ok) throw result.error;
  return result.value;
}

export function getOrUndefined<TValue extends object, TError>(
  result: CrishResult<TValue, TError>
): TValue | undefined {
  return result.ok ? result.value : undefined;
}

export async function promiseResult<T>(
  promise: Promise<T>
): Promise<CrishResult<T, CrishError>> {
  try {
    return ok(await promise);
  } catch (error) {
    return err(normalizeCrishError(error));
  }
}
```

### 1.5 跨进程序列化 `toErrorPayload()`

**文件：** `packages/shared-types/src/errors/serialize.ts`

借鉴 KimiCode 的 `KimiErrorPayload` + `toKimiErrorPayload()` 模式。

```typescript
import { CrishError } from './classes';
import { ErrorCodes, type CrishErrorCode } from './codes';
import { getErrorInfo } from './info';

export interface CrishErrorPayload {
  readonly code: CrishErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly public: boolean;
}

export function isCrishError(error: unknown): error is CrishError {
  return error instanceof CrishError;
}

export function makeErrorPayload(
  code: CrishErrorCode,
  message: string,
  options?: { details?: Record<string, unknown>; name?: string }
): CrishErrorPayload {
  const info = getErrorInfo(code);
  return {
    code,
    message,
    name: options?.name,
    details: options?.details,
    retryable: info.retryable,
    public: info.public,
  };
}

export function toErrorPayload(error: unknown): CrishErrorPayload {
  if (isCrishError(error)) {
    return {
      code: error.code,
      message: error.message,
      name: error.name,
      details: error.details,
      retryable: error.retryable,
      public: error.public,
    };
  }

  if (error instanceof CrishRestError) {
    return toErrorPayloadFromStatus(error);
  }

  if (error instanceof Error) {
    return {
      code: ErrorCodes.INTERNAL,
      message: error.message,
      name: error.name,
      retryable: getErrorInfo(ErrorCodes.INTERNAL).retryable,
      public: getErrorInfo(ErrorCodes.INTERNAL).public,
    };
  }

  return {
    code: ErrorCodes.INTERNAL,
    message: String(error),
    retryable: getErrorInfo(ErrorCodes.INTERNAL).retryable,
    public: getErrorInfo(ErrorCodes.INTERNAL).public,
  };
}

export function fromErrorPayload(payload: CrishErrorPayload): CrishError {
  return new CrishError(payload.code, payload.message, {
    details: payload.details,
  });
}

function toErrorPayloadFromStatus(error: CrishRestError): CrishErrorPayload {
  const { statusCode, body } = error;
  const code: CrishErrorCode =
    statusCode === 429
      ? ErrorCodes.PROVIDER_RATE_LIMIT
      : statusCode === 401 || statusCode === 403
        ? ErrorCodes.PROVIDER_AUTH_ERROR
        : statusCode >= 500
          ? ErrorCodes.PROVIDER_API_ERROR
          : ErrorCodes.PROVIDER_API_ERROR;
  const info = getErrorInfo(code);
  return {
    code,
    message: body?.error?.message ?? error.message,
    name: error.name,
    details: { statusCode, requestId: body?.requestId },
    retryable: info.retryable,
    public: info.public,
  };
}
```

### 1.6 `normalizeCrishError()` 标准化函数

**文件：** `packages/shared-types/src/errors/normalize.ts`

借鉴 Pi 的 `normalizeHarnessError()` 模式，将任意 throw 值标准化为 `CrishError`。

```typescript
import { CrishError } from './classes';
import { ErrorCodes } from './codes';

export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

export function normalizeCrishError(
  error: unknown,
  fallbackCode?: CrishErrorCode
): CrishError {
  if (error instanceof CrishError) return error;
  const cause = toError(error);
  const code = fallbackCode ?? ErrorCodes.INTERNAL;
  return new CrishError(code, cause.message, { cause });
}
```

### 1.7 `isRetryable()` 分类方法

**文件：** `packages/shared-types/src/errors/retryable.ts`

借鉴 Codex 的 `CodexErr::is_retryable()` 和 KimiCode 的 `KIMI_ERROR_INFO.retryable`。

```typescript
import { CrishError } from './classes';
import type { CrishErrorCode } from './codes';
import { getErrorInfo } from './info';

export function isCrishRetryable(error: unknown): boolean {
  if (error instanceof CrishError) {
    return getErrorInfo(error.code).retryable;
  }
  return false;
}

export function isRetryableGenerateError(msg: AssistantMessage): boolean {
  if (msg.stopReason !== 'error') return false;
  if (!msg.errorMessage) return false;
  const lower = msg.errorMessage.toLowerCase();
  if (lower.includes('rate limit') || lower.includes('rate_limit')) return true;
  if (lower.includes('timeout') || lower.includes('timed out')) return true;
  if (lower.includes('server error') || lower.includes('5')) return true;
  if (
    lower.includes('context') &&
    (lower.includes('overflow') || lower.includes('length'))
  )
    return true;
  return false;
}
```

---

## 2. 错误处理模式

### 2.1 流式错误编码

**文件：** `packages/agent-runtime/src/provider-stream-contract/types.ts`

借鉴 Pi 的流式错误编码模式：运行时故障通过 `stopReason: 'error'` 编码，而非 throw。

```typescript
export interface AssistantMessage {
  role: 'assistant';
  content: TextContent[];
  stopReason?: 'end_turn' | 'max_tokens' | 'tool_use' | 'error' | 'aborted';
  errorMessage?: string;
  errorCode?: CrishErrorCode;
  errorDetails?: Record<string, unknown>;
  usage: Usage;
  model: string;
  provider: string;
}

export function createFailureMessage(
  model: ModelInfo,
  error: unknown,
  aborted: boolean
): AssistantMessage {
  const payload = toErrorPayload(error);
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    provider: model.provider,
    model: model.id,
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: payload.message,
    errorCode: payload.code,
    errorDetails: payload.details,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    timestamp: Date.now(),
  };
}
```

### 2.2 工具执行三层包装

**文件：** `packages/agent-runtime/src/tools/execution-wrapper.ts`

借鉴 Pi 的 `prepareToolCall` / `executePreparedToolCall` / `finalizeExecutedToolCall` 三层模式。

```typescript
export type ToolCallPhase = 'prepare' | 'execute' | 'finalize';

export interface ToolExecutionResult {
  content: Array<TextContent | ImageContent>;
  isError: boolean;
  errorCode?: CrishErrorCode;
}

export async function executeToolSafely(
  tool: AgentTool,
  input: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<CrishResult<ToolExecutionResult, CrishError>> {
  // 阶段 1: prepare - 参数验证与权限检查
  const prepareResult = await prepareToolCall(tool, input, context);
  if (!prepareResult.ok) return prepareResult;

  // 阶段 2: execute - 真实执行
  const executeResult = await executePreparedToolCall(
    tool,
    prepareResult.value,
    context
  );
  if (!executeResult.ok) {
    if (
      executeResult.error.code === 'tool.execution_failed' &&
      isRetryableToolError(executeResult.error)
    ) {
      return executeResult; // 交由上层重试逻辑
    }
    return executeResult;
  }

  // 阶段 3: finalize - 输出后处理
  return finalizeExecutedToolCall(tool, executeResult.value, context);
}

async function prepareToolCall(
  tool: AgentTool,
  input: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<CrishResult<PreparedToolCall, CrishError>> {
  const validation = validateToolInput(tool, input);
  if (!validation.ok)
    return err(
      new CrishError(ErrorCodes.RUNTIME_INVALID_ARGUMENT, validation.error)
    );

  const permission = await context.permissionChecker.check(tool, input);
  if (!permission.allowed)
    return err(
      new CrishError(
        ErrorCodes.TOOL_PERMISSION_DENIED,
        permission.reason ?? '权限被拒绝'
      )
    );

  return ok({ tool, input: validation.value, context });
}

async function executePreparedToolCall(
  tool: AgentTool,
  prepared: PreparedToolCall,
  context: ToolExecutionContext
): Promise<CrishResult<RawToolOutput, CrishError>> {
  try {
    const output = await tool.execute(prepared.input, context.signal);
    return ok(output);
  } catch (error) {
    const crishError = normalizeCrishError(
      error,
      ErrorCodes.TOOL_EXECUTION_FAILED
    );
    return err(crishError);
  }
}

async function finalizeExecutedToolCall(
  tool: AgentTool,
  output: RawToolOutput,
  context: ToolExecutionContext
): Promise<CrishResult<ToolExecutionResult, CrishError>> {
  const budgetCheck = checkOutputBudget(output, context.outputBudget);
  if (!budgetCheck.ok) return err(budgetCheck.error);

  const formatted: ToolExecutionResult = {
    content: output.content,
    isError: output.isError,
    errorCode: output.errorCode,
  };
  return ok(formatted);
}
```

### 2.3 自动重试机制

**文件：** `packages/agent-runtime/src/recovery/retry.ts`

借鉴 Pi 的指数退避 + KimiCode 的 `isRetryableGenerateError`。

```typescript
export const DEFAULT_RETRY_BACKOFFS_MS = [1_000, 4_000, 16_000] as const;
export const DEFAULT_MAX_RETRIES = 3;

export interface RetryOptions {
  maxRetries?: number;
  backoffsMs?: readonly number[];
  signal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<CrishResult<T, CrishError>> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffsMs = options.backoffsMs ?? DEFAULT_RETRY_BACKOFFS_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      return ok(result);
    } catch (error) {
      if (attempt >= maxRetries || options.signal?.aborted) {
        return err(normalizeCrishError(error));
      }
      if (!isCrishRetryable(error)) {
        return err(normalizeCrishError(error));
      }

      const delayMs = backoffsMs[Math.min(attempt, backoffsMs.length - 1)];
      options.onRetry?.(attempt + 1, delayMs, error);

      await sleep(delayMs, options.signal);
    }
  }

  return err(new CrishError(ErrorCodes.INTERNAL, 'Unreachable'));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(new CrishError(ErrorCodes.CANCELLED, '重试已取消'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CrishError(ErrorCodes.CANCELLED, '重试已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
```

### 2.4 上下文溢出恢复

**文件：** `packages/agent-runtime/src/recovery/context-overflow.ts`

借鉴 Pi 的 context overflow recovery。

```typescript
export async function handleContextOverflow(
  agent: Agent,
  sessionManager: SessionManager,
  options: ContextOverflowOptions
): Promise<CrishResult<CompactionResult, CrishError>> {
  const branchEntries = await sessionManager.getBranch();
  const preparation = prepareCompaction(
    branchEntries,
    options.compactionSettings
  );
  if (!preparation.ok) return preparation;

  const compactResult = await compact(
    preparation.value,
    options.model,
    options.apiKey,
    options.headers,
    options.customInstructions
  );

  if (!compactResult.ok) return compactResult;

  const entryId = await sessionManager.appendCompaction(
    compactResult.value.summary,
    compactResult.value.firstKeptEntryId,
    compactResult.value.tokensBefore
  );

  return ok(compactResult.value);
}
```

### 2.5 Emitter 安全网

**文件：** `packages/shared-types/src/errors/unexpectedError.ts`

借鉴 KimiCode 的 `onUnexpectedError` / `safelyCallListener`。

```typescript
export type UnexpectedErrorHandler = (err: unknown) => void;

let currentHandler: UnexpectedErrorHandler = (err) => {
  console.error('[crish:unexpected]', err);
};

export function setUnexpectedErrorHandler(
  handler: UnexpectedErrorHandler
): void {
  currentHandler = handler;
}

export function onUnexpectedError(err: unknown): void {
  try {
    currentHandler(err);
  } catch (handlerErr) {
    console.error(
      '[crish:unexpected] handler threw',
      handlerErr,
      'while reporting',
      err
    );
  }
}

export function safelyCallListener(listener: () => void): void {
  try {
    listener();
  } catch (err) {
    onUnexpectedError(err);
  }
}
```

---

## 3. 日志系统（TypeScript 端）

### 3.1 结构定义

**文件：** `packages/shared-types/src/logging/types.ts`

```typescript
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  module?: string;
  context?: Record<string, unknown>;
  error?: CrishErrorPayload;
  span_id?: string;
  trace_id?: string;
}

export interface Span {
  name: string;
  id: string;
  traceId: string;
  parentId?: string;
  startTime: bigint;
  endTime?: bigint;
}

export interface ILogger {
  trace(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(
    message: string,
    error?: unknown,
    context?: Record<string, unknown>
  ): void;
  fatal(
    message: string,
    error?: unknown,
    context?: Record<string, unknown>
  ): void;

  child(module: string): ILogger;
  withContext(context: Record<string, unknown>): ILogger;
  flush(): Promise<void>;
}
```

### 3.2 日志实现

**文件：** `packages/agent-daemon/src/observability/logger.ts`

借鉴 Codex 的 tracing 风格和 KimiCode 的 `ILogService` 设计。

```typescript
export class CrishLogger implements ILogger {
  private readonly sinks: Sink[];
  private readonly module: string;
  private readonly baseContext: Record<string, unknown>;
  private readonly spanStack: Span[];

  constructor(options: LoggerOptions) {
    this.sinks = options.sinks;
    this.module = options.module ?? 'root';
    this.baseContext = options.context ?? {};
    this.spanStack = [];
  }

  child(module: string): ILogger {
    return new CrishLogger({
      sinks: this.sinks,
      module: `${this.module}.${module}`,
      context: { ...this.baseContext },
    });
  }

  withContext(context: Record<string, unknown>): ILogger {
    return new CrishLogger({
      sinks: this.sinks,
      module: this.module,
      context: { ...this.baseContext, ...context },
    });
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.emit('info', message, undefined, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.emit('warn', message, undefined, context);
  }

  error(
    message: string,
    error?: unknown,
    context?: Record<string, unknown>
  ): void {
    const errorPayload =
      error !== undefined ? toErrorPayload(error) : undefined;
    this.emit('error', message, errorPayload, context);
  }

  // 其他级别类似 ...

  private emit(
    level: LogLevel,
    message: string,
    error?: CrishErrorPayload,
    context?: Record<string, unknown>
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      module: this.module,
      context: { ...this.baseContext, ...context },
      error,
      span_id: this.spanStack[this.spanStack.length - 1]?.id,
      trace_id: this.spanStack[this.spanStack.length - 1]?.traceId,
    };
    for (const sink of this.sinks) {
      sink.enqueue(entry);
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.flush()));
  }

  async close(): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.close()));
  }
}
```

### 3.3 轮转文件输出

**文件：** `packages/agent-daemon/src/observability/sinks.ts`

借鉴 KimiCode 的 `RotatingFileSink`。

```typescript
export interface Sink {
  enqueue(entry: LogEntry): void;
  flush(): Promise<boolean>;
  close(): Promise<void>;
  flushSync(): void;
}

export interface RotatingFileSinkOptions {
  readonly path: string;
  readonly maxBytes: number;
  readonly files: number;
  readonly formatter: LogFormatter;
}

export class RotatingFileSink implements Sink {
  private readonly queue: AsyncSerialQueue;
  private pending: string[] = [];
  private dropped = 0;
  private closed = false;
  private currentBytes = -1;
  private directorySynced = false;

  constructor(private readonly options: RotatingFileSinkOptions) {
    this.queue = new AsyncSerialQueue();
  }

  enqueue(entry: LogEntry): void {
    if (this.closed) return;
    if (this.pending.length >= PENDING_MAX) {
      this.pending.shift();
      this.dropped++;
    }
    const line = this.options.formatter.format(entry);
    this.pending.push(line + '\n');
    this.scheduleDrain();
  }

  async flush(): Promise<boolean> {
    return this.queue.run(() => this.drain());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
  }

  flushSync(): void {
    if (this.closed || this.pending.length === 0) return;
    try {
      mkdirSync(dirname(this.options.path), { recursive: true });
      const body = this.pending.join('') + this.takeDroppedNotice();
      this.pending = [];
      appendFileSync(this.options.path, body);
    } catch (error) {
      this.noteFailure(error);
    }
  }

  private async drain(): Promise<boolean> {
    // 实现细节同 KimiCode RotatingFileSink.drain()
    // 包括 rotate()、appendLines()、statSize() 等
  }

  private async rotate(): Promise<void> {
    const { path, files } = this.options;
    for (let i = files - 2; i >= 1; i--) {
      const from = `${path}.${i}`;
      const to = `${path}.${i + 1}`;
      try {
        await rename(from, to);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    try {
      await rename(path, `${path}.1`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    try {
      await unlink(`${path}.${files}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    this.currentBytes = 0;
    this.directorySynced = false;
  }
}
```

### 3.4 敏感信息消毒

**文件：** `packages/agent-daemon/src/observability/redact.ts`

借鉴 KimiCode 的 `redact()`。

```typescript
const REDACT_KEYS = new Set([
  'apiKey',
  'api_key',
  'apikey',
  'accessToken',
  'access_token',
  'secret',
  'password',
  'token',
  'Authorization',
  'authorization',
  'cookie',
  'Cookie',
]);

const REDACT_PATTERNS = [
  /(api[-_]?key|secret|token|password)=[^&\s]+/gi,
  /(Bearer\s+)[\w-]+\.[\w-]+\.[\w-]+/g,
];

export function redact(value: string): string {
  let result = value;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, (match, prefix) => `${prefix}***`);
  }
  return result;
}

export function redactContext(
  context: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (REDACT_KEYS.has(key)) {
      result[key] = '***';
    } else if (typeof value === 'string') {
      result[key] = redact(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
```

### 3.5 格式化器

**文件：** `packages/agent-daemon/src/observability/formatter.ts`

```typescript
export interface LogFormatter {
  format(entry: LogEntry): string;
}

export class JsonLogFormatter implements LogFormatter {
  format(entry: LogEntry): string {
    return JSON.stringify({
      ...entry,
      context: entry.context ? redactContext(entry.context) : undefined,
    });
  }
}

export class AnsiLogFormatter implements LogFormatter {
  format(entry: LogEntry): string {
    const timestamp = new Date(entry.timestamp).toLocaleTimeString();
    const levelTag = LEVEL_TAGS[entry.level] ?? entry.level;
    const moduleTag = entry.module ? ` [${entry.module}]` : '';
    const errorTag = entry.error ? ` error=${entry.error.code}` : '';
    return `${timestamp} ${levelTag}${moduleTag} ${entry.message}${errorTag}`;
  }
}

const LEVEL_TAGS: Record<string, string> = {
  trace: '\x1b[90mTRACE\x1b[0m',
  debug: '\x1b[36mDEBUG\x1b[0m',
  info: '\x1b[32mINFO\x1b[0m',
  warn: '\x1b[33mWARN\x1b[0m',
  error: '\x1b[31mERROR\x1b[0m',
  fatal: '\x1b[41;37mFATAL\x1b[0m',
};
```

### 3.6 日志初始化

**文件：** `packages/agent-daemon/src/observability/init.ts`

```typescript
export function initLogging(options: LoggingInitOptions): CrishLogger {
  const sinks: Sink[] = [];

  if (options.filePath) {
    mkdirSync(dirname(options.filePath), { recursive: true });
    sinks.push(
      new RotatingFileSink({
        path: options.filePath,
        maxBytes: options.maxBytes ?? 10 * 1024 * 1024,
        files: options.files ?? 5,
        formatter: new JsonLogFormatter(),
      })
    );
  }

  if (options.enableAnsi) {
    sinks.push(
      new AnsiConsoleSink({
        formatter: new AnsiLogFormatter(),
        level: options.consoleLevel ?? 'info',
      })
    );
  }

  return new CrishLogger({
    sinks,
    module: 'crish',
    context: { version: options.version, pid: process.pid },
  });
}
```

---

## 4. Telemetry/可观测性（TypeScript 端）

### 4.1 自定义 Telemetry 设计

**文件：** `packages/agent-daemon/src/observability/telemetry/types.ts`

借鉴 KimiCode 的 `TelemetryClient` 生命周期：`track()` + `flush()` + `shutdown()`。

```typescript
export type TelemetryPrimitive = boolean | number | string | undefined | null;
export type TelemetryProperties = Record<string, TelemetryPrimitive>;

export interface TelemetryEvent {
  readonly event_id: string;
  readonly device_id: string | null;
  readonly session_id: string | null;
  readonly event: string;
  readonly timestamp: number;
  readonly properties: TelemetryProperties;
}

export interface TelemetryTransport {
  send(events: readonly TelemetryEvent[], signal?: AbortSignal): Promise<void>;
  saveToDisk(events: readonly TelemetryEvent[]): void;
  retryDiskEvents(): Promise<void>;
}

export interface TelemetryShutdownOptions {
  readonly timeoutMs?: number;
}
```

### 4.2 Telemetry Client

**文件：** `packages/agent-daemon/src/observability/telemetry/client.ts`

```typescript
export class TelemetryClient {
  private sink: TelemetrySink | null = null;
  private deviceId: string | null = null;
  private sessionId: string | null = null;
  private disabled = false;

  setContext(input: {
    deviceId?: string | null;
    sessionId?: string | null;
  }): void {
    if (input.deviceId !== undefined) this.deviceId = input.deviceId;
    if (input.sessionId !== undefined) this.sessionId = input.sessionId;
  }

  attachSink(sink: TelemetrySink): void {
    if (this.sink) {
      this.sink.stopPeriodicFlush();
      this.sink.flushSync();
    }
    this.sink = sink;
  }

  track(event: string, properties: TelemetryProperties = {}): void {
    if (this.disabled) return;
    if (!this.sink) return;
    this.sink.accept({
      event_id: randomUUID().replaceAll('-', ''),
      device_id: this.deviceId,
      session_id: this.sessionId,
      event,
      timestamp: Date.now() / 1000,
      properties: sanitizeProperties(properties),
    });
  }

  async flush(signal?: AbortSignal): Promise<void> {
    await this.sink?.flush(signal);
  }

  flushSync(): void {
    this.sink?.flushSync();
  }

  async shutdown(options: TelemetryShutdownOptions = {}): Promise<void> {
    if (!this.sink) return;
    this.sink.stopPeriodicFlush();
    if (options.timeoutMs === undefined) {
      await this.sink.flush();
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    timer.unref?.();
    try {
      await this.sink.flush(controller.signal);
    } catch {
      this.sink.flushSync();
    } finally {
      clearTimeout(timer);
    }
  }
}
```

### 4.3 事件类型

**文件：** `packages/agent-daemon/src/observability/telemetry/events.ts`

借鉴 Codex 的 `log_event!` / `trace_event!` 概念和 KimiCode 的事件前缀。

```typescript
export const TELEMETRY_EVENTS = {
  APP_START: 'crish.app_start',
  APP_EXIT: 'crish.app_exit',

  SESSION_CREATED: 'crish.session.created',
  SESSION_DELETED: 'crish.session.deleted',

  TURN_STARTED: 'crish.turn.started',
  TURN_COMPLETED: 'crish.turn.completed',
  TURN_FAILED: 'crish.turn.failed',

  TOOL_EXECUTED: 'crish.tool.executed',
  TOOL_FAILED: 'crish.tool.failed',

  PROVIDER_REQUEST: 'crish.provider.request',
  PROVIDER_RESPONSE: 'crish.provider.response',
  PROVIDER_ERROR: 'crish.provider.error',

  COMPACTION_OCCURRED: 'crish.compaction.occurred',

  CRASH: 'crish.crash',
  SYSTEM_METRICS: 'crish.system_metrics',
} as const;
```

### 4.4 HTTP 传输

**文件：** `packages/agent-daemon/src/observability/telemetry/transport.ts`

借鉴 KimiCode 的 `AsyncTransport` 模式：fetch POST + 重试 [1s, 4s, 16s] + 401 匿名重试 + 磁盘回退。

```typescript
export const TELEMETRY_ENDPOINT = 'https://telemetry.crish.ai/v1/event';
export const RETRY_BACKOFFS_MS = [1_000, 4_000, 16_000] as const;
export const DISK_EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class TelemetryHttpTransport implements TelemetryTransport {
  constructor(private readonly options: AsyncTransportOptions) {}

  async send(
    events: readonly TelemetryEvent[],
    signal?: AbortSignal
  ): Promise<void> {
    if (events.length === 0) return;
    let savedToDisk = false;
    const saveToDisk = () => {
      if (!savedToDisk) {
        this.saveToDisk(events);
        savedToDisk = true;
      }
    };
    if (signal?.aborted) {
      saveToDisk();
      return;
    }

    let payload: TelemetryPayload;
    try {
      payload = buildPayload(events, this.options.deviceId);
    } catch {
      return;
    }

    try {
      for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
        try {
          await this.sendHttp(payload, signal);
          return;
        } catch (error) {
          if (signal?.aborted || isAbortError(error)) {
            saveToDisk();
            throw error;
          }
          if (!(error instanceof TransientTelemetryError)) break;
          const backoff = RETRY_BACKOFFS_MS[attempt];
          if (backoff === undefined) break;
          await this.sleep(backoff, signal);
        }
      }
    } catch {
      /* 忽略 — 磁盘回退已保存 */
    }
    saveToDisk();
  }

  private async sendHttp(
    payload: TelemetryPayload,
    signal?: AbortSignal
  ): Promise<void> {
    const token = this.options.getAccessToken
      ? await this.options.getAccessToken()
      : null;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await this.post(payload, headers, signal);
    if (response.status === 401 && headers['Authorization']) {
      delete headers['Authorization'];
      const retry = await this.post(payload, headers, signal);
      handleStatus(retry.status);
      return;
    }
    handleStatus(response.status);
  }

  saveToDisk(events: readonly TelemetryEvent[]): void {
    if (events.length === 0) return;
    const path = join(
      this.telemetryDir(),
      `failed_${randomBytes(6).toString('hex')}.jsonl`
    );
    const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(path, text, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  }

  async retryDiskEvents(): Promise<void> {
    // 扫描 telemetryDir() 下的 failed_*.jsonl 文件
    // 逐一重试发送，成功则删除，失败保留
  }

  private telemetryDir(): string {
    const path = join(this.options.homeDir, 'telemetry');
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }
}
```

### 4.5 系统指标收集

**文件：** `packages/agent-daemon/src/observability/telemetry/systemMetrics.ts`

借鉴 KimiCode 的 `SystemMetricsCollector`，每 5 分钟采集 RSS/CPU/内存。

```typescript
const DEFAULT_INTERVAL_MS = 300_000; // 5 分钟
const SYSTEM_METRICS_EVENT = 'crish.system_metrics';

export interface SystemMetricsCollectorOptions {
  readonly client: {
    track(event: string, properties?: TelemetryProperties): void;
  };
  readonly intervalMs?: number;
}

export class SystemMetricsCollector {
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private previousCpuUsage = process.cpuUsage();
  private previousHrtime = process.hrtime.bigint();
  private readonly processStartedAt = Math.floor(
    Date.now() / 1000 - process.uptime()
  );

  constructor(private readonly options: SystemMetricsCollectorOptions) {}

  start(): void {
    if (this.intervalTimer) return;
    this.intervalTimer = setInterval(
      () => this.sampleSafely(),
      this.options.intervalMs ?? DEFAULT_INTERVAL_MS
    );
    this.intervalTimer.unref?.();
  }

  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  private sampleSafely(): void {
    try {
      this.sample();
    } catch {
      this.stop();
    }
  }

  private sample(): void {
    const now = process.hrtime.bigint();
    const elapsedUs = Number(now - this.previousHrtime) / 1_000;
    const cpu = process.cpuUsage(this.previousCpuUsage);
    this.previousCpuUsage = process.cpuUsage();
    this.previousHrtime = now;

    const mem = process.memoryUsage();
    this.options.client.track(SYSTEM_METRICS_EVENT, {
      process_started_at: this.processStartedAt,
      process_uptime_ms: Math.round(process.uptime() * 1000),
      rss_bytes: mem.rss,
      heap_used_bytes: mem.heapUsed,
      heap_total_bytes: mem.heapTotal,
      cpu_user_us: cpu.user,
      cpu_system_us: cpu.system,
      cpu_elapsed_us: Math.round(elapsedUs),
      free_mem_bytes: freemem(),
      total_mem_bytes: totalmem(),
      cpu_count: cpus().length,
    });
  }
}
```

### 4.6 崩溃/恐慌处理

**文件：** `packages/agent-daemon/src/observability/telemetry/crash.ts`

借鉴 KimiCode 的 `installCrashHandlers()`：`uncaughtExceptionMonitor` + `unhandledRejection` + 去重 + 同步刷新。

```typescript
export type CrashPhase = 'startup' | 'runtime' | 'shutdown';

let phase: CrashPhase = 'startup';
let installed = false;
let installedUncaughtHandler:
  ((error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void) | null =
  null;
let installedRejectionHandler: ((reason: unknown) => void) | null = null;

export function setCrashPhase(nextPhase: CrashPhase): void {
  phase = nextPhase;
}

export function installCrashHandlers(client: {
  track(event: string, properties?: TelemetryProperties): void;
  flushSync(): void;
}): () => void {
  if (installed) return () => uninstallCrashHandlers();

  const recordedRejections = new Set<unknown>();
  const trackCrash = (errorType: string, source: string) => {
    try {
      client.track('crish.crash', {
        error_type: errorType,
        where: phase,
        source,
      });
      client.flushSync();
    } catch {
      /* 崩溃遥测绝不能掩盖原始异常 */
    }
  };

  installedUncaughtHandler = (error, origin) => {
    if (isAbortError(error)) return;
    if (recordedRejections.has(error)) return;
    trackCrash(crashErrorType(error), origin);
  };

  process.on('uncaughtExceptionMonitor', installedUncaughtHandler);

  installedRejectionHandler = (reason: unknown) => {
    const soleListener = process.listenerCount('unhandledRejection') === 1;
    if (!isAbortError(reason)) {
      trackCrash(crashErrorType(reason), 'unhandledRejection');
      recordedRejections.add(reason);
    }
    if (soleListener) throw reason;
  };

  process.on('unhandledRejection', installedRejectionHandler);
  installed = true;
  return () => uninstallCrashHandlers();
}

export function uninstallCrashHandlers(): void {
  if (!installed) return;
  if (installedUncaughtHandler)
    process.off('uncaughtExceptionMonitor', installedUncaughtHandler);
  if (installedRejectionHandler)
    process.off('unhandledRejection', installedRejectionHandler);
  installedUncaughtHandler = null;
  installedRejectionHandler = null;
  installed = false;
}

function crashErrorType(reason: unknown): string {
  if (reason instanceof Error) return reason.name || reason.constructor.name;
  return typeof reason;
}

function isAbortError(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    'name' in reason &&
    reason.name === 'AbortError'
  );
}
```

### 4.7 OpenTelemetry 集成（预留）

**文件：** `packages/agent-daemon/src/observability/otel/bridge.ts`

借鉴 Codex 的 `opentelemetry-otlp` 导出 + `tracing-opentelemetry` 层，为未来预留接口。

```typescript
// 占位 — 当 Crish 接入 OpenTelemetry  Collector 时激活
export interface OtelExporterOptions {
  endpoint: string;
  serviceName: string;
  serviceVersion: string;
}

export function createOtelTracingLayer(options: OtelExporterOptions) {
  // 计划使用 @opentelemetry/sdk-node
  // + @opentelemetry/exporter-trace-otlp-proto
  // + @opentelemetry/sdk-metrics
}

// 当前：no-op 实现确保模块可导入但不引入依赖
export class NoopOtelBridge {
  loggerLayer() {
    return null;
  }
  tracingLayer() {
    return null;
  }
  metricsLayer() {
    return null;
  }
}
```

---

## 5. Rust 侧错误处理

### 5.1 Thiserror 枚举

**文件：** `crates/conex-types/src/error.rs`（重写现有 CoreError）

借鉴 Codex 的 `CodexErr` + thiserror 枚举设计。

```rust
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub type Result<T> = std::result::Result<T, CrishError>;

#[derive(Debug, Clone, Serialize, Deserialize, Error)]
#[serde(tag = "kind", content = "detail")]
pub enum CrishError {
    #[error("Config error: {0}")]
    Config(String),

    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Agent not found: {0}")]
    AgentNotFound(String),

    #[error("Runtime error: {0}")]
    Runtime(String),

    #[error("Provider error: {0}")]
    Provider(String),

    #[error("Provider rate limit: retry after {0}ms")]
    ProviderRateLimit(u64),

    #[error("Context window overflow")]
    ContextOverflow,

    #[error("Tool execution failed: {0}")]
    ToolError(String),

    #[error("MCP error: {0}")]
    McpError(String),

    #[error("Storage error: {0}")]
    Storage(String),

    #[error("IO error: {0}")]
    Io(String),

    #[error("Serialization error: {0}")]
    Serde(String),

    #[error("Cancelled")]
    Cancelled,

    #[error("Internal error: {0}")]
    Internal(String),
}

impl CrishError {
    /// 等价于 CodexErr::is_retryable()
    pub fn is_retryable(&self) -> bool {
        match self {
            CrishError::ProviderRateLimit(_) => true,
            CrishError::Provider(_) => true,
            CrishError::Io(_) => true,
            CrishError::Serde(_) => false,
            CrishError::Config(_) => false,
            CrishError::SessionNotFound(_) => false,
            CrishError::AgentNotFound(_) => false,
            CrishError::Runtime(_) => false,
            CrishError::ContextOverflow => true,
            CrishError::ToolError(_) => true,
            CrishError::McpError(_) => true,
            CrishError::Storage(_) => true,
            CrishError::Cancelled => false,
            CrishError::Internal(_) => false,
        }
    }

    /// 转换为 TS 可消费的 error payload
    pub fn to_error_payload(&self) -> serde_json::Value {
        let kind = match self {
            CrishError::Config(_) => "config.invalid",
            CrishError::SessionNotFound(_) => "session.not_found",
            CrishError::AgentNotFound(_) => "agent.not_found",
            CrishError::Runtime(_) => "runtime.invalid_state",
            CrishError::Provider(_) => "provider.api_error",
            CrishError::ProviderRateLimit(_) => "provider.rate_limit",
            CrishError::ContextOverflow => "context.overflow",
            CrishError::ToolError(_) => "tool.execution_failed",
            CrishError::McpError(_) => "mcp.server_not_found",
            CrishError::Storage(_) => "store.write_failed",
            CrishError::Io(_) => "internal",
            CrishError::Serde(_) => "internal",
            CrishError::Cancelled => "cancelled",
            CrishError::Internal(_) => "internal",
        };
        serde_json::json!({
            "code": kind,
            "message": self.to_string(),
            "retryable": self.is_retryable(),
        })
    }
}

impl From<std::io::Error> for CrishError {
    fn from(e: std::io::Error) -> Self {
        CrishError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for CrishError {
    fn from(e: serde_json::Error) -> Self {
        CrishError::Serde(e.to_string())
    }
}
```

### 5.2 Rust -> TS 跨语言错误传播

**文件：** `crates/conex-types/src/error.rs`（已有 `IpcResponse` 中的 `error` 字段）

```rust
// 在 IpcResponse 中使用序列化后的 CrishError：
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IpcResponse {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,  // CrishError::to_error_payload()
}

// Tauri 命令封装
pub fn tauri_error_to_crish(e: impl Into<CrishError>) -> String {
    serde_json::to_string(&e.into().to_error_payload())
        .unwrap_or_else(|_| r#"{"code":"internal","message":"serialization error"}"#.into())
}
```

### 5.3 Rust Panic Hook

**文件：** `crates/conex-types/src/panic.rs`

借鉴 Codex 的 `set_panic_hook()` + `catch_unwind`。

```rust
use std::panic;
use tracing::error;

/// 安装 panic hook，通过 tracing 记录后转发到默认 hook。
pub fn set_panic_hook() {
    let prev_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        error!("panic: {info}");
        prev_hook(info);
    }));
}

/// 安全执行闭包，panic 时返回 Err(CrishError::Internal(...))。
pub fn catch_unwind<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce() -> R + panic::UnwindSafe,
{
    match panic::catch_unwind(f) {
        Ok(result) => Ok(result),
        Err(e) => {
            let msg = if let Some(s) = e.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = e.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown panic".into()
            };
            error!("catch_unwind caught panic: {msg}");
            Err(msg)
        }
    }
}
```

### 5.4 Rust Tracing Subscriber 多层组合

**文件：** `crates/conex-observability/src/lib.rs`（新 crate）

借鉴 Codex 的 tracing subscriber 多层组合：file + otel + 崩溃处理层。

```rust
use tracing_subscriber::prelude::*;

pub struct ObservabilityConfig {
    pub log_dir: Option<PathBuf>,
    pub otel_endpoint: Option<String>,
    pub service_name: String,
    pub service_version: String,
    pub enable_ansi: bool,
}

pub fn init_observability(config: ObservabilityConfig) -> Result<ObservabilityGuard> {
    let mut layers: Vec<Box<dyn Layer<S> + Send + Sync + 'static>> = Vec::new();

    // 1. ANSI 终端输出层（开发友好）
    if config.enable_ansi {
        layers.push(Box::new(
            tracing_subscriber::fmt::layer()
                .with_ansi(true)
                .with_target(true)
                .with_filter(EnvFilter::from_default_env().unwrap_or_else(|_| {
                    EnvFilter::new("info")
                })),
        ));
    }

    // 2. 文件日志层（JSON 格式，无 ANSI）
    if let Some(log_dir) = &config.log_dir {
        let log_file = OpenOptions::new()
            .create(true).append(true)
            .open(log_dir.join("crish.log"))
            .map_err(|e| io::Error::other(e.to_string()))?;
        let (non_blocking, _guard) = tracing_appender::non_blocking(log_file);
        layers.push(Box::new(
            tracing_subscriber::fmt::layer()
                .with_writer(non_blocking)
                .with_target(true)
                .with_ansi(false)
                .json()
                .with_filter(EnvFilter::new("info")),
        ));
    }

    // 3. OpenTelemetry 层（预留）
    // if let Some(otel_endpoint) = &config.otel_endpoint { ... }

    // 4. 崩溃反馈层（参考 Codex feedback 的 ring buffer 模式）
    // let feedback = CrishFeedback::new();
    // layers.push(feedback.logger_layer());

    let subscriber = tracing_subscriber::registry()
        .with(layers);

    // 处理 try_init 可能失败的情况（重复初始化）
    let _ = subscriber.try_init();

    Ok(ObservabilityGuard {
        // _file_log_guard,
    })
}

pub struct ObservabilityGuard;

impl Drop for ObservabilityGuard {
    fn drop(&mut self) {
        opentelemetry::global::shutdown_tracer_provider();
    }
}
```

---

## 6. 错误展示策略

### 6.1 GUI 极简原则

前台只显示无技术细节的 toast/notification，详细日志在后台。

```typescript
// packages/agent-daemon/src/handlers/error-display.ts

export interface UserVisibleError {
  title: string;
  message: string;
  action?: string;
  code?: CrishErrorCode;
}

export function toUserVisibleError(error: unknown): UserVisibleError {
  const payload = toErrorPayload(error);
  const info = getErrorInfo(payload.code);

  if (!info.public) {
    return {
      title: '内部错误',
      message: '发生意外错误，详情请查看日志。',
      code: payload.code,
    };
  }

  return {
    title: info.title,
    message: payload.message,
    action: info.action,
    code: payload.code,
  };
}
```

### 6.2 ErrorLog 面板 / `/doctor` 命令

借鉴 Codex 的 `/doctor` 命令和 KimiCode 的日志视图。

```typescript
// packages/agent-daemon/src/handlers/doctor-report.ts

export interface DoctorReport {
  version: string;
  uptime: number;
  memory: { rss: number; heapUsed: number; heapTotal: number };
  errors: Array<{
    timestamp: string;
    code: CrishErrorCode;
    message: string;
    count: number;
  }>;
  sessions: { total: number; active: number };
  config: { providers: string[]; models: string[] };
}

export async function generateDoctorReport(
  logger: CrishLogger
): Promise<DoctorReport> {
  const mem = process.memoryUsage();
  return {
    version: pkgVersion,
    uptime: process.uptime(),
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    errors: await logger.getRecentErrors(50),
    sessions: {
      total: await sessionStore.count(),
      active: await sessionStore.countActive(),
    },
    config: {
      providers: configStore.getProviderIds(),
      models: configStore.getModelIds(),
    },
  };
}
```

### 6.3 错误分类：用户可见 vs 仅日志

```typescript
// CRISH_ERROR_INFO 中的 public 字段决定：
// public: true  → 显示 toast/notification
// public: false → 只写日志，后台收集
```

---

## 7. 实施文件结构

### 7.1 新文件清单

```
packages/shared-types/src/errors/
  classes.ts              # CrishError 基类
  codes.ts                # 分域错误码 (ErrorCodes 常量)
  info.ts                 # 错误元信息注册表 (CRISH_ERROR_INFO)
  result.ts               # CrishResult<T,E> ADT + ok/err/getOrThrow
  serialize.ts            # CrishErrorPayload + toErrorPayload + fromErrorPayload
  normalize.ts            # normalizeCrishError + toError
  retryable.ts            # isCrishRetryable + isRetryableGenerateError
  unexpectedError.ts      # onUnexpectedError + safelyCallListener + Emitter 安全网
  index.ts                # 重新导出所有公共 API

packages/agent-daemon/src/observability/
  init.ts                 # initLogging() 初始化
  logger.ts               # CrishLogger 实现
  sinks.ts                # RotatingFileSink + AnsiConsoleSink + Sink 接口
  formatter.ts            # JsonLogFormatter + AnsiLogFormatter
  redact.ts               # redact() + redactContext()
  index.ts                # 重新导出

packages/agent-daemon/src/observability/telemetry/
  types.ts                # TelemetryPrimitive/TelemetryEvent/TelemetryTransport
  client.ts               # TelemetryClient (track/flush/shutdown)
  events.ts               # TELEMETRY_EVENTS 常量
  transport.ts            # TelemetryHttpTransport (HTTP + 重试 + 磁盘回退)
  systemMetrics.ts        # SystemMetricsCollector (每 5 分钟)
  crash.ts                # installCrashHandlers (uncaughtExceptionMonitor)
  index.ts                # 重新导出

packages/agent-daemon/src/observability/otel/
  bridge.ts               # Otel 桥接 (预留)

packages/agent-runtime/src/recovery/
  retry.ts                # withRetry + 指数退避
  context-overflow.ts     # handleContextOverflow

packages/agent-runtime/src/tools/
  execution-wrapper.ts    # executeToolSafely (三层包装)

crates/conex-types/src/
  error.rs                # CrishError enum (替代现有 CoreError)
  panic.rs                # set_panic_hook + catch_unwind

crates/conex-observability/
  Cargo.toml
  src/lib.rs              # init_observability + 多层 subscriber
```

### 7.2 模块依赖关系

```
shared-types/errors/*          ← (无内部依赖，可首先迁移)
         ↓
agent-daemon/observability/*   ← 依赖 shared-types/errors 的类型
agent-runtime/recovery/*       ← 依赖 shared-types/errors 的类型
         ↓
agent-runtime/tools/*          ← 依赖 shared-types/errors + recovery
agent-runtime/src/*            ← 逐步替换现有 throw Error → CrishError
         ↓
crates/conex-types/error.rs    ← (Rust 侧，与 TS 侧独立演进)
crates/conex-observability/    ← 依赖 conex-types + tracing 生态
```

### 7.3 现有文件修改清单

```
packages/agent-runtime/src/provider-stream-contract/types.ts
  → 更新 AssistantMessage: 添加 errorCode/errorDetails 字段

packages/agent-runtime/src/index.ts
  → 重新导出新的错误处理 API

packages/agent-daemon/src/index.ts
  → 重新导出 observability 模块

packages/agent-daemon/src/daemon-logger.ts
  → 迁移到新的 observability/logger.ts，保留兼容层

packages/agent-runtime/src/error-classifier.ts
  → 迁移到 shared-types/errors 体系

packages/agent-runtime/src/provider-error-classifier.ts
  → 迁移到 shared-types/errors/serialize.ts 的 toErrorPayload

crates/conex-types/src/lib.rs
  → 扩展 CrishError（替代现有 CoreError）
```

---

## 8. 迁移步骤

### 阶段 1 — 核心类型层（无行为变化）

1. 创建 `packages/shared-types/src/errors/` 下所有文件
2. 实现 `CrishError` / `ErrorCodes` / `CRISH_ERROR_INFO` / `CrishResult` / `toErrorPayload` / `normalizeCrishError` / `isCrishRetryable`
3. 编写单元测试验证类型守卫和序列化/反序列化 roundtrip
4. **验证：** `npm run check` + 类型检查通过

### 阶段 2 — 日志系统

5. 创建 `packages/agent-daemon/src/observability/` 下的日志基础设施
6. 实现 `RotatingFileSink` / `CrishLogger` / `redact()` / 格式化器
7. 将现有的 `daemon-logger.ts` 瘦身适配为新 `ILogger` 接口
8. 替换所有 `console.log` / `console.error` 调用为 `logger.info` / `logger.error`
9. **验证：** 日志文件轮转、敏感信息消毒、ANSI 终端输出

### 阶段 3 — 错误处理模式

10. 实现 `packages/agent-runtime/src/recovery/retry.ts` 的 `withRetry`
11. 实现 `packages/agent-runtime/src/recovery/context-overflow.ts` 的 `handleContextOverflow`
12. 实现 `packages/agent-runtime/src/tools/execution-wrapper.ts` 的三层包装
13. 更新 `provider-stream-contract/types.ts` 的 `AssistantMessage` 流式错误编码
14. 替换现有 `throw Error` → `throw new CrishError(code, message)`
15. **验证：** 现有测试全部通过，重试逻辑在超时场景生效

### 阶段 4 — Telemetry

16. 创建 `packages/agent-daemon/src/observability/telemetry/` 下所有文件
17. 实现 `TelemetryClient` / `TelemetryHttpTransport` / `SystemMetricsCollector`
18. 实现 `installCrashHandlers` 并接入 `uncaughtExceptionMonitor`
19. **验证：** crash 事件被记录、遥测 HTTP 重试 + 磁盘回退工作

### 阶段 5 — Rust 侧

20. 重写 `crates/conex-types/src/error.rs` 为 `CrishError` 枚举
21. 迁移现有 `CoreError` 使用点到 `CrishError`
22. 实现 `crates/conex-types/src/panic.rs` 的 `set_panic_hook`
23. 创建 `crates/conex-observability/` 新 crate，组合 tracing 层
24. **验证：** `cargo test` 全部通过，Rust→TS 错误传播正确

### 阶段 6 — 展示层

25. 实现 `toUserVisibleError()` + `ErrorDisplayService`
26. 实现 `/doctor` 命令
27. 前台组件集成 toast/notification
28. **验证：** `public: false` 的错误不显示给用户

---

> 本方案整合了 Codex CLI 的 thiserror 枚举 + is_retryable() 分类、Pi 的 Result ADT + 流式错误编码 + 三层工具执行包装、Kimi Code 的 CrishError 基类 + 分域错误码 + telemetry 生命周期 + RotatingFileSink + 崩溃处理。每个模块都有明确的文件路径和迁移路径，可直接增量实施。
