import React, { useMemo } from 'react';
import ReactDOM from 'react-dom';
import type { MenuItem } from './types';
import { SmartPanelItem } from './SmartPanelItem';
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

/**
 * 二级级联子菜单 (Shell - Body - Footer 三段式解耦架构)
 * - Shell (.cascadeSubmenu): 纯粹负责外层 14px 圆角、6px 统一内衬、背景与阴影，绝对无滚动条；
 * - Body (.cascadeListBody): 限制最大高度约 240px，仅在条目超出时在内部展示 4px 微调滚动条；
 * - Footer (.cascadeFooter): 将尾部常驻操作（如管理技能...）吸附在卡片底端，不随滚动移出视野。
 */
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
}) => {
  // 分离可滚动数据条目区与尾部常驻动作区（如「分割线 + 管理技能...」）
  const { bodyItems, footerItems } = useMemo(() => {
    const list = activeSubmenu.children;
    const lastDividerIdx = list.map((c) => c.type).lastIndexOf('divider');
    if (lastDividerIdx > 0 && lastDividerIdx >= list.length - 3) {
      return {
        bodyItems: list.slice(0, lastDividerIdx),
        footerItems: list.slice(lastDividerIdx),
      };
    }
    return { bodyItems: list, footerItems: [] };
  }, [activeSubmenu.children]);

  return ReactDOM.createPortal(
    <div
      ref={cascadeSubmenuRef}
      className={styles.cascadeSubmenu}
      role="menu"
      data-state="open"
      data-side={side}
      aria-label={ariaLabel}
      style={submenuStyle}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <div className={styles.cascadeListBody}>
        {bodyItems.map((subItem) => (
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
      </div>

      {footerItems.length > 0 && (
        <div className={styles.cascadeFooter}>
          {footerItems.map((footerItem) => (
            <SmartPanelItem
              key={footerItem.id}
              item={footerItem}
              onSelect={(item, ev) => {
                footerItem.onSelect?.(item, ev);
                footerItem.onClick?.();
                onSelect(item);
                if (footerItem.closeOnSelect !== false) {
                  onRequestClose();
                }
              }}
            />
          ))}
        </div>
      )}
    </div>,
    container
  );
};
