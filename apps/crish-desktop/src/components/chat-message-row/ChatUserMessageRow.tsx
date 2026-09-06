import { useToast } from '../../services/toast/ToastContext';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './ChatMessageRow.module.css';
import { Tooltip } from '../ui';
import type { SessionMessage } from '../../store/types';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import { Pin } from 'lucide-react';
import {
  copyTextBestEffort,
  isUserBubbleLong,
  messageRowAriaLabel,
  userBubbleDisplayText,
  userBubbleExpandAria,
} from './chatMessageRowUtils';
import { UserMessageActionsBar } from './MessageActionsBar';
import { FileFormatIcon } from '../../assets/icons';
import { openFileInPanel } from '../../api/filePanelOpener';
import { convertFileSrc } from '@tauri-apps/api/core';
import { isAbsoluteFsPath } from '../../api/workspaceFsApi';

export type ChatUserMessageRowProps = {
  msg: SessionMessage;
  isPinned: boolean;
  isSearchHit: boolean;
  isExpanded: boolean;
  onToggleExpand: (msgId: string) => void;
  onTogglePin: (msgId: string) => void;
  /** 会话最后一条 user：挂消息级撤回（用户锁：入口在对话里，不在 composer） */
  isLastUser?: boolean;
  onRetract?: () => void;
  messageIndex: number;
  virtualScrollManager: VirtualScrollManager | null;
  onOpenPath?: (filePath: string) => void;
};

function userRowPropsEqual(
  prev: ChatUserMessageRowProps,
  next: ChatUserMessageRowProps
): boolean {
  return (
    prev.msg.id === next.msg.id &&
    prev.msg.status === next.msg.status &&
    prev.msg.text === next.msg.text &&
    prev.msg.timestamp === next.msg.timestamp &&
    prev.isPinned === next.isPinned &&
    prev.isSearchHit === next.isSearchHit &&
    prev.isExpanded === next.isExpanded &&
    prev.onToggleExpand === next.onToggleExpand &&
    prev.onTogglePin === next.onTogglePin &&
    prev.isLastUser === next.isLastUser &&
    prev.onRetract === next.onRetract &&
    prev.messageIndex === next.messageIndex &&
    prev.virtualScrollManager === next.virtualScrollManager &&
    prev.onOpenPath === next.onOpenPath &&
    prev.msg.images === next.msg.images &&
    prev.msg.attachments === next.msg.attachments &&
    true
  );
}

const ChatUserMessageRowInner: React.FC<ChatUserMessageRowProps> = ({
  msg,
  isPinned,
  isSearchHit,
  isExpanded,
  onToggleExpand,
  onTogglePin,
  isLastUser = false,
  onRetract,
  messageIndex: _messageIndex,
  virtualScrollManager,
  onOpenPath,
}) => {
  void _messageIndex;
  const { showToast } = useToast();
  const isLong = isUserBubbleLong(msg.text);
  const displayText = userBubbleDisplayText(msg.text, isExpanded);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const rowAria = messageRowAriaLabel({
    role: 'user',
    isPinned,
    status: msg.status,
  });

  const images = msg.images ?? [];
  const nonImageAttachments = (msg.attachments ?? []).filter(
    (a) => !a.dataUrl && (!a.mime || !a.mime.startsWith('image/'))
  );
  const hasImages = images.length > 0;
  const hasAttachments = nonImageAttachments.length > 0;

  const handleOpenPath = useCallback(
    (path: string) => {
      if (!path) return;
      if (onOpenPath) {
        onOpenPath(path);
        return;
      }
      openFileInPanel(path);
    },
    [onOpenPath]
  );

  useEffect(
    () => () => {
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    },
    []
  );

  // Skip while message is still processing; RO owns live height. Invalidate on settle / text edits.
  useEffect(() => {
    if (msg.status === 'processing') return;
    virtualScrollManager?.invalidateActual(msg.id);
  }, [
    msg.text,
    msg.id,
    msg.status,
    msg.images,
    msg.attachments,
    virtualScrollManager,
  ]);

  const handleCopy = useCallback(() => {
    const text = msg.text || '';
    if (!text) return;
    void copyTextBestEffort(text).then((ok) => {
      if (!ok) {
        showToast('复制失败');
        return;
      }
      setCopied(true);
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
    });
  }, [msg.text, showToast]);

  const retractHandler = isLastUser ? onRetract : undefined;

  const toggleExpand = useCallback(() => {
    if (isLong) {
      const sel = window.getSelection()?.toString();
      if (sel) return;
      onToggleExpand(msg.id);
    }
  }, [isLong, msg.id, onToggleExpand]);

  const onBubbleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isLong) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onToggleExpand(msg.id);
      }
    },
    [isLong, msg.id, onToggleExpand]
  );

  return (
    <div
      className={`${styles.row} ${styles.rowUser} msg-row msg-row-user${isSearchHit ? ` ${styles.searchHit} msg-search-hit` : ''}${isPinned ? ` ${styles.isPinned}` : ''}`}
      data-testid="chat-user-message-row"
      data-msg-id={msg.id}
      data-role="user"
      data-pinned={isPinned ? 'true' : undefined}
      role="article"
      aria-label={rowAria}
    >
      <div className={styles.userStack}>
        {isPinned ? (
          <Tooltip content="已固定">
            <span className={styles.pinBadge} aria-hidden="true">
              <Pin size={11} strokeWidth={2.25} />
              已固定
            </span>
          </Tooltip>
        ) : null}
        <div
          className={styles.userBubble}
          onClick={toggleExpand}
          onKeyDown={onBubbleKeyDown}
          style={{
            cursor: isLong ? 'pointer' : 'default',
          }}
          role={isLong ? 'button' : undefined}
          tabIndex={isLong ? 0 : undefined}
          aria-expanded={isLong ? isExpanded : undefined}
          aria-label={isLong ? userBubbleExpandAria(isExpanded) : undefined}
        >
          {hasImages ? (
            <div className={styles.userImages} data-testid="user-images-gallery">
              {images.map((img) => {
                const imgSrc =
                  img.resolvedUrl ||
                  (img.source?.startsWith('data:') ||
                  img.source?.startsWith('blob:') ||
                  img.source?.startsWith('http')
                    ? img.source
                    : isAbsoluteFsPath(img.source)
                      ? convertFileSrc(img.source)
                      : img.source);
                return (
                  <Tooltip
                    key={img.id || img.source}
                    content={img.alt || '查看图片'}
                  >
                    <div
                      className={styles.userImageWrapper}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenPath(img.source);
                      }}
                    >
                      <img
                        src={imgSrc}
                        alt={img.alt || '图片附件'}
                        className={styles.userImage}
                        loading="lazy"
                      />
                    </div>
                  </Tooltip>
                );
              })}
            </div>
          ) : null}

          {hasAttachments ? (
            <div
              className={styles.userAttachments}
              data-testid="user-attachments-strip"
            >
              {nonImageAttachments.map((a) => (
                <Tooltip key={a.name} content={a.path || a.name}>
                  <span
                    className={styles.userAttachmentChip}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpenPath(a.path || a.name);
                    }}
                  >
                    <FileFormatIcon fileName={a.name} size={14} />
                    <span className={styles.userAttachmentName}>{a.name}</span>
                  </span>
                </Tooltip>
              ))}
            </div>
          ) : null}

          {displayText ? displayText : null}
          {msg.status === 'queued' && (
            <span className={styles.queued}>排队中</span>
          )}
        </div>
        <UserMessageActionsBar
          timestamp={msg.timestamp}
          isPinned={isPinned}
          copied={copied}
          onCopy={handleCopy}
          onTogglePin={() => onTogglePin(msg.id)}
          onRetract={retractHandler}
          alwaysVisible={Boolean(retractHandler)}
        />
      </div>
    </div>
  );
};

export const ChatUserMessageRow = React.memo(
  ChatUserMessageRowInner,
  userRowPropsEqual
);
