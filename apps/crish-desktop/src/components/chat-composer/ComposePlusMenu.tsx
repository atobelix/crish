/**
 * 输入区「+」菜单：附件 / 技能 / 插件 / MCP / 扩展中心
 * 基于 ui/Menu 统一面板管理（T05.3.2 由 common/UnifiedSelectPopover 改 import），
 * 继承自动碰撞避让与标准键盘导航。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './ComposePlusMenu.module.css';
import { openSettings } from '../../api/storeAccess';
import { emitUiEvent } from '../../api/uiEvents';
import { Menu, Tooltip } from '../ui';
import type { SelectOptionItem } from '../ui';

type Props = {
  open: boolean;
  onClose: () => void;
  onAddFiles: () => void;
  /** 插入技能斜杠提示到输入框 */
  onInsertSkillSlash?: () => void;
  id?: string;
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
};

export const ComposePlusMenu: React.FC<Props> = ({
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
      hint: '图片或文档',
      icon: <Lucide.Paperclip size={13} strokeWidth={1.75} />,
      onClick: () => {
        onAddFiles();
        onClose();
      },
    },
    {
      id: 'skill',
      label: '使用技能',
      hint: '输入 / 选择技能',
      icon: <Lucide.Sparkles size={13} strokeWidth={1.75} />,
      onClick: () => {
        onInsertSkillSlash?.();
        onClose();
        queueMicrotask(() => restoreFocusRef?.current?.focus?.());
      },
    },
    {
      id: 'plugin',
      label: '插件',
      hint: '扩展包',
      icon: <Lucide.Puzzle size={13} strokeWidth={1.75} />,
      onClick: () => {
        onClose();
        openSettings('plugins');
      },
    },
    {
      id: 'mcp',
      label: 'MCP 工具',
      hint: '服务与工具开关',
      icon: <Lucide.Cable size={13} strokeWidth={1.75} />,
      onClick: () => {
        onClose();
        openSettings('plugins');
      },
    },
    {
      id: 'extensions',
      label: '扩展中心',
      hint: '发现 / 安装',
      icon: <Lucide.Blocks size={13} strokeWidth={1.75} />,
      onClick: () => {
        onClose();
        openSettings('plugins');
      },
    },
    {
      id: 'schedule',
      label: '定时任务',
      icon: <Lucide.Clock size={13} strokeWidth={1.75} />,
      onClick: () => {
        onClose();
        emitUiEvent('open-scheduled');
      },
    },
  ];

  if (!open) return null;

  return (
    <Menu
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      // P1-F4 根因修复（F7 F1）：以 restoreFocusRef 真实按钮为 Radix 浮动锚点
      // （Menu 基座 anchor → Popover.Anchor virtualRef），floating-ui 基于可见
      // 元素计算坐标；修复前传 display:none 空 div 作 trigger/锚点，其 rect 全 0
      // → 菜单被定位到视口 (0,0) 左上角。锚点即真实按钮，无需再渲染隐藏元素。
      anchor={restoreFocusRef}
      options={items}
      align="start"
      side="top"
      sideOffset={6}
      contentClassName={`${styles.plusMenu} no-drag`}
      renderItem={(item) => (
        <Tooltip key={item.id} content={item.hint || item.label}>
          <button
            type="button"
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
            <span className={styles.icon} aria-hidden>
              {item.icon}
            </span>
            <span className={styles.text}>
              <span className={styles.title}>{item.label}</span>
              {item.hint ? (
                <span className={styles.desc}>{item.hint}</span>
              ) : null}
            </span>
          </button>
        </Tooltip>
      )}
    />
  );
};
