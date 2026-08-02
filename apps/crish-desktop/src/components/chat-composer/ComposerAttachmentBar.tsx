import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatComposer.module.css';
import { Tooltip } from '../Tooltip';
import type { ChatAttachment } from '../../hooks/useChatStream';

export interface ComposerAttachmentBarProps {
  attachments: ChatAttachment[];
  onRemoveAttachment: (name: string) => void;
}

export const ComposerAttachmentBar: React.FC<ComposerAttachmentBarProps> = ({
  attachments,
  onRemoveAttachment,
}) => {
  if (attachments.length === 0) return null;

  return (
    <div
      className={styles.attachStrip}
      role="list"
      aria-label={`附件，共 ${attachments.length} 个`}
    >
      {attachments.map((a) => (
        <Tooltip key={a.name} content={a.name}>
          <span
            role="listitem"
            className={`${styles.attachChip} ${a.dataUrl ? styles.attachChipImage : ''}`}
          >
            {a.dataUrl ? (
              <img src={a.dataUrl} alt={a.name} className={styles.attachThumb} />
            ) : (
              <Lucide.Paperclip size={14} className={styles.attachIcon} aria-hidden />
            )}
            <span className={styles.attachName}>{a.name}</span>
            <Tooltip content={`移除 ${a.name}`}>
              <button
                type="button"
                className="ui-btn ui-btn-ghost chat-attach-remove"
                aria-label={`移除附件 ${a.name}`}
                onClick={() => onRemoveAttachment(a.name)}
              >
                <Lucide.X size={14} aria-hidden />
              </button>
            </Tooltip>
          </span>
        </Tooltip>
      ))}
    </div>
  );
};
