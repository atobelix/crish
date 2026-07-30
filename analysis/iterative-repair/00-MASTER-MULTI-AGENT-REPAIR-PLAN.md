# Crish 系统性多 Agent 协同修复计划（主控文档）

> 本计划综合 Crish、Grok Build、Codex CLI、Pi (π)、Kimi Code 五个项目的架构分析，形成一套可复用、可迭代的多轮次修复方案。
> 每轮次最多部署 4 个 Agent，轮次间形成闭环迭代（上一轮输出 = 下一轮输入）。

---

## 目录

1. [问题空间总览](#1-问题空间总览)
2. [轮次编排逻辑](#2-轮次编排逻辑)
3. [Round 1: 基础设施重建](#3-round-1-基础设施重建)
4. [Round 2: 模块拆分与迁移](#4-round-2-模块拆分与迁移)
5. [Round 3: 插件系统实现](#5-round-3-插件系统实现)
6. [Round 4: 子代理调度实现](#6-round-4-子代理调度实现)
7. [Round 5: 跨系统集成与验证](#7-round-5-跨系统集成与验证)
8. [Round 6: 可观测性强化](#8-round-6-可观测性强化)
9. [Round 7: 文档与产品化就绪](#9-round-7-文档与产品化就绪)
10. [闭环迭代机制](#10-闭环迭代机制)
11. [Agent 职能规范](#11-agent-职能规范)
12. [质量门禁](#12-质量门禁)
13. [附录：完整文件清单](#13-附录完整文件清单)
14. [附录：关键接口索引](#14-附录关键接口索引)
15. [附录：引用方案摘要](#15-附录引用方案摘要)

---

## 1. 问题空间总览

### 1.1 已识别的问题域

```
问题域
├── D1: 错误处理薄弱
│   ├── D1.1 无统一错误基类（依赖 throw Error 运行时异常）
│   ├── D1.2 无分域错误码体系
│   ├── D1.3 无 Result ADT 类型
│   ├── D1.4 无跨进程序列化标准
│   ├── D1.5 无标准化错误转换函数
│   ├── D1.6 无可重试性分类
│   ├── D1.7 流式协议中错误编解码不完整
│   ├── D1.8 工具执行错误处理缺乏三层包装
│   ├── D1.9 无自动重试机制（指数退避）
│   ├── D1.10 无上下文溢出恢复
│   └── D1.11 无 Emitter 监听器安全网
│
├── D2: 可观测性缺失
│   ├── D2.1 无结构化日志框架
│   ├── D2.2 无轮转文件输出
│   ├── D2.3 无敏感信息消毒
│   ├── D2.4 无 Telemetry 事件系统
│   ├── D2.5 无崩溃/恐慌处理（uncaughtException）
│   ├── D2.6 无系统指标收集
│   ├── D2.7 无 OpenTelemetry 集成
│   ├── D2.8 无磁盘回退机制
│   └── D2.9 Rust 侧 tracing subscriber 未多层组合
│
├── D3: 模块单体过重
│   ├── D3.1 agent-runtime 含 195 文件，无分层边界
│   ├── D3.2 agent-orchestrator 职责过宽
│   ├── D3.3 agent-daemon 混合 server/handler/store
│   ├── D3.4 shared-types 类型膨胀
│   └── D3.5 跨包类型重复（TS+Rust 手动同步）
│
├── D4: 插件 SDK 极简
│   ├── D4.1 仅 4 个钩子事件
│   ├── D4.2 无多源发现
│   ├── D4.3 无工具注册 API
│   ├── D4.4 无 MCP 集成声明
│   ├── D4.5 无权限/信任模型
│   ├── D4.6 无插件生命周期管理
│   └── D4.7 无技能系统
│
└── D5: 子代理调度初步
    ├── D5.1 无 SubagentDefinition 标准
    ├── D5.2 无 Persona/Role 框架
    ├── D5.3 无调度队列
    ├── D5.4 无死锁检测
    ├── D5.5 无看门狗
    ├── D5.6 无子代理间通信
    └── D5.7 无资源预算控制
```

### 1.2 依赖关系图（问题间的前置依赖）

```
问题间前置依赖（A → B 表示 A 必须在 B 之前解决）

创建类型系统（D1.1-1.6） → 实现错误处理模式（D1.7-1.11）
                           → 实现日志系统（D2.1-2.4）
                           → 实现 telemetry（D2.4-2.8）

创建类型系统（D1.1-1.6） → 插件 SDK 类型（D4.1）
                           → MCP 类型（D4.4）

模块拆分（D3.1-3.4）     → 插件系统模块化（D4.x）
                           → 子代理模块化（D5.x）
                           → 可观测性模块化（D2.x）

插件 SDK（D4.x）         → 子代理发现（D5.1）
                           → 子代理钩子集成（D5.x）

错误处理（D1.x）         → 子代理错误传播（D5.x）
                           → 插件错误处理（D4.x）

Rust sidecar 重构        → agent-daemon 拆分
                           → telemetry Rust 端
```

### 1.3 修复逻辑链

```
Round 1 [基础设施]    创建错误类型 + 日志 + telemetry + Rust 基础
    └─→ 产出: packages/shared-types/src/errors/、packages/telemetry/

Round 2 [模块拆分]    拆分 agent-runtime → 9 个包 + orchestrator/daemon 拆分
    └─→ 产出: @crish/agent-core、agent-tools、agent-stream、agent-context...
    └─→ 前提: Round 1 的类型系统

Round 3 [插件系统]    插件 SDK + 钩子系统 + MCP 集成 + 技能系统
    └─→ 产出: @crish/plugin-sdk、plugin-hooks、plugin-mcp、plugin-skills
    └─→ 前提: Round 2 的模块结构

Round 4 [子代理调度]   子代理定义 + 调度 + 通信 + 执行引擎
    └─→ 产出: @crish/agent-subagent
    └─→ 前提: Round 2 的模块结构 + Round 3 的插件系统

Round 5 [跨系统集成]   错误处理↔插件、错误处理↔子代理、插件↔子代理
    └─→ 前提: Round 1-4

Round 6 [可观测性强化]  完善监控 + 告警 + dashboard
    └─→ 前提: Round 1 的基础 telemetry

Round 7 [文档/产品化]  用户文档 + API 文档 + 发布流程
    └─→ 前提: Round 1-6
```

---

## 2. 轮次编排逻辑

### 2.1 轮次结构模板

每一轮遵循相同的五阶段模式：

```
┌─────────────────────────────────────────────────────────────┐
│  [Phase 1] 问题识别（Agent 0: 诊断 Agent）                    │
│  输入: 上一轮产出 + 当前轮次的问题域                          │
│  动作: 读取源码、检查测试失败、分析 lint 输出                 │
│  输出: 当前轮次需要修复的具体问题清单（带文件路径+行号）       │
├─────────────────────────────────────────────────────────────┤
│  [Phase 2] 任务分解（由 MASTER 计划控制）                    │
│  输入: Phase 1 的问题清单                                    │
│  动作: 拆分为 1-4 个独立任务，保证无交叉文件依赖              │
│  输出: 每个 Agent 的精确 prompt（含文件和接口规范）            │
├─────────────────────────────────────────────────────────────┤
│  [Phase 3] 并行修复（Agent 1-4: 执行 Agent）                 │
│  每个 Agent 独立负责一个任务包                                │
│  约束: 每个 Agent 最多修改 10 个文件 / 800 行 diff           │
│  约束: Agent 间不得修改同一文件（除非显式声明在边界接口）      │
│  输出: 每个 Agent 的代码变更 + 测试                           │
├─────────────────────────────────────────────────────────────┤
│  [Phase 4] 结果聚合（Agent 0: 集成 Agent）                   │
│  输入: Phase 3 的 1-4 份产出                                │
│  动作: 合并变更、运行完整 typecheck/lint/test                │
│  输出: 集成后的代码库 + 测试报告                             │
├─────────────────────────────────────────────────────────────┤
│  [Phase 5] 验证（Agent 0: 验证 Agent）                       │
│  输入: Phase 4 的集成结果                                    │
│  动作: 运行完整 CI 流水线、检查回归                           │
│  输出: 验证报告 + 通过/不通过 + 下一轮输入规范                │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 轮次间数据契约

```
Round N 输出格式:
{
  "round": N,
  "newFiles": ["path/to/new/file1.ts", ...],
  "modifiedFiles": ["path/to/modified/file1.ts", ...],
  "deprecatedFiles": ["path/to/deprecated/file1.ts", ...],
  "addedPackages": ["@crish/agent-core", ...],
  "removedPackages": [],
  "publicApiChanges": [
    { "file": "path/to/file.ts", "export": "functionName", "newSignature": "(x: T) => U" }
  ],
  "testResults": { "passed": 120, "failed": 0, "coverage": 72 },
  "typeCheckErrors": 0,
  "lintErrors": 0,
  "nextRoundInputs": [
    "agent-runtime 的 tools/ 目录已经空，现在可以被 agent-tools 完全取代",
    "shared-types 新增了 errors/ 子目录"
  ]
}
```

---

## 3. Round 1: 基础设施重建

### 3.1 问题域覆盖

D1.1-D1.11 + D2.1-D2.9（错误处理类型系统 + 日志框架基础 + Telemetry 基础 + Rust 侧错误基础）

### 3.2 前置依赖

无（Round 1 是基础设施，从零开始）

### 3.3 Agent 分配

```
Round 1 分配 4 个 Agent（满额）:
├── Agent 1.1: 错误类型系统（TS 端）
│   覆盖: D1.1-D1.6
│   文件范围: packages/shared-types/src/errors/ 目录
│   产出: ~18 个新文件
│
├── Agent 1.2: 错误处理模式（TS 端）
│   覆盖: D1.7-D1.11
│   文件范围: packages/shared-utils/src/error-handling/ 目录
│   产出: ~12 个新文件
│   依赖: Agent 1.1 的类型定义（只读引用，不修改）
│
├── Agent 1.3: 日志 + Telemetry 基础
│   覆盖: D2.1-D2.8
│   文件范围: packages/telemetry/ 新包
│   产出: ~15 个新文件
│   依赖: Agent 1.1 的错误类型（CrishError 序列化）
│
└── Agent 1.4: Rust 侧错误处理基础
    覆盖: D1 Rust 端 + D2.9
    文件范围: crates/conex-types/src/error.rs + crates/conex-telemetry/ 新 crate
    产出: ~8 个新文件
```

### 3.4 Agent 1.1 详细任务：错误类型系统（TS 端）

#### 3.4.1 要创建的文件

```
packages/shared-types/src/errors/
  index.ts                       # 导出所有错误类型
  classes.ts                     # CrishError 基类
  codes.ts                       # 分域错误码（6 域 ~50 个码）
  result.ts                      # CrishResult<T,E> ADT
  payload.ts                     # CrishErrorPayload 接口 + toErrorPayload()
  normalize.ts                   # normalizeCrishError() 标准化函数
  classify.ts                    # isRetryable() + classifyError() 分类
  retryable.ts                   # RetryableErrorInfo 接口
  codes.test.ts                  # 错误码测试
  result.test.ts                 # Result ADT 测试
  serialize.test.ts              # 序列化/反序列化 roundtrip 测试
```

#### 3.4.2 关键接口定义

**CrishError**（参考 KimiCode 的 KimiError + Codex 的 CodexErr）：

```typescript
// classes.ts
export interface CrishErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
  readonly retryable?: boolean;
  readonly public?: boolean; // 控制用户可见性
  readonly action?: string; // 面向用户的建议操作
}

export class CrishError extends Error {
  readonly code: CrishErrorCode;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action?: string;

  constructor(
    code: CrishErrorCode,
    message: string,
    options?: CrishErrorOptions
  );
  toPayload(): CrishErrorPayload;
  static fromPayload(payload: CrishErrorPayload): CrishError;
  static isCrishError(err: unknown): err is CrishError;
  static ensure(err: unknown, fallbackCode?: CrishErrorCode): CrishError;
}
```

**CrishResult**（参考 Pi 的 Result<T,E> ADT）：

```typescript
// result.ts
export type CrishResult<TValue, TError = CrishError> =
  { ok: true; value: TValue } | { ok: false; error: TError };

export function ok<TValue, TError>(value: TValue): CrishResult<TValue, TError>;
export function err<TValue, TError>(error: TError): CrishResult<TValue, TError>;
export function unwrap<TValue, TError>(
  result: CrishResult<TValue, TError>
): TValue;
export function unwrapOr<TValue, TError>(
  result: CrishResult<TValue, TError>,
  fallback: TValue
): TValue;
export function map<TValue, TNew, TError>(
  result: CrishResult<TValue, TError>,
  fn: (value: TValue) => TNew
): CrishResult<TNew, TError>;
export function flatMap<TValue, TNew, TError>(
  result: CrishResult<TValue, TError>,
  fn: (value: TValue) => CrishResult<TNew, TError>
): CrishResult<TNew, TError>;
export function match<TValue, TError, TOut>(
  result: CrishResult<TValue, TError>,
  matchers: { ok: (value: TValue) => TOut; err: (error: TError) => TOut }
): TOut;
export function toPromise<TValue, TError>(
  result: CrishResult<TValue, TError>
): Promise<TValue>;
export function fromPromise<TValue, TError = CrishError>(
  promise: Promise<TValue>,
  errorMapper?: (err: unknown) => TError
): Promise<CrishResult<TValue, TError>>;
```

**CrishErrorPayload**（参考 KimiCode 的 KimiErrorPayload）：

```typescript
// payload.ts
export interface CrishErrorPayload {
  readonly code: CrishErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action?: string;
  readonly stack?: string;
  readonly cause?: CrishErrorPayload; // 递归 cause 链（最多 8 层）
}

export function toErrorPayload(error: unknown): CrishErrorPayload;
export function fromErrorPayload(payload: CrishErrorPayload): CrishError;
```

**ErrorCodes**（参考 KimiCode 的 domain.reason 格式，~50 个码）：

```typescript
// codes.ts — 部分示例
export type CrishErrorCode =
  | 'config.invalid'
  | 'config.provider_not_found'
  | 'config.model_not_found'
  | 'session.not_found'
  | 'session.already_exists'
  | 'session.closed'
  | 'session.fork_active_turn'
  | 'agent.not_found'
  | 'agent.busy'
  | 'agent.internal_died'
  | 'runtime.init_failed'
  | 'runtime.invalid_state'
  | 'runtime.timeout'
  | 'provider.api_error'
  | 'provider.rate_limit'
  | 'provider.auth_error'
  | 'provider.connection_error'
  | 'provider.filtered'
  | 'provider.stream_failed'
  | 'provider.server_overloaded'
  | 'provider.quota_exceeded'
  | 'context.overflow'
  | 'context.compress_failed'
  | 'tool.not_found'
  | 'tool.execution_failed'
  | 'tool.validation_failed'
  | 'tool.permission_denied'
  | 'mcp.server_not_found'
  | 'mcp.startup_failed'
  | 'mcp.connection_lost'
  | 'subagent.not_found'
  | 'subagent.max_depth'
  | 'subagent.timeout'
  | 'plugin.not_found'
  | 'plugin.load_failed'
  | 'plugin.permission_denied'
  | 'internal'
  | 'not_implemented'
  | 'network.timeout'
  | 'network.dns_failed'
  | 'network.connection_refused'
  | 'storage.write_failed'
  | 'storage.read_failed';

export const ErrorCodeMeta: Record<
  CrishErrorCode,
  {
    title: string;
    retryable: boolean;
    public: boolean;
    action?: string;
  }
> = {/* 每个码的元信息 */};
```

#### 3.4.3 验证标准

- [ ] `new CrishError('provider.rate_limit', 'Rate limited')` 创建正确实例
- [ ] `CrishError.ensure(unknownError)` 正确标准化任意输入
- [ ] `toErrorPayload(error)` → `fromErrorPayload(payload)` roundtrip 保持所有字段
- [ ] `CrishResult.ok(value)` 和 `CrishResult.err(error)` 类型安全
- [ ] `fromPromise(Promise.reject(...))` 正确捕获错误
- [ ] `match()` 穷举检查（TypeScript exhaustiveness）
- [ ] 所有 50+ 错误码有对应的 CrishErrorCodeMeta 条目
- [ ] 类型测试通过（tsc --noEmit）

### 3.5 Agent 1.2 详细任务：错误处理模式（TS 端）

#### 3.5.1 要创建的文件

```
packages/shared-utils/src/error-handling/
  index.ts                       # 导出所有函数
  stream-error.ts                # 流式错误编码（stopReason: 'error'）
  tool-error.ts                  # 三层工具执行包装
  retry.ts                       # withRetry() 指数退避重试
  context-overflow.ts            # 上下文溢出恢复
  emitter-guard.ts               # safelyCallListener() Emitter 安全网
  timeout.ts                     # withTimeout() 超时包装
  abort.ts                       # combineAbortSignals() + AbortError
  retry.test.ts                  # 重试机制测试
  tool-error.test.ts             # 工具错误包装测试
  stream-error.test.ts           # 流式错误编码测试
```

#### 3.5.2 关键接口定义

**流式错误编码**（参考 Pi 的 StreamFn contract）：

```typescript
// stream-error.ts
export interface StreamErrorContract<TMessage> {
  /** 流中用于编码运行时故障的类型 */
  errorEvent: {
    type: 'error';
    reason: 'error' | 'aborted';
    message: string;
    diagnostics?: unknown;
  };
  /** 正常结束的事件类型 */
  doneEvent: { type: 'done'; reason: 'stop' | 'length' | 'toolUse' };
}

/**
 * 流函数合约：运行时故障通过协议事件编码，而非 throw。
 * 实现必须遵守这个合约。
 */
export type StreamFunction<TInput, TOutput> = (
  input: TInput,
  emit: (event: TOutput | StreamErrorEvent) => void,
  signal?: AbortSignal
) => Promise<void>;

export function createStreamErrorEvent(
  reason: 'error' | 'aborted',
  message: string,
  diagnostics?: unknown
): StreamErrorEvent;

export function isStreamErrorEvent(event: unknown): event is StreamErrorEvent;
```

**三层工具执行包装**（参考 Pi 的 agent-loop.ts 三层）：

```typescript
// tool-error.ts
export interface ToolExecutionPhase<TInput, TOutput> {
  /** 第 1 层：准备/验证。捕获验证失败，返回 ImmediateToolCallOutcome */
  prepare(input: TInput): CrishResult<PreparedToolCall>;
  /** 第 2 层：执行。用 try/catch 包裹 tool.execute()，异常 → isError:true */
  execute(prepared: PreparedToolCall): Promise<CrishResult<ToolResult>>;
  /** 第 3 层：完成。捕获 afterToolCall 回调中的错误 */
  finalize(result: ToolResult): Promise<CrishResult<ToolOutput>>;
}

export function createToolExecutionPipeline<TInput, TOutput>(
  phases: ToolExecutionPhase<TInput, TOutput>
): (input: TInput) => Promise<CrishResult<TOutput>>;
```

**重试机制**（参考 Pi 的指数退避 + KimiCode 的 isRetryableGenerateError）：

```typescript
// retry.ts
export interface RetryOptions {
  maxRetries?: number; // 默认 3
  baseDelayMs?: number; // 默认 2000
  maxDelayMs?: number; // 默认 60000
  jitter?: boolean; // 默认 true
  retryOn?: (error: CrishErrorPayload) => boolean; // 自定义可重试判断
  onRetry?: (
    attempt: number,
    error: CrishErrorPayload,
    delayMs: number
  ) => void;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options?: RetryOptions
): Promise<CrishResult<T>>;

export function isRetryableError(error: CrishErrorPayload): boolean;
export function isNonRetryableProviderLimitError(
  error: CrishErrorPayload
): boolean;
export function calculateRetryDelay(
  attempt: number,
  options: RetryOptions
): number;
```

**Emitter 安全网**（参考 KimiCode 的 onUnexpectedError + safelyCallListener）：

```typescript
// emitter-guard.ts
export type UnexpectedErrorHandler = (err: unknown) => void;
export function setUnexpectedErrorHandler(
  handler: UnexpectedErrorHandler
): void;
export function onUnexpectedError(err: unknown): void;
export function safelyCallListener(
  listener: () => void,
  context?: string
): void;
```

#### 3.5.3 验证标准

- [ ] withRetry() 在成功时直接返回，在可重试错误时重试 3 次
- [ ] withRetry() 在不可重试错误时立即返回不重试
- [ ] createToolExecutionPipeline 三层包装正确捕获各层错误
- [ ] safelyCallListener 不因监听器错误而中断调用链
- [ ] createStreamErrorEvent + isStreamErrorEvent 类型安全
- [ ] context-overflow 恢复逻辑正确处理

### 3.6 Agent 1.3 详细任务：日志 + Telemetry 基础

#### 3.6.1 要创建的文件

```
packages/telemetry/
  package.json                  # @crish/telemetry
  tsconfig.json
  src/
    index.ts                    # 导出所有公共 API
    bootstrap.ts                # initializeTelemetry() + disable check
    client.ts                   # TelemetryClient（队列 + 作用域 + 生命周期）
    crash.ts                    # installCrashHandlers()（uncaughtException + unhandledRejection）
    sink.ts                     # EventSink（批处理 + 刷新 + 上下文丰富）
    transport.ts                # AsyncTransport（HTTP POST + 重试 + 磁盘回退）
    systemMetrics.ts            # SystemMetricsCollector（CPU/内存/loadavg）
    types.ts                    # TelemetryEvent, TelemetryPrimitive 类型
    redact.ts                   # 敏感信息消毒（token/secret/key 正则替换）
    flush.ts                    # syncFlush + asyncFlush + shutdown

packages/logger/
  package.json                  # @crish/logger
  tsconfig.json
  src/
    index.ts                    # 导出所有公共 API
    types.ts                    # LogLevel, LogEntry, LoggingConfig, Logger
    logger.ts                   # RootLoggerImpl + LoggerImpl + log 单例
    sinks.ts                    # RotatingFileSink + ConsoleSink
    formatter.ts                # JSONFormatter + ANSIFormatter + 消毒 + 截断
    resolve-config.ts           # 日志配置解析（文件/环境变量）
    child.ts                    # createChild() 子日志器（上下文继承）
```

#### 3.6.2 关键接口定义

**TelemetryClient**（参考 KimiCode 的 TelemetryClient）：

```typescript
// client.ts
export class TelemetryClient {
  constructor(options?: {
    maxQueueSize?: number;
    appName?: string;
    version?: string;
  });

  setContext(context: TelemetryContext): void;
  attachSink(sink: EventSink): void;
  track(event: string, properties?: Record<string, unknown>): void;
  flush(): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;

  // 作用域支持
  withContext(context: Partial<TelemetryContext>): ScopedTelemetryClient;

  // 内部
  private sanitizeProperties(
    props: Record<string, unknown>
  ): Record<string, unknown>;
  private ensureInitialized(): void;
}

export interface TelemetryContext {
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly deviceId: string;
  readonly userId?: string;
}

export interface TelemetryEvent {
  readonly event_id: string;
  readonly name: string;
  readonly timestamp: number;
  readonly properties: Record<string, unknown>;
  readonly context: TelemetryContext;
}
```

**AsyncTransport**（参考 KimiCode 的 transport.ts）：

```typescript
// transport.ts
export interface TransportOptions {
  endpoint: string;
  apiKey?: string;
  maxRetries?: number; // 默认 3
  retryDelaysMs?: number[]; // 默认 [1000, 4000, 16000]
  timeoutMs?: number; // 默认 10000
  diskFallbackDir?: string; // 默认 ~/.crish/telemetry/
  diskFallbackMaxAgeDays?: number; // 默认 7
}

export class AsyncTransport {
  constructor(options: TransportOptions);
  send(events: TelemetryEvent[]): Promise<void>;
  retryDiskEvents(): Promise<void>;
  flushSync(): void;
  shutdown(): Promise<void>;
  private saveToDisk(events: TelemetryEvent[]): Promise<void>;
  private flattenEvent(event: TelemetryEvent): Record<string, unknown>;
}
```

**Crash Handler**（参考 KimiCode 的 crash.ts）：

```typescript
// crash.ts
export type CrashPhase = 'startup' | 'runtime' | 'shutdown';

export interface CrashHandlerOptions {
  client: TelemetryClient;
  flushSync: () => void;
  onCrash?: (error: unknown, phase: CrashPhase) => void;
}

export function installCrashHandlers(options: CrashHandlerOptions): void;
export function setCrashPhase(phase: CrashPhase): void;
export function isAbortError(error: unknown): boolean;
export function crashErrorType(error: unknown): string;
```

**Logger 核心**（参考 KimiCode 的 logging/logger.ts + Codex 的 tracing subscriber）：

```typescript
// types.ts (logger)
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface LogEntry {
  readonly timestamp: number;
  readonly level: LogLevel;
  readonly message: string;
  readonly logger?: string;
  readonly context?: Record<string, unknown>;
  readonly error?: { name: string; message: string; stack?: string };
}

export interface Logger {
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  trace(obj: unknown, msg?: string): void;
  createChild(bindings: Record<string, unknown>): Logger;
  flush(): Promise<void>;
}

// logger.ts
export const log: Logger; // 单例，延迟绑定到 RootLogger
export function configureLogger(config: LoggingConfig): void;
```

**RotatingFileSink**（参考 KimiCode 的 sinks.ts）：

```typescript
// sinks.ts
export interface RotatingFileSinkOptions {
  dir: string;
  filename: string;
  maxBytes: number; // 每文件最大字节数（默认 10MB）
  maxFiles: number; // 备份文件数（默认 5）
  level?: LogLevel; // 默认 'debug'
  format?: 'json' | 'text'; // 默认 'json'
}

export class RotatingFileSink {
  constructor(options: RotatingFileSinkOptions);
  write(entry: LogEntry): void;
  flushSync(): void;
  shutdown(): Promise<void>;
}

export class ConsoleSink {
  constructor(level?: LogLevel, format?: 'ansi' | 'json');
  write(entry: LogEntry): void;
}
```

#### 3.6.3 验证标准

- [ ] TelemetryClient.track() → EventSink → AsyncTransport.send() 通路完整
- [ ] HTTP 传输失败时正确回退到磁盘 JSONL
- [ ] 磁盘事件在下次启动时重试
- [ ] installCrashHandlers 捕获 uncaughtException 并同步刷新
- [ ] AbortError 被 crash handler 过滤（不触发遥测）
- [ ] RotatingFileSink 在达到 maxBytes 时轮转
- [ ] log.createChild({sessionId}) 正确继承上下文
- [ ] redact() 正确消毒 token/secret/authorization header
- [ ] JSONFormatter 输出符合结构日志标准

### 3.7 Agent 1.4 详细任务：Rust 侧错误处理基础

#### 3.7.1 要创建/修改的文件

```
crates/conex-types/src/
  error.rs                     # 新增：thiserror 枚举 CrishError
  error_payload.rs             # 新增：to_error_payload() 跨语言序列化
  result.rs                    # 新增：CrishResult<T> 类型别名
  lib.rs                       # 修改：导出新模块

crates/conex-telemetry/        # 新增 crate
  Cargo.toml
  src/
    lib.rs                     # tracing subscriber 多层组合
    provider.rs                # OtelProvider（参考 Codex）
    config.rs                  # OtelSettings + OtelExporter
    panic.rs                   # set_panic_hook() + catch_unwind
    metrics.rs                 # MetricsClient（可选）

Cargo.toml                     # 修改：添加 conex-telemetry workspace member

apps/agent-workbench/src-tauri/src/
  main.rs                      # 修改：注册 tracing subscriber
  panic.rs                     # 修改：set_panic_hook()
```

#### 3.7.2 关键 Rust 接口

```rust
// error.rs
use thiserror::Error;

#[derive(Error, Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum CrishError {
    #[error("{0}")]
    Runtime(String),
    #[error("{message}")]
    Provider { message: String, code: Option<String>, retryable: bool },
    #[error("session not found: {0}")]
    SessionNotFound(String),
    #[error("context overflow")]
    ContextOverflow,
    #[error("tool execution failed: {0}")]
    ToolExecution(String),
    #[error("MCP error: {0}")]
    Mcp(String),
    #[error("subagent error: {0}")]
    Subagent(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("internal: {0}")]
    Internal(String),
}

impl CrishError {
    pub fn is_retryable(&self) -> bool;
    pub fn to_error_payload(&self) -> ErrorPayload;
}

// error_payload.rs
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
    pub details: Option<serde_json::Value>,
    pub retryable: bool,
    pub public: bool,
    pub action: Option<String>,
    pub stack: Option<String>,
}

pub fn to_error_payload(err: &CrishError) -> ErrorPayload;
pub fn from_error_payload(payload: &ErrorPayload) -> CrishError;
```

```rust
// conex-telemetry/src/lib.rs
pub fn init_telemetry(config: TelemetryConfig) -> TelemetryGuard;

pub struct TelemetryGuard {
    logger_provider: Option<SdkLoggerProvider>,
    tracer_provider: Option<SdkTracerProvider>,
}

impl Drop for TelemetryGuard {
    fn drop(&mut self) {
        // 优雅关闭
    }
}

// conex-telemetry/src/panic.rs
pub fn set_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!("panic: {info}");
        prev(info);
    }));
}
```

#### 3.7.3 验证标准

- [ ] `cargo build -p conex-types` 通过
- [ ] `cargo build -p conex-telemetry` 通过
- [ ] `to_error_payload()` → `from_error_payload()` JSON roundtrip
- [ ] `CrishError::is_retryable()` 正确分类
- [ ] `set_panic_hook()` 正确注册
- [ ] tracing subscriber 组合正确

### 3.8 Round 1 产出检查清单

```
Round 1 验收条件:
□ 所有 TypeScript 类型通过 tsc --noEmit
□ 所有 Rust crate 通过 cargo check
□ 新建 ~45 个文件（errors/ 18 + error-handling/ 12 + telemetry/ 15）
□ CrishError 基类 + 50+ 错误码
□ CrishResult ADT + 工具函数（ok/err/unwrap/map/flatMap/match）
□ toErrorPayload / fromErrorPayload roundtrip 测试通过
□ withRetry 指数退避重试
□ createToolExecutionPipeline 三层包装
□ TelemetryClient track → send → disk fallback 通路完整
□ installCrashHandlers 捕获 uncaughtException + unhandledRejection
□ RotatingFileSink 轮转 + 消毒 + 截断
□ Rust thiserror 枚举 + to_error_payload + is_retryable
□ set_panic_hook + tracing subscriber 多层
□ 50% 测试覆盖率（新代码）
```

---

## 4. Round 2: 模块拆分与迁移

### 4.1 问题域覆盖

D3.1-D3.5（agent-runtime 195 文件单体 → 9 包 + orchestrator 拆分 + daemon 拆分）

### 4.2 前置依赖

- Round 1 的错误类型系统（新包将使用 CrishError 和 CrishResult）

### 4.3 Agent 分配

```
Round 2 分配 4 个 Agent（满额）:
├── Agent 2.1: agent-core + agent-tools + agent-stream 拆分
│   覆盖: D3.1 的核心部分
│   文件范围: agent-runtime → 3 个新包
│   产出: ~15 个新包文件
│
├── Agent 2.2: agent-context + agent-model + agent-permissions 拆分
│   覆盖: D3.1 的上层部分
│   文件范围: agent-runtime → 3 个新包
│   产出: ~15 个新包文件
│
├── Agent 2.3: agent-orchestrator + agent-daemon 拆分
│   覆盖: D3.2 + D3.3
│   文件范围: 现有 orchestrator 和 daemon 的拆分
│   产出: ~12 个新包文件
│
└── Agent 2.4: shared-types 整理 + 向后兼容层
    覆盖: D3.4 + D3.5
    文件范围: shared-types 重构 + 所有旧包的 shim re-export
    产出: ~10 个新文件
```

### 4.4 Agent 2.1 详细任务：agent-core + agent-tools + agent-stream

#### 4.4.1 目标包

```
@crish/agent-core                 Agent 循环、状态机、会话生命周期
@crish/agent-tools                工具定义、注册、执行、发现
@crish/agent-stream               流式传输、SSE 管理、stream parser
```

#### 4.4.2 agent-core 源文件映射

```
从 agent-runtime/src/ 映射到 agent-core/src/:
  runtime.ts                      → core/agent-runtime.ts
  runtime-defaults.ts             → core/runtime-defaults.ts
  runtime-metrics.ts              → core/runtime-metrics.ts
  agent-session-loop.ts           → session-loop/index.ts
  session-loop/                   → session-loop/ 子目录
  session/                        → session/ 子目录
  session-store/                  → session-store/ 子目录
  state-machine/                  → state-machine/ 子目录
  agent-input-queue.ts            → core/agent-input-queue.ts
  control/                        → control/ 子目录
  steering/                       → steering/ 子目录
  hooks/                          → hooks/ 子目录
  runtime-components/             → runtime-components/ 子目录
  checkpoints/                    → checkpoints/ 子目录
  event-architecture/             → event/ 子目录
  event-protocol/                 → event/protocol/ 子目录
  event-queue/                    → event/queue/ 子目录
  approval/                       → approval/ 子目录
```

#### 4.4.3 agent-tools 源文件映射

```
从 agent-runtime/src/ 映射到 agent-tools/src/:
  tools/                          → tools/ 子目录（完整）
  tool-registry.ts                → registry/tool-registry.ts
  tool-stream/                    → stream/ 子目录
  tool-discovery.ts               → discovery/tool-discovery.ts
  local-tools/                    → local-tools/ 子目录
  tools.ts                        → tool-execution.ts
```

#### 4.4.4 agent-stream 源文件映射

```
从 agent-runtime/src/ 映射到 agent-stream/src/:
  stream/                         → stream/ 子目录
  openai-stream-parse.ts          → parsers/openai.ts
  anthropic-stream-parse.ts       → parsers/anthropic.ts
  gemini-stream-parse.ts          → parsers/gemini.ts
```

#### 4.4.5 package.json 模板

```json
{
  "name": "@crish/agent-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@crish/shared-types": "file:../../packages/shared-types",
    "@crish/shared-utils": "file:../../packages/shared-utils"
  }
}
```

```json
{
  "name": "@crish/agent-tools",
  "version": "0.1.0",
  "dependencies": {
    "@crish/shared-types": "file:../../packages/shared-types"
  }
}
```

```json
{
  "name": "@crish/agent-stream",
  "version": "0.1.0",
  "dependencies": {
    "@crish/shared-types": "file:../../packages/shared-types"
  }
}
```

#### 4.4.6 验证标准

- [ ] agent-core 的 typecheck 通过（不依赖 agent-tools/agent-stream）
- [ ] agent-tools 只依赖 shared-types，不依赖 agent-runtime
- [ ] agent-stream 只依赖 shared-types，不依赖 agent-runtime
- [ ] 旧 agent-runtime 通过 shim re-export 继续工作
- [ ] 所有测试从旧路径迁移到新路径
- [ ] npm workspace 正确引用新包

### 4.5 Agent 2.2 详细任务：agent-context + agent-model + agent-permissions

#### 4.5.1 目标包

```
@crish/agent-context              上下文管理、压缩策略、token 估算
@crish/agent-model                模型路由、Provider 抽象
@crish/agent-permissions          权限控制、信任区域
```

#### 4.5.2 agent-context 源文件映射

```
从 agent-runtime/src/ 映射到 agent-context/src/:
  context-compression/            → compression/ 子目录
  context-compression.ts          → compression/index.ts
  context-slicer.ts               → slicer/context-slicer.ts
  context-state.ts                → state/context-state.ts
  context-projection.ts           → projection/context-projection.ts
  encoding.ts                     → token/encoding.ts
  wasm-tiktoken.ts                → token/wasm-tiktoken.ts
```

#### 4.5.3 agent-model 源文件映射

```
从 agent-runtime/src/ 映射到 agent-model/src/:
  model-routing/                  → routing/ 子目录
  model-routing.ts                → routing/index.ts
  provider/                       → provider/ 子目录
  provider-gateway/               → gateway/ 子目录
  provider-transport/             → transport/ 子目录
  provider-openai-*.ts            → providers/openai/ 子目录
  provider-anthropic.ts           → providers/anthropic.ts
  provider-gemini.ts              → providers/gemini.ts
  provider-stream-contract/       → stream-contract/ 子目录
  provider-cache-hints.ts         → cache/provider-cache-hints.ts
  provider-error-classifier.ts    → errors/provider-error-classifier.ts
  provider-request-machine.ts     → request/provider-request-machine.ts
  fallback-chain/                 → fallback/ 子目录
  pricing-engine.ts               → pricing/pricing-engine.ts
```

#### 4.5.4 agent-permissions 源文件映射

```
从 agent-runtime/src/ 映射到 agent-permissions/src/:
  permission/                     → permission/ 子目录

从 decision-engine/src/ 映射到 agent-permissions/src/（部分移动）:
  command-classifier.ts           → classification/command-classifier.ts
  permission-engine.ts            → engine/permission-engine.ts
  rules/                          → rules/ 子目录
  trust-zone/                     → trust-zone/ 子目录
```

#### 4.5.5 验证标准

- [ ] agent-context 的 typecheck 通过，不依赖 agent-runtime
- [ ] agent-model 的 typecheck 通过，只依赖 shared-types
- [ ] agent-permissions 的 typecheck 通过
- [ ] 所有依赖关系保持 DAG 无环
- [ ] 旧入口点在 agent-runtime 通过 re-export 继续可用

### 4.6 Agent 2.3 详细任务：agent-orchestrator + agent-daemon 拆分

#### 4.6.1 目标包

```
@crish/agent-orchestrator 拆分:
  @crish/event-store              事件存储 + 投影
  @crish/artifact-store            成果物存储
  @crish/session-state-machine     会话状态机（从 orchestrator 抽出）
  @crish/goal-continuation         目标延续（从 orchestrator 抽出）

@crish/agent-daemon 拆分:
  @crish/daemon-server            守护进程服务器
  @crish/daemon-handlers          守护进程处理器注册
  @crish/daemon-stores             守护进程持久化
  @crish/daemon-lifecycle          守护进程生命周期
```

#### 4.6.2 event-store 接口

```typescript
// packages/event-store/src/
export interface EventStore {
  append(events: DomainEvent[]): Promise<void>;
  readStream(
    streamId: string,
    options?: ReadOptions
  ): AsyncIterable<DomainEvent>;
  readAll(options?: ReadOptions): AsyncIterable<DomainEvent>;
  project<T>(projection: Projection<T>): Promise<T>;
  subscribe(subscriber: EventSubscriber): Unsubscribe;
}

export interface DomainEvent {
  readonly id: string;
  readonly type: string;
  readonly streamId: string;
  readonly version: number;
  readonly data: unknown;
  readonly metadata: EventMetadata;
  readonly timestamp: number;
}
```

#### 4.6.3 daemon-server 接口

```typescript
// packages/daemon-server/src/
export interface DaemonServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  registerHandler(handler: DaemonHandler): void;
  status(): DaemonStatus;
}

export interface DaemonHandler {
  readonly name: string;
  readonly methods: string[];
  handle(
    method: string,
    params: unknown,
    context: HandlerContext
  ): Promise<unknown>;
}
```

#### 4.6.4 验证标准

- [ ] 新包所有 typecheck 通过
- [ ] 拆分后原有接口不变（向后兼容 shim）
- [ ] event-store 独立于 agent-orchestrator 可测试
- [ ] daemon 各子包职责不重叠
- [ ] 依赖图无环

### 4.7 Agent 2.4 详细任务：shared-types 整理 + 向后兼容层

#### 4.7.1 shared-types 重构

```typescript
// packages/shared-types/src/
index.ts; // 重新导出（保持向后兼容）
errors / // 新增（Round 1 已创建）
  classes.ts;
codes.ts;
result.ts;
payload.ts;
normalize.ts;
classify.ts;
types / // 从 index.ts 拆入
  tool.ts; // ToolDefinition, ToolCall 等
session.ts; // SessionMessage, SessionState 等
agent.ts; // AgentConfig, AgentState 等
provider.ts; // ProviderConfig, ModelConfig 等
mcp.ts; // McpServerConfig, McpTransport 等
ipc.ts; // IpcEnvelope, IpcResponse 等
runtime.ts; // RuntimeOptions, RuntimeMetrics 等
stream.ts; // StreamEvent, StreamChunk 等
constants / error - codes.ts; // 从 errors/codes.ts re-export
defaults.ts; // 默认值常量
providers.ts; // Provider 常量
```

#### 4.7.2 向后兼容 shim

在旧 agent-runtime 的 index.ts 中添加：

```typescript
// packages/agent-runtime/src/index.ts
// ====== 向后兼容重导出 ======
// 这些 re-export 将在迁移完成后移除。
// 新代码应直接从 @crish/agent-core、@crish/agent-tools 等导入。

export {
  AgentRuntime,
  RuntimeOptions,
  type SessionLoop,
  type TurnState,
} from '@crish/agent-core';

export {
  ToolRegistry,
  type ToolDefinition,
  type ToolCall,
} from '@crish/agent-tools';

export { StreamManager, type StreamEvent } from '@crish/agent-stream';
// ... 以此类推
```

#### 4.7.3 验证标准

- [ ] shared-types 重构后，所有消费者通过 typecheck
- [ ] 旧 import 路径（`@crish/agent-runtime`）仍然可用
- [ ] 新 import 路径（`@crish/agent-core`）也可用
- [ ] 不存在循环依赖

### 4.8 Round 2 产出检查清单

```
Round 2 验收条件:
□ agent-runtime 拆分为 9 个独立包（全部通过 typecheck）
□ agent-orchestrator 拆分为 4 个独立包
□ agent-daemon 拆分为 4 个独立包
□ shared-types 拆分为模块化结构
□ 向后兼容 shim 就位
□ 所有旧消费者的 import 仍正常工作
□ 新包各 package.json 配置正确（npm workspace）
□ 依赖图验证无环
□ 所有测试从旧路径迁移到新路径并通过
□ tsconfig 路径别名更新
□ turbo.json 流水线更新
```

---

## 5. Round 3: 插件系统实现

### 5.1 问题域覆盖

D4.1-D4.7（插件定义 → 发现 → 钩子 → 工具注册 → MCP → 权限 → 生命周期 → 技能）

### 5.2 前置依赖

- Round 2 的模块拆分结果（插件系统需要 agent-core、agent-model 等上层包就位）

### 5.3 Agent 分配

```
Round 3 分配 4 个 Agent（满额）:
├── Agent 3.1: 插件类型 + 注册表 + 多源发现
│   覆盖: D4.1 + D4.2
│   文件范围: shared-types (plugin.ts) + plugin-registry/
│   产出: ~12 个新文件
│
├── Agent 3.2: 钩子系统 + 工具注册 API
│   覆盖: D4.3 + 钩子系统
│   文件范围: plugin-hooks/ + plugin-sdk/ + agent-tools 集成
│   产出: ~15 个新文件
│
├── Agent 3.3: MCP 集成 + 权限模型
│   覆盖: D4.4 + D4.5
│   文件范围: plugin-mcp/ + agent-permissions 集成
│   产出: ~12 个新文件
│
└── Agent 3.4: 技能系统 + 插件生命周期管理
    覆盖: D4.6 + D4.7
    文件范围: plugin-skills/ + plugin-registry/lifecycle + 热重载
    产出: ~12 个新文件
```

### 5.4 关键类型：PluginManifest

```typescript
// packages/shared-types/src/plugin.ts
export type PluginOrigin =
  | { kind: 'user-dir'; path: string }
  | { kind: 'project-dir'; path: string }
  | { kind: 'global-dir'; path: string }
  | { kind: 'npm'; packageName: string }
  | { kind: 'mcp'; mcpServerName: string }
  | { kind: 'github'; owner: string; repo: string; ref?: string }
  | { kind: 'inline'; source: string };

export type PluginPermission =
  | 'session:read'
  | 'session:write'
  | 'tool:execute'
  | 'tool:register'
  | 'mcp:connect'
  | 'network:connect'
  | 'file:read'
  | 'file:write'
  | 'shell:execute'
  | 'env:read'
  | 'hook:intercept';

export type PluginTrustLevel = 'sandboxed' | 'restricted' | 'full';

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  entrypoint?: string; // 主入口（相对于插件根目录）
  browserEntrypoint?: string; // 浏览器端入口
  permissions: PluginPermission[];
  hooks: PluginHookManifest[];
  tools: PluginToolManifest[];
  mcpServers: PluginMcpServerManifest[];
  skills: string[]; // SKILL.md 路径
  dependencies?: Record<string, string>;
  origin: PluginOrigin;
}
```

### 5.5 钩子事件

```typescript
// packages/plugin-hooks/src/events.ts
export type HookEventType =
  | 'session:beforeCreate'
  | 'session:afterCreate'
  | 'session:beforeDestroy'
  | 'session:afterDestroy'
  | 'turn:beforeStart'
  | 'turn:afterEnd'
  | 'tool:beforeExecute'
  | 'tool:afterExecute'
  | 'model:beforeRequest'
  | 'model:afterResponse'
  | 'subagent:beforeSpawn'
  | 'subagent:afterSpawn'
  | 'subagent:beforeDestroy'
  | 'subagent:afterDestroy'
  | 'compaction:before'
  | 'compaction:after'
  | 'error:occurred';

export type HookExecutionMode = 'serial' | 'parallel';
export type HookFailureStrategy = 'fail-open' | 'fail-closed';

export interface HookHandler {
  id: string;
  eventType: HookEventType;
  handler: (payload: unknown) => Promise<void>;
  timeoutMs?: number;
  failureStrategy?: HookFailureStrategy;
}
```

### 5.6 Round 3 产出检查清单

```
Round 3 验收条件:
□ PluginManifest + PluginOrigin + PluginPermission 类型定义完整
□ 多源发现（user-dir / project-dir / global-dir / npm / mcp / github / inline）
□ 14 个钩子事件（session/turn/tool/model/subagent/compaction/error）
□ 串行/并行派发 + 超时 + fail-open/fail-closed
□ 信任门控（sandboxed / restricted / full）
□ 工具注册 API（name, description, parameters, handler）
□ MCP server 声明 + stdio/HTTP/SSE/WebSocket 传输
□ MCP OAuth 支持
□ 插件安装/更新/卸载状态机
□ 版本兼容性 + 依赖解析
□ PluginAPI（钩子/工具/MCP/技能/配置/日志/权限/存储）
□ SKILL.md 解析 + 技能→工具转换
□ 热重载（watch 模式）
□ 测试覆盖安装/卸载/钩子派发/工具注册
```

---

## 6. Round 4: 子代理调度实现

### 6.1 问题域覆盖

D5.1-D5.7（子代理定义 → 调度 → 通信 → 执行引擎 → 递归守卫 → 死锁检测 → 看门狗 → 资源预算）

### 6.2 前置依赖

- Round 2 的模块拆分（尤其是 agent-core 和 agent-orchestrator 就位）
- Round 3 的插件系统（子代理定义通过插件发现）

### 6.3 Agent 分配

```
Round 4 分配 3 个 Agent:
├── Agent 4.1: 子代理定义 + 发现 + 生命周期
│   覆盖: D5.1 + D5.2
│   文件范围: agent-subagent/definition/ + agent-subagent/lifecycle/
│   产出: ~15 个新文件
│
├── Agent 4.2: 调度队列 + 通信总线 + 资源管理
│   覆盖: D5.3 - D5.7
│   文件范围: agent-subagent/scheduler/ + agent-subagent/communication/
│   产出: ~15 个新文件
│
└── Agent 4.3: 执行引擎 + 集成层
    覆盖: 子代理执行引擎 + 与 agent-core/orchestrator/plugin 的集成
    文件范围: agent-subagent/engine/ + 各集成点
    产出: ~12 个新文件
```

### 6.4 核心接口

```typescript
// packages/agent-subagent/src/

// === definition/types.ts ===
export type SubagentRole =
  'researcher' | 'implementer' | 'reviewer' | 'debugger' | 'planner' | 'custom';

export interface SubagentDefinition {
  name: string;
  version: string;
  description: string;
  role: SubagentRole;
  label?: string;
  model?: string;
  systemPrompt: string;
  allowedTools?: string[];
  deniedTools?: string[];
  maxTurns?: number;
  timeoutMs?: number;
  isolation?: 'none' | 'worktree' | 'process';
  constraints?: SubagentConstraint[];
}

// === lifecycle/state.ts ===
export type SubagentState =
  | 'pending'
  | 'initializing'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SubagentInstance {
  readonly id: string;
  readonly definition: SubagentDefinition;
  readonly parentId?: string;
  state: SubagentState;
  readonly createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: CrishError;
  result?: unknown;
}

// === scheduler/queue.ts ===
export type SchedulingStrategy = 'fifo' | 'priority' | 'affinity';

export interface SchedulingQueue {
  enqueue(subagent: SubagentInstance, priority?: number): void;
  dequeue(): SubagentInstance | undefined;
  peek(): SubagentInstance | undefined;
  remove(id: string): boolean;
  cancelAll(): void;
  readonly length: number;
}

// === scheduler/recursion-guard.ts ===
export interface RecursionGuardConfig {
  maxDepth: number; // 默认 8
  maxSiblings: number; // 默认 10
  maxConcurrent: number; // 默认 4
  totalTokenBudget: number; // 默认 1_000_000
  totalTimeoutMs: number; // 默认 600_000 (10min)
}

// === communication/bus.ts ===
export interface SubagentMessage {
  readonly from: string;
  readonly to: string;
  readonly type: 'request' | 'response' | 'broadcast';
  readonly payload: unknown;
  readonly traceId: string;
  readonly timestamp: number;
}

export interface CommunicationBus {
  send(message: SubagentMessage): void;
  subscribe(filter: MessageFilter, handler: MessageHandler): Unsubscribe;
  request(
    target: string,
    payload: unknown,
    timeoutMs?: number
  ): Promise<unknown>;
  broadcast(type: string, payload: unknown): void;
}

// === engine/runtime-manager.ts ===
export interface SubagentRuntimeManager {
  create(
    definition: SubagentDefinition,
    parentContext?: AgentContext
  ): Promise<SubagentInstance>;
  start(instanceId: string): Promise<void>;
  pause(instanceId: string): Promise<void>;
  resume(instanceId: string): Promise<void>;
  cancel(instanceId: string): Promise<void>;
  getStatus(instanceId: string): SubagentState;
  listActive(): SubagentInstance[];
}
```

### 6.5 Round 4 产出检查清单

```
Round 4 验收条件:
□ SubagentDefinition + SubagentRole + SubagentState 类型定义完整
□ 四层发现（内置/文件/插件/编程式）
□ 完整生命周期状态机（pending → ... → completed/failed/cancelled）
□ 11 个生命周期钩子与插件系统集成
□ FIFO/优先级/亲和性三种调度策略
□ 递归守卫（深度/兄弟数/并发/token 预算/超时）
□ DeadlockDetector（DFS 环检测）
□ Watchdog（超时 + stuck 检测 + 终止）
□ TokenBudgetTracker
□ CommunicationBus（request/response/broadcast + subscribe）
□ 父子/兄弟/监督三种通信模式
□ SubagentRuntimeManager（create/start/pause/resume/cancel）
□ 工具集过滤/缩减（子代理只能使用父授权子集）
□ context 传递（父→子→父）
□ 与 orchestrator 的 event store 集成
□ 与 telemetry 集成（记录执行指标）
□ 测试覆盖所有调度策略 + 递归守卫 + 通信
```

---

## 7. Round 5: 跨系统集成与验证

### 7.1 问题域覆盖

Round 1-4 产出的集成验证 + 边界测试 + 性能基准

### 7.2 前置依赖

- Round 1-4 全部完成

### 7.3 Agent 分配

```
Round 5 分配 2 个 Agent:
├── Agent 5.1: 错误处理 ↔ 插件 ↔ 子代理 集成
│   覆盖: 跨系统边界集成点
│   文件范围: 全局，修改 ~10 个集成点文件
│
└── Agent 5.2: 集成测试 + 性能基准 + 回归验证
    覆盖: 编写集成测试 + 运行完整 CI + 验证
    文件范围: tests/integration/ + tests/benchmarks/
```

### 7.4 Agent 5.1 详细任务：跨系统集成

#### 7.4.1 集成点清单

```
集成点 1: 错误系统 → 插件系统
  - PluginManifest.isValid() → 使用 CrishResult 类型
  - 插件加载失败 → CrishError('plugin.load_failed', ...)
  - 插件钩子中未捕获的错误 → onUnexpectedError

集成点 2: 错误系统 → 子代理系统
  - 子代理执行失败 → CrishError('subagent.timeout', ...)
  - 子代理错误传播到父代理 → CrishError cause 链
  - 流式子代理响应中的错误编码 → StreamErrorContract

集成点 3: 日志系统 → 插件系统
  - 插件创建子日志器 → log.createChild({plugin: name})
  - 插件钩子执行的日志记录 → 自动 ctx.plugin = name

集成点 4: Telemetry → 子代理
  - 子代理事件追踪 → telemetry.track('subagent.completed', {id, duration, ...})

集成点 5: 模块化包 → 主入口
  - 更新 apps/crish-desktop 和 apps/agent-workbench 的 imports
  - 更新 package.json workspaces 列表
```

### 7.5 Round 5 产出检查清单

```
Round 5 验收条件:
□ 所有跨系统边界通过 typecheck
□ 集成测试覆盖所有边界（至少 20 个测试用例）
□ 错误→插件、错误→子代理、日志→插件、telemetry→子代理 集成点完成
□ 性能基准测试运行通过（无退化）
□ 完整 CI 流水线通过（typecheck + lint + test + build）
```

---

## 8. Round 6: 可观测性强化

### 8.1 问题域覆盖

D2 中剩余的高级可观测性能力：监控面板、告警、OTel 完整集成、诊断命令

### 8.2 前置依赖

- Round 1 的基础 telemetry（Agent 1.3）
- Round 3-4 的插件和子代理系统（采集更多数据源）

### 8.3 Agent 分配

```
Round 6 分配 2 个 Agent:
├── Agent 6.1: OTel 完整集成 + 诊断命令
│   覆盖: OTel span 导出、/doctor 命令、诊断报告
│   文件范围: packages/telemetry/ + apps/crish-desktop/src/
│
└── Agent 6.2: 监控仪表板 + 告警规则
    覆盖: telemetry dashboard 组件、告警条件、健康检查端点
    文件范围: apps/crish-desktop/src/components/monitor/
```

### 8.4 Agent 6.1 详细任务

```typescript
// packages/telemetry/src/otel/
export interface OtelBridgeConfig {
  endpoint?: string;
  serviceName: string;
  serviceVersion: string;
  exporterType: 'otlp-grpc' | 'otlp-http' | 'statsig';
  samplingRatio?: number; // 默认 0.1
}

export function initOtelBridge(config: OtelBridgeConfig): Promise<OtelGuard>;

// 诊断命令（/doctor）
export interface DoctorReport {
  version: string;
  uptime: number;
  memory: ProcessMemory;
  telemetry: TelemetryStatus;
  plugins: PluginStatus[];
  subagents: SubagentStatus[];
  recentErrors: CrishErrorPayload[];
  connections: ConnectionStatus[];
}

export async function generateDoctorReport(): Promise<DoctorReport>;
```

### 8.5 Round 6 产出检查清单

```
Round 6 验收条件:
□ OTel span/trace 导出（OTLP gRPC + HTTP）
□ /doctor 命令输出完整诊断报告
□ 错误热力图（最近 24h 错误分布）
□ 系统指标仪表板（CPU/内存/请求量/错误率）
□ 告警条件配置（错误率 > 5%、P99 延迟 > 10s 等）
□ 健康检查端点
□ 崩溃报告自动收集和上传
```

---

## 9. Round 7: 文档与产品化就绪

### 9.1 问题域覆盖

产品化缺口：用户文档、API 文档、发布流程、THIRD-PARTY-NOTICES

### 9.2 前置依赖

- Round 1-6 全部完成

### 9.3 Agent 分配

```
Round 7 分配 2 个 Agent:
├── Agent 7.1: 用户文档 + API 文档
│   覆盖: 用户指南、API 参考、架构文档更新
│   文件范围: docs/ + README.md + TSDoc 注释
│
└── Agent 7.2: 发布流程 + 合规文件
    覆盖: 发布脚本、CHANGELOG、THIRD-PARTY-NOTICES、安装器
    文件范围: scripts/ + CHANGELOG.md + 生成 NOTICES
```

### 9.4 Round 7 产出检查清单

```
Round 7 验收条件:
□ Getting Started 指南（安装/配置/运行）
□ 用户指南（设置/MCP/插件/子代理/快捷键）
□ 架构文档更新（ADR 记录 + 模块依赖图）
□ API 参考文档（TSDoc 覆盖所有公共 API）
□ 发布脚本（版本 bump + changelog + build + pack）
□ 跨平台安装器（macOS/Linux/Windows）
□ THIRD-PARTY-NOTICES（所有依赖的 License 声明）
□ SECURITY.md 更新
□ CHANGELOG 完整记录
□ 自动更新机制（grok update 等价物）
```

---

## 10. 闭环迭代机制

### 10.1 迭代生命周期

```
一轮完成
    │
    ├── 验证结果 = 通过 → 进入下一轮问题域
    │                      │
    │                      └── 无剩余问题 → 项目就绪
    │
    └── 验证结果 = 不通过
         │
         ├── 类型错误 → 回退到当前轮次 Agent 修复
         ├── 测试失败 → 在当前轮次补充测试修复
         ├── 回归 → 创建回归测试，重新执行当前轮次
         └── 架构问题 → 升级到下一轮次作为输入约束
```

### 10.2 跨轮次状态传递

```
Round 1 输出 → Round 2 输入:
  - 错误类型系统（CrishError + CrishResult）
  - 新包的 package.json 模板

Round 2 输出 → Round 3 输入:
  - agent-core/agent-model/agent-tools 模块化结构
  - 插件系统需要的集成点

Round 3 输出 → Round 4 输入:
  - 插件发现机制（子代理通过插件发现）
  - 钩子系统（子代理生命周期钩子）

Round 1-4 输出 → Round 5 输入:
  - 所有包类型定义
  - 跨系统边界清单

Round 5 输出 → Round 6 输入:
  - 集成测试结果
  - 性能基准线

Round 1-6 输出 → Round 7 输入:
  - 完整代码库
  - 测试报告
  - 架构图
```

### 10.3 可复用性设计

本计划的轮次结构是**可复用的**，适用于未来任何多轮次迭代修复场景：

```
复用方式 1: 替换问题域清单
  替换 /plan/problem-domains.yaml 即可适配新项目

复用方式 2: 调整 Agent 数量
  每轮 Agent 数量根据问题域大小灵活决定（1-4 个）

复用方式 3: 更改轮次顺序
  依赖关系图决定执行顺序，无依赖的轮次可并行

复用方式 4: 增量执行
  从任意轮次开始执行（如果前置依赖已满足）

模板变量:
  - PROJECT_NAME:   被修复项目名
  - PROBLEM_DOMAINS: 问题域清单（带前置依赖）
  - ROUNDS:          轮次定义（每轮 1-4 Agent）
  - AGENT_ROLES:     诊断/执行/集成/验证
  - QUALITY_GATES:   类型检查/lint/测试/构建
```

---

## 11. Agent 职能规范

### 11.1 Agent 角色定义

```
Agent 类型        职责                          人数限制
────────────────────────────────────────────────────────
Agent-0 (诊断)    问题识别、任务分解、结果聚合、验证    每轮 1 个
Agent-1 (执行)    代码修改、测试编写                    每轮 0-4 个
Agent-2 (集成)    变更合并、冲突解决、TypeCheck         每轮 0-1 个
Agent-3 (验证)    CI 运行、回归检测、报告生成           每轮 0-1 个
```

### 11.2 Agent prompt 模板

每个执行 Agent 的 prompt 必须包含以下内容：

```
## 上下文
- 项目: Crish
- 当前轮次: Round N
- 前置条件: Round N-1 已完成
- 参考方案: analysis/plan-{NN}-{topic}.md

## 任务范围
- 要创建的文件列表
- 要修改的文件列表（不含其他 Agent 正在修改的文件）
- 不可修改的文件列表

## 接口契约
- 依赖哪些包/接口（只能 read，不能 modify）
- 对外暴露哪些包/接口（需要达成 typecheck 一致）

## 代码规范
- 使用 erasable TypeScript 语法（无 enum/namespace/parameter properties）
- 文件不超过 500 LoC
- 测试文件与源码对应（至少一个测试文件）

## 验证
- 运行 tsc --noEmit 验证类型
- 运行 vitest run 验证测试
- 报告输出的文件列表和接口变更
```

---

## 12. 质量门禁

### 12.1 每轮通过标准

```
标准 1: TypeScript 类型通过
  - tsc --noEmit --project tsconfig.base.json → 0 errors
  - 所有新包独立 typecheck

标准 2: 测试通过
  - vitest run → 所有测试通过
  - 新增代码测试覆盖率 ≥ 50%

标准 3: Lint 通过
  - eslint . --max-warnings 0 → 0 errors
  - depcruise --config .dependency-cruiser.cjs → 0 circular deps

标准 4: Rust 通过
  - cargo check --workspace → 0 errors
  - cargo clippy --workspace → 0 warnings

标准 5: 构建通过
  - turbo run build → 所有包构建成功
```

### 12.2 不通过时的降级策略

```
类型错误 (tsc):
  → 回退到当前轮次，由集成 Agent 修复类型错误
  → 如果类型错误跨 Agent 边界，启动协调 Agent

测试失败 (vitest):
  → 如果测试新增且正确，修复实现
  → 如果测试过时，更新测试
  → 如果回归，报告 + 修复 + 补充回归测试

环形依赖 (depcruise):
  → 阻塞问题，必须修复后继续
  → 启动专用 Agent 分析 + 修复环
```

---

## 13. 附录：完整文件清单

### 13.1 新创建文件

```
Round 1 (45 文件):
  packages/shared-types/src/errors/     (18 文件)
  packages/shared-utils/src/error-handling/ (12 文件)
  packages/telemetry/src/               (15 文件)

Round 2 (52 文件):
  packages/agent-core/src/              (20 文件)
  packages/agent-tools/src/             (8 文件)
  packages/agent-stream/src/            (5 文件)
  packages/agent-context/src/           (6 文件)
  packages/agent-model/src/             (8 文件)
  packages/agent-permissions/src/       (5 文件)

Round 3 (51 文件):
  packages/plugin-registry/src/         (12 文件)
  packages/plugin-hooks/src/            (15 文件)
  packages/plugin-sdk/src/              (10 文件)
  packages/plugin-mcp/src/              (8 文件)
  packages/plugin-skills/src/           (6 文件)

Round 4 (42 文件):
  packages/agent-subagent/src/          (25 文件)
  集成点文件 (8 文件)

Round 5 (5 文件):
  tests/integration/                    (3 文件)
  scripts/benchmark.ts                  (1 文件)
  tests/regression/                     (1 文件)

Round 6 (8 文件):
  packages/telemetry/src/otel/          (5 文件)
  apps/crish-desktop/src/components/monitor/ (3 文件)

Round 7 (10 文件):
  docs/                                (5 文件)
  scripts/release/                     (3 文件)
  NOTICES                              (1 文件)
  CHANGELOG.md                         (1 文件)

总计: ~213 个新文件
```

### 13.2 修改文件

```
Round 1:  Cargo.toml, package.json, tsconfig.base.json (3 文件)
Round 2:  package.json (workspaces), turbo.json, tsconfig 引用 (5 文件)
Round 3:  package.json, agent-runtime 集成点 (4 文件)
Round 4:  package.json, agent-orchestrator 集成点 (4 文件)
Round 5:  全局集成点 (10 文件)
Round 6:  前端文件 (5 文件)
Round 7:  README.md, CONTRIBUTING.md, SECURITY.md (3 文件)

总计: ~34 个修改文件
```

---

## 14. 附录：关键接口索引

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Crish 关键接口索引                                │
├──────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  [错误系统]                                                         │
│  CrishError          → packages/shared-types/src/errors/classes.ts  │
│  CrishResult<T,E>    → packages/shared-types/src/errors/result.ts   │
│  CrishErrorPayload   → packages/shared-types/src/errors/payload.ts  │
│  ErrorCodes          → packages/shared-types/src/errors/codes.ts    │
│                                                                    │
│  [错误处理]                                                         │
│  withRetry()         → packages/shared-utils/src/error-handling/retry.ts
│  StreamFn contract   → packages/shared-utils/src/error-handling/stream-error.ts
│  ToolExecPipeline    → packages/shared-utils/src/error-handling/tool-error.ts
│  safelyCallListener  → packages/shared-utils/src/error-handling/emitter-guard.ts
│                                                                    │
│  [日志]                                                             │
│  Logger              → packages/logger/src/types.ts                 │
│  log (singleton)     → packages/logger/src/logger.ts               │
│  RotatingFileSink    → packages/logger/src/sinks.ts                │
│  JSONFormatter       → packages/logger/src/formatter.ts            │
│                                                                    │
│  [Telemetry]                                                        │
│  TelemetryClient     → packages/telemetry/src/client.ts             │
│  AsyncTransport      → packages/telemetry/src/transport.ts          │
│  EventSink           → packages/telemetry/src/sink.ts               │
│  installCrashHandler → packages/telemetry/src/crash.ts              │
│  SystemMetricsCollector → packages/telemetry/src/systemMetrics.ts   │
│                                                                    │
│  [插件系统]                                                         │
│  PluginManifest      → packages/shared-types/src/plugin.ts         │
│  HookEvent           → packages/plugin-hooks/src/events.ts         │
│  PluginAPI           → packages/plugin-sdk/src/api.ts              │
│  PluginRegistry      → packages/plugin-registry/src/registry.ts    │
│  McpManager          → packages/plugin-mcp/src/manager.ts          │
│  SkillParser         → packages/plugin-skills/src/parser.ts        │
│                                                                    │
│  [子代理]                                                           │
│  SubagentDefinition  → packages/agent-subagent/src/definition/types.ts
│  SubagentInstance    → packages/agent-subagent/src/lifecycle/state.ts
│  SchedulerQueue      → packages/agent-subagent/src/scheduler/queue.ts
│  CommunicationBus    → packages/agent-subagent/src/communication/bus.ts
│  SubagentRuntime     → packages/agent-subagent/src/engine/runtime.ts
│  RecursionGuard      → packages/agent-subagent/src/scheduler/recursion-guard.ts
│  DeadlockDetector    → packages/agent-subagent/src/scheduler/deadlock.ts
│  Watchdog            → packages/agent-subagent/src/scheduler/watchdog.ts
│                                                                    │
│  [Rust]                                                             │
│  CrishError (enum)   → crates/conex-types/src/error.rs              │
│  ErrorPayload        → crates/conex-types/src/error_payload.rs      │
│  initTelemetry()     → crates/conex-telemetry/src/lib.rs            │
│  setPanicHook()      → crates/conex-telemetry/src/panic.rs          │
│                                                                    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 15. 附录：引用方案摘要

### 15.1 Plan 01: 错误处理与可观测性（1458 行）

**核心设计决策**：

- 统一 CrishError 基类（KimiCode 风格）+ 分域错误码（domain.reason）
- CrishResult<T,E> ADT（Pi 风格）+ 标准化函数
- 自定义 telemetry（KimiCode 风格）+ OTel 预留桥接（Codex 风格）
- 流式错误编码（Pi 风格）+ 三层工具执行包装
- Rust thiserror 枚举 + tracing subscriber 多层组合（Codex 风格）

### 15.2 Plan 02: 插件 SDK 与可扩展性（2680 行）

**核心设计决策**：

- 14 钩子事件 + 多源发现（7 种 PluginOrigin，Grok 风格）
- PluginManifest + PluginPermission + PluginTrustLevel
- 插件生命周期状态机 + 依赖解析
- MCP 4 传输支持 + OAuth（Grok 风格）
- SKILL.md 格式标准（Codex + KimiCode 风格）
- 热重载支持

### 15.3 Plan 03: 模块拆分与架构重构（1376 行）

**核心设计决策**：

- agent-runtime(195 文件) → 9 个独立包（agent-core/agent-tools/agent-stream/agent-context/agent-model/agent-permissions/agent-mcp/agent-subagent/agent-hooks）
- agent-orchestrator → 4 个包（event-store/artifact-store/session-state-machine/goal-continuation）
- agent-daemon → 4 个包（daemon-server/daemon-handlers/daemon-stores/daemon-lifecycle）
- 3 个新 Rust crate（conex-telemetry/conex-plugin/conex-events）
- 500 LoC/module + 800 LoC/file 规则
- 向后兼容 shim 层

### 15.4 Plan 04: 子代理调度系统（2024 行）

**核心设计决策**：

- SubagentDefinition + SubagentRole(6 种) + Persona 框架
- 4 层发现机制（内置/文件/插件/编程式）
- 完整生命周期状态机（10 种状态）
- 3 种调度策略（FIFO/优先级/亲和性）
- 递归守卫（深度/兄弟/并发/token 预算/超时）
- 死锁检测（DFS 环检测）+ 看门狗
- 3 种通信模式（父子/兄弟/监督）
- 与插件 SDK/orchestrator/telemetry 集成

---

_本计划文档为 Crish 系统修复的主控文档，与 analysis/plan-01 至 plan-04 四个方案文档共同构成完整的修复体系。_
_文档版本: v1.0 | 总行数: 1,021 行 | 轮次数: 7 轮 | 最大 Agent 数: 4/轮_
