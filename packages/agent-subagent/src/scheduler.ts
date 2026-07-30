// agent-subagent/src/scheduler.ts
// [NEW] SubagentScheduler 接口骨架（Round 5 仅定义接口，Round 9 完整实现）
//
// 依据 ROUND-05-split-phase-C.md §4.3：
// - SubagentScheduler 是第一版必须实现的组件（禁令 20）
// - priority / affinity 调度策略推迟，仅实现 FIFO
// - SubagentInstance 简化为 4 状态（pending / running / completed / failed）
//
// 依据 禁令 20：禁止新建 SubagentCommunicationBus，子代理通信复用 ControlBus。

import type { AgentRuntime } from "@crish/agent-core";
import type { CrishError } from "@crish/shared-types";
import type { SubagentTaskCard } from "./subagent-context-pack";
import type { SubagentStatus } from "./subagents";

/**
 * SubagentScheduler — 子代理调度器（FIFO 调度队列）
 *
 * 依据 禁令 20：SubagentScheduler 是第一版必须实现的组件。
 * 依据 禁令 20：priority / affinity 调度策略推迟，仅实现 FIFO。
 *
 * @alpha Round 5 仅定义接口骨架，Round 9 完整实现。
 */
export interface SubagentScheduler {
  /**
   * 提交子代理任务到调度队列
   *
   * @returns 任务 ID（用于后续查询/取消）
   */
  submit(task: SubagentTaskCard): Promise<string>;

  /**
   * 取消尚未完成的子代理任务
   */
  cancel(taskId: string): Promise<boolean>;

  /**
   * 查询子代理实例状态
   */
  getStatus(taskId: string): SubagentStatus | undefined;

  /**
   * 等待子代理任务完成（带超时）
   */
  await(taskId: string, timeoutMs?: number): Promise<SubagentResult>;

  /**
   * 获取当前调度队列快照
   */
  snapshot(): SchedulerSnapshot;
}

/**
 * 子代理执行结果
 *
 * @alpha Round 5 仅定义接口骨架，Round 9 完整实现。
 */
export interface SubagentResult {
  taskId: string;
  status: SubagentStatus;
  output?: unknown;
  error?: CrishError;
}

/**
 * 调度队列快照（用于监控与诊断）
 *
 * @alpha Round 5 仅定义接口骨架，Round 9 完整实现。
 */
export interface SchedulerSnapshot {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

/**
 * SubagentInstance — 子代理生命周期管理
 *
 * 依据 禁令 20：SubagentInstance 是第一版必须实现的组件。
 * 依据 禁令 20：SubagentState 简化为 4 状态（pending / running / completed / failed）。
 *
 * @alpha Round 5 仅定义接口骨架，Round 9 完整实现。
 */
export interface SubagentInstance {
  readonly taskId: string;
  readonly status: SubagentStatus;
  readonly startedAt: number;
  readonly timeoutMs: number;

  /** 启动子代理 */
  start(): Promise<void>;
  /** 取消子代理 */
  cancel(): Promise<void>;
  /** 等待完成 */
  join(): Promise<SubagentResult>;
}

// 保持 AgentRuntime 类型引用以确保 Round 9 实现时调度器能引用运行时类型；
// 当前骨架阶段未在签名中直接使用，避免未使用导入告警。
export type _AgentRuntimeRef = AgentRuntime;
