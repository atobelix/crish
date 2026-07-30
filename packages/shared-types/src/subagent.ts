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
