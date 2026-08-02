/**
 * 向导盖层挂载标记（模块级副作用，非 React 状态）。
 * 与 LS done 标记解耦：密钥步落盘后向导仍保持独占，
 * 供 ChatStatusRibbons / ChatEmptyState 判断是否让位。
 * 挂载/卸载由 useFirstRunWizard 的 effect 维护。
 */
let firstRunOverlayMounted = false;

/** 向导盖层是否挂载（组件生命周期；与 LS done 标记解耦，避免中途写密钥后 soft-hint 抢位） */
export function isFirstRunOverlayOpen(): boolean {
  return firstRunOverlayMounted;
}

/** 仅供 useFirstRunWizard 的挂载 effect 调用；禁止外部直接改写。 */
export function setFirstRunOverlayOpen(open: boolean): void {
  firstRunOverlayMounted = open;
}
