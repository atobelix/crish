// agent-subagent/src/recursion-guard.ts
// [NEW] RecursionGuard 增强接口（保留现有 SubagentDepthGuard，扩展全局预算字段）
//
// 依据 ROUND-05-split-phase-C.md §4.4：
// - 保留现有 SubagentDepthGuard（来自 ./subagents）
// - 增加 totalTokenBudget / totalTimeoutMs 字段
// - 递归守卫默认值依据 ROUND-09 §3.2 唯一权威值
//
// 依据 禁令 20：
// - totalTokenBudget：预留字段，默认 0（不限制），Round 9 实现全局 token 预算
// - totalTimeoutMs：预留字段，默认 0（不限制），第一版依赖每个子代理的 timeoutMs

import type { SubagentDepthGuard } from "./subagents";

// 重新导出 SubagentDepthGuard，便于消费者从单一入口获取递归守卫相关类型
export type { SubagentDepthGuard } from "./subagents";

/**
 * RecursionGuard 增强接口（在 SubagentDepthGuard 基础上扩展）
 *
 * 依据 禁令 20：
 * - totalTokenBudget：预留字段，默认 0（不限制），Round 9 实现全局 token 预算
 * - totalTimeoutMs：预留字段，默认 0（不限制），第一版依赖每个子代理的 timeoutMs
 *
 * @alpha Round 5 仅定义接口与默认值，Round 9 完整实现执行逻辑。
 */
export interface RecursionGuard extends SubagentDepthGuard {
  /** 全局 token 预算上限（0 = 不限制，Round 9 实现） */
  readonly totalTokenBudget: number;
  /** 全局超时上限（0 = 不限制，Round 9 实现） */
  readonly totalTimeoutMs: number;
}

/**
 * 递归守卫默认值（ROUND-09 §3.2 唯一权威值）
 *
 * 注意：现有 subagents.ts 中 DEFAULT_SUBAGENT_DEPTH_GUARD 的值已更新为以下权威值：
 *   maxDepth: 3, maxSiblings: 5, maxConcurrent: 6
 *
 * 本常量在 DEFAULT_SUBAGENT_DEPTH_GUARD 基础上增加预留字段：
 *   totalTokenBudget: 0（不限制）
 *   totalTimeoutMs: 0（不限制）
 */
export const DEFAULT_RECURSION_GUARD: RecursionGuard = {
  maxDepth: 3,
  maxSiblings: 5,
  maxConcurrent: 6,
  totalTokenBudget: 0,
  totalTimeoutMs: 0,
};

/**
 * DeadlockDetector — DFS 环检测（接口骨架）
 *
 * 依据 禁令 20：DeadlockDetector 是第一版必须实现的组件。
 * 实现为轻量级：在 spawn 时检查 ancestorSessionIds 是否包含目标 session，O(depth) 复杂度。
 * 禁止运行时后台线程扫描。
 *
 * @alpha Round 5 仅定义接口骨架，Round 9 完整实现。
 */
export interface DeadlockDetector {
  /**
   * 检测 spawn 是否会造成环
   *
   * @param ancestorSessionIds 从根到当前 session 的祖先链
   * @param targetSessionId 要 spawn 的目标 session
   * @returns true 表示检测到环（将造成死锁）
   */
  detectCycle(ancestorSessionIds: string[], targetSessionId: string): boolean;
}
