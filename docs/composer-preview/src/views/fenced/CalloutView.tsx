/**
 * CalloutView — Callout 区块 NodeView 组件 (v2)
 *
 * 支持 5 种类型：note / tip / important / warning / caution
 * 编辑模式显示 > [!TYPE] 围栏标记
 * 渲染模式显示带图标和背景色的提示卡片
 */

import React, { useCallback } from 'react';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { useBlockEditing } from '../../hooks/useBlockEditing';
import { FenceMarker } from '../_shared/FenceMarker';
import { CALLOUT_CONFIGS } from '../../core/types/editor';
import type { CalloutType } from '../../core/types/blocks';

export const CalloutView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  editor,
  getPos,
}) => {
  const { isEditing, focusNode } = useBlockEditing(editor, getPos);

  const calloutType = (node.attrs.type as CalloutType) || 'note';
  const config = CALLOUT_CONFIGS[calloutType] || CALLOUT_CONFIGS.note;

  // 点击图标循环切换类型
  const cycleType = useCallback(() => {
    const types: CalloutType[] = ['note', 'tip', 'important', 'warning', 'caution'];
    const currentIdx = types.indexOf(calloutType);
    const nextType = types[(currentIdx + 1) % types.length];
    updateAttributes({ type: nextType });
  }, [calloutType, updateAttributes]);

  // 编辑模式：围栏标记文本变更
  const handleFenceChange = useCallback((newText: string) => {
    const match = newText.match(/^>\s*\[!(\w+)\]/i);
    if (match) {
      const typeName = match[1].toLowerCase();
      if (typeName in CALLOUT_CONFIGS) {
        updateAttributes({ type: typeName });
      }
    }
  }, [updateAttributes]);

  if (isEditing) {
    return (
      <NodeViewWrapper className="callout-block is-editing">
        <FenceMarker
          text={`> [!${calloutType.toUpperCase()}]`}
          position="top"
          editable
          onTextChange={handleFenceChange}
          onEnter={focusNode}
        />
        <div className="callout-block__content">
          <NodeViewContent />
        </div>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      className={`callout-block callout-block--${calloutType}`}
      onClick={focusNode}
    >
      <span
        className="callout-block__icon"
        onClick={(e) => { e.stopPropagation(); cycleType(); }}
        contentEditable={false}
        role="button"
        aria-label="切换提示类型"
      >
        {config.icon}
      </span>
      <div className="callout-block__content">
        <NodeViewContent />
      </div>
    </NodeViewWrapper>
  );
};
