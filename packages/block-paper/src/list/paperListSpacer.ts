/**
 * W3-G · PaperList spacer + 根属性（SD-20 切开 · spacer）
 *
 * 窗外块用 spacer 撑滚动高度；**禁止** CSS hidden 挂全量 DOM 冒充虚拟化。
 *
 * - **≠ EL-01**；**≠ W3-P**；**≠ C2 默开**
 */

import type { MountPlan } from './buildMountPlan';
import {
  BP_PAPER_MOUNTED_COUNT,
  BP_PAPER_TOTAL_COUNT,
  BP_PAPER_WITHIN_DOM_BOUND,
} from './paperListConstants';

export type PaperListSpacerTarget = {
  root: HTMLElement;
  spacerBefore: HTMLElement;
  spacerAfter: HTMLElement;
};

/** 写 spacer 高度与结构门根属性（不碰块行）。 */
export function applyPaperListSpacers(
  target: PaperListSpacerTarget,
  plan: MountPlan
): void {
  target.spacerBefore.style.height = `${plan.spacerBeforePx}px`;
  target.spacerAfter.style.height = `${plan.spacerAfterPx}px`;
  target.root.setAttribute(BP_PAPER_MOUNTED_COUNT, String(plan.mountedCount));
  target.root.setAttribute(BP_PAPER_TOTAL_COUNT, String(plan.totalCount));
  target.root.setAttribute(
    BP_PAPER_WITHIN_DOM_BOUND,
    plan.withinDomBound ? '1' : '0'
  );
}
