/**
 * GoalAuditStrategy — Goal 审计纠偏策略（占位）
 *
 * 在 before-turn 阶段评估是否需要构建结构化的 Goal 审计 Prompt。
 *
 * 当前实现为占位（始终返回 null），待后续 Layer 实现 Goal 审计逻辑后，
 * 将在此策略中封装 buildGoalAuditPrompt 的逻辑。
 */

import type { SteeringAction, SteeringContext, SteeringPhase, SteeringStrategy } from "./steering-types";

export class GoalAuditStrategy implements SteeringStrategy {
  readonly name = "goal-audit";
  readonly phases: SteeringPhase[] = ["before-turn"];

  evaluate(_phase: SteeringPhase, _context: SteeringContext): SteeringAction | null {
    // 占位：当前不进行 Goal 审计纠偏
    return null;
  }
}