/**
 * ui 原子层统一出口（barrel）
 *
 * 分层契约：ui/ 原子层不依赖业务 store/hooks/api/services；
 * 业务组件层依赖本出口，页面层依赖业务组件层。
 * 详见本目录 README.md（依赖规则 + 样式规范）。
 */
export { Button } from './Button/Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button/Button';

export { Input } from './Input/Input';
export type { InputProps, InputVariant } from './Input/Input';

export { Dialog } from './Dialog/Dialog';
export type { DialogProps, DialogSize, DialogRole } from './Dialog/Dialog';

export { Menu } from './Menu/Menu';
export type { MenuProps } from './Menu/Menu';
export type { SelectOptionItem } from './Menu/types';
export { clampPosition, measureMenu, MENU_EDGE_PAD } from './Menu/position';
export type { ClampedPosition } from './Menu/position';

export { Tooltip } from './Tooltip/Tooltip';
export type { TooltipProps, TooltipSide } from './Tooltip/Tooltip';

export { Select } from './Select/Select';
export type { SelectProps, SelectOption } from './Select/Select';
