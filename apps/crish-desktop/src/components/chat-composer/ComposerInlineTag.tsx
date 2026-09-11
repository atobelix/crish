/**
 * 行内 mention 芯片（文件图标盒 + Skill 变体）。
 * Tiptap NodeView：统一 AppIcon，禁止 dangerouslySetInnerHTML / lucide-react。
 * 文件类点击走已有 openFileInPanel（叶预览），不造 body 模态。
 */
import React from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';

import { openFileInPanel } from '../../api/filePanelOpener';
import { AppIcon, type IconName } from '../ui/icons';

function iconForKind(kind: string): IconName {
  if (kind === 'skill') return 'sparkles';
  if (kind === 'agent') return 'bot';
  return 'file-text';
}

export const ComposerInlineTag: React.FC<NodeViewProps> = ({
  node,
  deleteNode,
}) => {
  const kind = String(node.attrs.kind || 'file');
  const label = String(node.attrs.label || node.attrs.id || '');
  const id = String(node.attrs.id || '');
  const iconName = iconForKind(kind);
  const text = kind === 'skill' ? label : `@${label}`;
  const canOpen = kind === 'file' && id.length > 0;

  return (
    <NodeViewWrapper
      as="span"
      className={`mention-chip mention-chip-${kind}`}
      data-type="mention"
      data-kind={kind}
      data-id={id}
      data-label={label}
      data-file-open-path={canOpen ? id : undefined}
      data-testid="composer-inline-tag"
      contentEditable={false}
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      aria-label={canOpen ? `打开 ${label}` : text}
      onClick={(e: React.MouseEvent) => {
        if (!canOpen) return;
        e.preventDefault();
        e.stopPropagation();
        openFileInPanel(id);
      }}
      onAuxClick={(e: React.MouseEvent) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        deleteNode?.();
      }}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (!canOpen) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        openFileInPanel(id);
      }}
    >
      <span className="mention-icon-box" aria-hidden="true">
        <AppIcon name={iconName} size={12} stroke={1.75} />
      </span>
      <span className="mention-label">{text}</span>
    </NodeViewWrapper>
  );
};