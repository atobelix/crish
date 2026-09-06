import { toast } from '../../services/toast/ToastContext';
import { useCallback, useRef } from 'react';
import styles from './ChatMessageList.module.css';
import type { SessionMessage } from '../../store/types';

export function pinSnippet(text?: string, max = 72): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '（无文本）';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function findScrollContainer(el?: HTMLElement | null): HTMLElement | null {
  const byAttr = document.querySelector<HTMLElement>(
    '[data-chat-scroll-container]'
  );
  if (byAttr) return byAttr;
  if (el) {
    const closest = el.closest<HTMLElement>(
      '[data-chat-scroll-container], [data-virtual-scroll="true"], .list'
    );
    if (closest) return closest;
  }
  return document.querySelector<HTMLElement>(
    '[data-virtual-scroll="true"], [role="region"][aria-label="会话消息"]'
  );
}

function findMessageElement(
  messageId: string,
  container?: HTMLElement | null
): HTMLElement | null {
  const escaped = CSS.escape(messageId);
  const selector = `[data-msg-id="${escaped}"], [data-vindex="${escaped}"], [data-chat-node-key="${escaped}"]`;
  const el = container
    ? container.querySelector(selector)
    : document.querySelector(selector);
  return el instanceof HTMLElement ? el : null;
}

export function scrollToMessage(messageId: string): boolean {
  const container = findScrollContainer();
  const el = findMessageElement(messageId, container);
  if (!el) return false;

  const scroller =
    container ??
    findScrollContainer(el) ??
    el.parentElement;

  if (scroller) {
    const elRect = el.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const diff = elRect.top - scrollerRect.top;

    let relativeOffsetTop = diff + scroller.scrollTop;

    // 亚像素/无布局引擎环境（如 Vitest jsdom）回退处理：沿 offsetParent 链累加 offsetTop
    if (diff === 0) {
      let offset = 0;
      let curr: HTMLElement | null = el;
      while (curr && curr !== scroller) {
        offset += curr.offsetTop || 0;
        curr = curr.offsetParent as HTMLElement | null;
      }
      if (offset > 0) {
        relativeOffsetTop = offset;
      } else if (el.offsetTop > 0) {
        relativeOffsetTop = el.offsetTop;
      }
    }

    const viewportHeight = scroller.clientHeight;
    const targetHeight = el.clientHeight;
    let targetScrollTop = relativeOffsetTop;
    if (viewportHeight > 0) {
      // 居中视口对齐，消除视口被动向上扯动的顽疾，仅向单一滚动宿主写入 scrollTop
      targetScrollTop =
        relativeOffsetTop - Math.max(0, (viewportHeight - targetHeight) / 2);
    }
    scroller.scrollTop = Math.max(0, targetScrollTop);
  }

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
}

export function useScrollAnchor({
  messages,
  sessionAllMessages,
  showAllMessages,
  }: UseScrollAnchorOptions) {
  // Refs keep jumpToPinned identity stable across stream token message array churn
  // so MessageVirtualizer memo is not busted every token (pin path only reads on click).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const allMessagesRef = useRef(sessionAllMessages);
  allMessagesRef.current = sessionAllMessages;
  const showAllRef = useRef(showAllMessages);
  showAllRef.current = showAllMessages;
  const onShowToastRef = useRef((m: string) => toast.show(m));
  

  const jumpToPinned = useCallback((messageId: string) => {
    const display = messagesRef.current;
    const all = allMessagesRef.current;
    const showAll = showAllRef.current;
    const toast = onShowToastRef.current;

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

    if (scrollToMessage(messageId)) {
      return;
    }

    scrollToMessageAfterPaint(messageId, () => {
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
