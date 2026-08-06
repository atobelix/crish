/**
 * ToggleListView — 折叠列表 NodeView 组件
 *
 * 与 ToggleHeadingView 类似，但用于普通文本内容（非标题）。
 * 点击箭头展开/收起内容区域。
 */

import React, { useCallback } from 'react';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { ChevronRight } from 'lucide-react';

export const ToggleListView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  selected,
}) => {
  const collapsed = (node.attrs.collapsed as boolean) || false;
  const expanded = !collapsed;

  /** 切换折叠状态 */
  const handleToggle = useCallback(() => {
    updateAttributes({ collapsed: !collapsed });
  }, [collapsed, updateAttributes]);

  return (
    <NodeViewWrapper
      className={`toggle-list ${selected ? 'toggle-list--selected' : ''}`}
    >
      {/* 标题行 */}
      <div className="toggle-list__header">
        <button
          type="button"
          className={`toggle-list__arrow ${expanded ? 'toggle-list__arrow--expanded' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            handleToggle();
          }}
          contentEditable={false}
          aria-label={expanded ? '收起' : '展开'}
          aria-expanded={expanded}
        >
          <ChevronRight size={14} />
        </button>
        <div className="toggle-list__summary">
          <NodeViewContent />
        </div>
      </div>

      {/* 可折叠内容 */}
      <div
        className={`toggle-list__content ${expanded ? 'toggle-list__content--expanded' : ''}`}
        role="region"
        aria-hidden={!expanded}
      >
        <div className="toggle-list__content-inner">
          <span className="toggle-list__empty-hint" contentEditable={false}>
            {expanded && '在此输入折叠内容'}
          </span>
        </div>
      </div>
    </NodeViewWrapper>
  );
};
