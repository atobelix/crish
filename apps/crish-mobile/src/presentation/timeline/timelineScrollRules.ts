// 时间线滚动纯规则（批 B ⑱㉕）：锚点偏移换算与离屏流式尾部冻结的
// 迟滞判定——纯函数便于 jest 直测，TimelineView 只做接线。

/** 冻结进入线：流式尾块顶缘低于视口底缘超过此距离（px）才冻结其渲染 */
export const TAIL_FREEZE_ENTER_PX = 320;
/** 冻结退出线：回滚到此距离以内解冻（与进入线构成迟滞带，防临界抖动反复冻结/解冻） */
export const TAIL_FREEZE_EXIT_PX = 160;

/**
 * 尾部冻结判定（迟滞）：distanceBelowPx = 尾块顶缘 y − 视口底缘
 * （负数 = 尾块已进入视口）。未冻结时越过 ENTER 线才冻结；已冻结时
 * 回到 EXIT 线以内才解冻。
 */
export function shouldFreezeTail(
  distanceBelowPx: number,
  currentlyFrozen: boolean
): boolean {
  return currentlyFrozen
    ? distanceBelowPx > TAIL_FREEZE_EXIT_PX
    : distanceBelowPx > TAIL_FREEZE_ENTER_PX;
}

/** 锚点块内偏移 = 当前滚动位置 − 块顶缘（块顶在视口下方时归零） */
export function anchorOffsetWithinBlock(
  scrollYPx: number,
  itemTopPx: number
): number {
  return Math.max(0, scrollYPx - itemTopPx);
}

/** 锚点恢复目标滚动偏移 = 块顶缘 + 块内偏移（负数归零） */
export function restoreScrollOffset(
  itemTopPx: number,
  offsetPx: number
): number {
  return Math.max(0, itemTopPx + offsetPx);
}
