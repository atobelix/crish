// packages/shared-types/src/subagent.ts
// 约束来源：ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 20-22 与本 Round 推迟项
//
// 嵌套禁止裁决（用户裁决，REQ-D08 kill 项，T-D-01/02 落地）：
// maxDepth=1 —— 仅主 Agent（深度 0）可派发子 Agent；子 Agent 深度 1，
// 无派发能力。Rust 侧 DEFAULT_RECURSION_GUARD 为唯一权威默认值，两侧同值。

/** 子代理角色（标签，仅用于展示与过滤，不影响调度）— 禁令 21 */
export type SubagentRole =
  'researcher' | 'implementer' | 'reviewer' | 'debugger' | 'planner';

/**
 * 子代理任务类型（REQ-D04 收敛，T-D-07）— 禁令 21 保持：新维度，
 * 不并入 role / capabilityMode。
 * 驱动系统默认权限集（Rust 侧 default_permissions 六映射），
 * 缺省 = analysis（最安全，fail-closed）；主 agent 不用配、也不必知道细节。
 */
export type SubagentTaskType =
  | 'analysis'
  | 'design'
  | 'review'
  | 'implementation'
  | 'organization'
  | 'commit';

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
  /** 最大递归深度，默认 1（仅主 Agent 可派发，用户裁决；T-D-01/02） */
  readonly maxDepth: number;
  /** 最大兄弟并发数，默认 5（保持；兄弟并发应小于全局并发） */
  readonly maxSiblings: number;
  /**
   * 最大全局并发数，默认 12（T-D-06 上限 12 对齐，6→12；
   * 与 Rust 侧 DEFAULT_RECURSION_GUARD 同值同语义）
   */
  readonly maxConcurrent: number;
  /** 全局 token 预算，默认 0（不限制，ROUND-09 §3 推迟组件） */
  readonly totalTokenBudget: number;
  /** 全局超时，默认 0（不限制，依赖每个子代理的 timeoutMs） */
  readonly totalTimeoutMs: number;
}

export const DEFAULT_RECURSION_GUARD: Readonly<RecursionGuardConfig> = {
  // maxDepth=1：嵌套禁止（仅主 Agent 可派发；与 Rust 侧同值同语义）
  maxDepth: 1,
  maxSiblings: 5,
  // T-D-06：上限 12 对齐（6→12，maxSiblings=5 保持）
  maxConcurrent: 12,
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
  /**
   * 任务类型（可选；缺省 analysis——最安全默认；默认权限集由系统映射，
   * T-D-07；驱动引擎侧 default_permissions，主 agent 不用配细节）
   */
  readonly taskType?: SubagentTaskType;
  /**
   * 显式写路径白名单（可选；硬沙箱输入——Rust 侧按此越权拒绝，
   * T-D-08；缺省 = 按 taskType 默认集装配，如 implementation=工作区根）
   */
  readonly allowedWritePaths?: readonly string[];
  /**
   * 模型覆盖（扩展点预留，T-D-10 已决策「多模型不做」）：
   * 不暴露 UI、不实现任何消费逻辑，引擎侧恒不读取；全构造点显式不传
   * （Rust 侧编译器强制 None）。详见「调研-可视化与扩展点.md」§3。
   */
  readonly modelOverride?: string;
}

/**
 * 收敛声明（REQ-D04 九参数收敛为五项，调研-权限传递层.md §3.2）：
 * enableWriteTools / enableCommandTools / enableMcpTools / allowedReadPaths
 * **不在定义契约中**——前三项由 taskType 默认集派生（系统硬编码），
 * 读路径默认全工作区可读（无安全增益）。验收断言：上述字段不存在于
 * 本契约（类型级——字段引用即编译错误）。
 */

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
