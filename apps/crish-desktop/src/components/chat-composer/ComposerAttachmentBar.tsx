/**
 * 附件发丝卡：横滑、类型图标、悬停小叉、点开走叶预览。
 * 预览走 openFileInPanel / 可选 onOpenPath，不造 body 模态、不用 picsum。
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

type AttachKind = 'image' | 'code' | 'text' | 'file';

function attachKind(a: ChatAttachment): AttachKind {
  if (
    a.dataUrl ||
    (a.mime && a.mime.startsWith('image/')) ||
    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.name)
  ) {
    return 'image';
  }
  if (/\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|css|json)$/i.test(a.name)) {
    return 'code';
  }
  if (a.text || /\.(md|txt|csv|log|yml|yaml|toml)$/i.test(a.name)) {
    return 'text';
  }
  return 'file';
}

function KindIcon({ kind }: { kind: AttachKind }) {
  const Icon =
    kind === 'code'
      ? Lucide.FileCode
      : kind === 'text'
        ? Lucide.FileText
        : Lucide.File;
  return <Icon size={14} className={styles.attachIcon} aria-hidden />;
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
      className={styles.attachStrip}
      role="list"
      aria-label={`附件，共 ${attachments.length} 个`}
      data-testid="composer-attach-strip"
    >
      {attachments.map((a) => {
        const kind = attachKind(a);
        return (
          <Tooltip key={a.name} content={a.name}>
            <span
              role="listitem"
              tabIndex={0}
              data-testid="composer-attach-card"
              data-attach-kind={kind}
              data-file-open-path={a.name}
              className={`${styles.attachChip} ${a.dataUrl ? styles.attachChipImage : ''}`}
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
              {a.dataUrl ? (
                <img
                  src={a.dataUrl}
                  alt={a.name}
                  className={styles.attachThumb}
                />
              ) : (
                <span className={styles.attachIconBox} aria-hidden>
                  <KindIcon kind={kind} />
                </span>
              )}
              {a.dataUrl ? null : (
                <span className={styles.attachName}>{a.name}</span>
              )}
              <Tooltip content={`移除 ${a.name}`}>
                <Button
                  type="button"
                  variant="ghost"
                  className={`${styles.attachRemove} chat-attach-remove`}
                  aria-label={`移除附件 ${a.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveAttachment(a.name);
                  }}
                >
                  <Lucide.X size={10} aria-hidden />
                </Button>
              </Tooltip>
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
};
