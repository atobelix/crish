/**
 * ToolTabAddButton — 工具条双态加号（随流位 + 溢出固定位）与「添加面板」菜单。
 *
 * 菜单项来自 viewRegistry 工具视图；单例与多实例工具由 openToolInDock 统一分配独立 tabId。
 */

import React from 'react';
import { Tooltip, Button } from '@/components/ui';
import { SmartExpandablePanel, type MenuItem } from '@/components/ui';
import { viewRegistry } from '../../services/view-registry';
import styles from './LeafToolTabStrip.module.css';
import { AppIcon } from '@/components/ui/icons';

export interface ToolTabAddButtonProps {
  tabs: string[];
  isInFlow: boolean;
  openPanel: (pid: string) => void;
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
      icon: iconName ? (
        <AppIcon name={iconName} size={13} aria-hidden />
      ) : undefined,
      onSelect: () => {
        openPanel(pid);
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
