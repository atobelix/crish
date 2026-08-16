import React, { useCallback } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatQueuePanel.module.css';
import type { QueuedMessage } from '../../hooks/useChatStream';
import { Button, Tooltip } from '../ui';

export interface ChatQueuePanelProps {
  queue: QueuedMessage[];
  onSendNow: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  className?: string;
}

const MAX_TEXT_LEN = 80;

function formatQueueText(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= MAX_TEXT_LEN) return trimmed;
  return `${trimmed.slice(0, MAX_TEXT_LEN)}…`;
}

export const ChatQueuePanel: React.FC<ChatQueuePanelProps> = ({
  queue,
  onSendNow,
  onEdit,
  onDelete,
  className,
}) => {
  const handleSendNow = useCallback(
    (id: string) => () => onSendNow(id),
    [onSendNow]
  );
  const handleEdit = useCallback((id: string) => () => onEdit(id), [onEdit]);
  const handleDelete = useCallback(
    (id: string) => () => onDelete(id),
    [onDelete]
  );

  if (queue.length === 0) return null;

  return (
    <div
      className={`${styles.panel}${className ? ` ${className}` : ''}`}
      role="region"
      aria-label={`排队消息，共 ${queue.length} 条`}
    >
      {queue.map((msg, index) => (
        <div key={msg.id} className={styles.item}>
          <span className={styles.index}>{index + 1}</span>
          <Tooltip content={msg.text}>
            <span className={styles.text}>
              {formatQueueText(msg.text)}
              {msg.attachments.length > 0 && (
                <span className={styles.attachmentHint}>
                  （{msg.attachments.length} 个附件）
                </span>
              )}
            </span>
          </Tooltip>
          <div className={styles.actions}>
            <Tooltip content="发送">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.actionBtn}
                aria-label="立即发送"
                onClick={handleSendNow(msg.id)}
                icon={<Lucide.Send size={14} aria-hidden />}
              />
            </Tooltip>
            <Tooltip content="编辑">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.actionBtn}
                aria-label="编辑排队消息"
                onClick={handleEdit(msg.id)}
                icon={<Lucide.Pencil size={14} aria-hidden />}
              />
            </Tooltip>
            <Tooltip content="删除">
              <Button
                type="button"
                variant="danger"
                size="sm"
                className={`${styles.actionBtn} ${styles.danger}`}
                aria-label="删除排队消息"
                onClick={handleDelete(msg.id)}
                icon={<Lucide.Trash2 size={14} aria-hidden />}
              />
            </Tooltip>
          </div>
        </div>
      ))}
    </div>
  );
};

ChatQueuePanel.displayName = 'ChatQueuePanel';
