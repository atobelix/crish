// 时间线滚动纯规则：锚点偏移换算（纯函数便于 jest 直测，TimelineView 只做接线）。
// 历史离屏尾部冻结机制已彻底废除（2026-11-04 方案 15）：流式正文恒定由单一真理源直出渲染。

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
