/**
 * Layer 3: 上下文与文件引用卡片区（Attachment Bar）
 * 严格对齐 docs/ui-reference-alignment-audit/02-pixel-perfect-implementation-plan.md §4.4 与 reference/chat-composer-component/css/file-cards.css
 * - 24px 高度圆角芯片卡片（.file-card / .attachChip）；
 * - 官方 160+ 高频彩色格式图标（FileFormatIcon）；
 * - 文件名省略号截断；
 * - 右上角微型删除叉号（.file-remove，无阴影扁平圆钮，Hover 变红）；
 * - 图片缩略图预览（24px）；
 * - 点击文件名/卡片在右侧打开该文件（openFileInPanel / onOpenPath）。
 */
import React, { useState } from 'react';
import styles from './ChatComposer.module.css';
import type { ChatAttachment } from '../../hooks/useChatStream';
import { openFileInPanel } from '../../api/filePanelOpener';
import {
  AttachmentCard,
  isImageAttachmentItem,
} from '../chat-attachment/AttachmentCard';

export interface ComposerAttachmentBarProps {
  attachments: ChatAttachment[];
  onRemoveAttachment: (name: string) => void;
  /** 点卡开预览；缺省走 openFileInPanel（工作区叶） */
  onOpenPath?: (path: string) => void;
}

export type AttachKind = 'image' | 'code' | 'table' | 'text' | 'file' | 'annotation';

export function attachKind(a: ChatAttachment): AttachKind {
  if (a.annotation || a.mime === 'text/x-annotation') {
    return 'annotation';
  }
  if (
    a.isImage ||
    a.dataUrl ||
    (a.mime && a.mime.startsWith('image/')) ||
    /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(a.name || a.path || '')
  ) {
    return 'image';
  }
  if (/\.(csv|tsv|xlsx?)$/i.test(a.name || a.path || '')) {
    return 'table';
  }
  if (/\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|css|json)$/i.test(a.name || a.path || '')) {
    return 'code';
  }
  if (a.text || /\.(md|markdown|txt|log|ya?ml|toml)$/i.test(a.name || a.path || '')) {
    return 'text';
  }
  return 'file';
}

import { AnnotationChipItem } from './AnnotationChipItem';

export const ComposerAttachmentBar: React.FC<ComposerAttachmentBarProps> = ({
  attachments,
  onRemoveAttachment,
  onOpenPath,
}) => {
  const [activePopoverId, setActivePopoverId] = useState<string | null>(null);

  if (attachments.length === 0) return null;

  const openPreview = (a: ChatAttachment) => {
    if (a.path && a.path !== a.name) {
      const open = onOpenPath ?? openFileInPanel;
      open(a.path.trim());
      return;
    }
    if (a.dataUrl) {
      const win = typeof window !== 'undefined' ? window.open('', '_blank') : null;
      if (win) {
        win.document.write(
          `<!DOCTYPE html><html><head><title>${a.name}</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#111;}img{max-width:95vw;max-height:95vh;object-fit:contain;}</style></head><body><img src="${a.dataUrl}" alt="${a.name}"/></body></html>`
        );
        win.document.close();
      }
      return;
    }
    const targetPath = (a.path || a.name || '').trim();
    const open = onOpenPath ?? openFileInPanel;
    open(targetPath);
  };

  return (
    <div
      className={`${styles.fileZone} ${styles.attachStrip} file-zone`}
      role="list"
      aria-label={`附件，共 ${attachments.length} 个`}
      data-testid="composer-attach-strip"
    >
      {attachments.map((a, index) => {
        const kind = attachKind(a);
        const itemKey = a.id || (a.annotation ? a.annotation.id : `${a.path || a.name}_${index}`);
        if (kind === 'annotation' && a.annotation) {
          return (
            <AnnotationChipItem
              key={itemKey}
              attachment={a}
              isOpen={activePopoverId === itemKey}
              onRequestOpen={() => setActivePopoverId(itemKey)}
              onRequestClose={() =>
                setActivePopoverId((prev) => (prev === itemKey ? null : prev))
              }
              onRemove={onRemoveAttachment}
              onOpenPath={onOpenPath}
            />
          );
        }

        const isImg =
          kind === 'image' ||
          isImageAttachmentItem({
            name: a.name,
            path: a.path,
            mime: a.mime,
            dataUrl: a.dataUrl,
            isImage: a.isImage,
          });

        const removeId = a.id || a.name;

        return (
          <AttachmentCard
            key={itemKey}
            item={{
              id: a.id,
              name: a.name,
              path: a.path,
              mime: a.mime,
              size: (a as { size?: number }).size,
              dataUrl: a.dataUrl,
              thumbnailUrl: a.thumbnailUrl,
              isImage: isImg,
              status: a.status,
              progress: a.progress,
            }}
            kind={kind}
            testId="composer-attach-card"
            onClick={() => openPreview(a)}
            onRemove={() => onRemoveAttachment(removeId)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
                onRemoveAttachment(removeId);
              }
            }}
          />
        );
      })}
    </div>
  );
};
