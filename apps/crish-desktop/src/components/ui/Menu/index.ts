/**
 * ui/Menu 目录出口
 *
 * 方案依据: docs/ui-infra-evolution/plans/03-headless-primitives-and-stability.md §3.4
 * 统一从这里导出 Menu 组件、公共类型与坐标纯函数；
 * 全量 barrel 在 ui/index.ts。
 */

export { Menu, MenuContext } from './Menu';
export type {
  MenuProps,
  MenuPositionConfig,
  MenuOpenState,
  MenuPanelConfig,
  MenuOutsideHandlers,
} from './Menu';
export type { SelectOptionItem } from './types';
export { shouldSuppressMenuReopen, toggleExclusiveMenu } from './menuOpenGuard';
export { calculateSubmenuPosition } from './position';
export type { SubmenuPlacementResult } from './position';
