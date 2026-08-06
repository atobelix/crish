/**
 * BlockShell — 块级组件的统一外壳
 *
 * 所有面板类区块（图表、嵌入、布局、按钮…）共用的「块 chrome」：
 * 选中环、悬浮工具条、拖拽手柄锚点、空状态。
 *
 * 存在的意义是让交互规范只实现一次。
 * 如果每个 NodeView 各写一套 hover 逻辑，就必然出现
 * 「这个块的工具条在右上角、那个在左上角」「这个有 120ms 淡入、
 * 那个直接闪现」这类不一致——而这正是「看起来不高级」的根源。
 *
 * ── 统一的 affordance 约定 ──────────────────────────
 *   悬浮块       → 工具条自右上角淡入（--dur-fast）
 *   块被选中     → 2px 强调色描边，不位移
 *   拖拽手柄     → 块左外侧，仅悬浮时出现
 *   空状态       → 居中图标 + 主行动按钮
 *   键盘可达     → 工具条按钮参与 Tab 序，focus-within 时常驻
 */

import React from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import { GripVertical } from 'lucide-react';
import { Button } from '../../ui';

export interface BlockShellAction {
  id: string;
  label: string;
  icon: React.FC<{ size?: number }>;
  onClick: () => void;
  /** 处于「已激活」状态时高亮，如已复制、编辑模式中 */
  active?: boolean;
  /** 危险操作（删除）用红色反馈 */
  danger?: boolean;
}

export interface BlockShellProps {
  /** 块类型标识，用作 CSS 钩子 `block--<kind>` */
  kind: string;
  /** 是否处于选中态（通常来自 NodeViewProps.selected） */
  selected?: boolean;
  /** 悬浮工具条上的操作 */
  actions?: BlockShellAction[];
  /** 左上角的类型标签，如「Mermaid」「图表」 */
  badge?: React.ReactNode;
  /** 是否显示拖拽手柄 */
  draggable?: boolean;
  /** 额外的 class */
  className?: string;
  children: React.ReactNode;
}

export const BlockShell: React.FC<BlockShellProps> = ({
  kind,
  selected = false,
  actions = [],
  badge,
  draggable = true,
  className = '',
  children,
}) => {
  return (
    <NodeViewWrapper
      className={[
        'block-shell',
        `block--${kind}`,
        selected ? 'is-selected' : '',
        'motion-affordance-host',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-block-kind={kind}
    >
      {draggable && (
        <div
          className="block-shell__handle motion-affordance"
          contentEditable={false}
          data-drag-handle
          role="button"
          tabIndex={-1}
          aria-label="拖拽移动此块"
        >
          <GripVertical size={14} />
        </div>
      )}

      {badge && (
        <div className="block-shell__badge motion-affordance" contentEditable={false}>
          {badge}
        </div>
      )}

      {actions.length > 0 && (
        <div className="block-shell__toolbar motion-affordance" contentEditable={false}>
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={[
                'block-shell__action motion-tap',
                action.active ? 'is-active' : '',
                action.danger ? 'is-danger' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={action.onClick}
              title={action.label}
              aria-label={action.label}
            >
              <action.icon size={14} />
            </button>
          ))}
        </div>
      )}

      {children}
    </NodeViewWrapper>
  );
};

/* ────────────────────────────────────────────
 * 空状态
 * ──────────────────────────────────────────── */

export interface BlockEmptyProps {
  icon: React.FC<{ size?: number }>;
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
}

/**
 * 块的空状态。
 *
 * 设计要点：空状态不是「什么都没有」，而是「下一步该做什么」。
 * 因此始终给出一个明确的主行动按钮，而不是只放一行灰字。
 */
export const BlockEmpty: React.FC<BlockEmptyProps> = ({
  icon: Icon,
  title,
  hint,
  actionLabel,
  onAction,
}) => (
  <div className="block-empty motion-fade-in" contentEditable={false}>
    <div className="block-empty__icon">
      <Icon size={20} />
    </div>
    <div className="block-empty__text">
      <div className="block-empty__title">{title}</div>
      {hint && <div className="block-empty__hint">{hint}</div>}
    </div>
    {actionLabel && onAction && (
      <Button variant="secondary" size="sm" className="motion-tap" onClick={onAction}>
        {actionLabel}
      </Button>
    )}
  </div>
);
