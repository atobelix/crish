/**
 * 行内 mention 芯片（文件图标盒 + Skill 变体）。
 * Tiptap NodeView：Lucide 图标，禁止 dangerouslySetInnerHTML / 参考仓图标字典。
 * 文件类点击走已有 openFileInPanel（叶预览），不造 body 模态。
 */
import React from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import * as Lucide from 'lucide-react';
import { openFileInPanel } from '../../api/filePanelOpener';

function iconForKind(kind: string) {
  if (kind === 'skill') return Lucide.Sparkles;
  if (kind === 'agent') return Lucide.Bot;
  return Lucide.FileText;
}

export const ComposerInlineTag: React.FC<NodeViewProps> = ({ node }) => {
  const kind = String(node.attrs.kind || 'file');
  const label = String(node.attrs.label || node.attrs.id || '');
  const id = String(node.attrs.id || '');
  const Icon = iconForKind(kind);
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
      onKeyDown={(e: React.KeyboardEvent) => {
        if (!canOpen) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        openFileInPanel(id);
      }}
    >
      <span className="mention-icon-box" aria-hidden="true">
        <Icon size={12} strokeWidth={1.75} />
      </span>
      <span className="mention-label">{text}</span>
    </NodeViewWrapper>
  );
};
