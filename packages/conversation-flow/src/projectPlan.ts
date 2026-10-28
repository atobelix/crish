/**
 * 仅已有 plan 模式为真时投影 Task 根。
 * 不从 SessionMessage 发明步骤，不造演示五步剧本。
 */

import type { PlanNode } from './types';

/**
 * 计划模式投影输入：仅依赖显式任务参数，彻底与底层权限解耦
 */
export interface ProjectPlanInput {
  planModeEnabled?: boolean;
  planApproved?: boolean;
  /** 缺省「计划模式」；调用方不得塞演示剧本标题 */
  title?: string;
}

/** 仅看显式任务标志 `planModeEnabled` */
export function isPlanModeEnabled(
  input: Pick<ProjectPlanInput, 'planModeEnabled'> | null | undefined
): boolean {
  if (!input) return false;
  return input.planModeEnabled === true;
}

/**
 * plan 模式 → 单颗 PlanNode（steps 恒空）；非 plan → null。
 */
export function projectPlanRoot(
  input: ProjectPlanInput | null | undefined
): PlanNode | null {
  if (!isPlanModeEnabled(input)) return null;
  const title = input?.title?.trim() || '计划模式';
  return {
    kind: 'plan',
    id: 'plan-root',
    title,
    status: input?.planApproved === true ? 'success' : 'running',
    currentStepIndex: 0,
    steps: [],
    children: [],
  };
}
