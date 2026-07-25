import { useCallback } from 'react';
import styles from '../ChatMessageList.module.css';
import {
  DEFAULT_RECENT_MESSAGE_COUNT,
  expandedOlderForPinJump,
} from '../../api/messageWindow';
import type { SessionMessage } from '../../store/layoutStore';

export type IdleHandle = number;

export const HAS_NATIVE_REQUEST_IDLE =
  typeof requestIdleCallback === 'function' &&
  typeof cancelIdleCallback === 'function';

export function scheduleIdle(
  task: (deadline?: IdleDeadline) => void,
  options?: { timeout?: number }
): { handle: IdleHandle; cancel: () => void } {
  if (HAS_NATIVE_REQUEST_IDLE) {
    const handle = requestIdleCallback(task, options) as IdleHandle;
    return {
      handle,
      cancel: () => {
        if (typeof cancelIdleCallback === 'function') {
          cancelIdleCallback(handle);
        }
      },
    };
  }
  const timeout = options?.timeout ?? 16;
  const handle = window.setTimeout(
    () => task(undefined),
    timeout
  ) as unknown as IdleHandle;
  return {
    handle,
    cancel: () => window.clearTimeout(handle),
  };
}

export function pinSnippet(text?: string, max = 72): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '（无文本）';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function findMessageElement(messageId: string): HTMLElement | null {
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

export function scrollToMessageAfterPaint(
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
  messages: SessionMessage[];
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
  const jumpToPinned = useCallback(
    (messageId: string) => {
      const idx = messages.findIndex((m) => m.id === messageId);
      if (idx < 0 && showAllMessages) {
        const exists = sessionAllMessages.some((m) => m.id === messageId);
        onShowToast(exists ? '该消息不在当前过滤结果中' : '未找到该固定消息');
        return;
      }
      const listForPin = idx >= 0 ? messages : sessionAllMessages;
      const inList = listForPin.some((m) => m.id === messageId);
      if (!inList) {
        onShowToast('未找到该固定消息');
        return;
      }

      const raisePinWindow = (prev: number) =>
        expandedOlderForPinJump(
          listForPin,
          messageId,
          prev,
          DEFAULT_RECENT_MESSAGE_COUNT
        );

      if (!showAllMessages) {
        setExpandedOlder(raisePinWindow);
      }

      scrollToMessageAfterPaint(messageId, () => {
        if (!showAllMessages) {
          setExpandedOlder(raisePinWindow);
        }
        window.setTimeout(() => {
          if (!scrollToMessage(messageId)) {
            onShowToast('未找到该固定消息');
          }
        }, 50);
      });
    },
    [messages, sessionAllMessages, showAllMessages, onShowToast, setExpandedOlder]
  );

  return {
    jumpToPinned,
    scrollToMessage,
    scrollToMessageAfterPaint,
  };
}
