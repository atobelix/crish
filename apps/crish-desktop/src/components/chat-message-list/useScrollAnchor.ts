import { useCallback, useRef } from 'react';
import styles from './ChatMessageList.module.css';
import {
  DEFAULT_RECENT_MESSAGE_COUNT,
  expandedOlderForPinJump,
} from '../../api/messageWindow';
import type { SessionMessage } from '../../store/types';

export function pinSnippet(text?: string, max = 72): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '（无文本）';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function findMessageElement(messageId: string): HTMLElement | null {
  const el = document.querySelector(
    `[data-msg-id="${CSS.escape(messageId)}"]`
  );
  return el instanceof HTMLElement ? el : null;
}

export function scrollToMessage(messageId: string): boolean {
  const el = findMessageElement(messageId);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const flashClass = styles.rowPinFlash;
  if (flashClass) {
    el.classList.add(flashClass);
    window.setTimeout(() => {
      el.classList.remove(flashClass);
    }, 1200);
  }
  return true;
}

function scrollToMessageAfterPaint(
  messageId: string,
  onMiss?: () => void
): void {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (!scrollToMessage(messageId)) onMiss?.();
    });
  });
}

export interface UseScrollAnchorOptions {
  /** Display / filtered list. */
  messages: SessionMessage[];
  /**
   * Full unfiltered session messages (parent-owned). Used when pin target is
   * outside the filtered display list. Prefer props over a second store sub.
   */
  sessionAllMessages: SessionMessage[];
  showAllMessages: boolean;
  onShowToast: (message: string) => void;
  setExpandedOlder: React.Dispatch<React.SetStateAction<number>>;
}

export function useScrollAnchor({
  messages,
  sessionAllMessages,
  showAllMessages,
  onShowToast,
  setExpandedOlder,
}: UseScrollAnchorOptions) {
  // Refs keep jumpToPinned identity stable across stream token message array churn
  // so MessageVirtualizer memo is not busted every token (pin path only reads on click).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const allMessagesRef = useRef(sessionAllMessages);
  allMessagesRef.current = sessionAllMessages;
  const showAllRef = useRef(showAllMessages);
  showAllRef.current = showAllMessages;
  const onShowToastRef = useRef(onShowToast);
  onShowToastRef.current = onShowToast;
  const setExpandedOlderRef = useRef(setExpandedOlder);
  setExpandedOlderRef.current = setExpandedOlder;

  const jumpToPinned = useCallback((messageId: string) => {
    const display = messagesRef.current;
    const all = allMessagesRef.current;
    const showAll = showAllRef.current;
    const toast = onShowToastRef.current;
    const setExpanded = setExpandedOlderRef.current;

    const idx = display.findIndex((m) => m.id === messageId);
    if (idx < 0 && showAll) {
      const exists = all.some((m) => m.id === messageId);
      toast(exists ? '该消息不在当前过滤结果中' : '未找到该固定消息');
      return;
    }
    const listForPin = idx >= 0 ? display : all;
    const inList = listForPin.some((m) => m.id === messageId);
    if (!inList) {
      toast('未找到该固定消息');
      return;
    }

    const raisePinWindow = (prev: number) =>
      expandedOlderForPinJump(
        listForPin,
        messageId,
        prev,
        DEFAULT_RECENT_MESSAGE_COUNT
      );

    if (!showAll) {
      setExpanded(raisePinWindow);
    }

    scrollToMessageAfterPaint(messageId, () => {
      if (!showAllRef.current) {
        setExpandedOlderRef.current(raisePinWindow);
      }
      window.setTimeout(() => {
        if (!scrollToMessage(messageId)) {
          onShowToastRef.current('未找到该固定消息');
        }
      }, 50);
    });
  }, []);

  return {
    jumpToPinned,
    scrollToMessage,
    scrollToMessageAfterPaint,
  };
}
