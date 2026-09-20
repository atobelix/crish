import React from 'react';

import styles from './ComposePlusMenu.module.css';
import { openSettings } from '../../api/storeAccess';
import { emitUiEvent } from '../../api/uiEvents';
import { Button, Menu, Tooltip } from '../ui';
import type { SelectOptionItem } from '../ui';
import { AppIcon } from '../ui/icons/index';

export interface ComposePlusMenuProps {
  open: boolean;
  onClose: () => void;
  onAddFiles: () => void;
  /** 插入技能斜杠提示到输入框 */
  onInsertSkillSlash?: () => void;
  id?: string;
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
}

export const ComposePlusMenu: React.FC<ComposePlusMenuProps> = ({
  open,
  onClose,
  onAddFiles,
  onInsertSkillSlash,
  restoreFocusRef,
}) => {
  const items: SelectOptionItem[] = [
    {
      id: 'file',
      label: '添加文件',
      hint: '图片、代码或文档',
      icon: <AppIcon name="paperclip" size={14} />,
      onClick: () => {
        onAddFiles();
        onClose();
      },
    },
    {
      id: 'skill',
      label: '使用技能',
      hint: '键入 / 快速唤起技能',
      icon: <AppIcon name="sparkles" size={14} />,
      onClick: () => {
        onInsertSkillSlash?.();
        onClose();
        queueMicrotask(() => restoreFocusRef?.current?.focus?.());
      },
    },
    {
      id: 'plugin',
      label: '插件',
      hint: '管理已安装插件',
      icon: <AppIcon name="puzzle" size={14} />,
      onClick: () => {
        onClose();
        openSettings('plugins');
      },
    },
    {
      id: 'mcp',
      label: 'MCP 工具',
      hint: '服务与协议连接',
      icon: <AppIcon name="cable" size={14} />,
      onClick: () => {
        onClose();
        openSettings('plugins');
      },
    },
    {
      id: 'extensions',
      label: '扩展中心',
      hint: '发现与安装新工具',
      icon: <AppIcon name="blocks" size={14} />,
      onClick: () => {
        onClose();
        openSettings('plugins');
      },
    },
    {
      id: 'schedule',
      label: '定时任务',
      hint: '计划执行与循环任务',
      icon: <AppIcon name="clock" size={14} />,
      onClick: () => {
        onClose();
        emitUiEvent('open-scheduled');
      },
    },
  ];

  if (!open) return null;

  return (
    <Menu
      openState={{
        open,
        onOpenChange: (nextOpen) => {
          if (!nextOpen) onClose();
        },
      }}
      // P1-F4 根因修复（F7 F1）：以 restoreFocusRef 真实按钮为 Radix 浮动锚点
      // （Menu 基座 anchor → Popover.Anchor virtualRef），floating-ui 基于可见
      // 元素计算坐标；修复前传 display:none 空 div 作 trigger/锚点，其 rect 全 0
      // → 菜单被定位到视口 (0,0) 左上角。锚点即真实按钮，无需再渲染隐藏元素。
      anchor={restoreFocusRef}
      options={items}
      position={{ align: 'start', side: 'top', sideOffset: 6 }}
      panel={{ contentClassName: `${styles.plusMenu} no-drag` }}
      renderItem={(item) => (
        <Tooltip key={item.id} content={item.hint || item.label}>
          <Button
            type="button"
            variant="ghost"
            className={styles.item}
            role="menuitem"
            aria-label={item.hint ? `${item.label}，${item.hint}` : item.label}
            onClick={(e) => {
              e.stopPropagation();
              item.onClick?.();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span className={styles.icon} aria-hidden="true">
              {item.icon}
            </span>
            <div className={styles.text}>
              <span className={styles.title}>{item.label}</span>
              {item.hint ? (
                <span className={styles.desc}>{item.hint}</span>
              ) : null}
            </div>
          </Button>
        </Tooltip>
      )}
    />
  );
};
