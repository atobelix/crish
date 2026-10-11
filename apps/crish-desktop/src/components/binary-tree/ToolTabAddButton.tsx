/**
 * ToolTabAddButton — 工具条双态加号（随流位 + 溢出固定位）与「添加面板」菜单。
 *
 * 菜单项来自 viewRegistry 工具视图；preview / terminal 允许无限多开，
 * 已存在时自动追加序号后缀（preview:2 / terminal:2 ...）。
 */

import React from 'react';
import { Tooltip, Button } from '../ui';
import {
  SmartExpandablePanel,
  type MenuItem,
} from '../ui/SmartExpandablePanel';
import { viewRegistry } from '../../services/view-registry';
import styles from './LeafToolTabStrip.module.css';
import { AppIcon } from '../ui/icons/index';

export interface ToolTabAddButtonProps {
  tabs: string[];
  isInFlow: boolean;
  openPanel: (pid: string) => void;
}

/** 为可多开的浏览器/终端标签推导下一个未占用 id */
export function nextMultiOpenTabId(tabs: string[], base: string): string {
  if (!tabs.includes(base)) return base;
  let nextIdx = 2;
  while (tabs.includes(`${base}:${nextIdx}`)) {
    nextIdx++;
  }
  return `${base}:${nextIdx}`;
}

export const ToolTabAddButton: React.FC<ToolTabAddButtonProps> = ({
  tabs,
  isInFlow,
  openPanel,
}) => {
  const occupied = new Set(tabs);
  // 每次渲染即时推导（面板注册是低频事件，列表极小，无需 memo 缓存引入陈旧风险）
  const availablePanels = viewRegistry
    .getToolViews()
    .map((v) => v.id)
    .filter(
      (pid) => pid === 'preview' || pid === 'terminal' || !occupied.has(pid)
    );

  const btnClass = `${styles.addBtn} ${
    isInFlow ? styles.inFlow : styles.pinned
  } ${isInFlow ? 'in-flow' : 'pinned'} side-panel-add-btn`;

  const btnElement = (
    <Button
      type="button"
      variant="ghost"
      className={btnClass}
      aria-label="添加功能面板"
    >
      <AppIcon name="plus" size={13} />
    </Button>
  );

  if (availablePanels.length === 0) {
    return (
      <Tooltip content="添加工具标签" side="bottom">
        {btnElement}
      </Tooltip>
    );
  }

  const addMenuItems: MenuItem[] = availablePanels.map((pid) => {
    const iconName = viewRegistry.getIcon(pid);
    return {
      id: pid,
      label: viewRegistry.getTitle(pid),
      icon: iconName ? <AppIcon name={iconName} size={13} aria-hidden /> : undefined,
      onSelect: () => {
        if (pid === 'preview' || pid === 'terminal') {
          openPanel(nextMultiOpenTabId(tabs, pid));
        } else {
          openPanel(pid);
        }
      },
    };
  });

  return (
    <SmartExpandablePanel
      position={{ align: 'end', side: 'bottom', sideOffset: 4 }}
      triggerMode="click"
      trigger={
        <Tooltip content="添加工具标签" side="bottom">
          {btnElement}
        </Tooltip>
      }
      items={addMenuItems}
      className={styles.leafToolAddPanel}
    />
  );
};

ToolTabAddButton.displayName = 'ToolTabAddButton';
