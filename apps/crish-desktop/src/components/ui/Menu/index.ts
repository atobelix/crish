/**
 * ui/Menu 目录出口（PE-05 T05.3）
 *
 * 菜单基座以目录为锚点（`ui/Menu` 可直接 import），
 * 统一从这里导出 Menu 组件、公共类型与坐标纯函数；
 * 全量 barrel 见 `ui/index.ts`。
 */
export { Menu } from './Menu';
export type { MenuProps } from './Menu';
export type { SelectOptionItem } from './types';
export { clampPosition, measureMenu, MENU_EDGE_PAD } from './position';
export type { ClampedPosition, ViewportSize } from './position';
