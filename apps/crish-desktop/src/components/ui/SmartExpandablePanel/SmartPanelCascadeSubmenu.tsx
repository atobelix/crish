import React from 'react';
import ReactDOM from 'react-dom';
import type { MenuItem } from './types';
import { SmartPanelItem } from './SmartPanelItem';
import menuStyles from '../Menu/Menu.module.css';
import styles from './SmartExpandablePanel.module.css';

interface SmartPanelCascadeSubmenuProps {
  /** 当前展开的父条目（必须带 children）。 */
  parent: MenuItem & { children: MenuItem[] };
  /** 子菜单的无障碍名称（父条目 label，缺省由调用方给出兜底文案）。 */
  ariaLabel: string;
  style: React.CSSProperties;
  side: 'left' | 'right';
  submenuRef: React.RefObject<HTMLDivElement | null>;
  /** Portal 挂载点：对话框覆盖层内优先，否则 document.body。 */
  container: Element | DocumentFragment;
  /** 指针进入子菜单：取消 Safe-Aim 的延迟关闭。 */
  onPointerEnter: () => void;
  /** 指针离开子菜单：触发平滑缓冲延迟关闭。 */
  onPointerLeave?: () => void;
  onSelect: (item: MenuItem) => void;
  /** 选中后关闭整个面板（closeOnSelect !== false 时）。 */
  onRequestClose: () => void;
}

/** 二级级联子菜单 (8px 同心圆角 / 4px 内衬 / 4px-6px 条目)，Portal 逃逸渲染。 */
export const SmartPanelCascadeSubmenu: React.FC<
  SmartPanelCascadeSubmenuProps
> = ({
  parent: activeSubmenu,
  ariaLabel,
  style: submenuStyle,
  side,
  submenuRef: cascadeSubmenuRef,
  container,
  onPointerEnter,
  onPointerLeave,
  onSelect,
  onRequestClose,
}) =>
  ReactDOM.createPortal(
    <div
      ref={cascadeSubmenuRef}
      className={`${menuStyles.menuContent} ${styles.cascadeSubmenu}`}
      role="menu"
      data-side={side}
      aria-label={ariaLabel}
      style={submenuStyle}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      {activeSubmenu.children.map((subItem) => (
        <SmartPanelItem
          key={subItem.id}
          item={subItem}
          onSelect={(item, ev) => {
            subItem.onSelect?.(item, ev);
            subItem.onClick?.();
            onSelect(item);
            if (subItem.closeOnSelect !== false) {
              onRequestClose();
            }
          }}
        />
      ))}
    </div>,
    container
  );
