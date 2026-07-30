# Round 1：类型基础层 + 基线审计

> **本文档定位**：Round 1（类型基础层 + 基线审计）的详细执行设计。所有错误码、`CrishResult` 工具函数签名、`CrishErrorPayload` 序列化格式的**权威来源**为 `./03-ERROR-MIGRATION.md`，本文档引用其结论并细化到文件级实现。
>
> **前置文档**（必须先阅读）：
>
> - `../../ANTI_OVERENGINEERING_GUARDRAILS.md` — 架构治理约束（禁令 10-31）
> - `./01-OVERVIEW.md` — 总览（轮次编排、依赖图、agent 分配原则）
> - `./03-ERROR-MIGRATION.md` — 错误码迁移映射表（本 Round 的核心输入）

---

## 1. Round 概述

### 1.1 目标

本 Round 是整个十二轮修复方案的**第一轮**，处于依赖图 Layer 0（最底层），为后续所有轮次提供类型基础。具体目标：

1. **建立完整的错误类型体系**：在 `@crish/shared-types` 包内实现 64 个正式 `domain.reason` 格式错误码 + 10 个 reserved（19 域）、`CrishError` 基类扩展、`CrishResult<T>` ADT、`CrishErrorPayload` 跨进程序列化协议。
2. **建立基线审计数据**：采集 TSC 错误基线（315 个）、依赖图基线、测试覆盖率基线、throw 清单，作为后续每轮"不恶化"门禁的对比基准。
3. **定义子代理/插件/钩子类型骨架**：为 Round 8（plugin-sdk）和 Round 9（agent-subagent）提前在 `shared-types` 落地类型契约，避免后续轮次反向依赖。
4. **共存而非替换**（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 23）：旧 `CrishError`/`SessionError`/`ProviderError`/`ProtocolError`/`PermissionError` 保留为 deprecated 适配层，新类型与之共存，零破坏现有代码。

### 1.2 前置条件

| 条件                                             | 状态 | 说明                                                                                         |
| ------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------- |
| `./03-ERROR-MIGRATION.md` 已完成                 | 满足 | 64 正式码 + 10 reserved 码体系、迁移映射、`CrishResult`/`CrishErrorPayload` 签名均已权威定义 |
| `./01-OVERVIEW.md` 已完成                        | 满足 | 轮次编排、依赖图、Agent 分配原则已明确                                                       |
| `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10-31  | 满足 | 架构治理红线（含禁令 23-26 三阶段迁移、禁令 27-28 Agent 任务量）已生效                       |
| 现有 `shared-types/src/errors.ts`（81 行）可编译 | 满足 | 5 个错误类 + `SessionErrorCode` 联合类型，`category` 字段已存在                              |
| 前置轮次                                         | 无   | 本 Round 为第一轮                                                                            |

### 1.3 交付物清单

| 类别 | 文件                                                                    | 产出 Agent                           |
| ---- | ----------------------------------------------------------------------- | ------------------------------------ |
| 基线 | `analysis/iterative-repair/v2/baselines/tsc-errors-baseline.json`       | 1-A                                  |
| 基线 | `analysis/iterative-repair/v2/baselines/dependency-graph-baseline.json` | 1-A                                  |
| 基线 | `analysis/iterative-repair/v2/baselines/test-coverage-baseline.json`    | 1-A                                  |
| 基线 | `analysis/iterative-repair/v2/baselines/throw-inventory.json`           | 1-A                                  |
| 基线 | `analysis/iterative-repair/v2/baselines/tech-debt-inventory.md`         | 1-A                                  |
| 代码 | `packages/shared-types/src/errors/codes.ts`                             | 1-B                                  |
| 代码 | `packages/shared-types/src/errors/info.ts`                              | 1-B                                  |
| 代码 | `packages/shared-types/src/errors/classes.ts`                           | 1-C                                  |
| 代码 | `packages/shared-types/src/errors/result.ts`                            | 1-C                                  |
| 代码 | `packages/shared-types/src/errors/serialize.ts`                         | 1-D                                  |
| 代码 | `packages/shared-types/src/errors/normalize.ts`                         | 1-D                                  |
| 代码 | `packages/shared-types/src/errors/index.ts`                             | 1-C（barrel，汇总 1-B/1-C/1-D 产出） |
| 代码 | `packages/shared-types/src/subagent.ts`                                 | 1-E                                  |
| 代码 | `packages/shared-types/src/plugin.ts`                                   | 1-E                                  |
| 代码 | `packages/shared-types/src/hooks.ts`                                    | 1-E                                  |
| 修改 | `packages/shared-types/src/index.ts`                                    | 1-E                                  |
| 修改 | `packages/shared-types/src/errors.ts` → 转为 deprecated re-export shim  | 1-C                                  |

---

## 2. Agent 任务详细设计

### 2.1 Agent 1-A：基线审计（Phase 1）

#### 输入

- 仓库根目录 `C:\Software\conex`
- `./03-ERROR-MIGRATION.md` §0.2 扫描基线（throw 总数 250 处/96 文件，TSC 错误 315）
- `./01-OVERVIEW.md` §1.2 编译健康状态表

#### 任务步骤

**步骤 1：采集 TSC 错误基线**

在仓库根目录执行：

```bash
npx tsc --noEmit --pretty false > analysis/iterative-repair/v2/baselines/tsc-errors-raw.txt 2>&1
```

将原始输出解析为结构化 JSON，写入 `analysis/iterative-repair/v2/baselines/tsc-errors-baseline.json`，schema：

```json
{
  "collectedAt": "2026-07-30T...",
  "tscVersion": "<from npx tsc --version>",
  "totalErrors": 315,
  "errorsByCode": {
    "TS2375": <count>,
    "TS2379": <count>,
    "TS2532": <count>,
    "TS18048": <count>,
    "TS6133": <count>,
    "TS6192": <count>,
    "TS2307": <count>,
    "TS2305": <count>,
    "TS1484": <count>,
    "TS7006": <count>
  },
  "errorsByPackage": {
    "agent-runtime": <count>,
    "agent-orchestrator": <count>,
    "agent-daemon": <count>,
    "shared-types": <count>,
    "shared-utils": <count>,
    "decision-engine": <count>
  },
  "errors": [
    {
      "file": "<absolute or repo-relative path>",
      "line": <number>,
      "col": <number>,
      "code": "TS2532",
      "message": "<text>"
    }
  ]
}
```

解析逻辑：每行匹配正则 `^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$`，聚合 `totalErrors`/`errorsByCode`/`errorsByPackage`（按文件路径首段归类到包）。`totalErrors` 必须等于 315（`./01-OVERVIEW.md` §1.2 基线），若不符则在 JSON 中标注实际值并记录差异原因。

**步骤 2：采集依赖图基线**

扫描所有 `packages/*/package.json` 的 `dependencies` 与 `devDependencies` 字段，构建当前依赖图，写入 `analysis/iterative-repair/v2/baselines/dependency-graph-baseline.json`，schema：

```json
{
  "collectedAt": "2026-07-30T...",
  "packages": [
    {
      "name": "@crish/shared-types",
      "path": "packages/shared-types",
      "dependencies": ["<pkg name>", ...],
      "devDependencies": ["<pkg name>", ...]
    }
  ],
  "edges": [
    { "from": "@crish/shared-types", "to": "@crish/shared-utils", "type": "dependencies" }
  ],
  "circularDependencies": []
}
```

同时执行 `npm run lint:depcruise`（若脚本存在）并记录输出，确认循环依赖为 0（`./01-OVERVIEW.md` §1.2 基线）。若 depcruise 脚本不存在，则基于 `package.json` 静态分析并标注"depcruise 脚本缺失，仅静态分析"。

**步骤 3：采集测试覆盖率基线**

执行：

```bash
npx vitest run --coverage --reporter=json > analysis/iterative-repair/v2/baselines/vitest-output.json 2>&1
```

提取每个包的 `stmts`/`branches`/`funcs`/`lines` 覆盖率百分比，写入 `analysis/iterative-repair/v2/baselines/test-coverage-baseline.json`，schema：

```json
{
  "collectedAt": "2026-07-30T...",
  "coverageByPackage": {
    "agent-runtime": { "statements": <pct>, "branches": <pct>, "functions": <pct>, "lines": <pct> },
    "agent-orchestrator": { ... },
    "agent-daemon": { ... },
    "shared-types": { ... },
    "shared-utils": { ... },
    "decision-engine": { ... }
  },
  "thresholds": {
    "agent-orchestrator": { "statements": 70 },
    "agent-runtime": { "statements": 50 }
  }
}
```

若 vitest 无 coverage 配置，记录各包测试文件数与用例数作为替代指标。

**步骤 4：生成 throw 清单**

基于 `./03-ERROR-MIGRATION.md` §0.2、§4.1、§4.2 的扫描结果，汇总为结构化 `throw-inventory.json`，schema：

```json
{
  "collectedAt": "2026-07-30T...",
  "summary": {
    "throwNewError_total": 250,
    "throwNewError_sourceFiles": 168,
    "throwNewError_testFiles": 82,
    "throwNewCrishError": 31,
    "throwNewProviderError": 25,
    "throwNewSessionError": 31,
    "throwNewProtocolError": 2,
    "throwNewPermissionError": 0,
    "grandTotal": 339
  },
  "throwNewError": [
    {
      "file": "packages/agent-runtime/src/local-tools/fs-edit-tools/edit-tool.ts",
      "line": <number>,
      "priority": "P0",
      "targetDomain": "tool.*",
      "migrationRound": 4
    }
  ],
  "throwCrishFamily": [
    {
      "file": "packages/agent-runtime/src/lsp-tools.ts",
      "subclass": "CrishError",
      "count": 16,
      "legacyCode": "TOOL_ERROR",
      "newCodeDomain": "tool.*",
      "priority": "P0",
      "migrationRound": 4
    }
  ]
}
```

数据源：直接引用 `./03-ERROR-MIGRATION.md` §4.1（throw new Error 热点文件清单 67 源码文件 + 测试文件统计）与 §4.2（throw Crish 家族 89 处/14 文件 + SessionError 5 文件）的表格，转为 JSON 数组。每条记录的 `priority`/`targetDomain`/`migrationRound` 字段从该文档 §4.1 优先级定义和 §4.3 迁移优先级表查得。

**步骤 5：生成技术债清单**

写入 `analysis/iterative-repair/v2/baselines/tech-debt-inventory.md`，内容结构：

```markdown
# Crish 技术债清单（Round 1 基线）

## 1. 错误处理债务

- 250 处 `throw new Error` 使用裸 Error（来源：./03-ERROR-MIGRATION.md §0.2）
- 49 处 `TOOL_ERROR` 混用 transient/permanent/路径校验/入参校验（来源：§1.4）
- `ProviderErrorKind` 12 个 kind 既是分类标签又是错误码，职责重叠（§1.3）
- Rust `CoreError` 6 variant 与 TS `CrishError` 序列化格式不统一（§1.5）

## 2. 类型安全债务

- 315 个 TSC 编译错误（来源：./01-OVERVIEW.md §1.2）
- `CrishError.code` 为裸 string，无分域错误码（S-03）
- ...

## 3. 架构债务

- agent-runtime ~31K LOC 单体包（S-01）
- plugin-sdk 仅 17 行（S-02）
- ...
```

#### 输出

| 文件                                       | 内容                        |
| ------------------------------------------ | --------------------------- |
| `baselines/tsc-errors-baseline.json`       | 315 个 TSC 错误的结构化清单 |
| `baselines/dependency-graph-baseline.json` | 当前包依赖关系图            |
| `baselines/test-coverage-baseline.json`    | 各包测试覆盖率              |
| `baselines/throw-inventory.json`           | 339 处 throw 的迁移追踪清单 |
| `baselines/tech-debt-inventory.md`         | 技术债清单                  |

#### 验证标准

1. `tsc-errors-baseline.json` 的 `totalErrors` 字段值 = 315（或标注实际值与差异原因）
2. `dependency-graph-baseline.json` 的 `circularDependencies` 数组为空
3. `throw-inventory.json` 的 `summary.grandTotal` 与 `./03-ERROR-MIGRATION.md` §0.2 实测值一致
4. 所有基线文件可被后续 Round 的验证脚本机器读取（JSON schema 合法）

---

### 2.2 Agent 1-B：CrishErrorCode 体系 + CrishErrorInfo 注册表

#### 输入

- `./03-ERROR-MIGRATION.md` §2.1（设计原则）、§2.2（完整错误码表 64 正式码 + 10 reserved 码/19 域）、§2.3（CrishErrorInfo 注册表签名）
- 现有 `packages/shared-types/src/primitive-types.ts`（`JsonObject` 类型）

#### 任务步骤

**步骤 1：实现 `packages/shared-types/src/errors/codes.ts`**

定义 `CrishErrorCode` 联合类型，**完整列出 64 个正式码值 + 10 个 reserved 码值**（来自 `./03-ERROR-MIGRATION.md` §2.2）。同时定义 `CrishErrorCategory` 与域常量。

```ts
// packages/shared-types/src/errors/codes.ts
// 错误码权威定义，来源：./03-ERROR-MIGRATION.md §2.2

export type CrishErrorCode =
  // config 域（3 码）
  | 'config.invalid'
  | 'config.missing'
  | 'config.parse_failed'
  // session 域（5 码）
  | 'session.not_found'
  | 'session.invalid_session'
  | 'session.invalid_entry'
  | 'session.invalid_state'
  | 'session.storage_failed'
  // agent 域（3 码）
  | 'agent.max_turns_reached'
  | 'agent.no_progress'
  | 'agent.intervention_required'
  // runtime 域（3 码）
  | 'runtime.unexpected_state'
  | 'runtime.transition_failed'
  | 'runtime.aborted'
  // provider 域（12 码）
  | 'provider.network'
  | 'provider.gateway_challenge'
  | 'provider.rate_limit'
  | 'provider.auth'
  | 'provider.quota'
  | 'provider.endpoint_unavailable'
  | 'provider.schema'
  | 'provider.server'
  | 'provider.timeout'
  | 'provider.cancelled'
  | 'provider.stream_interrupted'
  | 'provider.unknown'
  // context 域（3 码）
  | 'context.length_exceeded'
  | 'context.compaction_failed'
  | 'context.heal_failed'
  // tool 域（4 码）
  | 'tool.not_found'
  | 'tool.invalid_input'
  | 'tool.execution_failed'
  | 'tool.path_escape'
  // mcp 域（3 码）
  | 'mcp.connection_failed'
  | 'mcp.protocol_violation'
  | 'mcp.server_not_found'
  // store 域（3 码）
  | 'store.write_failed'
  | 'store.read_failed'
  | 'store.corrupted'
  // subagent 域（3 码）
  | 'subagent.depth_exceeded'
  | 'subagent.deadlock_detected'
  | 'subagent.timeout'
  // plugin 域（3 码）
  | 'plugin.not_found'
  | 'plugin.activation_failed'
  | 'plugin.permission_denied'
  // approval 域（2 码）
  | 'approval.timeout'
  | 'approval.rejected'
  // event_store 域（2 码）
  | 'event_store.append_failed'
  | 'event_store.consistency_violation'
  // artifact 域（2 码）
  | 'artifact.not_found'
  | 'artifact.invalid_uri'
  // run 域（3 码）
  | 'run.not_found'
  | 'run.invalid_state'
  | 'run.not_goal_run'
  // network 域（2 码）
  | 'network.unreachable'
  | 'network.daemon_dead'
  // telemetry 域（3 码，含 log.write_failed）
  | 'telemetry.export_failed'
  | 'telemetry.trace_lost'
  | 'log.write_failed'
  // common 域（2 码）
  | 'common.unknown'
  | 'common.unsupported';

/** 故障类别，保留现有 4 类（设计约束 1） */
export type CrishErrorCategory =
  'transient' | 'permanent' | 'security' | 'protocol';

/** 错误域枚举（19 域），用于按域聚合与路由 */
export const CRISH_ERROR_DOMAINS = [
  'config',
  'session',
  'agent',
  'runtime',
  'provider',
  'context',
  'tool',
  'mcp',
  'store',
  'subagent',
  'plugin',
  'approval',
  'event_store',
  'artifact',
  'run',
  'network',
  'telemetry',
  'common',
] as const;

export type CrishErrorDomain = (typeof CRISH_ERROR_DOMAINS)[number];

/** 从错误码提取域前缀 */
export function domainOf(code: CrishErrorCode): CrishErrorDomain {
  return code.split('.')[0] as CrishErrorDomain;
}

/** 判断字符串是否为合法 CrishErrorCode */
export function isCrishErrorCode(value: string): value is CrishErrorCode {
  return /^[a-z_]+\.[a-z_]+$/.test(value);
}
```

**步骤 2：实现 `packages/shared-types/src/errors/info.ts`**

定义 `CrishErrorInfo` 接口与 `CRISH_ERROR_REGISTRY` 静态注册表（60 条），提供 `getErrorInfo()` 查询函数。每条记录的 `title`/`category`/`retryable`/`public`/`action` 字段**逐条对应** `./03-ERROR-MIGRATION.md` §2.2 的表格。

```ts
// packages/shared-types/src/errors/info.ts
// 错误码元信息注册表，来源：./03-ERROR-MIGRATION.md §2.2

import type { CrishErrorCode, CrishErrorCategory } from './codes';

export interface CrishErrorInfo {
  readonly code: CrishErrorCode;
  readonly title: string;
  readonly category: CrishErrorCategory;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action: string;
}

export const CRISH_ERROR_REGISTRY: Readonly<
  Record<CrishErrorCode, CrishErrorInfo>
> = {
  // ── config 域 ──
  'config.invalid': {
    code: 'config.invalid',
    title: '配置项非法',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.config.check_field',
  },
  'config.missing': {
    code: 'config.missing',
    title: '配置缺失',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.config.provide_value',
  },
  'config.parse_failed': {
    code: 'config.parse_failed',
    title: '配置解析失败',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.config.verify_syntax',
  },
  // ── session 域 ──
  'session.not_found': {
    code: 'session.not_found',
    title: '会话未找到',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.session.select_existing',
  },
  'session.invalid_session': {
    code: 'session.invalid_session',
    title: '会话数据非法',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.session.restart',
  },
  'session.invalid_entry': {
    code: 'session.invalid_entry',
    title: '会话条目非法',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.session.check_entry',
  },
  'session.invalid_state': {
    code: 'session.invalid_state',
    title: '会话状态非法',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.session.refresh',
  },
  'session.storage_failed': {
    code: 'session.storage_failed',
    title: '会话存储失败',
    category: 'transient',
    retryable: true,
    public: true,
    action: 'action.session.retry_save',
  },
  // ── agent 域 ──
  'agent.max_turns_reached': {
    code: 'agent.max_turns_reached',
    title: '达到最大轮次',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.agent.increase_max_turns',
  },
  'agent.no_progress': {
    code: 'agent.no_progress',
    title: 'Agent 无进展',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.agent.intervene',
  },
  'agent.intervention_required': {
    code: 'agent.intervention_required',
    title: '需用户介入',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.agent.review',
  },
  // ── runtime 域 ──
  'runtime.unexpected_state': {
    code: 'runtime.unexpected_state',
    title: '运行时状态异常',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.runtime.restart_session',
  },
  'runtime.transition_failed': {
    code: 'runtime.transition_failed',
    title: '状态转移失败',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.runtime.report_bug',
  },
  'runtime.aborted': {
    code: 'runtime.aborted',
    title: '用户中止',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.runtime.none',
  },
  // ── provider 域（12 码）──
  'provider.network': {
    code: 'provider.network',
    title: '网络故障',
    category: 'transient',
    retryable: true,
    public: true,
    action: 'action.provider.check_network',
  },
  'provider.gateway_challenge': {
    code: 'provider.gateway_challenge',
    title: '网关质询拦截',
    category: 'protocol',
    retryable: false,
    public: true,
    action: 'action.provider.disable_proxy',
  },
  'provider.rate_limit': {
    code: 'provider.rate_limit',
    title: '限流',
    category: 'transient',
    retryable: true,
    public: true,
    action: 'action.provider.wait_retry',
  },
  'provider.auth': {
    code: 'provider.auth',
    title: '鉴权失败',
    category: 'security',
    retryable: false,
    public: true,
    action: 'action.provider.check_api_key',
  },
  'provider.quota': {
    code: 'provider.quota',
    title: '配额耗尽',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.provider.top_up',
  },
  'provider.endpoint_unavailable': {
    code: 'provider.endpoint_unavailable',
    title: '端点不可用',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.provider.check_endpoint',
  },
  'provider.schema': {
    code: 'provider.schema',
    title: '请求 schema 非法',
    category: 'protocol',
    retryable: false,
    public: true,
    action: 'action.provider.fix_request',
  },
  'provider.server': {
    code: 'provider.server',
    title: '服务端错误',
    category: 'transient',
    retryable: true,
    public: true,
    action: 'action.provider.wait_retry',
  },
  'provider.timeout': {
    code: 'provider.timeout',
    title: '请求超时',
    category: 'transient',
    retryable: true,
    public: true,
    action: 'action.provider.retry',
  },
  'provider.cancelled': {
    code: 'provider.cancelled',
    title: '请求取消',
    category: 'permanent',
    retryable: false,
    public: false,
    action: 'action.runtime.none',
  },
  'provider.stream_interrupted': {
    code: 'provider.stream_interrupted',
    title: '流中断',
    category: 'transient',
    retryable: true,
    public: true,
    action: 'action.provider.retry',
  },
  'provider.unknown': {
    code: 'provider.unknown',
    title: '未知 Provider 错误',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.provider.report_bug',
  },
  // ── context 域 ──
  'context.length_exceeded': {
    code: 'context.length_exceeded',
    title: '上下文超长',
    category: 'protocol',
    retryable: true,
    public: true,
    action: 'action.context.compact',
  },
  'context.compaction_failed': {
    code: 'context.compaction_failed',
    title: '上下文压缩失败',
    category: 'transient',
    retryable: true,
    public: true,
    action: 'action.context.retry_compact',
  },
  'context.heal_failed': {
    code: 'context.heal_failed',
    title: '上下文修复失败',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.context.manual_trim',
  },
  // ── tool 域（4 码）──
  'tool.not_found': {
    code: 'tool.not_found',
    title: '工具未找到',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.tool.check_name',
  },
  'tool.invalid_input': {
    code: 'tool.invalid_input',
    title: '工具入参非法',
    category: 'protocol',
    retryable: false,
    public: true,
    action: 'action.tool.fix_input',
  },
  'tool.execution_failed': {
    code: 'tool.execution_failed',
    title: '工具执行失败',
    category: 'transient',
    retryable: true,
    public: true,
    action: 'action.tool.retry',
  },
  'tool.path_escape': {
    code: 'tool.path_escape',
    title: '路径越界',
    category: 'security',
    retryable: false,
    public: true,
    action: 'action.tool.check_path',
  },
  // ── mcp 域 ──
  'mcp.connection_failed': {
    code: 'mcp.connection_failed',
    title: 'MCP 连接失败',
    category: 'transient',
    retryable: true,
    public: true,
    action: 'action.mcp.check_server',
  },
  'mcp.protocol_violation': {
    code: 'mcp.protocol_violation',
    title: 'MCP 协议违规',
    category: 'protocol',
    retryable: false,
    public: true,
    action: 'action.mcp.report_bug',
  },
  'mcp.server_not_found': {
    code: 'mcp.server_not_found',
    title: 'MCP 服务器未找到',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.mcp.check_config',
  },
  // ── store 域 ──
  'store.write_failed': {
    code: 'store.write_failed',
    title: '存储写入失败',
    category: 'transient',
    retryable: true,
    public: true,
    action: 'action.store.retry_write',
  },
  'store.read_failed': {
    code: 'store.read_failed',
    title: '存储读取失败',
    category: 'transient',
    retryable: true,
    public: true,
    action: 'action.store.retry_read',
  },
  'store.corrupted': {
    code: 'store.corrupted',
    title: '存储数据损坏',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.store.restore_backup',
  },
  // ── subagent 域 ──
  'subagent.depth_exceeded': {
    code: 'subagent.depth_exceeded',
    title: '子代理递归深度超限',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.subagent.reduce_depth',
  },
  'subagent.deadlock_detected': {
    code: 'subagent.deadlock_detected',
    title: '子代理死锁',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.subagent.break_cycle',
  },
  'subagent.timeout': {
    code: 'subagent.timeout',
    title: '子代理超时',
    category: 'transient',
    retryable: true,
    public: true,
    action: 'action.subagent.retry',
  },
  // ── plugin 域 ──
  'plugin.not_found': {
    code: 'plugin.not_found',
    title: '插件未找到',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.plugin.check_install',
  },
  'plugin.activation_failed': {
    code: 'plugin.activation_failed',
    title: '插件激活失败',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.plugin.check_manifest',
  },
  'plugin.permission_denied': {
    code: 'plugin.permission_denied',
    title: '插件权限不足',
    category: 'security',
    retryable: false,
    public: true,
    action: 'action.plugin.grant_permission',
  },
  // ── approval 域 ──
  'approval.timeout': {
    code: 'approval.timeout',
    title: '审批超时',
    category: 'transient',
    retryable: true,
    public: true,
    action: 'action.approval.resubmit',
  },
  'approval.rejected': {
    code: 'approval.rejected',
    title: '审批被拒',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.approval.modify_request',
  },
  // ── event_store 域 ──
  'event_store.append_failed': {
    code: 'event_store.append_failed',
    title: '事件追加失败',
    category: 'transient',
    retryable: true,
    public: false,
    action: 'action.event_store.retry_append',
  },
  'event_store.consistency_violation': {
    code: 'event_store.consistency_violation',
    title: '事件一致性违规',
    category: 'permanent',
    retryable: false,
    public: false,
    action: 'action.event_store.rebuild_index',
  },
  // ── artifact 域 ──
  'artifact.not_found': {
    code: 'artifact.not_found',
    title: 'Artifact 未找到',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.artifact.check_uri',
  },
  'artifact.invalid_uri': {
    code: 'artifact.invalid_uri',
    title: 'Artifact URI 非法',
    category: 'protocol',
    retryable: false,
    public: true,
    action: 'action.artifact.fix_uri',
  },
  // ── run 域 ──
  'run.not_found': {
    code: 'run.not_found',
    title: 'Run 未找到',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.run.select_existing',
  },
  'run.invalid_state': {
    code: 'run.invalid_state',
    title: 'Run 状态非法',
    category: 'protocol',
    retryable: false,
    public: true,
    action: 'action.run.refresh',
  },
  'run.not_goal_run': {
    code: 'run.not_goal_run',
    title: '非 Goal Run',
    category: 'protocol',
    retryable: false,
    public: true,
    action: 'action.run.use_goal_run',
  },
  // ── network 域 ──
  'network.unreachable': {
    code: 'network.unreachable',
    title: '网络不可达',
    category: 'transient',
    retryable: true,
    public: true,
    action: 'action.network.check_connection',
  },
  'network.daemon_dead': {
    code: 'network.daemon_dead',
    title: '后台 Daemon 已死',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.network.restart_daemon',
  },
  // ── telemetry 域（含 log.write_failed）──
  'telemetry.export_failed': {
    code: 'telemetry.export_failed',
    title: '观测数据导出失败',
    category: 'transient',
    retryable: true,
    public: false,
    action: 'action.telemetry.retry_export',
  },
  'telemetry.trace_lost': {
    code: 'telemetry.trace_lost',
    title: 'Trace 丢失',
    category: 'transient',
    retryable: true,
    public: false,
    action: 'action.telemetry.none',
  },
  'log.write_failed': {
    code: 'log.write_failed',
    title: '日志写入失败',
    category: 'transient',
    retryable: true,
    public: false,
    action: 'action.log.retry_write',
  },
  // ── common 域 ──
  'common.unknown': {
    code: 'common.unknown',
    title: '未知错误',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.common.report_bug',
  },
  'common.unsupported': {
    code: 'common.unsupported',
    title: '不支持的操作',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.common.check_version',
  },
};

/** 查询错误码元信息，未知码回退到 common.unknown */
export function getErrorInfo(code: CrishErrorCode): CrishErrorInfo {
  return CRISH_ERROR_REGISTRY[code] ?? CRISH_ERROR_REGISTRY['common.unknown'];
}

/** 按域聚合错误码（用于分组展示与路由） */
export function codesByDomain(domain: string): CrishErrorCode[] {
  return (Object.keys(CRISH_ERROR_REGISTRY) as CrishErrorCode[]).filter((c) =>
    c.startsWith(domain + '.')
  );
}
```

**步骤 3：编译验证**

在 `packages/shared-types` 目录执行 `npx tsc --noEmit`，确认 `codes.ts` 与 `info.ts` 无新增 TSC 错误（不恶化基线）。重点检查：

- `verbatimModuleSyntax`（TS1484）：所有类型导入使用 `import type`
- `exactOptionalPropertyTypes`（TS2375）：可选字段使用 `?:` 而非 `| undefined`
- 注册表 60 条记录的 key 与 `CrishErrorCode` 联合类型完全匹配（穷尽性检查）

#### 输出

| 文件                                        | 行数预估 | 内容                                                                  |
| ------------------------------------------- | -------- | --------------------------------------------------------------------- |
| `packages/shared-types/src/errors/codes.ts` | ~90 行   | `CrishErrorCode` 联合类型 + `CrishErrorCategory` + 域工具函数         |
| `packages/shared-types/src/errors/info.ts`  | ~110 行  | `CrishErrorInfo` 接口 + `CRISH_ERROR_REGISTRY` 60 条 + `getErrorInfo` |

#### 验证标准

1. `CRISH_ERROR_REGISTRY` 的 key 数量 = 60，且与 `CrishErrorCode` 联合类型成员一一对应（编译器穷尽性检查通过）
2. 每条记录的 `category`/`retryable`/`public`/`action` 与 `./03-ERROR-MIGRATION.md` §2.2 表格完全一致
3. `getErrorInfo("nonexistent" as CrishErrorCode)` 回退到 `common.unknown`（运行时安全）
4. `npx tsc --noEmit` 在 shared-types 包内无新增错误

---

### 2.3 Agent 1-C：CrishError 基类扩展 + CrishResult ADT

#### 输入

- `./03-ERROR-MIGRATION.md` §2.3（CrishErrorInfo）、附录 A（CrishError 扩展构造函数）、§5.1（CrishResult 使用策略）、§5.2（CrishResult 工具函数签名）、附录 C（子类迁移）
- Agent 1-B 产出：`errors/codes.ts`、`errors/info.ts`
- 现有 `packages/shared-types/src/errors.ts`（81 行，5 个类 + SessionErrorCode）
- 现有 `packages/shared-types/src/primitive-types.ts`（`JsonObject`）

#### 任务步骤

**步骤 1：实现 `packages/shared-types/src/errors/classes.ts`（新 CrishError 基类）**

扩展现有 `CrishError`，新增 `cause`/`public`/`action` 字段，`code` 字段接受 `CrishErrorCode | string`（共存，`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 23）。构造函数签名遵循 `./03-ERROR-MIGRATION.md` 附录 A。

```ts
// packages/shared-types/src/errors/classes.ts
import type { JsonObject } from '../primitive-types';
import type { CrishErrorCode, CrishErrorCategory } from './codes';
import { CRISH_ERROR_REGISTRY, getErrorInfo } from './info';

/**
 * Crish 错误基类（扩展版）。
 *
 * 共存阶段：code 字段接受新 CrishErrorCode 或旧裸 string。
 * 旧调用 `new CrishError(msg, "TOOL_ERROR", "permanent", false)` 继续工作。
 * 新调用 `new CrishError(msg, "tool.path_escape", "security", false, meta, { cause })`。
 *
 * 权威定义：./03-ERROR-MIGRATION.md 附录 A
 */
export class CrishError extends Error {
  readonly code: CrishErrorCode | string;
  readonly category: CrishErrorCategory;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action: string;
  readonly metadata?: JsonObject | undefined;
  readonly cause?: CrishError | undefined;

  constructor(
    message: string,
    code: CrishErrorCode | string,
    category: CrishErrorCategory,
    retryable: boolean,
    metadata?: JsonObject,
    options?: { cause?: CrishError; public?: boolean; action?: string }
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined
    );
    this.code = code;
    this.category = category;
    this.retryable = retryable;
    this.metadata = metadata;
    this.cause = options?.cause;
    // 旧码（不在注册表内）回退到 common.unknown 的元信息
    const info =
      typeof code === 'string' &&
      Object.prototype.hasOwnProperty.call(CRISH_ERROR_REGISTRY, code)
        ? CRISH_ERROR_REGISTRY[code as CrishErrorCode]
        : CRISH_ERROR_REGISTRY['common.unknown'];
    this.public = options?.public ?? info.public;
    this.action = options?.action ?? info.action;
    this.name = 'CrishError';
  }
}

/**
 * Provider 错误（deprecated 适配层，共存阶段保留）。
 * 迁移阶段构造函数改为接受 CrishErrorCode（provider.* 域）。
 * 删除阶段（Round 12）移除，统一用 CrishError(code="provider.*")。
 * @deprecated 改用 `new CrishError(msg, "provider.*", "transient"|"protocol"|"security", retryable)`
 */
export class ProviderError extends CrishError {
  constructor(
    message: string,
    code: string,
    retryable: boolean,
    metadata?: JsonObject
  ) {
    super(message, code, 'transient', retryable, metadata);
    this.name = 'ProviderError';
  }
}

/**
 * 权限错误（deprecated 适配层）。
 * @deprecated 改用 `new CrishError(msg, "plugin.permission_denied"|"tool.path_escape", "security", false)`
 */
export class PermissionError extends CrishError {
  constructor(message: string, code: string, metadata?: JsonObject) {
    super(message, code, 'security', false, metadata);
    this.name = 'PermissionError';
  }
}

/**
 * 会话错误（deprecated 适配层）。
 * @deprecated 改用 `new CrishError(msg, "session.*", "permanent"|"transient", retryable)`
 */
export class SessionError extends CrishError {
  constructor(message: string, code: SessionErrorCode, metadata?: JsonObject) {
    super(message, code, 'permanent', false, metadata);
    this.name = 'SessionError';
  }
}

/**
 * 协议错误（deprecated 适配层）。
 * @deprecated 改用 `new CrishError(msg, "*.invalid_*"|"*.protocol_violation", "protocol", false)`
 */
export class ProtocolError extends CrishError {
  constructor(message: string, code: string, metadata?: JsonObject) {
    super(message, code, 'protocol', false, metadata);
    this.name = 'ProtocolError';
  }
}

/** 旧 SessionErrorCode 类型（deprecated，删除阶段移除） */
export type SessionErrorCode =
  | 'not_found'
  | 'invalid_session'
  | 'invalid_entry'
  | 'invalid_state'
  | 'storage';
```

**步骤 2：实现 `packages/shared-types/src/errors/result.ts`（CrishResult ADT）**

实现 `CrishResult<T, E>` 判别联合与 11 个工具函数，签名严格遵循 `./03-ERROR-MIGRATION.md` §5.2。

```ts
// packages/shared-types/src/errors/result.ts
// CrishResult ADT，权威定义：./03-ERROR-MIGRATION.md §5.2

import type { CrishError } from './classes';

/**
 * 不可变判别联合。readonly 字段避免误改。
 * 使用策略见 ./03-ERROR-MIGRATION.md §5.1：
 * - 公共 API 边界 / 异步流式 / 状态机转移 / 工具执行 / 审批决策 → 返回 CrishResult
 * - 内部辅助函数 / 入参校验 / 不可恢复错误 → throw
 */
export type CrishResult<T, E extends CrishError = CrishError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

// ── 构造 ──
export function ok<T>(value: T): CrishResult<T, never>;
export function ok(): CrishResult<void, never>;
export function ok<T>(value?: T): CrishResult<T | void, never> {
  return { ok: true, value };
}

export function err<E extends CrishError>(error: E): CrishResult<never, E> {
  return { ok: false, error };
}

// ── 提取 ──
export function getOrThrow<T, E extends CrishError>(
  result: CrishResult<T, E>
): T {
  if (result.ok) return result.value;
  throw result.error;
}

export function unwrapOr<T, E extends CrishError>(
  result: CrishResult<T, E>,
  fallback: T
): T {
  return result.ok ? result.value : fallback;
}

// ── 转换 ──
export function mapResult<T, U, E extends CrishError>(
  result: CrishResult<T, E>,
  fn: (value: T) => U
): CrishResult<U, E> {
  return result.ok ? { ok: true, value: fn(result.value) } : result;
}

export function flatMapResult<
  T,
  U,
  E extends CrishError,
  E2 extends CrishError,
>(
  result: CrishResult<T, E>,
  fn: (value: T) => CrishResult<U, E2>
): CrishResult<U, E | E2> {
  return result.ok ? fn(result.value) : result;
}

/** 对 error 分支做转换（不改变 ok 分支） */
export function mapErr<T, E extends CrishError, E2 extends CrishError>(
  result: CrishResult<T, E>,
  fn: (error: E) => E2
): CrishResult<T, E2> {
  return result.ok ? result : { ok: false, error: fn(result.error) };
}

// ── 模式匹配 ──
export function match<T, U, E extends CrishError>(
  result: CrishResult<T, E>,
  handlers: { ok: (value: T) => U; err: (error: E) => U }
): U {
  return result.ok ? handlers.ok(result.value) : handlers.err(result.error);
}

// ── 守卫 ──
export function isOk<T, E extends CrishError>(
  result: CrishResult<T, E>
): result is { ok: true; value: T } {
  return result.ok;
}

export function isErr<T, E extends CrishError>(
  result: CrishResult<T, E>
): result is { ok: false; error: E } {
  return !result.ok;
}

// ── Promise 互转 ──
/**
 * 捕获 rejected promise 并包装为 CrishError（未知错误用 common.unknown）。
 * resolved → ok(value)，rejected → err(CrishError)
 */
export async function fromPromise<T>(
  promise: Promise<T>
): Promise<CrishResult<T, CrishError>> {
  try {
    const value = await promise;
    return { ok: true, value };
  } catch (e) {
    const error =
      e instanceof CrishError
        ? e
        : new CrishError(
            e instanceof Error ? e.message : String(e),
            'common.unknown',
            'permanent',
            false
          );
    return { ok: false, error };
  }
}

/**
 * 反向操作：ok 解包为 resolved，err 转为 rejected。
 * 用于必须 throw 的边界（如 React 事件处理器）。
 */
export function promiseResult<T, E extends CrishError>(
  result: CrishResult<T, E>
): Promise<T> {
  return result.ok
    ? Promise.resolve(result.value)
    : Promise.reject(result.error);
}
```

**步骤 3：将旧 `packages/shared-types/src/errors.ts` 转为 deprecated re-export shim**

由于新代码移入 `errors/` 子目录，旧 `errors.ts` 必须转为 re-export shim，保持现有 `import { CrishError } from "./errors"` 与 `import { CrishError } from "@crish/shared-types"` 两条导入路径继续工作。

> **模块解析说明**：TypeScript 中 `./errors` 会优先解析到 `errors.ts` 文件；若该文件被删除则解析到 `errors/index.ts`。为避免歧义，保留 `errors.ts` 作为 shim，由它 re-export `./errors/index` 的全部符号。`errors/index.ts` 由本步骤创建（见步骤 4）。

```ts
// packages/shared-types/src/errors.ts （转为 deprecated re-export shim）
/**
 * @deprecated 本文件已转为 re-export shim。新代码请直接从 @crish/shared-types 根导出引用，
 * 或从 "./errors/classes" 等子模块导入。本 shim 在 Round 12（删除阶段）移除。
 */
export {
  CrishError,
  ProviderError,
  PermissionError,
  SessionError,
  ProtocolError,
} from './errors/classes';
export type { SessionErrorCode } from './errors/classes';
export type {
  CrishErrorCode,
  CrishErrorCategory,
  CrishErrorDomain,
} from './errors/codes';
export type { CrishErrorInfo } from './errors/info';
export {
  CRISH_ERROR_REGISTRY,
  getErrorInfo,
  codesByDomain,
} from './errors/info';
export type { CrishResult } from './errors/result';
export {
  ok,
  err,
  getOrThrow,
  unwrapOr,
  mapResult,
  flatMapResult,
  mapErr,
  match,
  isOk,
  isErr,
  fromPromise,
  promiseResult,
} from './errors/result';
export type { CrishErrorPayload } from './errors/serialize';
export {
  toErrorPayload,
  fromErrorPayload,
  makeErrorPayload,
  fromUnknownError,
  codeFromHttpStatus,
} from './errors/serialize';
export {
  normalizeCrishError,
  isCrishError,
  migrateErrorCode,
} from './errors/normalize';
```

**步骤 4：创建 `packages/shared-types/src/errors/index.ts`（barrel）**

汇总 Agent 1-B/1-C/1-D 的全部导出，供 `errors.ts` shim 与根 `index.ts` 引用。

```ts
// packages/shared-types/src/errors/index.ts
export * from './codes';
export * from './info';
export * from './classes';
export * from './result';
export * from './serialize';
export * from './normalize';
```

#### 输出

| 文件                                          | 行数预估 | 内容                                                    |
| --------------------------------------------- | -------- | ------------------------------------------------------- |
| `packages/shared-types/src/errors/classes.ts` | ~110 行  | 新 CrishError + 4 个 deprecated 子类 + SessionErrorCode |
| `packages/shared-types/src/errors/result.ts`  | ~120 行  | CrishResult ADT + 11 工具函数                           |
| `packages/shared-types/src/errors/index.ts`   | ~8 行    | barrel                                                  |
| `packages/shared-types/src/errors.ts`         | ~25 行   | 转为 deprecated re-export shim                          |

#### 验证标准

1. 现有调用 `new CrishError(msg, "TOOL_ERROR", "permanent", false)` 编译通过且运行时不报错（向后兼容）
2. 新调用 `new CrishError(msg, "tool.path_escape", "security", false, meta, { cause })` 编译通过
3. `ok(42)` 推断为 `CrishResult<number, never>`，`err(new CrishError(...))` 推断为 `CrishResult<never, CrishError>`
4. `fromPromise(Promise.resolve(1))` 返回 `Promise<CrishResult<number, CrishError>>`，`ok: true`
5. `fromPromise(Promise.reject(new Error("x")))` 返回 `err` 分支，`error.code === "common.unknown"`
6. `npx tsc --noEmit` 在 shared-types 包内错误数不恶化（≤ 基线）

---

### 2.4 Agent 1-D：CrishErrorPayload 跨进程序列化 + normalize

#### 输入

- `./03-ERROR-MIGRATION.md` §6.1（TS 端 CrishErrorPayload 接口 + toErrorPayload/fromUnknownError + codeFromHttpStatus 静态映射表）、§3（旧码→新码迁移映射）、附录 B（migrateErrorCode 函数签名）
- Agent 1-B 产出：`errors/codes.ts`、`errors/info.ts`
- Agent 1-C 产出：`errors/classes.ts`（CrishError 类）
- 现有 `packages/shared-types/src/primitive-types.ts`（`JsonObject`）

#### 任务步骤

**步骤 1：实现 `packages/shared-types/src/errors/serialize.ts`（CrishErrorPayload + 序列化函数）**

接口定义严格遵循 `./03-ERROR-MIGRATION.md` §6.1。递归 cause 最多 8 层（设计约束 3）。`HTTP_STATUS_TO_CODE` 静态映射表替代 if-else 分支，从结构上消除 `CrishRestError` 死代码模式（§6.1 设计要点 4）。

```ts
// packages/shared-types/src/errors/serialize.ts
// 权威定义：./03-ERROR-MIGRATION.md §6.1
import type { JsonObject } from '../primitive-types';
import type { CrishErrorCode, CrishErrorCategory } from './codes';
import { getErrorInfo, isCrishErrorCode } from './info';
import { CrishError } from './classes';

/** 跨进程序列化的错误负载（TS ↔ Rust ↔ 前端） */
export interface CrishErrorPayload {
  readonly code: CrishErrorCode;
  readonly message: string;
  readonly category: CrishErrorCategory;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action: string;
  readonly metadata?: JsonObject | undefined;
  /** 递归因果链，最多 8 层 */
  readonly cause?: CrishErrorPayload | undefined;
  /** 调用栈（仅开发环境，生产环境置空） */
  readonly stack?: string | undefined;
  /** 时间戳（epoch ms） */
  readonly timestamp: number;
}

/** 递归深度上限（设计约束 3） */
export const CRISH_ERROR_CAUSE_MAX_DEPTH = 8;

/** 从 CrishError 构造 Payload，自动截断 cause 链到 8 层 */
export function toErrorPayload(
  error: CrishError,
  depth = 0
): CrishErrorPayload {
  if (depth >= CRISH_ERROR_CAUSE_MAX_DEPTH) {
    return truncatedPayload(error, depth);
  }
  const code = isCrishErrorCode(error.code) ? error.code : 'common.unknown';
  const info = getErrorInfo(code);
  const payload: CrishErrorPayload = {
    code,
    message: error.message,
    category: error.category,
    retryable: error.retryable,
    public: error.public,
    action: error.action,
    timestamp: Date.now(),
  };
  if (error.metadata !== undefined) {
    payload.metadata = error.metadata;
  }
  if (error.cause instanceof CrishError) {
    payload.cause = toErrorPayload(error.cause, depth + 1);
  }
  if (process.env.NODE_ENV !== 'production') {
    payload.stack = error.stack;
  }
  return payload;
}

/** 从 CrishErrorPayload 还原为 CrishError 实例（前端 invoke catch 后使用） */
export function fromErrorPayload(payload: CrishErrorPayload): CrishError {
  const cause =
    payload.cause !== undefined ? fromErrorPayload(payload.cause) : undefined;
  return new CrishError(
    payload.message,
    payload.code,
    payload.category,
    payload.retryable,
    payload.metadata,
    { cause, public: payload.public, action: payload.action }
  );
}

/** 从任意值构造 Payload（兜底，未知错误用 common.unknown） */
export function fromUnknownError(error: unknown): CrishErrorPayload {
  if (error instanceof CrishError) return toErrorPayload(error);
  const payload: CrishErrorPayload = {
    code: 'common.unknown',
    message: error instanceof Error ? error.message : String(error),
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.common.report_bug',
    timestamp: Date.now(),
  };
  if (error instanceof Error && error.stack !== undefined) {
    payload.stack = error.stack;
  }
  return payload;
}

/**
 * 从未知错误构造 Payload 的工厂别名。
 * 与 fromUnknownError 语义相同，提供给偏好工厂函数命名的调用方。
 */
export function makeErrorPayload(error: unknown): CrishErrorPayload {
  return fromUnknownError(error);
}

/** 深度截断时的占位 Payload */
function truncatedPayload(error: CrishError, depth: number): CrishErrorPayload {
  return {
    code: 'common.unknown',
    message: `cause chain truncated at depth ${depth}`,
    category: 'permanent',
    retryable: false,
    public: false,
    action: 'action.runtime.none',
    timestamp: Date.now(),
  };
}

/**
 * HTTP 状态码 → CrishErrorCode 静态映射表。
 * 替代 if-else 分支，从结构上消除 CrishRestError 死代码模式（§6.1 设计要点 4）。
 * 权威定义：./03-ERROR-MIGRATION.md §6.1
 */
const HTTP_STATUS_TO_CODE: Readonly<Record<number, CrishErrorCode>> = {
  400: 'provider.schema',
  401: 'provider.auth',
  402: 'provider.quota',
  403: 'provider.auth',
  404: 'provider.endpoint_unavailable',
  405: 'provider.endpoint_unavailable',
  413: 'provider.schema',
  415: 'provider.endpoint_unavailable',
  422: 'provider.schema',
  429: 'provider.rate_limit',
  500: 'provider.server',
  502: 'provider.server',
  503: 'provider.server',
  504: 'provider.server',
  520: 'provider.server',
  522: 'provider.server',
  523: 'provider.server',
  524: 'provider.server',
};

export function codeFromHttpStatus(status: number): CrishErrorCode {
  return HTTP_STATUS_TO_CODE[status] ?? 'common.unknown';
}
```

**步骤 2：实现 `packages/shared-types/src/errors/normalize.ts`（normalize + isCrishError + migrateErrorCode）**

`migrateErrorCode()` 函数签名严格遵循 `./03-ERROR-MIGRATION.md` 附录 B，覆盖 §3.1（SessionErrorCode）、§3.3（ProviderErrorKind）、§3.4（自由字符串码含 TOOL_ERROR 拆分）、§3.2（ErrorDomain）四类旧码映射。

```ts
// packages/shared-types/src/errors/normalize.ts
// 权威定义：./03-ERROR-MIGRATION.md 附录 B、§3
import type { CrishErrorCode } from './codes';
import { CrishError } from './classes';

/**
 * 旧错误码 → 新 CrishErrorCode 映射。
 * 覆盖：SessionErrorCode、ProviderErrorKind、自由字符串码（含 TOOL_ERROR 拆分）、ErrorDomain。
 * 权威定义：./03-ERROR-MIGRATION.md §3 + 附录 B
 *
 * @param legacyCode 旧错误码字符串
 * @param context 拆分上下文（仅 TOOL_ERROR / ARTIFACT_ERROR / ADAPTER_ERROR / CLIENT_INVALID_INPUT 需要）
 */
export function migrateErrorCode(
  legacyCode: string,
  context?: {
    kind?: 'path' | 'input' | 'not_found' | 'execution';
    subType?: string;
  }
): CrishErrorCode {
  // ── SessionErrorCode（§3.1）──
  switch (legacyCode) {
    case 'not_found':
      return 'session.not_found';
    case 'invalid_session':
      return 'session.invalid_session';
    case 'invalid_entry':
      return 'session.invalid_entry';
    case 'invalid_state':
      return 'session.invalid_state';
    case 'storage':
      return 'session.storage_failed';
  }
  // ── ProviderErrorKind（§3.3）──
  switch (legacyCode) {
    case 'network':
      return 'provider.network';
    case 'gateway-challenge':
      return 'provider.gateway_challenge';
    case 'rate-limit':
      return 'provider.rate_limit';
    case 'auth':
      return 'provider.auth';
    case 'quota':
      return 'provider.quota';
    case 'endpoint-unavailable':
      return 'provider.endpoint_unavailable';
    case 'schema':
      return 'provider.schema';
    case 'server':
      return 'provider.server';
    case 'timeout':
      return 'provider.timeout';
    case 'cancelled':
      return 'provider.cancelled';
    case 'invalid-stream':
      return 'provider.stream_interrupted';
    case 'unknown':
      return 'provider.unknown';
  }
  // ── 自由字符串码（§3.4）──
  switch (legacyCode) {
    case 'CONFIG_ERROR':
      return 'config.invalid';
    case 'CHECKPOINT_ERROR':
      return 'store.corrupted';
    case 'BOUNDARY_ERROR':
      return 'store.corrupted';
    case 'ARTIFACT_ERROR':
      return context?.kind === 'not_found'
        ? 'artifact.not_found'
        : 'artifact.invalid_uri';
    case 'ADAPTER_ERROR':
      return context?.kind === 'not_found'
        ? 'artifact.not_found'
        : 'store.corrupted';
    case 'SCOPED_CONTEXT_ERROR':
      return 'store.corrupted';
    case 'DAEMON_DEAD':
      return 'network.daemon_dead';
    case 'NETWORK_ERROR':
      return 'provider.network';
    case 'INVALID_RUN_STATE':
      return 'run.invalid_state';
    case 'NOT_A_GOAL_RUN':
      return 'run.not_goal_run';
    case 'DAEMON_ERROR':
      return 'network.daemon_dead';
  }
  // ── TOOL_ERROR 按 context.kind 拆分（§3.4，49 处 → 4 码）──
  if (legacyCode === 'TOOL_ERROR') {
    switch (context?.kind) {
      case 'path':
        return 'tool.path_escape';
      case 'input':
        return 'tool.invalid_input';
      case 'not_found':
        return 'tool.not_found';
      case 'execution':
        return 'tool.execution_failed';
      default:
        return 'tool.execution_failed';
    }
  }
  // ── ErrorDomain 枚举值（§3.2）──
  switch (legacyCode) {
    case 'USER_ABORT':
      return 'runtime.aborted';
    case 'TRANSIENT_NETWORK':
      return 'provider.network';
    case 'TRANSIENT_SERVER':
      return 'provider.server';
    case 'RATE_LIMIT':
      return 'provider.rate_limit';
    case 'CLIENT_AUTH':
      return 'provider.auth';
    case 'CLIENT_INVALID_INPUT':
      return context?.subType === 'context_length_exceeded'
        ? 'context.length_exceeded'
        : 'provider.schema';
    case 'QUOTA_EXHAUSTED':
      return 'provider.quota';
    case 'STREAM_INTERRUPT':
      return 'provider.stream_interrupted';
    case 'ENDPOINT_UNAVAILABLE':
      return 'provider.endpoint_unavailable';
    case 'GATEWAY_CHALLENGE':
      return 'provider.gateway_challenge';
    case 'UNKNOWN':
      return 'common.unknown';
  }
  return 'common.unknown';
}

/** 类型守卫：判断未知值是否为 CrishError 实例 */
export function isCrishError(value: unknown): value is CrishError {
  return value instanceof CrishError;
}

/**
 * 标准化函数：将任意错误（Error/CrishError/未知值）归一为 CrishError。
 * - CrishError 直接返回
 * - Error 用 common.unknown 包装（保留 cause）
 * - 其他值用 String() 转为 message
 */
export function normalizeCrishError(error: unknown): CrishError {
  if (error instanceof CrishError) return error;
  if (error instanceof Error) {
    return new CrishError(
      error.message,
      'common.unknown',
      'permanent',
      false,
      undefined,
      { cause: undefined }
    );
  }
  return new CrishError(String(error), 'common.unknown', 'permanent', false);
}
```

**步骤 3：编译验证**

在 `packages/shared-types` 执行 `npx tsc --noEmit`，重点检查：

- `exactOptionalPropertyTypes`：`metadata?`/`cause?`/`stack?` 字段赋值时用 `if !== undefined` 守卫，不能直接赋 `undefined`
- `verbatimModuleSyntax`：`import type` 用于纯类型导入
- `toErrorPayload` 递归深度截断逻辑正确（`depth >= 8` 返回 truncatedPayload）

#### 输出

| 文件                                            | 行数预估 | 内容                                                          |
| ----------------------------------------------- | -------- | ------------------------------------------------------------- |
| `packages/shared-types/src/errors/serialize.ts` | ~130 行  | CrishErrorPayload 接口 + 5 个序列化函数 + HTTP_STATUS_TO_CODE |
| `packages/shared-types/src/errors/normalize.ts` | ~110 行  | migrateErrorCode + isCrishError + normalizeCrishError         |

#### 验证标准

1. `toErrorPayload` 对深度 > 8 的 cause 链返回 `truncatedPayload`（code=`common.unknown`，message 含 "truncated at depth 8"）
2. `fromErrorPayload(toErrorPayload(err))` 还原的 CrishError 的 `code`/`message`/`category` 与原 error 一致
3. `codeFromHttpStatus(429)` === `"provider.rate_limit"`，`codeFromHttpStatus(999)` === `"common.unknown"`
4. `migrateErrorCode("TOOL_ERROR", { kind: "path" })` === `"tool.path_escape"`，`migrateErrorCode("TOOL_ERROR")` === `"tool.execution_failed"`（默认）
5. `migrateErrorCode("not_found")` === `"session.not_found"`（SessionErrorCode 映射）
6. `isCrishError(new CrishError(...))` === `true`，`isCrishError(new Error("x"))` === `false`
7. `npx tsc --noEmit` 在 shared-types 包内错误数不恶化

---

### 2.5 Agent 1-E：子代理 & 插件类型定义 + shared-types index 更新

#### 输入

- `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 14（钩子系统约束：observe/on 双模式）、禁令 15/16/17（PluginManifest 约束：声明式能力清单、handlerType 仅 sync/async、PluginOrigin 仅 user-dir+project-dir）、禁令 18（信任模型：restricted/full 两级）、禁令 21（SubagentRole：role 为标签、capabilityMode 控制权限）、ROUND-09 §3.2 DEFAULT_RECURSION_GUARD（递归守卫默认值）
- Agent 1-B/1-C/1-D 产出（errors 子目录全部文件）
- 现有 `packages/shared-types/src/index.ts`、`packages/shared-types/src/permissions.ts`

#### 任务步骤

**步骤 1：实现 `packages/shared-types/src/subagent.ts`（子代理类型定义）**

遵循 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 21（role 为标签、capabilityMode 控制权限，禁止双重维度）与 ROUND-09 §3.2 DEFAULT_RECURSION_GUARD（递归守卫默认值权威表）。

```ts
// packages/shared-types/src/subagent.ts
// 约束来源：ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 20-22 与本 Round 推迟项

/** 子代理角色（标签，仅用于展示与过滤，不影响调度）— 禁令 21 */
export type SubagentRole =
  'researcher' | 'implementer' | 'reviewer' | 'debugger' | 'planner';

/**
 * 能力模式（控制实际权限）— 禁令 21
 * 调度器只看 capabilityMode，role 是元数据。
 * 禁止 role 与 capabilityMode 并存的"双重维度"。
 */
export type SubagentCapabilityMode =
  'read-only' | 'read-write' | 'execute' | 'all';

/** 子代理状态机（ROUND-09 §3 简化为 4 状态，pause/resuming 推迟） */
export type SubagentState = 'pending' | 'running' | 'completed' | 'failed';

/** 隔离模式（ROUND-09 §3 第一版仅 none，worktree/process 推迟） */
export type SubagentIsolationMode = 'none';

/** 递归守卫配置（ROUND-09 §3.2 唯一权威默认值） */
export interface RecursionGuardConfig {
  /** 最大递归深度，默认 3 */
  readonly maxDepth: number;
  /** 最大兄弟并发数，默认 5 */
  readonly maxSiblings: number;
  /** 最大全局并发数，默认 6 */
  readonly maxConcurrent: number;
  /** 全局 token 预算，默认 0（不限制，ROUND-09 §3 推迟组件） */
  readonly totalTokenBudget: number;
  /** 全局超时，默认 0（不限制，依赖每个子代理的 timeoutMs） */
  readonly totalTimeoutMs: number;
}

export const DEFAULT_RECURSION_GUARD: Readonly<RecursionGuardConfig> = {
  maxDepth: 3,
  maxSiblings: 5,
  maxConcurrent: 6,
  totalTokenBudget: 0,
  totalTimeoutMs: 0,
};

/** 子代理定义（由插件 manifest 的 agents 字段声明，禁令 22） */
export interface SubagentDefinition {
  /** 子代理类型标识（唯一） */
  readonly id: string;
  /** 展示名 */
  readonly name: string;
  /** 角色标签（禁令 21） */
  readonly role: SubagentRole;
  /** 能力模式（禁令 21，控制实际权限） */
  readonly capabilityMode: SubagentCapabilityMode;
  /** 系统提示词 */
  readonly systemPrompt: string;
  /** 单次执行超时（ms），0 表示不限制 */
  readonly timeoutMs: number;
  /** 允许调用的工具白名单，undefined 表示继承父代理全部工具 */
  readonly allowedTools?: readonly string[];
  /** 隔离模式（ROUND-09 §3，第一版仅 none） */
  readonly isolationMode?: SubagentIsolationMode;
}

/** 子代理实例运行时状态（SubagentInstance 的一部分，Round 9 完整实现） */
export interface SubagentInstanceSnapshot {
  readonly instanceId: string;
  readonly parentSessionId: string;
  readonly definitionId: string;
  readonly state: SubagentState;
  readonly startedAt: number;
  readonly ancestors: readonly string[];
}

/** 死锁检测输入（ROUND-09 §3，spawn 时 O(depth) 检查祖先链） */
export interface DeadlockCheckInput {
  readonly targetSessionId: string;
  readonly ancestorSessionIds: readonly string[];
}
```

**步骤 2：实现 `packages/shared-types/src/plugin.ts`（PluginManifest 类型）**

遵循 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 15/16/17（声明式能力清单、handlerType 仅 sync/async、PluginOrigin 仅 user-dir+project-dir）、禁令 18（信任模型 restricted/full 两级，禁止 sandboxed）、禁令 19（OAuth 与 HotReload 推迟）。

```ts
// packages/shared-types/src/plugin.ts
// 约束来源：ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 13-19

/** 插件来源（禁令 17 精简为 2 种，npm/global-dir 推迟到 Phase 2） */
export type PluginOrigin = 'user-dir' | 'project-dir';

/** 信任级别（禁令 18 两级，禁止 sandboxed） */
export type PluginTrustLevel = 'restricted' | 'full';

/** 钩子处理器类型（禁令 16 仅 sync/async，禁止 command/webhook） */
export type HookHandlerType = 'sync' | 'async';

/** 钩子失败策略 */
export type HookFailStrategy = 'swallow' | 'propagate' | 'log';

/** 权限粒度（禁令 18 合并：file:read+file:write→file:access，shell:execute→tool:execute） */
export type PluginPermission =
  | 'file:access'
  | 'tool:execute'
  | 'hook:observe'
  | 'hook:intercept'
  | 'mcp:register'
  | 'subagent:spawn';

/** 插件 manifest（禁令 15 声明式能力清单） */
export interface PluginManifest {
  /** 插件唯一 ID */
  readonly id: string;
  /** 展示名 */
  readonly name: string;
  /** 版本（semver） */
  readonly version: string;
  /** 来源（禁令 17） */
  readonly origin: PluginOrigin;
  /** 信任级别（禁令 18） */
  readonly trustLevel: PluginTrustLevel;
  /** 入口模块路径（相对插件根目录） */
  readonly entry: string;
  /** 声明注册的钩子事件名清单（禁令 15，实际注册通过 activate(api)） */
  readonly declaredHooks: readonly string[];
  /** 声明注册的工具名清单（禁令 15） */
  readonly declaredTools: readonly string[];
  /** 声明注册的 MCP 服务器名清单（禁令 15） */
  readonly declaredMcpServers: readonly string[];
  /** 声明提供的子代理定义 ID 清单（禁令 22） */
  readonly declaredAgents: readonly string[];
  /** 申请的权限清单（禁令 15） */
  readonly permissions: readonly PluginPermission[];
  /** 最低宿主版本（可选） */
  readonly minHostVersion?: string;
}

/** 插件激活上下文（activate(api) 的 api 参数，Round 8 完整实现） */
export interface PluginActivationApi {
  readonly pluginId: string;
  /** 注册钩子处理器（命令式，必须在 manifest.declaredHooks 内） */
  readonly on: (event: string, handler: PluginHookHandler) => void;
  readonly observe: (event: string, handler: PluginHookHandler) => void;
  /** 注册工具（命令式，必须在 manifest.declaredTools 内） */
  readonly registerTool: (tool: PluginToolDeclaration) => void;
  /** 注册 MCP 服务器（禁令 13，通过 agent-mcp 的 registerPluginServer 入口） */
  readonly registerMcpServer: (
    name: string,
    declaration: PluginMcpDeclaration
  ) => void;
}

/** 钩子处理器（observe/on 双模式，禁令 14） */
export interface PluginHookHandler {
  readonly handlerType: HookHandlerType;
  readonly failStrategy?: HookFailStrategy;
  readonly timeoutMs?: number;
  readonly fn: (payload: unknown) => unknown | Promise<unknown>;
}

/** 控制型钩子返回信号（禁令 14，on 模式） */
export type HookControlSignal =
  | { readonly type: 'continue' }
  | { readonly type: 'stop' }
  | { readonly type: 'block'; readonly reason: string }
  | { readonly type: 'modifiedInput'; readonly input: unknown }
  | { readonly type: 'modifiedOutput'; readonly output: unknown };

/** 插件工具声明（骨架，Round 8 完整） */
export interface PluginToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/** 插件 MCP 服务器声明（骨架，Round 8 完整） */
export interface PluginMcpDeclaration {
  readonly transport: 'stdio';
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** 已激活插件实例 */
export interface ActivatedPlugin {
  readonly manifest: PluginManifest;
  readonly activatedAt: number;
}
```

**步骤 3：实现 `packages/shared-types/src/hooks.ts`（HookEvent 类型）**

遵循 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 14（observe/on 双模式、保留现有事件名、payload 字段不退化）。

```ts
// packages/shared-types/src/hooks.ts
// 约束来源：ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 14
// 事件名保留现有命名，新增事件用点分命名。

/** 现有事件名（禁令 14 保留命名，禁止重命名引入兼容层） */
export type ExistingHookEventName =
  | 'turn.start'
  | 'turn.end'
  | 'tool.pre'
  | 'tool.post'
  | 'context.compact.start'
  | 'context.compact.end';

/** 新增事件名（禁令 14 点分命名） */
export type NewHookEventName =
  | 'session.start'
  | 'session.end'
  | 'model.beforeRequest'
  | 'model.afterResponse'
  | 'subagent.start'
  | 'subagent.end';

export type HookEventName = ExistingHookEventName | NewHookEventName;

/** 钩子模式（禁令 14 双模式，禁止退化为单一 register） */
export type HookMode = 'observe' | 'on';

/** Turn 事件 payload */
export interface TurnStartPayload {
  readonly sessionId: string;
  readonly turnIndex: number;
}
export interface TurnEndPayload {
  readonly sessionId: string;
  readonly turnIndex: number;
  readonly outcome: 'completed' | 'aborted' | 'failed';
}

/** Tool 事件 payload */
export interface ToolPrePayload {
  readonly sessionId: string;
  readonly toolName: string;
  readonly input: unknown;
}
export interface ToolPostPayload {
  readonly sessionId: string;
  readonly toolName: string;
  readonly output: unknown;
  readonly durationMs: number;
  readonly isError: boolean;
}

/**
 * 上下文压缩事件 payload（禁令 14 payload 字段不得退化）。
 * 现有 ContextCompactEndPayload 的 aborted/trigger/compactionId/keptMessageCount 诊断字段必须保留。
 */
export interface ContextCompactStartPayload {
  readonly sessionId: string;
  readonly trigger: 'auto' | 'manual' | 'threshold';
  readonly currentTokenCount: number;
}
export interface ContextCompactEndPayload {
  readonly sessionId: string;
  readonly compactionId: string;
  readonly aborted: boolean;
  readonly trigger: 'auto' | 'manual' | 'threshold';
  readonly keptMessageCount: number;
  readonly compactedTokenCount: number;
  readonly durationMs: number;
}

/** 钩子注册描述符（供 LifecycleHookRegistry 使用，Round 8 完整） */
export interface HookRegistration {
  readonly event: HookEventName;
  readonly mode: HookMode;
  readonly handlerType: 'sync' | 'async';
  readonly failStrategy: HookFailStrategy;
  readonly timeoutMs: number;
}

/** 钩子失败策略 */
export type HookFailStrategy = 'swallow' | 'propagate' | 'log';
```

**步骤 4：更新 `packages/shared-types/src/index.ts`（导出全部新类型）**

在现有 `index.ts` 末尾追加 errors 子目录与三个新模块的导出。**保留现有 errors 导出块**（来自 `./errors` shim，向后兼容），新增 errors 子模块的细粒度导出。

在 `// 错误` 区块后追加：

```ts
// 错误（新版，共存阶段与旧导出并存）
export type {
  CrishErrorCode,
  CrishErrorCategory,
  CrishErrorDomain,
} from './errors/codes';
export {
  CRISH_ERROR_DOMAINS,
  domainOf,
  isCrishErrorCode,
} from './errors/codes';
export type { CrishErrorInfo } from './errors/info';
export {
  CRISH_ERROR_REGISTRY,
  getErrorInfo,
  codesByDomain,
} from './errors/info';
export type { CrishResult } from './errors/result';
export {
  ok,
  err,
  getOrThrow,
  unwrapOr,
  mapResult,
  flatMapResult,
  mapErr,
  match,
  isOk,
  isErr,
  fromPromise,
  promiseResult,
} from './errors/result';
export type { CrishErrorPayload } from './errors/serialize';
export {
  CRISH_ERROR_CAUSE_MAX_DEPTH,
  toErrorPayload,
  fromErrorPayload,
  makeErrorPayload,
  fromUnknownError,
  codeFromHttpStatus,
} from './errors/serialize';
export {
  normalizeCrishError,
  isCrishError,
  migrateErrorCode,
} from './errors/normalize';

// 子代理类型（约束：ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 20-22）
export type {
  SubagentRole,
  SubagentCapabilityMode,
  SubagentState,
  SubagentIsolationMode,
  RecursionGuardConfig,
  SubagentDefinition,
  SubagentInstanceSnapshot,
  DeadlockCheckInput,
} from './subagent';
export { DEFAULT_RECURSION_GUARD } from './subagent';

// 插件类型（约束：ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 13-19）
export type {
  PluginOrigin,
  PluginTrustLevel,
  HookHandlerType,
  HookFailStrategy,
  PluginPermission,
  PluginManifest,
  PluginActivationApi,
  PluginHookHandler,
  HookControlSignal,
  PluginToolDeclaration,
  PluginMcpDeclaration,
  ActivatedPlugin,
} from './plugin';

// 钩子事件类型（约束：ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 14）
export type {
  ExistingHookEventName,
  NewHookEventName,
  HookEventName,
  HookMode,
  TurnStartPayload,
  TurnEndPayload,
  ToolPrePayload,
  ToolPostPayload,
  ContextCompactStartPayload,
  ContextCompactEndPayload,
  HookRegistration,
} from './hooks';
```

**步骤 5：修复 shared-types 的 TSC 错误（不恶化基线）**

执行 `npx tsc --noEmit` 检查 shared-types 包。根据 Agent 1-A 的基线，shared-types 当前错误数较少（基线中占比小）。本步骤重点修复因新增文件引入的错误，包括：

- `verbatimModuleSyntax`（TS1484）：确保所有纯类型导入用 `import type`
- `exactOptionalPropertyTypes`（TS2375）：可选字段不赋 `undefined`
- 未使用的导入（TS6133/TS6192）

**不在本步骤范围内**：修复其他包的 TSC 错误（随各自 Round 迁移时修复）。

#### 输出

| 文件                                    | 行数预估 | 内容                                                          |
| --------------------------------------- | -------- | ------------------------------------------------------------- |
| `packages/shared-types/src/subagent.ts` | ~95 行   | SubagentDefinition + RecursionGuardConfig + 状态机类型        |
| `packages/shared-types/src/plugin.ts`   | ~120 行  | PluginManifest + PluginActivationApi + 钩子/工具/MCP 声明类型 |
| `packages/shared-types/src/hooks.ts`    | ~100 行  | HookEventName + 各事件 payload + HookRegistration             |
| `packages/shared-types/src/index.ts`    | +65 行   | 追加 errors 细粒度导出 + 3 个新模块导出                       |

#### 验证标准

1. `SubagentDefinition.role` 为 `SubagentRole` 联合类型，`capabilityMode` 为 `SubagentCapabilityMode`，两者独立字段（无双重维度映射）
2. `DEFAULT_RECURSION_GUARD.maxDepth === 3`、`maxSiblings === 5`、`maxConcurrent === 6`（ROUND-09 §3.2 权威值）
3. `PluginOrigin` 仅含 `"user-dir" | "project-dir"`（无 mcp/github/inline/npm/global-dir）
4. `HookHandlerType` 仅含 `"sync" | "async"`（无 command/webhook）
5. `ContextCompactEndPayload` 含 `aborted`/`trigger`/`compactionId`/`keptMessageCount` 字段（禁令 14 不退化）
6. `npx tsc --noEmit` 在 shared-types 包内错误数 ≤ 基线（不恶化）
7. 现有 `import { CrishError } from "@crish/shared-types"` 仍可编译（向后兼容）

---

## 3. 文件清单

### 3.1 新建文件

| 文件                                                                    | 产出 Agent | 说明                                                  |
| ----------------------------------------------------------------------- | ---------- | ----------------------------------------------------- |
| `analysis/iterative-repair/v2/baselines/tsc-errors-baseline.json`       | 1-A        | TSC 错误基线                                          |
| `analysis/iterative-repair/v2/baselines/dependency-graph-baseline.json` | 1-A        | 依赖图基线                                            |
| `analysis/iterative-repair/v2/baselines/test-coverage-baseline.json`    | 1-A        | 测试覆盖率基线                                        |
| `analysis/iterative-repair/v2/baselines/throw-inventory.json`           | 1-A        | throw 清单                                            |
| `analysis/iterative-repair/v2/baselines/tech-debt-inventory.md`         | 1-A        | 技术债清单                                            |
| `packages/shared-types/src/errors/codes.ts`                             | 1-B        | CrishErrorCode 联合类型 + 域工具                      |
| `packages/shared-types/src/errors/info.ts`                              | 1-B        | CrishErrorInfo 注册表（60 条）                        |
| `packages/shared-types/src/errors/classes.ts`                           | 1-C        | 新 CrishError + deprecated 子类                       |
| `packages/shared-types/src/errors/result.ts`                            | 1-C        | CrishResult ADT + 11 工具函数                         |
| `packages/shared-types/src/errors/serialize.ts`                         | 1-D        | CrishErrorPayload + 序列化函数                        |
| `packages/shared-types/src/errors/normalize.ts`                         | 1-D        | migrateErrorCode + isCrishError + normalizeCrishError |
| `packages/shared-types/src/errors/index.ts`                             | 1-C        | errors 子目录 barrel                                  |
| `packages/shared-types/src/subagent.ts`                                 | 1-E        | 子代理类型定义                                        |
| `packages/shared-types/src/plugin.ts`                                   | 1-E        | 插件 manifest 类型定义                                |
| `packages/shared-types/src/hooks.ts`                                    | 1-E        | 钩子事件类型定义                                      |

### 3.2 修改文件

| 文件                                  | 修改 Agent | 修改内容                                                                            |
| ------------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `packages/shared-types/src/errors.ts` | 1-C        | 81 行原实现 → ~25 行 deprecated re-export shim，re-export `./errors/index` 全部符号 |
| `packages/shared-types/src/index.ts`  | 1-E        | 追加 errors 细粒度导出 + subagent/plugin/hooks 三模块导出（+65 行）                 |

### 3.3 保留文件（deprecated）

以下文件/类型在共存阶段（Round 1）保留为 deprecated 适配层，**不删除**，删除阶段（Round 12）统一清理（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 23）。

| 文件/类型                             | 现状               | 共存阶段处理                                           | 删除阶段                                              |
| ------------------------------------- | ------------------ | ------------------------------------------------------ | ----------------------------------------------------- |
| `packages/shared-types/src/errors.ts` | 81 行原实现        | 转为 re-export shim，标 `@deprecated`                  | Round 12 删除                                         |
| `SessionErrorCode` 类型               | `errors.ts` L65-70 | 迁移到 `errors/classes.ts`，标 `@deprecated`           | Round 12 删除                                         |
| `ProviderError` 类                    | `errors.ts` L25-35 | 迁移到 `errors/classes.ts`，标 `@deprecated`           | Round 12 删除（改用 `CrishError(code="provider.*")`） |
| `SessionError` 类                     | `errors.ts` L48-57 | 迁移到 `errors/classes.ts`，标 `@deprecated`           | Round 12 删除                                         |
| `ProtocolError` 类                    | `errors.ts` L72-80 | 迁移到 `errors/classes.ts`，标 `@deprecated`           | Round 12 删除                                         |
| `PermissionError` 类                  | `errors.ts` L37-46 | 迁移到 `errors/classes.ts`，标 `@deprecated`           | Round 12 删除                                         |
| `ProviderErrorKind` 类型              | `tool.ts` L66-78   | 保留不动（Round 4 随 agent-model 迁移时标 deprecated） | Round 12 删除                                         |

---

## 4. 验证门禁

### 4.1 验证命令

Round 1 结束前，在仓库根目录 `C:\Software\conex` 依次执行以下 8 项检查（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 27）：

```bash
# 1. TypeScript 编译（全仓库）
npx tsc --noEmit

# 2. Rust 编译
cargo check --workspace

# 3. 单元测试（TS）
npx vitest run

# 4. 单元测试（Rust）
cargo test --workspace

# 5. 循环依赖
npm run lint:depcruise

# 6. 构建
npx turbo run build

# 7. Lint
npm run lint

# 8. Store 类型
npm run check:store-types
```

### 4.2 通过标准（TSC不恶化 = 错误数 ≤ 315）

| 检查项           | 通过标准                           | 说明                                                                                                            |
| ---------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| TypeScript 编译  | 错误数 ≤ 315（Round 1 开始时基线） | `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 26：每轮不恶化。基线值由 Agent 1-A 的 `tsc-errors-baseline.json` 记录 |
| Rust 编译        | 0 errors                           | 本 Round 不涉及 Rust 代码变更                                                                                   |
| 单元测试（TS）   | 全部通过                           | 现有测试不回归；本 Round 新增类型为纯类型定义（无运行时逻辑需测试），可选新增 errors 类型守卫的单元测试         |
| 单元测试（Rust） | 全部通过                           | 本 Round 不涉及 Rust                                                                                            |
| 循环依赖         | 0 violations                       | `errors.ts` shim → `errors/index.ts` → 子模块，无循环；新模块 `subagent.ts`/`plugin.ts`/`hooks.ts` 无包内依赖   |
| 构建             | 全部成功                           | shared-types 的 `build:types` + `build:js` 通过                                                                 |
| Lint             | 0 errors                           | 新增文件遵循现有 lint 规则（`import type` for types）                                                           |
| Store 类型       | 通过                               | 新增类型不破坏 store 类型检查                                                                                   |

**TSC 不恶化的判定逻辑**：

1. Agent 1-A 采集基线 `tsc-errors-baseline.json`，记录 `totalErrors`（预期 315）
2. Round 1 所有 Agent 完成后，再次执行 `npx tsc --noEmit`
3. 新错误数 ≤ 基线 `totalErrors` 即通过
4. 若 shared-types 包内错误数增加（因新文件引入的类型问题），必须在本 Round 内修复至不恶化

**本 Round 允许的 TSC 误差**：shared-types 包内可能因 `errors.ts` → `errors/` 重构引入少量临时错误（如 import 路径调整），但**全仓库总错误数不得增加**。其他包因 import `@crish/shared-types` 的符号未变（re-export shim 保证向后兼容），不应产生新错误。

---

## 5. 交付物

### 5.1 代码文件

| 文件路径                                        | 类型            | 行数预估          |
| ----------------------------------------------- | --------------- | ----------------- |
| `packages/shared-types/src/errors/codes.ts`     | 新建            | ~90               |
| `packages/shared-types/src/errors/info.ts`      | 新建            | ~110              |
| `packages/shared-types/src/errors/classes.ts`   | 新建            | ~110              |
| `packages/shared-types/src/errors/result.ts`    | 新建            | ~120              |
| `packages/shared-types/src/errors/serialize.ts` | 新建            | ~130              |
| `packages/shared-types/src/errors/normalize.ts` | 新建            | ~110              |
| `packages/shared-types/src/errors/index.ts`     | 新建            | ~8                |
| `packages/shared-types/src/errors.ts`           | 修改（转 shim） | 81 → ~25          |
| `packages/shared-types/src/subagent.ts`         | 新建            | ~95               |
| `packages/shared-types/src/plugin.ts`           | 新建            | ~120              |
| `packages/shared-types/src/hooks.ts`            | 新建            | ~100              |
| `packages/shared-types/src/index.ts`            | 修改            | +65               |
| **合计**                                        |                 | ~1080 行新增/修改 |

> Agent 任务量校验（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 28：≥5 文件或 ≥300 行）：
>
> - 1-A：5 个基线文件 ✓
> - 1-B：2 文件 ~200 行 ✓（≥300 行门槛通过行数满足）
> - 1-C：4 文件 ~263 行 ✓（含 errors.ts 修改 + index.ts barrel）
> - 1-D：2 文件 ~240 行 ✓（行数接近门槛，含密集逻辑）
> - 1-E：4 文件 ~380 行 ✓

### 5.2 基线文件

| 文件路径                                                                | 用途                                 |
| ----------------------------------------------------------------------- | ------------------------------------ |
| `analysis/iterative-repair/v2/baselines/tsc-errors-baseline.json`       | Round 2-12 每轮"不恶化"对比基准      |
| `analysis/iterative-repair/v2/baselines/dependency-graph-baseline.json` | 拆分后拓扑正确性验证                 |
| `analysis/iterative-repair/v2/baselines/test-coverage-baseline.json`    | 拆分后覆盖率不下降门禁               |
| `analysis/iterative-repair/v2/baselines/throw-inventory.json`           | Round 3-11 按包迁移 throw 的追踪清单 |
| `analysis/iterative-repair/v2/baselines/tech-debt-inventory.md`         | Round 12 删除阶段的清理清单          |

### 5.3 接口契约（供后续Round引用）

> 以下接口契约为 Round 2-12 的输入依赖，**签名变更必须更新本节并通知下游 Round**。

#### 5.3.1 错误码体系（Round 3-11 迁移 throw 时引用）

```ts
// 来源：packages/shared-types/src/errors/codes.ts
type CrishErrorCode = /* 64 个正式 + 10 个 reserved domain.reason 字面量，见 ./03-ERROR-MIGRATION.md §2.2 */;
type CrishErrorCategory = "transient" | "permanent" | "security" | "protocol";

// 来源：packages/shared-types/src/errors/info.ts
interface CrishErrorInfo {
  readonly code: CrishErrorCode;
  readonly title: string;
  readonly category: CrishErrorCategory;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action: string;
}
function getErrorInfo(code: CrishErrorCode): CrishErrorInfo;
```

**下游引用方**：

- Round 3-7（各包迁移 throw）：用 `migrateErrorCode(旧码, context)` 将旧码映射为新 `CrishErrorCode`，构造 `new CrishError(msg, newCode, category, retryable, meta, { cause })`
- Round 8（plugin-sdk）：插件错误用 `plugin.*` 域码
- Round 9（agent-subagent）：子代理错误用 `subagent.*` 域码
- Round 10（Rust）：`CrishErrorPayload` Rust impl 字段一一对应

#### 5.3.2 CrishError 类（Round 3-11 替换 throw 时引用）

```ts
// 来源：packages/shared-types/src/errors/classes.ts
class CrishError extends Error {
  readonly code: CrishErrorCode | string; // 共存：新码或旧裸 string
  readonly category: CrishErrorCategory;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action: string;
  readonly metadata?: JsonObject | undefined;
  readonly cause?: CrishError | undefined;
  constructor(
    message: string,
    code: CrishErrorCode | string,
    category: CrishErrorCategory,
    retryable: boolean,
    metadata?: JsonObject,
    options?: { cause?: CrishError; public?: boolean; action?: string }
  );
}
```

**向后兼容保证**：旧 5 参数构造函数 `new CrishError(msg, code, category, retryable, metadata)` 继续工作，`options` 缺省时 `public`/`action` 从注册表回退。

#### 5.3.3 CrishResult ADT（Round 5 PipelineResult 统一、Round 3-11 公共 API 边界引用）

```ts
// 来源：packages/shared-types/src/errors/result.ts
type CrishResult<T, E extends CrishError = CrishError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

function ok<T>(value: T): CrishResult<T, never>;
function err<E extends CrishError>(error: E): CrishResult<never, E>;
function getOrThrow<T, E extends CrishError>(result: CrishResult<T, E>): T;
function unwrapOr<T, E extends CrishError>(
  result: CrishResult<T, E>,
  fallback: T
): T;
function mapResult<T, U, E>(
  result: CrishResult<T, E>,
  fn: (value: T) => U
): CrishResult<U, E>;
function flatMapResult<T, U, E, E2>(
  result: CrishResult<T, E>,
  fn: (value: T) => CrishResult<U, E2>
): CrishResult<U, E | E2>;
function match<T, U, E>(
  result: CrishResult<T, E>,
  handlers: { ok: (value: T) => U; err: (error: E) => U }
): U;
function isOk<T, E>(
  result: CrishResult<T, E>
): result is { ok: true; value: T };
function isErr<T, E>(
  result: CrishResult<T, E>
): result is { ok: false; error: E };
function fromPromise<T>(
  promise: Promise<T>
): Promise<CrishResult<T, CrishError>>;
function promiseResult<T, E>(result: CrishResult<T, E>): Promise<T>;
```

**使用策略**（`./03-ERROR-MIGRATION.md` §5.1）：

- 公共 API 边界 / 异步流式 / 状态机转移 / 工具执行 / 审批决策 → 返回 `CrishResult`
- 内部辅助函数 / 入参校验 / 不可恢复错误 → `throw new CrishError(...)`

**下游引用方**：

- Round 5（agent-core）：`PipelineResult` 统一为 `CrishResult`，`tierUsed` 作为扩展字段
- Round 3-11 各包公共 API 边界函数改为返回 `CrishResult`

#### 5.3.4 CrishErrorPayload（Round 10 Rust 对齐、Round 11 前端翻译层引用）

```ts
// 来源：packages/shared-types/src/errors/serialize.ts
interface CrishErrorPayload {
  readonly code: CrishErrorCode;
  readonly message: string;
  readonly category: CrishErrorCategory;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action: string;
  readonly metadata?: JsonObject | undefined;
  readonly cause?: CrishErrorPayload | undefined; // 递归，最多 8 层
  readonly stack?: string | undefined; // 仅开发环境
  readonly timestamp: number; // epoch ms
}

function toErrorPayload(error: CrishError, depth?: number): CrishErrorPayload;
function fromErrorPayload(payload: CrishErrorPayload): CrishError;
function fromUnknownError(error: unknown): CrishErrorPayload;
function makeErrorPayload(error: unknown): CrishErrorPayload;
function codeFromHttpStatus(status: number): CrishErrorCode;
```

**下游引用方**：

- Round 10（Rust）：`crates/conex-types` 实现 `CrishErrorPayload` Rust struct，字段一一对应（`#[serde(rename_all = "camelCase")]`），`IpcResponse.error` 从 `Option<String>` 迁移为 `Option<serde_json::Value>`（共存）→ `Option<CrishErrorPayload>`（删除阶段）
- Round 11（前端）：`invoke()` catch 后用 `fromErrorPayload()` 还原为 `CrishError`，按 `code` 域路由到翻译层

#### 5.3.5 migrateErrorCode（Round 3-11 迁移阶段引用）

```ts
// 来源：packages/shared-types/src/errors/normalize.ts
function migrateErrorCode(
  legacyCode: string,
  context?: {
    kind?: 'path' | 'input' | 'not_found' | 'execution';
    subType?: string;
  }
): CrishErrorCode;

function isCrishError(value: unknown): value is CrishError;
function normalizeCrishError(error: unknown): CrishError;
```

**下游引用方**：

- Round 3-11 各包迁移 `throw new CrishError(msg, 旧码, ...)` → `throw new CrishError(msg, migrateErrorCode(旧码, ctx), ...)` 时引用
- Round 12（删除阶段）：迁移完成后 `migrateErrorCode` 无调用方即可删除

#### 5.3.6 子代理/插件/钩子类型（Round 8/9 引用）

```ts
// 来源：packages/shared-types/src/subagent.ts
interface SubagentDefinition {
  readonly id: string;
  readonly name: string;
  readonly role: SubagentRole; // 标签，不影响调度（禁令 21）
  readonly capabilityMode: SubagentCapabilityMode; // 控制权限（禁令 21）
  readonly systemPrompt: string;
  readonly timeoutMs: number;
  readonly allowedTools?: readonly string[];
  readonly isolationMode?: SubagentIsolationMode; // 第一版仅 "none"
}
const DEFAULT_RECURSION_GUARD: Readonly<RecursionGuardConfig>; // maxDepth=3, maxSiblings=5, maxConcurrent=6

// 来源：packages/shared-types/src/plugin.ts
interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly origin: PluginOrigin; // "user-dir" | "project-dir"（禁令 17）
  readonly trustLevel: PluginTrustLevel; // "restricted" | "full"（禁令 18）
  readonly entry: string;
  readonly declaredHooks: readonly string[];
  readonly declaredTools: readonly string[];
  readonly declaredMcpServers: readonly string[];
  readonly declaredAgents: readonly string[];
  readonly permissions: readonly PluginPermission[];
}

// 来源：packages/shared-types/src/hooks.ts
type HookEventName = ExistingHookEventName | NewHookEventName;
type HookMode = 'observe' | 'on'; // 禁令 14 双模式
interface ContextCompactEndPayload {
  readonly compactionId: string;
  readonly aborted: boolean; // 禁令 14 不退化
  readonly trigger: 'auto' | 'manual' | 'threshold';
  readonly keptMessageCount: number; // 禁令 14 不退化
  /* ... */
}
```

**下游引用方**：

- Round 8（plugin-sdk）：`PluginManifest`/`PluginActivationApi`/钩子类型作为插件 SDK 的类型基础；`HookBus`（留 agent-core）消费 `HookEventName`/`HookMode`
- Round 9（agent-subagent）：`SubagentDefinition`/`RecursionGuardConfig`/`DeadlockCheckInput` 作为调度系统的类型基础；`SubagentScheduler` 消费 `SubagentDefinition`，`DeadlockDetector` 消费 `DeadlockCheckInput`

---

## 附录：与前置文档的一致性声明

| 前置文档                                                           | 引用章节                       | 一致性                                                                             |
| ------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------- |
| `../../ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 23                 | 共存阶段策略                   | 本 Round 保留旧 5 个错误类为 deprecated，新类型共存 ✓                              |
| `../../ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 25                 | 错误码迁移约束                 | `migrateErrorCode()` 实现，禁止一次性全局替换 ✓                                    |
| `../../ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 26                 | TSC 错误管理                   | 不恶化门禁 ≤ 315，基线由 Agent 1-A 采集 ✓                                          |
| `../../ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 28                 | Agent 任务量                   | 每个 Agent ≥5 文件或 ≥300 行 ✓                                                     |
| `../../ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 14-19              | 插件/钩子约束                  | PluginOrigin/HandlerType/信任级别/payload 字段均遵循 ✓                             |
| `../../ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 21 + ROUND-09 §3.2 | 子代理约束                     | role 为标签、capabilityMode 控权限、递归守卫默认值 ✓                               |
| `./01-OVERVIEW.md` §4.1                                            | Round 1 交付物                 | CrishError + CrishResult + CrishErrorPayload + 64 正式码 + 10 reserved 码 + 基线 ✓ |
| `./03-ERROR-MIGRATION.md` §2                                       | 64 正式码 + 10 reserved 码体系 | 本 Round §2.2 完整引用，64 正式码 + 10 reserved 码/19 域 ✓                         |
| `./03-ERROR-MIGRATION.md` §3                                       | 迁移映射                       | `migrateErrorCode()` 覆盖 §3.1/3.2/3.3/3.4 全部映射 ✓                              |
| `./03-ERROR-MIGRATION.md` §5                                       | CrishResult                    | 11 工具函数签名一致（含 mapErr 扩展）✓                                             |
| `./03-ERROR-MIGRATION.md` §6                                       | CrishErrorPayload              | 接口字段、递归 8 层、HTTP_STATUS_TO_CODE 静态映射一致 ✓                            |

**说明**：`./03-ERROR-MIGRATION.md` 中文件路径为扁平结构（`error-codes.ts`/`result.ts`/`error-payload.ts`/`error-migration.ts`），本 Round 设计将其系统化为 `errors/` 子目录（`codes.ts`/`info.ts`/`classes.ts`/`result.ts`/`serialize.ts`/`normalize.ts`），更符合关注点分离原则。文件名差异不影响接口契约，下游 Round 按 `@crish/shared-types` 根导出引用即可，无需感知内部文件结构。
