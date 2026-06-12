/**
 * 统一纠偏策略层 — 公共导出
 *
 * 提供：
 * 1. SteeringCoordinator 核心协调器
 * 2. SteeringStrategy 接口和 SteeringAction/SteeringContext 类型
 * 3. 三个内置策略：Recovery, GoalAudit, CompressionRecovery
 */

// ─── 核心类型 ──────────────────────────────────────────────

export type {
  SteeringPhase,
  SteeringAction,
  SteeringContext,
  SteeringStrategy,
  SteeringEvaluationResult,
} from "./steering-types";

// ─── 核心协调器 ────────────────────────────────────────────

export {
  SteeringCoordinator,
  type SteeringCoordinatorOptions,
} from "./steering-coordinator";

// ─── 内置策略 ──────────────────────────────────────────────

export {
  RecoverySteeringStrategy,
  type RecoverySteeringStrategyOptions,
} from "./recovery-steering-strategy";

export {
  GoalAuditStrategy,
} from "./goal-audit-strategy";

export {
  CompressionRecoveryStrategy,
} from "./compression-recovery-strategy";