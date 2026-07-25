import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from '../ChatMessageRow.module.css';
import { Tooltip } from '../settings/SettingsUI';
import type { SessionMessage } from '../../store/layoutStore';
import { useBubbleShrinkWidth } from '../../hooks/useTextMeasure';
import { buildPretextFontForUiSize } from '../../utils/pretextFontBridge';
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

export type ChatUserMessageRowProps = {
  msg: SessionMessage;
  isPinned: boolean;
  isSearchHit: boolean;
  isExpanded: boolean;
  onToggleExpand: (msgId: string) => void;
  onTogglePin: (msgId: string) => void;
  onWithdraw: (msgId: string, text: string) => void;
  onShowToast?: (message: string) => void;
  messageIndex: number;
  virtualScrollManager: VirtualScrollManager | null;
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
    prev.onWithdraw === next.onWithdraw &&
    prev.onShowToast === next.onShowToast
  );
}

const ChatUserMessageRowInner: React.FC<ChatUserMessageRowProps> = ({
  msg,
  isPinned,
  isSearchHit,
  isExpanded,
  onToggleExpand,
  onTogglePin,
  onWithdraw: _onWithdraw,
  onShowToast,
  messageIndex,
  virtualScrollManager,
}) => {
  void _onWithdraw;
  const isLong = isUserBubbleLong(msg.text);
  const displayText = userBubbleDisplayText(msg.text, isExpanded);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const userRowRef = useRef<HTMLDivElement>(null);
  const userBubbleFont = useMemo(
    () => buildPretextFontForUiSize('medium', 'sans', 'normal'),
    []
  );
  const userBubbleWidth = useBubbleShrinkWidth(
    displayText,
    userBubbleFont,
    userRowRef,
    32
  );
  const rowAria = messageRowAriaLabel({
    role: 'user',
    isPinned,
    status: msg.status,
  });

  useEffect(
    () => () => {
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    },
    []
  );

  useEffect(() => {
    virtualScrollManager?.invalidateActual(String(messageIndex));
  }, [msg.text, messageIndex, virtualScrollManager]);

  const handleCopy = useCallback(() => {
    const text = msg.text || '';
    if (!text) return;
    void copyTextBestEffort(text).then((ok) => {
      if (!ok) {
        onShowToast?.('复制失败');
        return;
      }
      setCopied(true);
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
    });
  }, [msg.text, onShowToast]);

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
      ref={userRowRef}
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
          className={`${styles.userBubble} ${isExpanded ? 'expanded' : ''}`}
          onClick={toggleExpand}
          onKeyDown={onBubbleKeyDown}
          style={{
            cursor: isLong ? 'pointer' : 'default',
            maxWidth: userBubbleWidth ?? undefined,
          }}
          role={isLong ? 'button' : undefined}
          tabIndex={isLong ? 0 : undefined}
          aria-expanded={isLong ? isExpanded : undefined}
          aria-label={isLong ? userBubbleExpandAria(isExpanded) : undefined}
        >
          <span className={styles.userText}>{displayText}</span>
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
        />
      </div>
    </div>
  );
};

export const ChatUserMessageRow = React.memo(
  ChatUserMessageRowInner,
  userRowPropsEqual
);
