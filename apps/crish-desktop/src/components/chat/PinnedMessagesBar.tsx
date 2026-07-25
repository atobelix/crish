import React, { memo } from 'react';
import { ChevronDown, Pin, PinOff } from 'lucide-react';
import styles from '../ChatMessageList.module.css';
import { Tooltip } from '../settings/SettingsUI';

export interface PinnedItem {
  id: string;
  sender: 'user' | 'assistant';
  snippet: string;
}

interface PinnedMessagesBarProps {
  pinnedItems: PinnedItem[];
  pinsOpen: boolean;
  onTogglePinsOpen: () => void;
  onJumpToPinned: (messageId: string) => void;
  onTogglePin: (messageId: string) => void;
}

const PinnedMessagesBarInner: React.FC<PinnedMessagesBarProps> = ({
  pinnedItems,
  pinsOpen,
  onTogglePinsOpen,
  onJumpToPinned,
  onTogglePin,
}) => {
  if (pinnedItems.length === 0) return null;

  return (
    <div className={styles.pinnedBar} role="region" aria-label="已固定消息">
      <Tooltip content={pinsOpen ? '收起固定列表' : '展开固定列表'}>
        <button
          type="button"
          className={styles.pinnedBarToggle}
          onClick={onTogglePinsOpen}
          aria-expanded={pinsOpen}
          aria-controls="chat-pinned-list"
          aria-label={
            pinsOpen
              ? `收起已固定消息列表，共 ${pinnedItems.length} 条`
              : `展开已固定消息列表，共 ${pinnedItems.length} 条`
          }
        >
          <Pin size={13} strokeWidth={2} aria-hidden />
          <span>已固定 · {pinnedItems.length}</span>
          <ChevronDown
            size={14}
            className={`${styles.pinnedChevron}${pinsOpen ? ` ${styles.isOpen}` : ''}`}
            aria-hidden
          />
        </button>
      </Tooltip>
      {pinsOpen ? (
        <ul id="chat-pinned-list" className={styles.pinnedList}>
          {pinnedItems.map((item) => (
            <li key={item.id} className={styles.pinnedItem}>
              <Tooltip content="跳转到消息">
                <button
                  type="button"
                  className={styles.pinnedJump}
                  aria-label={`跳转到${item.sender === 'user' ? '你' : '助手'}的固定消息：${item.snippet}`}
                  onClick={() => onJumpToPinned(item.id)}
                >
                  <span className={styles.pinnedSnippet}>
                    {item.snippet}
                  </span>
                </button>
              </Tooltip>
              <Tooltip content="取消固定">
                <button
                  type="button"
                  className={styles.pinnedUnpin}
                  aria-label={`取消固定：${item.snippet}`}
                  onClick={() => onTogglePin(item.id)}
                >
                  <PinOff size={14} aria-hidden />
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};

export const PinnedMessagesBar = memo(PinnedMessagesBarInner);
PinnedMessagesBar.displayName = 'PinnedMessagesBar';
