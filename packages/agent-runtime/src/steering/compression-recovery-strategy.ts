/**
 * CompressionRecoveryStrategy — 上下文压缩恢复纠偏策略（占位）
 *
 * 在 after-compaction 阶段检查是否有被压缩掉的关键信息需要补回。
 *
 * 当前实现为占位（始终返回 null），待后续实现上下文压缩恢复逻辑后，
 * 将在此策略中评估是否需要注入补回消息。
 */

import type { SteeringAction, SteeringContext, SteeringPhase, SteeringStrategy } from "./steering-types";

export class CompressionRecoveryStrategy implements SteeringStrategy {
  readonly name = "compression-recovery";
  readonly phases: SteeringPhase[] = ["after-compaction"];

  evaluate(_phase: SteeringPhase, _context: SteeringContext): SteeringAction | null {
    // 占位：当前不进行压缩恢复纠偏
    return null;
  }
}