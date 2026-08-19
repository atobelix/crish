/**
 * 仅已有 plan 模式为真时投影 Task 根。
 * 不从 SessionMessage 发明步骤，不造演示五步剧本。
 */

import type { PlanNode } from './types';

/** 与 desktop permission / plan 读面同形的最小输入 */
export interface ProjectPlanInput {
  permissionMode?: string;
  planModeEnabled?: boolean;
  planApproved?: boolean;
  /** 缺省「计划模式」；调用方不得塞演示剧本标题 */
  title?: string;
}

/** 对齐产品 `inPlanMode = permissionMode === 'plan' || planModeEnabled` */
export function isPlanModeEnabled(
  input: Pick<ProjectPlanInput, 'permissionMode' | 'planModeEnabled'> | null | undefined,
): boolean {
  if (!input) return false;
  return input.permissionMode === 'plan' || input.planModeEnabled === true;
}

/**
 * plan 模式 → 单颗 PlanNode（steps 恒空）；非 plan → null。
 */
export function projectPlanRoot(
  input: ProjectPlanInput | null | undefined,
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
