# 子代理调度系统设计方案

## 目录

1. [概述](#1-概述)
2. [子代理定义体系](#2-子代理定义体系)
3. [子代理生命周期](#3-子代理生命周期)
4. [调度与资源管理](#4-调度与资源管理)
5. [子代理间通信](#5-子代理间通信)
6. [与现有系统集成](#6-与现有系统集成)
7. [执行引擎](#7-执行引擎)
8. [实施文件结构](#8-实施文件结构)
9. [测试策略](#9-测试策略)

---

## 1. 概述

### 1.1 设计目标

基于 Grok Build 的 SubagentRole/Persona 框架 + 子代理发现与调度系统、Codex CLI 的图状态管理和统一执行引擎、Pi 的三层工具执行管线和 Harness 抽象层、以及 Kimi Code 的 DI 服务层和 turn 循环模式，为 Crish 设计一套完整的子代理调度系统。

### 1.2 核心架构分层

```
┌─────────────────────────────────────────────────────────────────┐
│                    AgentOrchestrator (上层)                       │
│   Session管理 / Run调度 / Goal执行 / EventStore                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │  spawn / signal / observe
┌──────────────────────────▼──────────────────────────────────────┐
│              SubagentScheduler (新包 @crish/agent-subagent)       │
│   定义发现 / 调度队列 / 递归守卫 / 死锁检测 / 看门狗 / 通信总线    │
├─────────────────────────────────────────────────────────────────┤
│  SubagentDefinitionRegistry  │  SubagentSchedulingQueue         │
│  SubagentInstanceManager    │  SubagentCommunicationBus         │
│  RecursionGuard             │  DeadlockDetector                 │
│  Watchdog                   │  TokenBudgetTracker               │
└──────────┬──────────────────────────────────────┬───────────────┘
           │  create / run / pause / resume        │  tool call
┌──────────▼──────────────────────────────────────▼───────────────┐
│                    AgentRuntime (下层)                            │
│   ProviderGateway / ContextManager / SessionLoop / ToolRegistry  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 子代理定义体系

### 2.1 SubagentDefinition 接口

文件：`packages/agent-subagent/src/definition/types.ts`

```typescript
import type { JsonObject } from '@crish/shared-types';
import type { AgentProvider } from '@crish/agent-runtime';
import type { AgentTool, ToolSource } from '@crish/agent-runtime';

export type SubagentRole =
  'researcher' | 'implementer' | 'reviewer' | 'debugger' | 'planner' | 'custom';

export type SubagentIsolationMode = 'none' | 'worktree' | 'process';

export type SubagentCapabilityMode =
  'read-only' | 'read-write' | 'execute' | 'all';

export interface SubagentDefinition {
  /** 唯一名称 */
  name: string;
  /** 语义化版本 */
  version: string;
  /** 人类可读描述 */
  description: string;
  /** 角色标签 */
  role: SubagentRole;
  /** 显示标签（可选覆盖） */
  label?: string;
  /** 模型标识（如 "gpt-4o", "claude-sonnet-4"） */
  model?: string;
  /** 推理努力程度 */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** 系统提示词 */
  systemPrompt: string;
  /** 提示词模板文件路径（相对于定义文件所在目录） */
  promptFile?: string;
  /** 能力模式（控制工具权限） */
  capabilityMode?: SubagentCapabilityMode;
  /** 隔离模式 */
  isolation?: SubagentIsolationMode;
  /** 最大 turn 数 */
  maxTurns?: number;
  /** 超时时间（毫秒） */
  timeoutMs?: number;
  /** 允许的工具名称列表（空 = 继承父级全部） */
  allowedTools?: string[];
  /** 拒绝的工具名称列表 */
  deniedTools?: string[];
  /** 默认的 fork 策略 */
  defaultForkPolicy?: 'task-only' | 'summary' | 'full';
  /** 约束条件 */
  constraints?: SubagentConstraint[];
  /** 声明的输入输出接口（类似 Grok PersonaIOField） */
  io?: {
    inputs?: SubagentIOField[];
    outputs?: SubagentIOField[];
  };
  /** 元数据 */
  metadata?: JsonObject;
}

export interface SubagentConstraint {
  type: 'resource' | 'behavior' | 'security';
  rule: string;
  value?: unknown;
}

export interface SubagentIOField {
  name: string;
  ioType: 'file' | 'text' | 'json' | 'artifact-ref';
  required: boolean;
  description: string;
}
```

### 2.2 子代理发现机制

文件：`packages/agent-subagent/src/discovery/discovery.ts`

借鉴 Grok Build 的 `discovery::by_name_in_cwd_with_plugins` 和 `all_subagents_with_plugins` 模式：

```typescript
import type { SubagentDefinition } from '../definition/types';
import type { PluginRegistry } from '@crish/agent-runtime';

export interface SubagentDiscoverySource {
  readonly name: string;
  readonly priority: number; // 数字越小优先级越高
  discover(): AsyncIterable<SubagentDefinition>;
}

export interface SubagentDiscoveryContext {
  cwd: string;
  /** 用户级目录 ~/.crish/subagents/ */
  userSubagentDir?: string;
  /** 项目级目录 .crish/subagents/ */
  projectSubagentDir?: string;
  /** 插件注册表 */
  pluginRegistry?: PluginRegistry;
  /** 已注册的编程式子代理 */
  registeredDefinitions?: Map<string, SubagentDefinition>;
}

export class SubagentDiscoveryService {
  private readonly sources: SubagentDiscoverySource[] = [];

  constructor(private ctx: SubagentDiscoveryContext) {
    this.registerBuiltinSources();
  }

  private registerBuiltinSources(): void {
    // 1. 文件系统发现（按优先级排列）
    this.sources.push(new ProjectFileDiscoverySource(ctx)); // .crish/subagents/
    this.sources.push(new UserFileDiscoverySource(ctx)); // ~/.crish/subagents/
    // 2. 插件发现
    if (ctx.pluginRegistry) {
      this.sources.push(new PluginDiscoverySource(ctx));
    }
    // 3. 编程式注册
    this.sources.push(new RegistryDiscoverySource(ctx));
    // 4. 内置发现（bundled 子代理）
    this.sources.push(new BuiltinDiscoverySource(ctx));
  }

  /** 按名称发现定义（同 Grok Build discover_agent_definition） */
  async findByName(name: string): Promise<SubagentDefinition | null> {
    for (const source of this.sources) {
      for await (const def of source.discover()) {
        if (def.name === name) return def;
      }
    }
    return null;
  }

  /** 列出所有可用子代理 */
  async listAll(): Promise<SubagentDefinition[]> {
    const seen = new Map<string, SubagentDefinition>();
    const sorted = [...this.sources].sort((a, b) => a.priority - b.priority);
    for (const source of sorted) {
      for await (const def of source.discover()) {
        if (!seen.has(def.name)) {
          seen.set(def.name, def);
        }
      }
    }
    return [...seen.values()];
  }
}
```

文件：`packages/agent-subagent/src/discovery/file-source.ts`

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SubagentDefinition } from '../definition/types';
import type {
  SubagentDiscoverySource,
  SubagentDiscoveryContext,
} from './discovery';

export class FileDiscoverySource implements SubagentDiscoverySource {
  readonly name: string;
  readonly priority: number;

  constructor(
    private ctx: SubagentDiscoveryContext,
    private baseDir: string,
    opts: { name: string; priority: number }
  ) {
    this.name = opts.name;
    this.priority = opts.priority;
  }

  async *discover(): AsyncIterable<SubagentDefinition> {
    const dir = this.baseDir;
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(dir, entry.name, 'subagent.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const def: SubagentDefinition = JSON.parse(raw);
        def.metadata = {
          ...def.metadata,
          source: this.name,
          sourcePath: manifestPath,
        };
        yield def;
      } catch {
        // skip malformed definitions
      }
    }
  }
}

export class ProjectFileDiscoverySource extends FileDiscoverySource {
  constructor(ctx: SubagentDiscoveryContext) {
    const dir =
      ctx.projectSubagentDir ?? path.join(ctx.cwd, '.crish', 'subagents');
    super(ctx, dir, { name: 'project', priority: 10 });
  }
}

export class UserFileDiscoverySource extends FileDiscoverySource {
  constructor(ctx: SubagentDiscoveryContext) {
    const dir =
      ctx.userSubagentDir ??
      path.join(
        process.env.HOME || process.env.USERPROFILE || '~',
        '.crish',
        'subagents'
      );
    super(ctx, dir, { name: 'user', priority: 20 });
  }
}
```

文件：`packages/agent-subagent/src/discovery/builtin-source.ts`

```typescript
import type { SubagentDefinition } from '../definition/types';
import type { SubagentDiscoverySource } from './discovery';

const BUILTIN_DEFINITIONS: SubagentDefinition[] = [
  {
    name: 'explore',
    version: '1.0.0',
    description: '只读代码库探索代理',
    role: 'researcher',
    systemPrompt:
      'You are a read-only codebase exploration agent. Search and read files to answer questions.',
    capabilityMode: 'read-only',
    maxTurns: 10,
    isolation: 'none',
    allowedTools: ['read', 'glob', 'grep', 'list_files', 'search'],
  },
  {
    name: 'implement',
    version: '1.0.0',
    description: '代码实现代理',
    role: 'implementer',
    systemPrompt:
      'You are a focused implementation agent. Write code, create files, and make edits.',
    capabilityMode: 'read-write',
    maxTurns: 30,
    isolation: 'none',
    deniedTools: ['bash', 'terminal', 'exec'],
  },
  {
    name: 'review',
    version: '1.0.0',
    description: '代码审查代理',
    role: 'reviewer',
    systemPrompt:
      'You are a meticulous code reviewer. Review changes and produce structured review notes.',
    capabilityMode: 'read-only',
    maxTurns: 15,
    isolation: 'none',
  },
  {
    name: 'debug',
    version: '1.0.0',
    description: '调试诊断代理',
    role: 'debugger',
    systemPrompt:
      'You are a debugging specialist. Reproduce issues, analyze logs, and identify root causes.',
    capabilityMode: 'execute',
    maxTurns: 25,
    isolation: 'worktree',
  },
  {
    name: 'plan',
    version: '1.0.0',
    description: '任务规划代理',
    role: 'planner',
    systemPrompt:
      'You are a planning agent. Break down complex tasks into actionable steps.',
    capabilityMode: 'read-only',
    maxTurns: 8,
    isolation: 'none',
  },
];

export class BuiltinDiscoverySource implements SubagentDiscoverySource {
  readonly name = 'builtin';
  readonly priority = 100;

  async *discover(): AsyncIterable<SubagentDefinition> {
    for (const def of BUILTIN_DEFINITIONS) {
      yield def;
    }
  }
}
```

### 2.3 Persona/Role 框架

借鉴 Grok Build 的 `SubagentRole` / `SubagentPersona` 的配置优先机制（参见 `xai-grok-subagent-resolution/src/config.rs`）：

文件：`packages/agent-subagent/src/definition/persona.ts`

```typescript
export interface SubagentRoleDefinition {
  description: string;
  defaultCapabilityMode?: SubagentCapabilityMode;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  promptFile?: string;
  defaultIsolation?: SubagentIsolationMode;
  sourceDir?: string;
}

export interface SubagentPersona {
  instructions?: string;
  description?: string;
  instructionsFile?: string;
  inputs?: SubagentIOField[];
  outputs?: SubagentIOField[];
  defaultIsolation?: SubagentIsolationMode;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  sourceDir?: string;
  sourcePath?: string;
}

export interface EffectiveRuntimeConfig {
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  capabilityMode?: SubagentCapabilityMode;
  persona?: string;
  personaInstructions?: string;
  rolePrompt?: string;
  rolePromptWarning?: string;
  roleName?: string;
  personaError?: string;
  isolation: SubagentIsolationMode;
}
```

文件：`packages/agent-subagent/src/definition/override-resolver.ts`

```typescript
// 覆写优先级：显式 spawn 参数 > role 默认值 > persona 默认值 > 父代理继承
export function resolveEffectiveRuntimeConfig(
  overrides: SubagentRuntimeOverrides,
  role: SubagentRoleDefinition | null,
  personas: Map<string, SubagentPersona>,
  cwd: string | undefined,
  roleName: string | undefined
): EffectiveRuntimeConfig {
  // 模型解析
  const modelFromOverrideOrRole = overrides.model ?? role?.model ?? undefined;

  // 推理努力
  const reasoningFromOverrideOrRole =
    overrides.reasoningEffort ?? role?.reasoningEffort;

  // 能力模式（取交集，参考 Grok 的 intersect_capability_modes）
  const capabilityMode = intersectCapabilityModes(
    overrides.capabilityMode,
    role?.defaultCapabilityMode
  );

  // Persona 解析
  const persona = overrides.persona;
  const resolvedPersona = persona ? personas.get(persona) : undefined;

  // Persona 模型/努力回退
  const model = modelFromOverrideOrRole ?? resolvedPersona?.model;
  const reasoningEffort =
    reasoningFromOverrideOrRole ?? resolvedPersona?.reasoningEffort;

  // 隔离模式
  const isolation =
    overrides.isolation ??
    role?.defaultIsolation ??
    resolvedPersona?.defaultIsolation ??
    'none';

  return {
    model: model as EffectiveRuntimeConfig['model'],
    reasoningEffort:
      reasoningEffort as EffectiveRuntimeConfig['reasoningEffort'],
    capabilityMode,
    persona,
    isolation: isolation as SubagentIsolationMode,
  };
}

function intersectCapabilityModes(
  requested?: SubagentCapabilityMode,
  ceiling?: SubagentCapabilityMode
): SubagentCapabilityMode | undefined {
  if (!requested && !ceiling) return undefined;
  if (requested && !ceiling) return requested;
  if (!requested && ceiling) return ceiling;
  if (requested === 'all') return ceiling;
  if (ceiling === 'all') return requested;
  if (requested === 'read-only' || ceiling === 'read-only') return 'read-only';
  if (requested === ceiling) return requested;
  return 'read-only'; // incompatible -> most restrictive
}
```

---

## 3. 子代理生命周期

### 3.1 AgentState 枚举

文件：`packages/agent-subagent/src/lifecycle/state.ts`

```typescript
export type SubagentState =
  | 'pending' // 已创建但未初始化
  | 'initializing' // 正在初始化运行时
  | 'running' // 正在执行
  | 'paused' // 已暂停（可恢复）
  | 'completed' // 正常完成
  | 'failed' // 执行失败
  | 'cancelled' // 被取消
  | 'timed-out'; // 超时终止

export interface SubagentStateTransition {
  from: SubagentState;
  to: SubagentState;
  reason: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface SubagentStateSnapshot {
  subagentId: string;
  state: SubagentState;
  transitions: SubagentStateTransition[];
  currentTurn: number;
  totalTurns: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}
```

### 3.2 SubagentInstance 类（生命周期管理）

文件：`packages/agent-subagent/src/lifecycle/instance.ts`

```typescript
import type {
  SubagentDefinition,
  EffectiveRuntimeConfig,
} from '../definition/types';
import type {
  SubagentState,
  SubagentStateSnapshot,
  SubagentStateTransition,
} from './state';
import type {
  AgentRuntime,
  AgentEvent,
  AgentMessage,
} from '@crish/agent-runtime';
import type { LifecycleHookRegistry } from '@crish/agent-runtime/hooks';

export class SubagentInstance {
  readonly subagentId: string;
  readonly parentSessionId: string;
  readonly parentToolCallId: string;
  readonly definition: SubagentDefinition;
  readonly config: EffectiveRuntimeConfig;

  private _state: SubagentState = 'pending';
  private readonly transitions: SubagentStateTransition[] = [];
  private runtime: AgentRuntime | null = null;
  private abortController = new AbortController();
  private _currentTurn = 0;
  private _totalTurns = 0;
  private _error?: string;

  constructor(opts: {
    subagentId: string;
    parentSessionId: string;
    parentToolCallId: string;
    definition: SubagentDefinition;
    config: EffectiveRuntimeConfig;
    hooks?: LifecycleHookRegistry;
  }) {
    this.subagentId = opts.subagentId;
    this.parentSessionId = opts.parentSessionId;
    this.parentToolCallId = opts.parentToolCallId;
    this.definition = opts.definition;
    this.config = opts.config;
  }

  get state(): SubagentState {
    return this._state;
  }
  get error(): string | undefined {
    return this._error;
  }

  get snapshot(): SubagentStateSnapshot {
    return {
      subagentId: this.subagentId,
      state: this._state,
      transitions: [...this.transitions],
      currentTurn: this._currentTurn,
      totalTurns: this._totalTurns,
      error: this._error,
    };
  }

  private transition(to: SubagentState, reason: string): void {
    const from = this._state;
    this._state = to;
    this.transitions.push({
      from,
      to,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  async initialize(runtime: AgentRuntime): Promise<void> {
    this.transition('initializing', 'runtime assigned');
    this.runtime = runtime;
    this.transition('running', 'initialization complete');
  }

  async pause(): Promise<void> {
    if (this._state !== 'running')
      throw new Error('Can only pause a running subagent');
    this.transition('paused', 'user requested pause');
  }

  async resume(): Promise<void> {
    if (this._state !== 'paused')
      throw new Error('Can only resume a paused subagent');
    this.transition('running', 'user requested resume');
  }

  async cancel(reason?: string): Promise<void> {
    if (
      this._state === 'completed' ||
      this._state === 'cancelled' ||
      this._state === 'timed-out'
    )
      return;
    this.abortController.abort(reason);
    this.runtime?.abort(reason);
    this.transition('cancelled', reason ?? 'cancelled by parent');
  }

  async timeout(): Promise<void> {
    this.abortController.abort('timeout');
    this.runtime?.abort('timeout');
    this.transition('timed-out', 'execution timeout exceeded');
  }

  markCompleted(): void {
    this.transition('completed', 'execution finished');
  }

  markFailed(error: string): void {
    this._error = error;
    this.transition('failed', error);
  }
}
```

### 3.3 生命周期钩子

文件：`packages/agent-subagent/src/lifecycle/hooks.ts`

```typescript
import type { SubagentInstance } from './instance';
import type {
  SubagentDefinition,
  EffectiveRuntimeConfig,
} from '../definition/types';

export type SubagentHookEventType =
  | 'subagent:beforeCreate'
  | 'subagent:afterCreate'
  | 'subagent:beforeInitialize'
  | 'subagent:afterInitialize'
  | 'subagent:beforeTurn'
  | 'subagent:afterTurn'
  | 'subagent:completed'
  | 'subagent:failed'
  | 'subagent:cancelled'
  | 'subagent:timedOut'
  | 'subagent:beforePause'
  | 'subagent:afterResume';

export interface SubagentHookPayloadMap {
  'subagent:beforeCreate': {
    definition: SubagentDefinition;
    overrides: Record<string, unknown>;
  };
  'subagent:afterCreate': {
    instance: SubagentInstance;
  };
  'subagent:beforeInitialize': {
    instance: SubagentInstance;
  };
  'subagent:afterInitialize': {
    instance: SubagentInstance;
  };
  'subagent:beforeTurn': {
    instance: SubagentInstance;
    turnIndex: number;
  };
  'subagent:afterTurn': {
    instance: SubagentInstance;
    turnIndex: number;
    events: unknown[];
  };
  'subagent:completed': {
    instance: SubagentInstance;
    result: unknown;
  };
  'subagent:failed': {
    instance: SubagentInstance;
    error: string;
  };
  'subagent:cancelled': {
    instance: SubagentInstance;
    reason?: string;
  };
  'subagent:timedOut': {
    instance: SubagentInstance;
  };
  'subagent:beforePause': {
    instance: SubagentInstance;
  };
  'subagent:afterResume': {
    instance: SubagentInstance;
  };
}

export type SubagentHookHandler<T extends SubagentHookEventType> = (
  payload: SubagentHookPayloadMap[T]
) => void | Promise<void>;

export interface SubagentHookRegistry {
  observe<T extends SubagentHookEventType>(
    event: T,
    handler: SubagentHookHandler<T>
  ): () => void;

  emit<T extends SubagentHookEventType>(
    event: T,
    payload: SubagentHookPayloadMap[T]
  ): void | Promise<void>;
}
```

---

## 4. 调度与资源管理

### 4.1 调度策略

文件：`packages/agent-subagent/src/scheduler/queue.ts`

```typescript
export type SchedulingStrategy = 'fifo' | 'priority' | 'affinity';

export type Priority = 'high' | 'medium' | 'low';

const PRIORITY_ORDER: Record<Priority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export interface SubagentSchedulingRequest {
  subagentId: string;
  definitionName: string;
  priority: Priority;
  strategy: SchedulingStrategy;
  parentSessionId: string;
  createdAt: string;
  affinityTarget?: string; // 期望的执行器/agent 类型
  payload: SubagentSpawnPayload;
}

export interface SubagentSpawnPayload {
  prompt: string;
  description: string;
  mode: string;
  overrides: SubagentRuntimeOverrides;
  // context 继承控制
  forkPolicy: 'task-only' | 'summary' | 'full';
}

export interface SubagentRuntimeOverrides {
  model?: string;
  reasoningEffort?: string;
  capabilityMode?: SubagentCapabilityMode;
  persona?: string;
  isolation?: SubagentIsolationMode;
}

export class SubagentSchedulingQueue {
  private fifoQueue: SubagentSchedulingRequest[] = [];
  private priorityBuckets: Record<Priority, SubagentSchedulingRequest[]> = {
    high: [],
    medium: [],
    low: [],
  };
  private affinityMap = new Map<string, SubagentSchedulingRequest[]>();
  private _strategy: SchedulingStrategy;

  constructor(strategy: SchedulingStrategy = 'fifo') {
    this._strategy = strategy;
  }

  get strategy(): SchedulingStrategy {
    return this._strategy;
  }

  enqueue(request: SubagentSchedulingRequest): void {
    switch (this._strategy) {
      case 'fifo':
        this.fifoQueue.push(request);
        break;
      case 'priority':
        this.priorityBuckets[request.priority].push(request);
        break;
      case 'affinity':
        if (request.affinityTarget) {
          const bucket = this.affinityMap.get(request.affinityTarget) ?? [];
          bucket.push(request);
          this.affinityMap.set(request.affinityTarget, bucket);
        } else {
          this.fifoQueue.push(request);
        }
        break;
    }
  }

  dequeue(): SubagentSchedulingRequest | undefined {
    switch (this._strategy) {
      case 'fifo':
        return this.fifoQueue.shift();
      case 'priority': {
        for (const level of ['high', 'medium', 'low'] as Priority[]) {
          const bucket = this.priorityBuckets[level];
          if (bucket.length > 0) return bucket.shift();
        }
        return undefined;
      }
      case 'affinity': {
        if (this.fifoQueue.length > 0) return this.fifoQueue.shift();
        for (const [, bucket] of this.affinityMap) {
          if (bucket.length > 0) return bucket.shift();
        }
        return undefined;
      }
    }
  }

  peek(): SubagentSchedulingRequest | undefined {
    switch (this._strategy) {
      case 'fifo':
        return this.fifoQueue[0];
      case 'priority': {
        for (const level of ['high', 'medium', 'low'] as Priority[]) {
          if (this.priorityBuckets[level].length > 0)
            return this.priorityBuckets[level][0];
        }
        return undefined;
      }
      case 'affinity': {
        if (this.fifoQueue.length > 0) return this.fifoQueue[0];
        for (const [, bucket] of this.affinityMap) {
          if (bucket.length > 0) return bucket[0];
        }
        return undefined;
      }
    }
  }

  size(): number {
    switch (this._strategy) {
      case 'fifo':
        return this.fifoQueue.length;
      case 'priority':
        return Object.values(this.priorityBuckets).reduce(
          (s, b) => s + b.length,
          0
        );
      case 'affinity': {
        let total = this.fifoQueue.length;
        for (const [, bucket] of this.affinityMap) total += bucket.length;
        return total;
      }
    }
  }

  cancel(subagentId: string): boolean {
    const removeFirst = (arr: SubagentSchedulingRequest[]): boolean => {
      const idx = arr.findIndex((r) => r.subagentId === subagentId);
      if (idx >= 0) {
        arr.splice(idx, 1);
        return true;
      }
      return false;
    };
    if (removeFirst(this.fifoQueue)) return true;
    for (const level of ['high', 'medium', 'low'] as Priority[]) {
      if (removeFirst(this.priorityBuckets[level])) return true;
    }
    for (const [, bucket] of this.affinityMap) {
      if (removeFirst(bucket)) return true;
    }
    return false;
  }
}
```

### 4.2 并发限制管理

文件：`packages/agent-subagent/src/scheduler/concurrency-controller.ts`

```typescript
export interface ConcurrencyLimits {
  /** 全局最大并发子代理数 */
  maxGlobalConcurrency: number;
  /** 每父级最大并发子代理数 */
  maxPerParent: number;
  /** 全局最大待处理数 */
  maxQueued: number;
}

export const DEFAULT_CONCURRENCY_LIMITS: ConcurrencyLimits = {
  maxGlobalConcurrency: 6,
  maxPerParent: 4,
  maxQueued: 20,
};

export class ConcurrencyController {
  private activeCount = 0;
  private parentCounts = new Map<string, number>();
  private readonly limits: ConcurrencyLimits;

  constructor(limits?: Partial<ConcurrencyLimits>) {
    this.limits = { ...DEFAULT_CONCURRENCY_LIMITS, ...limits };
  }

  canSpawn(parentSessionId: string): { allowed: boolean; reason?: string } {
    if (this.activeCount >= this.limits.maxGlobalConcurrency) {
      return { allowed: false, reason: 'max-global-concurrency-exceeded' };
    }
    const parentCount = this.parentCounts.get(parentSessionId) ?? 0;
    if (parentCount >= this.limits.maxPerParent) {
      return { allowed: false, reason: 'max-per-parent-exceeded' };
    }
    return { allowed: true };
  }

  acquire(parentSessionId: string): void {
    this.activeCount++;
    this.parentCounts.set(
      parentSessionId,
      (this.parentCounts.get(parentSessionId) ?? 0) + 1
    );
  }

  release(parentSessionId: string): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    const count = this.parentCounts.get(parentSessionId) ?? 0;
    if (count <= 1) {
      this.parentCounts.delete(parentSessionId);
    } else {
      this.parentCounts.set(parentSessionId, count - 1);
    }
  }

  get stats() {
    return {
      activeCount: this.activeCount,
      maxGlobalConcurrency: this.limits.maxGlobalConcurrency,
      parentCounts: new Map(this.parentCounts),
    };
  }
}
```

### 4.3 递归守卫

文件：`packages/agent-subagent/src/guard/recursion-guard.ts`

```typescript
export interface RecursionGuardConfig {
  /** 最大递归深度（0=禁止嵌套，默认3） */
  maxDepth: number;
  /** 同一父级最大兄弟数 */
  maxSiblings: number;
  /** 最大并发子代理数 */
  maxConcurrent: number;
  /** 总 token 预算（所有子代理累计，0=不限制） */
  totalTokenBudget: number;
  /** 总超时时间（ms，所有子代理累计，0=不限制） */
  totalTimeoutMs: number;
}

export const DEFAULT_RECURSION_GUARD: RecursionGuardConfig = {
  maxDepth: 3,
  maxSiblings: 5,
  maxConcurrent: 6,
  totalTokenBudget: 0,
  totalTimeoutMs: 0,
};

export interface RecursionContext {
  currentDepth: number;
  parentSessionId?: string;
  ancestorSessionIds: string[];
}

export class RecursionGuard {
  private readonly config: RecursionGuardConfig;

  constructor(config?: Partial<RecursionGuardConfig>) {
    this.config = { ...DEFAULT_RECURSION_GUARD, ...config };
  }

  checkSpawn(
    context: RecursionContext,
    parentSessionId: string,
    siblingsCount: number
  ): { allowed: boolean; reason?: string } {
    if (context.currentDepth >= this.config.maxDepth) {
      return {
        allowed: false,
        reason: `max-depth (${this.config.maxDepth}) exceeded`,
      };
    }
    if (siblingsCount >= this.config.maxSiblings) {
      return {
        allowed: false,
        reason: `max-siblings (${this.config.maxSiblings}) exceeded`,
      };
    }
    return { allowed: true };
  }

  checkAncestorCycle(sessionId: string, ancestors: string[]): boolean {
    return ancestors.includes(sessionId);
  }

  getConfig(): RecursionGuardConfig {
    return { ...this.config };
  }
}
```

### 4.4 死锁检测

文件：`packages/agent-subagent/src/guard/deadlock-detector.ts`

```typescript
/**
 * 死锁检测（子代理相互等待场景）
 *
 * 通过维护子代理间的等待依赖图（有向图），
 * 定期检测是否存在环。如果检测到环，则终止环中
 * 优先级最低的子代理来解除死锁。
 */
export interface WaitDependency {
  fromSessionId: string;
  toSessionId: string;
  waitType: 'result' | 'resource' | 'completion';
  createdAt: string;
}

export class DeadlockDetector {
  private dependencies: WaitDependency[] = [];
  private readonly checkIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(checkIntervalMs = 5000) {
    this.checkIntervalMs = checkIntervalMs;
  }

  addDependency(dep: WaitDependency): void {
    this.dependencies.push(dep);
  }

  removeDependency(from: string, to: string): void {
    const idx = this.dependencies.findIndex(
      (d) => d.fromSessionId === from && d.toSessionId === to
    );
    if (idx >= 0) this.dependencies.splice(idx, 1);
  }

  /**
   * 检测依赖图中是否存在环
   * 返回环中的节点列表（如果有）
   */
  detectCycle(): string[][] {
    const graph = this.buildGraph();
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const dfs = (node: string, path: string[]) => {
      visited.add(node);
      recStack.add(node);
      path.push(node);

      const neighbors = graph.get(node) ?? [];
      for (const next of neighbors) {
        if (!visited.has(next)) {
          dfs(next, path);
        } else if (recStack.has(next)) {
          // 发现环：从 next 到当前 path 末尾
          const cycleStart = path.indexOf(next);
          if (cycleStart >= 0) {
            cycles.push(path.slice(cycleStart));
          }
        }
      }

      path.pop();
      recStack.delete(node);
    };

    for (const node of graph.keys()) {
      if (!visited.has(node)) {
        dfs(node, []);
      }
    }

    return cycles;
  }

  startAutoDetect(onDeadlock: (cycles: string[][]) => void): void {
    this.timer = setInterval(() => {
      const cycles = this.detectCycle();
      if (cycles.length > 0) {
        onDeadlock(cycles);
      }
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private buildGraph(): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    for (const dep of this.dependencies) {
      const neighbors = graph.get(dep.fromSessionId) ?? [];
      neighbors.push(dep.toSessionId);
      graph.set(dep.fromSessionId, neighbors);
    }
    return graph;
  }
}
```

### 4.5 看门狗

文件：`packages/agent-subagent/src/guard/watchdog.ts`

```typescript
/**
 * 看门狗（stuck detection + 超时终止）
 *
 * 监控正在运行的子代理，检测：
 * 1. 超时（超出 timeoutMs 设定值）
 * 2. 卡住（长时间无进展——无 tool call、无 text delta）
 */
export interface WatchdogOptions {
  /** 看门狗检查间隔（ms） */
  tickIntervalMs: number;
  /** 卡住判定阈值（ms，超过此时间无任何进展则判定卡住） */
  stuckThresholdMs: number;
}

export const DEFAULT_WATCHDOG_OPTIONS: WatchdogOptions = {
  tickIntervalMs: 2000,
  stuckThresholdMs: 60000,
};

export interface WatchdogEntry {
  instance: SubagentInstance;
  timeoutMs: number;
  startedAt: number;
  lastProgressAt: number;
  turnsCompleted: number;
}

export class SubagentWatchdog {
  private entries = new Map<string, WatchdogEntry>();
  private options: WatchdogOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onTimeout: (subagentId: string) => void;
  private readonly onStuck: (subagentId: string) => void;

  constructor(
    opts: Partial<WatchdogOptions>,
    onTimeout: (subagentId: string) => void,
    onStuck: (subagentId: string) => void
  ) {
    this.options = { ...DEFAULT_WATCHDOG_OPTIONS, ...opts };
    this.onTimeout = onTimeout;
    this.onStuck = onStuck;
  }

  watch(instance: SubagentInstance, timeoutMs: number): void {
    const now = Date.now();
    this.entries.set(instance.subagentId, {
      instance,
      timeoutMs,
      startedAt: now,
      lastProgressAt: now,
      turnsCompleted: 0,
    });
  }

  reportProgress(subagentId: string): void {
    const entry = this.entries.get(subagentId);
    if (entry) {
      entry.lastProgressAt = Date.now();
      entry.turnsCompleted++;
    }
  }

  unwatch(subagentId: string): void {
    this.entries.delete(subagentId);
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.options.tickIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private tick(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.instance.state !== 'running') continue;

      // 超时检测
      if (entry.timeoutMs > 0 && now - entry.startedAt > entry.timeoutMs) {
        this.onTimeout(id);
        continue;
      }

      // 卡住检测
      if (now - entry.lastProgressAt > this.options.stuckThresholdMs) {
        this.onStuck(id);
      }
    }
  }
}
```

### 4.6 Token 预算跟踪

文件：`packages/agent-subagent/src/guard/token-budget.ts`

```typescript
export class TokenBudgetTracker {
  private usedBySubagent = new Map<string, number>();
  private totalUsed = 0;
  private readonly budget: number;

  constructor(budget: number) {
    this.budget = budget; // 0 = 无限制
  }

  recordUsage(subagentId: string, tokens: number): boolean {
    if (this.budget <= 0) return true; // 无限制
    const current = this.usedBySubagent.get(subagentId) ?? 0;
    this.usedBySubagent.set(subagentId, current + tokens);
    this.totalUsed += tokens;
    return this.totalUsed <= this.budget;
  }

  isOverBudget(): boolean {
    return this.budget > 0 && this.totalUsed >= this.budget;
  }

  remaining(): number {
    return this.budget > 0
      ? Math.max(0, this.budget - this.totalUsed)
      : Infinity;
  }

  usageBy(subagentId: string): number {
    return this.usedBySubagent.get(subagentId) ?? 0;
  }

  reset(): void {
    this.usedBySubagent.clear();
    this.totalUsed = 0;
  }
}
```

---

## 5. 子代理间通信

### 5.1 消息传递接口

文件：`packages/agent-subagent/src/communication/message-bus.ts`

```typescript
export type SubagentMessageType =
  'text' | 'result' | 'error' | 'progress' | 'request' | 'response' | 'steer';

export interface SubagentMessage {
  id: string;
  type: SubagentMessageType;
  fromSessionId: string;
  toSessionId: string;
  payload: unknown;
  timestamp: string;
  correlationId?: string; // 用于请求-响应配对
}

export interface SubagentMessageHandler {
  (message: SubagentMessage): Promise<void> | void;
}

export interface SubagentCommunicationBus {
  /** 发送消息到指定子代理 */
  send(
    targetSessionId: string,
    message: Omit<SubagentMessage, 'id' | 'timestamp'>
  ): Promise<void>;
  /** 订阅指定来源的消息 */
  subscribe(fromSessionId: string, handler: SubagentMessageHandler): () => void;
  /** 广播消息给所有子代理 */
  broadcast(
    message: Omit<SubagentMessage, 'id' | 'timestamp' | 'toSessionId'>
  ): Promise<void>;
  /** 请求-响应模式 */
  request(
    targetSessionId: string,
    payload: unknown,
    timeoutMs?: number
  ): Promise<unknown>;
}
```

### 5.2 通信模式实现

文件：`packages/agent-subagent/src/communication/bus-impl.ts`

```typescript
import { createId, nowIso } from '@crish/agent-runtime';

export class DefaultSubagentCommunicationBus implements SubagentCommunicationBus {
  private subscribers = new Map<string, Set<SubagentMessageHandler>>();
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  async send(
    targetSessionId: string,
    message: Omit<SubagentMessage, 'id' | 'timestamp'>
  ): Promise<void> {
    const full: SubagentMessage = {
      id: createId('msg'),
      timestamp: nowIso(),
      ...message,
      toSessionId: targetSessionId,
    };
    const handlers = this.subscribers.get(targetSessionId);
    if (handlers) {
      for (const handler of handlers) {
        await handler(full);
      }
    }
  }

  subscribe(
    fromSessionId: string,
    handler: SubagentMessageHandler
  ): () => void {
    let handlers = this.subscribers.get(fromSessionId);
    if (!handlers) {
      handlers = new Set();
      this.subscribers.set(fromSessionId, handlers);
    }
    handlers.add(handler);
    return () => handlers?.delete(handler);
  }

  async broadcast(
    message: Omit<SubagentMessage, 'id' | 'timestamp' | 'toSessionId'>
  ): Promise<void> {
    for (const [sessionId] of this.subscribers) {
      await this.send(sessionId, { ...message, toSessionId: sessionId });
    }
  }

  async request(
    targetSessionId: string,
    payload: unknown,
    timeoutMs = 30000
  ): Promise<unknown> {
    const correlationId = createId('corr');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(
          new Error(
            `Request to ${targetSessionId} timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      this.pendingRequests.set(correlationId, { resolve, reject, timer });
      this.send(targetSessionId, {
        fromSessionId: 'parent',
        toSessionId: targetSessionId,
        type: 'request',
        payload,
        correlationId,
      });
    });
  }

  async respond(correlationId: string, payload: unknown): Promise<void> {
    const pending = this.pendingRequests.get(correlationId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(correlationId);
      pending.resolve(payload);
    }
  }
}
```

### 5.3 父子通信模式

文件：`packages/agent-subagent/src/communication/patterns.ts`

```typescript
/**
 * 父子通信模式
 *
 * 父代理通过 spawn 参数传递 context（task card、context pack），
 * 子代理通过 progress event 回报进展，最终结果通过 spawn 的 return value 传递。
 *
 * 共享 Artifact Store 用于结果共享。
 */

export interface ParentChildProtocol {
  /** 发送 steer 指令给子代理（不打断，入队等待安全点） */
  steerChild(subagentId: string, instruction: string): Promise<void>;
  /** 强制中断子代理 */
  cancelChild(subagentId: string, reason?: string): Promise<void>;
  /** 读取子代理的当前状态 */
  getChildSnapshot(subagentId: string): SubagentStateSnapshot;
  /** 等待子代理完成 */
  waitForChild(
    subagentId: string,
    timeoutMs?: number
  ): Promise<SubagentRunResult>;
}

/**
 * 兄弟通信模式
 *
 * 兄弟子代理通过共享的 CommunicationBus 进行消息传递，
 * 也可以通过 ArtifactStore 共享结果文件。
 */
export interface SiblingProtocol {
  /** 向兄弟子代理发送消息 */
  sendToSibling(siblingId: string, message: unknown): Promise<void>;
  /** 请求兄弟子代理的结果 */
  requestFromSibling(siblingId: string, artifactKey: string): Promise<unknown>;
  /** 共享 artifact */
  shareArtifact(key: string, value: unknown): Promise<void>;
}

/**
 * 监督模式（Supervisor Orchestration）
 *
 * 父代理作为 supervisor，协调多个子代理的工作。
 * 子代理向 supervisor 报告进度，supervisor 根据进度决定下一步。
 */
export interface SupervisorProtocol {
  /** supervisor 指派任务给子代理 */
  assignTask(subagentId: string, task: SubagentTaskCard): Promise<void>;
  /** 子代理报告任务完成 */
  reportCompletion(subagentId: string, result: unknown): Promise<void>;
  /** supervisor 决定下一步 */
  decideNextAction(): Promise<'continue' | 'restart' | 'stop'>;
}
```

---

## 6. 与现有系统集成

### 6.1 与 agent-runtime 的集成

文件：修改 `packages/agent-runtime/src/runtime.ts`

```typescript
// 在 AgentRuntimeOptions 中新增：
export interface AgentRuntimeOptions {
  // ... 现有字段 ...

  /** 递归深度（子代理用） */
  subagentDepth?: number;

  /** 父会话 ID（子代理用） */
  parentSessionId?: string;

  /** 子代理通信总线（子代理用） */
  subagentBus?: SubagentCommunicationBus;

  /** 子代理规格定义（子代理用） */
  subagentDefinition?: SubagentDefinition;

  /** 子代理实例句柄（子代理用） */
  subagentInstance?: SubagentInstance;
}
```

### 6.2 与 agent-orchestrator 的集成

文件：`packages/agent-orchestrator/src/event-store/event-types.ts`（新增子代理事件类型）

```typescript
export type SubagentEventType =
  | 'subagent-created'
  | 'subagent-started'
  | 'subagent-completed'
  | 'subagent-failed'
  | 'subagent-cancelled'
  | 'subagent-timed-out'
  | 'subagent-progress'
  | 'subagent-message';

export interface SubagentCreatedPayload {
  subagentId: string;
  parentSessionId: string;
  parentRunId: string;
  definitionName: string;
  role: string;
  model: string;
  mode: string;
  description: string;
}

export interface SubagentStartedPayload {
  subagentId: string;
  parentSessionId: string;
  startedAt: string;
}

export interface SubagentCompletedPayload {
  subagentId: string;
  parentSessionId: string;
  status: 'completed' | 'failed';
  turnsUsed: number;
  toolsUsed: number;
  totalTokens: number;
  durationMs: number;
  finalText: string;
  completionSummary: string;
  error?: string;
}
```

### 6.3 与 Plugin SDK 的集成

文件：`packages/agent-subagent/src/discovery/plugin-source.ts`

```typescript
import type { PluginRegistry } from '@crish/agent-runtime';
import type { SubagentDefinition } from '../definition/types';
import type { SubagentDiscoverySource } from './discovery';

export class PluginDiscoverySource implements SubagentDiscoverySource {
  readonly name = 'plugin';
  readonly priority = 30;

  constructor(private pluginRegistry: PluginRegistry) {}

  async *discover(): AsyncIterable<SubagentDefinition> {
    const plugins = this.pluginRegistry.listPlugins();
    for (const plugin of plugins) {
      const agents = plugin.manifest?.agents ?? [];
      for (const agent of agents) {
        yield {
          name: agent.name,
          version: agent.version ?? plugin.manifest.version ?? '1.0.0',
          description: agent.description ?? '',
          role: agent.role ?? 'custom',
          systemPrompt: agent.systemPrompt ?? '',
          model: agent.model,
          maxTurns: agent.maxTurns,
          timeoutMs: agent.timeoutMs,
          allowedTools: agent.allowedTools,
          capabilityMode: agent.capabilityMode,
          isolation: agent.isolation,
          metadata: {
            ...agent.metadata,
            pluginName: plugin.name,
            pluginVersion: plugin.manifest.version,
          },
        };
      }
    }
  }
}
```

### 6.4 与权限系统集成

文件：`packages/agent-subagent/src/integration/permissions.ts`

```typescript
import type { PermissionPolicy } from '@crish/agent-runtime';
import type { SubagentCapabilityMode } from '../definition/types';

/**
 * 子代理权限继承/缩减策略
 *
 * 子代理的权限 = 父代理权限 ∩ 子代理 capabilityMode 对应的权限
 * 即子代理无法获得父代理没有的权限
 */
export function computeSubagentPermissionPolicy(
  parentPolicy: PermissionPolicy,
  capabilityMode: SubagentCapabilityMode,
  cwd: string
): PermissionPolicy {
  switch (capabilityMode) {
    case 'read-only':
      // 只读模式：所有写操作被阻止
      return createRestrictedPolicy(parentPolicy, {
        denyPatterns: [
          'write',
          'create',
          'delete',
          'edit',
          'modify',
          'bash',
          'exec',
          'terminal',
          'run_command',
        ],
      });
    case 'read-write':
      // 读写模式：允许文件和代码操作，禁止命令执行
      return createRestrictedPolicy(parentPolicy, {
        denyPatterns: ['bash', 'exec', 'terminal', 'run_command'],
      });
    case 'execute':
      // 执行模式：允许运行命令，对文件写操作需审批
      return createRestrictedPolicy(parentPolicy, {
        askPatterns: ['write', 'create', 'delete', 'edit', 'modify'],
      });
    case 'all':
      // 完全模式：继承父代理策略
      return parentPolicy;
  }
}

function createRestrictedPolicy(
  base: PermissionPolicy,
  rules: { denyPatterns?: string[]; askPatterns?: string[] }
): PermissionPolicy {
  return {
    decide: async (request) => {
      const toolName = request.toolCall?.name ?? '';
      const lower = toolName.toLowerCase();

      if (rules.denyPatterns?.some((p) => lower.includes(p))) {
        return {
          behavior: 'deny',
          reason: `capability mode restriction: tool ${toolName} not allowed`,
        };
      }
      if (rules.askPatterns?.some((p) => lower.includes(p))) {
        return {
          behavior: 'ask',
          reason: `capability mode: tool ${toolName} requires approval`,
        };
      }

      return base.decide(request);
    },
  };
}
```

### 6.5 与 Telemetry 集成

文件：`packages/agent-subagent/src/integration/telemetry.ts`

```typescript
export interface SubagentTelemetryEvent {
  type:
    | 'subagent.start'
    | 'subagent.end'
    | 'subagent.turn'
    | 'subagent.tool'
    | 'subagent.error';
  subagentId: string;
  parentSessionId: string;
  definitionName: string;
  role: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export class SubagentTelemetryCollector {
  private events: SubagentTelemetryEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents = 1000) {
    this.maxEvents = maxEvents;
  }

  record(event: Omit<SubagentTelemetryEvent, 'timestamp'>): void {
    this.events.push({
      ...event,
      timestamp: new Date().toISOString(),
    });
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  flush(): SubagentTelemetryEvent[] {
    const snapshot = [...this.events];
    this.events = [];
    return snapshot;
  }

  getStats(): {
    totalStarted: number;
    totalCompleted: number;
    totalFailed: number;
    avgTurns: number;
  } {
    const started = this.events.filter(
      (e) => e.type === 'subagent.start'
    ).length;
    const completed = this.events.filter(
      (e) => e.type === 'subagent.end' && !e.payload.error
    ).length;
    const failed = this.events.filter(
      (e) => e.type === 'subagent.end' && e.payload.error
    ).length;
    const turnEvents = this.events.filter((e) => e.type === 'subagent.turn');
    const totalTurns = turnEvents.reduce(
      (sum, e) => sum + ((e.payload.turnCount as number) ?? 0),
      0
    );
    return {
      totalStarted: started,
      totalCompleted: completed,
      totalFailed: failed,
      avgTurns: completed > 0 ? Math.round(totalTurns / completed) : 0,
    };
  }
}
```

---

## 7. 执行引擎

### 7.1 SubagentRuntimeManager

文件：`packages/agent-subagent/src/execution/runtime-manager.ts`

```typescript
import { AgentRuntime } from '@crish/agent-runtime';
import type { AgentProvider, AgentTool } from '@crish/agent-runtime';
import type {
  SubagentDefinition,
  EffectiveRuntimeConfig,
} from '../definition/types';
import type { SubagentInstance } from '../lifecycle/instance';

export interface SubagentRuntimeOptions {
  definition: SubagentDefinition;
  config: EffectiveRuntimeConfig;
  parentSessionId: string;
  parentToolCallId: string;
  cwd: string;
  systemPrompt: string;
  taskCard: string;
  parentProvider?: AgentProvider;
  parentTools?: AgentTool[];
  subagentDepth: number;
  instance: SubagentInstance;
}

export class SubagentRuntimeManager {
  async createRuntime(opts: SubagentRuntimeOptions): Promise<AgentRuntime> {
    const runtime = new AgentRuntime({
      sessionId: opts.instance.subagentId,
      cwd: opts.cwd,
      systemPrompt: opts.systemPrompt,
      provider: opts.parentProvider ?? this.resolveProvider(opts.config),
      tools: this.filterTools(opts.parentTools ?? [], opts.definition),
      maxTurns: opts.definition.maxTurns,
      subagentDepth: opts.subagentDepth,
      parentSessionId: opts.parentSessionId,
    });

    await opts.instance.initialize(runtime);
    return runtime;
  }

  private filterTools(
    allTools: AgentTool[],
    definition: SubagentDefinition
  ): AgentTool[] {
    let tools = allTools;

    if (definition.allowedTools && definition.allowedTools.length > 0) {
      const allowed = new Set(
        definition.allowedTools.map((t) => t.toLowerCase())
      );
      tools = tools.filter((t) => allowed.has(t.name.toLowerCase()));
    }

    if (definition.deniedTools && definition.deniedTools.length > 0) {
      const denied = new Set(
        definition.deniedTools.map((t) => t.toLowerCase())
      );
      tools = tools.filter((t) => !denied.has(t.name.toLowerCase()));
    }

    if (definition.capabilityMode === 'read-only') {
      tools = tools.filter((t) => t.isReadOnly ?? true);
    }

    return tools;
  }

  private resolveProvider(config: EffectiveRuntimeConfig): AgentProvider {
    // 根据模型配置创建 provider，使用默认 provider 工厂
    return undefined as any; // TODO: 集成 provider 工厂
  }
}
```

### 7.2 Context 传递机制

文件：`packages/agent-subagent/src/execution/context-transfer.ts`

构建子代理 context pack 时传入父级 context snapshot（参考现有 `subagent-context-pack.ts`），同时新增上下文继承控制：

```typescript
export interface ContextInheritancePolicy {
  /** 是否继承父级消息历史 */
  inheritMessages: boolean;
  /** 消息历史最大条数 */
  maxParentMessages: number;
  /** 是否继承父级工具集 */
  inheritTools: boolean;
  /** 是否继承父级系统提示词 */
  inheritSystemPrompt: boolean;
  /** 是否继承父级 context state */
  inheritContextState: boolean;
}

export const DEFAULT_CONTEXT_INHERITANCE: ContextInheritancePolicy = {
  inheritMessages: true,
  maxParentMessages: 10,
  inheritTools: true,
  inheritSystemPrompt: false,
  inheritContextState: false,
};
```

### 7.3 主调度器

文件：`packages/agent-subagent/src/scheduler/subagent-scheduler.ts`

```typescript
import type {
  SubagentDefinition,
  SubagentRuntimeOverrides,
} from '../definition/types';
import type { SubagentInstance } from '../lifecycle/instance';
import type { SubagentRunResult } from './types';

export interface SubagentSpawnOptions {
  /** 子代理定义名称（来自发现系统） */
  definitionName: string;
  /** 任务 prompt */
  prompt: string;
  /** 描述 */
  description: string;
  /** 模式 */
  mode: 'research' | 'implement' | 'verify';
  /** 覆写（可选） */
  overrides?: SubagentRuntimeOverrides;
  /** 调度优先级 */
  priority?: 'high' | 'medium' | 'low';
  /** fork 策略 */
  forkPolicy?: 'task-only' | 'summary' | 'full';
  /** 超时 */
  timeoutMs?: number;
  /** 进度回调 */
  onProgress?: (event: SubagentProgressEvent) => void;
}

export class SubagentScheduler {
  private readonly discovery: SubagentDiscoveryService;
  private readonly queue: SubagentSchedulingQueue;
  private readonly concurrency: ConcurrencyController;
  private readonly recursionGuard: RecursionGuard;
  private readonly watchDog: SubagentWatchdog;
  private readonly deadlockDetector: DeadlockDetector;
  private readonly runtimeManager: SubagentRuntimeManager;
  private readonly bus: DefaultSubagentCommunicationBus;
  private readonly telemetry: SubagentTelemetryCollector;
  private readonly hooks: SubagentHookRegistry;

  private instances = new Map<string, SubagentInstance>();
  private depthMap = new Map<string, number>(); // sessionId -> depth

  constructor(opts: {
    cwd: string;
    pluginRegistry?: PluginRegistry;
    hooks: SubagentHookRegistry;
    lifecycleHooks?: LifecycleHookRegistry;
    limits?: Partial<ConcurrencyLimits>;
    guard?: Partial<RecursionGuardConfig>;
    watchDog?: Partial<WatchdogOptions>;
    schedulingStrategy?: SchedulingStrategy;
  }) {
    this.discovery = new SubagentDiscoveryService({
      cwd: opts.cwd,
      pluginRegistry: opts.pluginRegistry,
    });
    this.queue = new SubagentSchedulingQueue(opts.schedulingStrategy);
    this.concurrency = new ConcurrencyController(opts.limits);
    this.recursionGuard = new RecursionGuard(opts.guard);
    this.watchDog = new SubagentWatchdog(
      opts.watchDog ?? {},
      (id) => this.handleTimeout(id),
      (id) => this.handleStuck(id)
    );
    this.deadlockDetector = new DeadlockDetector();
    this.runtimeManager = new SubagentRuntimeManager();
    this.bus = new DefaultSubagentCommunicationBus();
    this.telemetry = new SubagentTelemetryCollector();
    this.hooks = opts.hooks;
  }

  /** 列出所有可用子代理定义 */
  async listDefinitions(): Promise<SubagentDefinition[]> {
    return this.discovery.listAll();
  }

  /** 查找子代理定义 */
  async findDefinition(name: string): Promise<SubagentDefinition | null> {
    return this.discovery.findByName(name);
  }

  /** 同步创建并排入调度队列 */
  async spawn(
    parentSessionId: string,
    parentDepth: number,
    options: SubagentSpawnOptions
  ): Promise<SubagentRunResult> {
    // 1. 查找定义
    const definition = await this.findDefinition(options.definitionName);
    if (!definition) {
      return {
        subagentId: '',
        parentSessionId,
        parentToolCallId: '',
        description: options.description,
        mode: options.mode,
        status: 'failed',
        error: `Unknown subagent definition: ${options.definitionName}`,
        stats: { toolUses: 0, turns: 0, events: {} },
        finalText: '',
        completionSummary: '',
        contextPack: {},
      };
    }

    // 2. 检查递归守卫
    const siblingsCount = this.countSiblings(parentSessionId);
    const guardCheck = this.recursionGuard.checkSpawn(
      {
        currentDepth: parentDepth + 1,
        parentSessionId,
        ancestorSessionIds: this.computeAncestors(parentSessionId),
      },
      parentSessionId,
      siblingsCount
    );
    if (!guardCheck.allowed) {
      return {
        subagentId: '',
        parentSessionId,
        parentToolCallId: '',
        description: options.description,
        mode: options.mode,
        status: 'failed',
        error: guardCheck.reason!,
        stats: { toolUses: 0, turns: 0, events: {} },
        finalText: '',
        completionSummary: '',
        contextPack: {},
      };
    }

    // 3. 检查并发限制
    const concurrencyCheck = this.concurrency.canSpawn(parentSessionId);
    if (!concurrencyCheck.allowed) {
      return {
        subagentId: '',
        parentSessionId,
        parentToolCallId: '',
        description: options.description,
        mode: options.mode,
        status: 'failed',
        error: concurrencyCheck.reason!,
        stats: { toolUses: 0, turns: 0, events: {} },
        finalText: '',
        completionSummary: '',
        contextPack: {},
      };
    }

    // 4. 触发 beforeCreate hook
    await this.hooks.emit('subagent:beforeCreate', {
      definition,
      overrides: options.overrides ?? {},
    });

    // 5. 创建实例并入队
    const subagentId = createId('subagent');
    const config = resolveEffectiveRuntimeConfig(
      options.overrides ?? {},
      null, // TODO: resolve role
      new Map(), // TODO: resolve persona
      undefined,
      undefined
    );
    const instance = new SubagentInstance({
      subagentId,
      parentSessionId,
      parentToolCallId: '', // set by caller
      definition,
      config,
      hooks: this.hooks,
    });
    this.instances.set(subagentId, instance);
    this.depthMap.set(subagentId, parentDepth + 1);

    await this.hooks.emit('subagent:afterCreate', { instance });

    // 6. 注册看门狗
    this.watchDog.watch(
      instance,
      options.timeoutMs ?? definition.timeoutMs ?? 300000
    );

    // 7. 排入队列
    this.queue.enqueue({
      subagentId,
      definitionName: options.definitionName,
      priority: options.priority ?? 'medium',
      strategy: 'fifo',
      parentSessionId,
      createdAt: new Date().toISOString(),
      payload: {
        prompt: options.prompt,
        description: options.description,
        mode: options.mode,
        overrides: options.overrides ?? {},
        forkPolicy: options.forkPolicy ?? 'summary',
      },
    });

    // 8. 尝试立即执行（如果队列有空位）
    return this.tryDequeueAndExecute(parentSessionId);
  }

  private async tryDequeueAndExecute(
    parentSessionId: string
  ): Promise<SubagentRunResult> {
    const request = this.queue.dequeue();
    if (!request) return null as any; // 队列空

    this.concurrency.acquire(parentSessionId);
    const instance = this.instances.get(request.subagentId)!;

    try {
      // 执行子代理
      const result = await this.executeInstance(instance, request.payload);
      instance.markCompleted();
      await this.hooks.emit('subagent:completed', { instance, result });

      this.telemetry.record({
        type: 'subagent.end',
        subagentId: instance.subagentId,
        parentSessionId,
        definitionName: request.definitionName,
        role: instance.definition.role,
        payload: { status: 'completed', turns: result.stats.turns },
      });

      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      instance.markFailed(errorMsg);
      await this.hooks.emit('subagent:failed', { instance, error: errorMsg });

      this.telemetry.record({
        type: 'subagent.end',
        subagentId: instance.subagentId,
        parentSessionId,
        definitionName: request.definitionName,
        role: instance.definition.role,
        payload: { status: 'failed', error: errorMsg },
      });

      return {
        subagentId: instance.subagentId,
        parentSessionId,
        parentToolCallId: request.payload.description,
        description: request.payload.description,
        mode: request.payload.mode,
        status: 'failed',
        error: errorMsg,
        stats: { toolUses: 0, turns: 0, events: {} },
        finalText: '',
        completionSummary: '',
        contextPack: {},
      };
    } finally {
      this.concurrency.release(parentSessionId);
      this.watchDog.unwatch(instance.subagentId);
      this.instances.delete(instance.subagentId);
      this.depthMap.delete(instance.subagentId);
    }
  }

  private async executeInstance(
    instance: SubagentInstance,
    payload: SubagentSpawnPayload
  ): Promise<SubagentRunResult> {
    // 内部执行逻辑：创建运行时 → 运行 → 收集结果
    // 此处整合现有的 createSubagentTool 的 execute 逻辑
    const runtime = new AgentRuntime({
      sessionId: instance.subagentId,
      cwd: '',
      systemPrompt: `${instance.definition.systemPrompt}\n\n${payload.prompt}`,
      provider: undefined as any, // TODO
      tools: [], // TODO
      maxTurns: instance.definition.maxTurns,
      subagentDepth: this.depthMap.get(instance.subagentId) ?? 1,
    });

    const iterator = runtime.run(payload.prompt);
    const messages: AgentMessage[] = [];
    let status: 'completed' | 'failed' = 'completed';
    let error: string | undefined;

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        messages = next.value;
        break;
      }
      if (next.value.type === 'agent-end') {
        if (next.value.reason !== 'stop') {
          status = 'failed';
          error = next.value.error ?? `agent ended with ${next.value.reason}`;
        }
      }
      // 报告看门狗进展
      this.watchDog.reportProgress(instance.subagentId);
    }

    const finalText = messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    return {
      subagentId: instance.subagentId,
      parentSessionId: instance.parentSessionId,
      parentToolCallId: '',
      description: payload.description,
      mode: payload.mode,
      status,
      error,
      stats: { toolUses: 0, turns: 0, events: {} },
      finalText,
      completionSummary: `${payload.description} ${status}.`,
      contextPack: {},
    };
  }

  // ... 辅助方法
}
```

---

## 8. 实施文件结构

### 8.1 新包 `@crish/agent-subagent`

```
packages/agent-subagent/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                          # 公共导出
    ├── types.ts                          # 模块级类型
    │
    ├── definition/
    │   ├── types.ts                      # SubagentDefinition, EffectiveRuntimeConfig
    │   ├── persona.ts                    # SubagentRoleDefinition, SubagentPersona
    │   └── override-resolver.ts          # resolveEffectiveRuntimeConfig
    │
    ├── discovery/
    │   ├── discovery.ts                  # SubagentDiscoveryService, SubagentDiscoverySource
    │   ├── file-source.ts                # 文件系统发现（项目/用户级）
    │   ├── builtin-source.ts             # 内置子代理定义
    │   └── plugin-source.ts              # 插件发现
    │
    ├── lifecycle/
    │   ├── state.ts                      # SubagentState, SubagentStateSnapshot
    │   ├── instance.ts                   # SubagentInstance
    │   └── hooks.ts                      # SubagentHookRegistry, SubagentHookEventType
    │
    ├── scheduler/
    │   ├── queue.ts                      # SubagentSchedulingQueue, SchedulingStrategy
    │   ├── concurrency-controller.ts     # ConcurrencyController
    │   └── subagent-scheduler.ts         # SubagentScheduler（主调度器）
    │
    ├── guard/
    │   ├── recursion-guard.ts            # RecursionGuard
    │   ├── deadlock-detector.ts          # DeadlockDetector
    │   ├── watchdog.ts                   # SubagentWatchdog
    │   └── token-budget.ts               # TokenBudgetTracker
    │
    ├── communication/
    │   ├── message-bus.ts                # SubagentCommunicationBus 接口
    │   ├── bus-impl.ts                   # DefaultSubagentCommunicationBus
    │   └── patterns.ts                   # 通信模式（父子/兄弟/监督）
    │
    ├── execution/
    │   ├── runtime-manager.ts            # SubagentRuntimeManager
    │   └── context-transfer.ts           # ContextInheritancePolicy
    │
    └── integration/
        ├── permissions.ts                # computeSubagentPermissionPolicy
        └── telemetry.ts                  # SubagentTelemetryCollector
```

### 8.2 对 `@crish/agent-runtime` 的修改

```
packages/agent-runtime/src/
├── runtime.ts                           # AgentRuntimeOptions 新增 subagentDepth / parentSessionId
├── types.ts                             # 新增 AgentRuntimeOptions 扩展
├── subagents.ts                         # 重构：委托给 SubagentScheduler.spawn
├── subagent-types.ts                    # 保留兼容导出
├── subagent-context-pack.ts             # 无变更
├── subagent-loop.ts                     # 无变更（保留为轻量 loop）
└── subagent-skill-runner.ts             # 无变更
```

### 8.3 对 `@crish/agent-orchestrator` 的修改

```
packages/agent-orchestrator/src/
├── event-store/event-types.ts           # 新增 SubagentEventType 和 payload 类型
├── orchestrator.ts                      # 新增 subagentScheduler getter
└── orchestrator/agent-loop.ts           # 在 run 中集成 SubagentScheduler
```

### 8.4 package.json 配置

```json
{
  "name": "@crish/agent-subagent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./definition": "./src/definition/index.ts",
    "./scheduler": "./src/scheduler/index.ts",
    "./guard": "./src/guard/index.ts",
    "./lifecycle": "./src/lifecycle/index.ts",
    "./communication": "./src/communication/index.ts",
    "./discovery": "./src/discovery/index.ts",
    "./execution": "./src/execution/index.ts",
    "./integration": "./src/integration/index.ts"
  },
  "dependencies": {
    "@crish/shared-types": "workspace:*",
    "@crish/shared-utils": "workspace:*",
    "@crish/agent-runtime": "workspace:*"
  }
}
```

### 8.5 `@crish/agent-subagent/src/index.ts`

```typescript
export type {
  SubagentDefinition,
  SubagentRole,
  SubagentIsolationMode,
  SubagentCapabilityMode,
  SubagentConstraint,
  SubagentIOField,
  SubagentRuntimeOverrides,
  SubagentSpawnPayload,
} from './definition/types';

export type {
  SubagentRoleDefinition,
  SubagentPersona,
  EffectiveRuntimeConfig,
} from './definition/persona';

export { resolveEffectiveRuntimeConfig } from './definition/override-resolver';

export { SubagentDiscoveryService } from './discovery/discovery';

export type {
  SubagentDiscoverySource,
  SubagentDiscoveryContext,
} from './discovery/discovery';

export { BuiltinDiscoverySource } from './discovery/builtin-source';

export { PluginDiscoverySource } from './discovery/plugin-source';

export type {
  SubagentState,
  SubagentStateSnapshot,
  SubagentStateTransition,
} from './lifecycle/state';

export { SubagentInstance } from './lifecycle/instance';

export type {
  SubagentHookEventType,
  SubagentHookPayloadMap,
  SubagentHookHandler,
  SubagentHookRegistry,
} from './lifecycle/hooks';

export type {
  SchedulingStrategy,
  Priority,
  SubagentSchedulingRequest,
} from './scheduler/queue';

export { SubagentSchedulingQueue } from './scheduler/queue';

export { ConcurrencyController } from './scheduler/concurrency-controller';

export type { ConcurrencyLimits } from './scheduler/concurrency-controller';

export { SubagentScheduler } from './scheduler/subagent-scheduler';

export type { SubagentSpawnOptions } from './scheduler/subagent-scheduler';

export { RecursionGuard } from './guard/recursion-guard';

export type {
  RecursionGuardConfig,
  RecursionContext,
} from './guard/recursion-guard';

export { DeadlockDetector } from './guard/deadlock-detector';

export type { WaitDependency } from './guard/deadlock-detector';

export { SubagentWatchdog } from './guard/watchdog';

export type { WatchdogOptions } from './guard/watchdog';

export { TokenBudgetTracker } from './guard/token-budget';

export type {
  SubagentCommunicationBus,
  SubagentMessage,
  SubagentMessageType,
} from './communication/message-bus';

export { DefaultSubagentCommunicationBus } from './communication/bus-impl';

export type { ContextInheritancePolicy } from './execution/context-transfer';

export { SubagentRuntimeManager } from './execution/runtime-manager';

export { computeSubagentPermissionPolicy } from './integration/permissions';

export { SubagentTelemetryCollector } from './integration/telemetry';

export type { SubagentTelemetryEvent } from './integration/telemetry';
```

---

## 9. 测试策略

### 9.1 单元测试清单

| 模块     | 文件                                       | 测试内容                                       |
| -------- | ------------------------------------------ | ---------------------------------------------- |
| 定义     | `definition/types.test.ts`                 | SubagentDefinition 序列化/反序列化，角色默认值 |
| 发现     | `discovery/discovery.test.ts`              | 多源查找合并、按名称查找、优先级排序           |
| 发现     | `discovery/file-source.test.ts`            | 文件系统解析、manifest 加载失败处理            |
| 生命周期 | `lifecycle/instance.test.ts`               | 状态转换合法性、转换记录、pause/resume         |
| 生命周期 | `lifecycle/hooks.test.ts`                  | Hook 注册、取消、emit 顺序                     |
| 调度     | `scheduler/queue.test.ts`                  | FIFO/优先级/亲和性出队顺序、取消               |
| 调度     | `scheduler/concurrency-controller.test.ts` | 并发上限、父级计数                             |
| 调度     | `scheduler/subagent-scheduler.test.ts`     | 完整 spawn 流程、递归守卫拒绝                  |
| 守卫     | `guard/recursion-guard.test.ts`            | 深度/兄弟/环检测                               |
| 守卫     | `guard/deadlock-detector.test.ts`          | 依赖图建图、环检测、无环场景                   |
| 守卫     | `guard/watchdog.test.ts`                   | 超时触发、卡住检测、progress 刷新              |
| 守卫     | `guard/token-budget.test.ts`               | Token 累计、超预算判定                         |
| 通信     | `communication/bus-impl.test.ts`           | 发送/订阅/广播/请求-响应/超时                  |
| 集成     | `integration/permissions.test.ts`          | 各种 capabilityMode 对应的权限策略             |
| 集成     | `integration/telemetry.test.ts`            | 事件采集、flush、统计                          |
| 执行     | `execution/runtime-manager.test.ts`        | 运行时创建、工具过滤                           |
| 执行     | `execution/context-transfer.test.ts`       | ContextInheritancePolicy 继承配置              |

### 9.2 集成测试

```typescript
// packages/agent-subagent/src/__tests__/subagent-scheduling.e2e.ts
describe('SubagentScheduling e2e', () => {
  it('finds builtin definitions', async () => {
    const scheduler = createTestScheduler();
    const defs = await scheduler.listDefinitions();
    expect(defs.map((d) => d.name)).toContain('explore');
    expect(defs.map((d) => d.name)).toContain('implement');
  });

  it('spawns a builtin explore subagent', async () => {
    const scheduler = createTestScheduler();
    const result = await scheduler.spawn('parent-session', 0, {
      definitionName: 'explore',
      prompt: 'List all TypeScript files in the project',
      description: 'Exploration task',
      mode: 'research',
    });
    expect(result.status).toBe('completed');
  });

  it('rejects spawn when max depth exceeded', async () => {
    const scheduler = createTestScheduler({ maxDepth: 1 });
    const result = await scheduler.spawn('parent', 0, {
      definitionName: 'explore',
      prompt: 'task',
      description: 'test',
      mode: 'research',
    });
    expect(result.status).toBe('completed'); // depth 1 ok

    const childResult = await scheduler.spawn('child', 1, {
      definitionName: 'explore',
      prompt: 'nested task',
      description: 'nested',
      mode: 'research',
    });
    expect(childResult.status).toBe('failed');
    expect(childResult.error).toContain('max-depth');
  });

  it('respects concurrency limits', async () => {
    const scheduler = createTestScheduler({ maxGlobalConcurrency: 1 });
    // 第一个占用并发槽
    const first = scheduler.spawn('parent', 0, {
      definitionName: 'explore',
      prompt: 'task1',
      description: 'test1',
      mode: 'research',
    });
    // 第二个应被拒绝
    const second = await scheduler.spawn('parent', 0, {
      definitionName: 'explore',
      prompt: 'task2',
      description: 'test2',
      mode: 'research',
    });
    expect(second.status).toBe('failed');
    expect(second.error).toContain('max-concurrent');
  });
});
```

---

## 附录 A：与 Grok Build 的模式对比

| Crish 实现                 | Grok Build 参考                                           | 关键区别                                         |
| -------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| `SubagentDefinition`       | `AgentDefinition` (`xai-grok-agent::config`)              | Crish 用 JSON 定义，Grok 用 Rust struct + TOML   |
| `SubagentDiscoveryService` | `discovery::by_name_in_cwd_with_plugins`                  | Crish 支持多源叠加，Grok 以 plugin registry 为主 |
| `SubagentSchedulingQueue`  | 无显式队列                                                | Crish 新增优先级/亲和性队列                      |
| `RecursionGuard`           | 深度限制嵌入 `apply_child_tool_policy`                    | Crish 独立为完整守卫模块（深度+兄弟+环）         |
| `DeadlockDetector`         | 无                                                        | Crish 新增                                       |
| `SubagentWatchdog`         | `timing.rs` 超时处理                                      | Crish 新增卡住检测                               |
| `EffectiveRuntimeConfig`   | `EffectiveRuntimeConfig` (`xai-grok-subagent-resolution`) | Crish 使用 TS 版本，解析逻辑一致                 |
| `SubagentRole/Persona`     | `SubagentRole`/`SubagentPersona` (`config.rs`)            | Crish 保留相同优先级策略                         |

## 附录 B：与 Pi/Codex CLI/Kimi Code 的模式对比

| Crish 实现                                     | Pi 参考                      | Codex CLI 参考                 | Kimi Code 参考          |
| ---------------------------------------------- | ---------------------------- | ------------------------------ | ----------------------- |
| `SubagentInstance` (状态机)                    | `AgentHarnessPhase` 状态管理 | `agent-graph-store` 图状态     | `agent/turn` TurnFlow   |
| `SubagentScheduler` (调度)                     | `agent-harness.ts` 编排      | `unified_exec` 执行引擎        | `di/` 服务层            |
| `SubagentWatchdog` + `DeadlockDetector` (守卫) | `handleRunFailure` 错误处理  | `agent_loop` 主循环            | `turn` 循环中的超时处理 |
| `SubagentCommunicationBus` (通信)              | 无显式总线                   | `agent-graph-store` 节点间通信 | `subagentHost` 父子通信 |
| `ConcurrencyController`                        | `AsyncSemaphore` 信号量      | 线程管理                       | `turn` 单 turn 限制     |
