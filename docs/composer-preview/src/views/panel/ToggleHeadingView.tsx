/**
 * ToggleHeadingView — 折叠标题 NodeView 组件
 *
 * 参考 Notion 的折叠标题设计：
 * - 标题左侧有可旋转的三角箭头（▶ / ▼）
 * - 点击箭头切换折叠/展开
 * - 折叠/展开有 CSS 过渡动画
 * - 支持 H1/H2/H3 三个标题级别
 */

import React, { useCallback } from 'react';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { ChevronRight } from 'lucide-react';
import type { HeadingLevel } from '../../core/types/blocks';

/* ────────────────────────────────────────────
 * ToggleArrow — 可旋转的折叠箭头
 * ──────────────────────────────────────────── */

interface ToggleArrowProps {
  /** 是否已展开 */
  expanded: boolean;
  /** 点击回调 */
  onClick: () => void;
}

const ToggleArrow: React.FC<ToggleArrowProps> = ({ expanded, onClick }) => (
  <button
    type="button"
    className={`toggle-heading__arrow ${expanded ? 'toggle-heading__arrow--expanded' : ''}`}
    onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}
    contentEditable={false}
    aria-label={expanded ? '收起' : '展开'}
    aria-expanded={expanded}
  >
    <ChevronRight size={16} />
  </button>
);

/* ────────────────────────────────────────────
 * ToggleContent — 可折叠的内容区域
 * ──────────────────────────────────────────── */

interface ToggleContentProps {
  /** 是否已展开 */
  expanded: boolean;
  /** 子节点内容 */
  children: React.ReactNode;
}

const ToggleContent: React.FC<ToggleContentProps> = ({ expanded, children }) => (
  <div
    className={`toggle-heading__content ${expanded ? 'toggle-heading__content--expanded' : ''}`}
    role="region"
    aria-hidden={!expanded}
  >
    <div className="toggle-heading__content-inner">
      {children}
    </div>
  </div>
);

/* ────────────────────────────────────────────
 * ToggleHeadingView — 主组件
 * ──────────────────────────────────────────── */

export const ToggleHeadingView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  selected,
}) => {
  const level = (node.attrs.level as HeadingLevel) || 2;
  const collapsed = (node.attrs.collapsed as boolean) || false;
  const expanded = !collapsed;

  /** 切换折叠状态 */
  const handleToggle = useCallback(() => {
    updateAttributes({ collapsed: !collapsed });
  }, [collapsed, updateAttributes]);

  /** 根据标题级别确定 CSS 类名 */
  const levelClass = `toggle-heading--h${level}`;

  return (
    <NodeViewWrapper
      className={`toggle-heading ${levelClass} ${selected ? 'toggle-heading--selected' : ''}`}
    >
      {/* 标题行 */}
      <div className="toggle-heading__header">
        <ToggleArrow expanded={expanded} onClick={handleToggle} />
        <div className="toggle-heading__title" data-heading-level={level}>
          <NodeViewContent />
        </div>
      </div>

      {/* 可折叠内容区域 */}
      <ToggleContent expanded={expanded}>
        {/* 折叠内容在 Schema 中以 block+ 定义，ProseMirror 自动管理 */}
        <div className="toggle-heading__body-placeholder">
          {expanded && (
            <span className="toggle-heading__empty-hint" contentEditable={false}>
              折叠内容区域（在此输入内容）
            </span>
          )}
        </div>
      </ToggleContent>
    </NodeViewWrapper>
  );
};
