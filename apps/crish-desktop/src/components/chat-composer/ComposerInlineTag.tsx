/**
 * 行内 mention 芯片（文件图标盒 + Skill 变体）。
 * Tiptap NodeView：统一 AppIcon，禁止 dangerouslySetInnerHTML / lucide-react。
 * 文件类点击走已有 openFileInPanel（叶预览），不造 body 模态。
 */
import React from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';

import { openFileInPanel } from '../../api/filePanelOpener';
import { AppIcon, type IconName } from '../ui/icons';

function iconForKind(kind: string, customIcon?: string): IconName {
  if (customIcon) return customIcon as IconName;
  if (kind === 'skill') return 'blocks';
  if (kind === 'command') return 'sparkles';
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
  const customIcon = node.attrs.iconName
    ? String(node.attrs.iconName)
    : undefined;
  const iconName = iconForKind(kind, customIcon);
  const text = kind === 'skill' || kind === 'command' ? label : `@${label}`;
  const canOpen = (kind === 'file' || kind === 'skill') && id.length > 0;

  const handleOpen = async (e: React.SyntheticEvent) => {
    if (!canOpen) return;
    e.preventDefault();
    e.stopPropagation();
    if (kind === 'skill') {
      const isPath =
        id.includes('/') || id.includes('\\') || id.endsWith('.md');
      if (isPath) {
        const res = openFileInPanel(id);
        if (!res) {
          try {
            const { revealSkillPath } = await import('../../api/skillsApi');
            await revealSkillPath(id);
          } catch {
            /* swallow-ok */
          }
        }
        return;
      }
      try {
        const { getSkillSlashCommandsCached, revealSkillPath } =
          await import('../../api/skillsApi');
        const { skills } = await getSkillSlashCommandsCached();
        const target = skills.find(
          (s) =>
            s.id === id ||
            s.name.toLowerCase() === id.toLowerCase() ||
            s.filePath === id
        );
        if (target?.filePath) {
          const res = openFileInPanel(target.filePath);
          if (!res) {
            await revealSkillPath(target.filePath);
          }
        }
      } catch {
        /* swallow-ok */
      }
    } else {
      openFileInPanel(id);
    }
  };

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
      aria-label={
        canOpen
          ? kind === 'skill'
            ? `打开技能 ${label}`
            : `打开 ${label}`
          : text
      }
      onClick={handleOpen}
      onAuxClick={(e: React.MouseEvent) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        deleteNode?.();
      }}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (!canOpen) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        void handleOpen(e);
      }}
    >
      <span className="mention-icon-box" aria-hidden="true">
        <AppIcon name={iconName} size={15} stroke={1.75} />
      </span>
      <span className="mention-label">{text}</span>
    </NodeViewWrapper>
  );
};
