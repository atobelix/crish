/**
 * Layer 3: 上下文与文件引用卡片区（Attachment Bar）
 * 严格对齐 docs/ui-reference-alignment-audit/02-pixel-perfect-implementation-plan.md §4.4 与 reference/chat-composer-component/css/file-cards.css
 * - 24px 高度圆角芯片卡片（.file-card / .attachChip）；
 * - 展示文件类型专属图标（Markdown, Code, Table/CSV, Text, Image, File）；
 * - 文件名省略号截断；
 * - 右上角微型删除叉号 ×（.file-remove，Hover 变红）；
 * - 图片缩略图预览（24px/27px）；
 * - 点击文件名/卡片在右侧 Side Panel 打开该文件（openFileInPanel / onOpenPath）。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatComposer.module.css';
import { Button, Tooltip } from '../ui';
import type { ChatAttachment } from '../../hooks/useChatStream';
import { openFileInPanel } from '../../api/filePanelOpener';

export interface ComposerAttachmentBarProps {
  attachments: ChatAttachment[];
  onRemoveAttachment: (name: string) => void;
  /** 点卡开预览；缺省走 openFileInPanel（工作区叶） */
  onOpenPath?: (path: string) => void;
}

export type AttachKind = 'image' | 'code' | 'table' | 'text' | 'file';

export function attachKind(a: ChatAttachment): AttachKind {
  if (
    a.dataUrl ||
    (a.mime && a.mime.startsWith('image/')) ||
    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.name)
  ) {
    return 'image';
  }
  if (/\.(csv|tsv|xlsx?)$/i.test(a.name)) {
    return 'table';
  }
  if (/\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|css|json)$/i.test(a.name)) {
    return 'code';
  }
  if (a.text || /\.(md|markdown|txt|log|ya?ml|toml)$/i.test(a.name)) {
    return 'text';
  }
  return 'file';
}

function KindIcon({ kind }: { kind: AttachKind }) {
  if (kind === 'code') {
    return <Lucide.FileCode size={14} className={styles.attachIcon} aria-hidden />;
  }
  if (kind === 'table') {
    return <Lucide.Table size={14} className={styles.attachIcon} aria-hidden />;
  }
  if (kind === 'image') {
    return <Lucide.Image size={14} className={styles.attachIcon} aria-hidden />;
  }
  if (kind === 'text') {
    return <Lucide.FileText size={14} className={styles.attachIcon} aria-hidden />;
  }
  return <Lucide.File size={14} className={styles.attachIcon} aria-hidden />;
}

export const ComposerAttachmentBar: React.FC<ComposerAttachmentBarProps> = ({
  attachments,
  onRemoveAttachment,
  onOpenPath,
}) => {
  if (attachments.length === 0) return null;

  const openPreview = (a: ChatAttachment) => {
    const open = onOpenPath ?? openFileInPanel;
    open(a.name);
  };

  return (
    <div
      className={`${styles.fileZone} ${styles.attachStrip} file-zone`}
      role="list"
      aria-label={`附件，共 ${attachments.length} 个`}
      data-testid="composer-attach-strip"
    >
      {attachments.map((a) => {
        const kind = attachKind(a);
        const hasThumb = Boolean(a.dataUrl);

        return (
          <Tooltip key={a.name} content={a.name}>
            <span
              role="listitem"
              tabIndex={0}
              data-testid="composer-attach-card"
              data-attach-kind={kind}
              data-file-type={kind}
              data-file-name={a.name}
              data-file-open-path={a.name}
              className={`${styles.fileCard} ${styles.attachChip} file-card ${hasThumb ? `${styles.attachChipImage} type-image` : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                openPreview(a);
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                e.stopPropagation();
                onRemoveAttachment(a.name);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openPreview(a);
                }
              }}
            >
              {hasThumb ? (
                <img
                  src={a.dataUrl}
                  alt={a.name}
                  className={`${styles.fileThumbnail} ${styles.attachThumb} file-thumbnail`}
                />
              ) : (
                <span className={`${styles.fileIcon} ${styles.attachIconBox} file-icon`} aria-hidden>
                  <KindIcon kind={kind} />
                </span>
              )}

              {hasThumb ? null : (
                <span className={`${styles.fileName} ${styles.attachName} file-name`}>
                  {a.name}
                </span>
              )}

              <Tooltip content={`移除附件 ${a.name}`}>
                <Button
                  type="button"
                  variant="ghost"
                  className={`${styles.fileRemove} ${styles.attachRemove} file-remove chat-attach-remove`}
                  aria-label={`移除附件 ${a.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveAttachment(a.name);
                  }}
                  icon={<Lucide.X size={10} strokeWidth={2.5} aria-hidden />}
                />
              </Tooltip>
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
};
