import React from 'react';
import { Paperclip, X } from 'lucide-react';
import styles from '../ChatComposer.module.css';
import { Tooltip } from '../settings/SettingsUI';
import type { ChatAttachment } from '../hooks/useChatStream';

interface ComposerAttachmentsBarProps {
  attachments: ChatAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
}

export const ComposerAttachmentsBar: React.FC<ComposerAttachmentsBarProps> = ({
  attachments,
  setAttachments,
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
              <img
                src={a.dataUrl}
                alt={a.name}
                className={styles.attachThumb}
              />
            ) : (
              <Paperclip
                size={14}
                className={styles.attachIcon}
                aria-hidden
              />
            )}
            <span className={styles.attachName}>{a.name}</span>
            <Tooltip content={`移除 ${a.name}`}>
              <button
                type="button"
                className="ui-btn ui-btn-ghost chat-attach-remove"
                aria-label={`移除附件 ${a.name}`}
                onClick={() =>
                  setAttachments((prev) =>
                    prev.filter((x) => x.name !== a.name),
                  )
                }
              >
                <X size={14} aria-hidden />
              </button>
            </Tooltip>
          </span>
        </Tooltip>
      ))}
    </div>
  );
};
