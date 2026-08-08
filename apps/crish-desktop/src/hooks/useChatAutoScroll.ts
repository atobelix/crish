import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface UseChatAutoScrollResult {
  chatFlowRef: RefObject<HTMLDivElement | null>;
  showScrollToBottom: boolean;
  /** 用户点「回到最新」：恢复自动滚底并滚到末尾 */
  scrollToBottom: () => void;
}

/** 实际滚动节点：优先虚拟列表 .list（data-virtual-scroll），否则 chatDocFlow 自身 */
function resolveScrollEl(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  const list = root.querySelector<HTMLElement>('[data-virtual-scroll="true"]');
  return list ?? root;
}

/**
 * Chat auto-scroll via DOM scrollHeight deltas only.
 * Multiple message updates in a frame are merged into one rAF apply.
 * No Pretext prepare/layout path — pure incremental scrollTop.
 */
export function useChatAutoScroll(
  messages: unknown[],
  isProcessing = false,
): UseChatAutoScrollResult {
  const chatFlowRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  /** Last observed scrollHeight of the active scroller */
  const prevScrollHeightRef = useRef(0);
  /** Pending coalesced auto-scroll frame */
  const rafIdRef = useRef<number | null>(null);

  // Coalesce token/message updates: one scroll apply per animation frame
  useEffect(() => {
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current);
    }

    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      const el = resolveScrollEl(chatFlowRef.current);
      if (!el) return;

      const scrollHeight = el.scrollHeight;
      const prevHeight = prevScrollHeightRef.current;

      if (!userScrolledRef.current) {
        if (isProcessing && prevHeight > 0) {
          // Incremental: advance by content growth only
          const dh = scrollHeight - prevHeight;
          if (dh > 0) {
            el.scrollTop = Math.min(el.scrollTop + dh, scrollHeight);
          } else if (dh < 0) {
            // F7-F17：内容收缩（新行实际高度 < 估算高度 → scrollHeight
            // 缩小，dh ≤ 0 不滚动）时，若当前贴底则重新吸附到真实底部，
            // 避免长代码块消息渲染后底部残留空白
            const atBottom =
              scrollHeight - el.scrollTop - el.clientHeight < 60;
            if (atBottom) {
              el.scrollTop = Math.max(0, scrollHeight - el.clientHeight);
            }
          }
        } else {
          // Idle / first sample: snap to real bottom (also calibrates after stream)
          el.scrollTop = scrollHeight;
        }
        setShowScrollToBottom(false);
      }

      prevScrollHeightRef.current = scrollHeight;
    });

    return () => {
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [messages, isProcessing]);

  // Detect user scroll-up to stop auto-scroll（绑在实际滚动容器上）
  useEffect(() => {
    const root = chatFlowRef.current;
    if (!root) return;

    const el = resolveScrollEl(root);
    let attached: HTMLElement | null = null;

    const handleScroll = () => {
      const scroller = attached;
      if (!scroller) return;
      const atBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
      if (atBottom) {
        userScrolledRef.current = false;
        setShowScrollToBottom(false);
      } else {
        userScrolledRef.current = true;
        setShowScrollToBottom(true);
      }
    };

    const attach = (target: HTMLElement | null) => {
      if (attached === target) return;
      if (attached) {
        attached.removeEventListener('scroll', handleScroll);
      }
      attached = target;
      if (attached) {
        attached.addEventListener('scroll', handleScroll, { passive: true });
      }
    };

    attach(el);

    // 消息列表从 empty 挂载后出现 .list，需重新绑定
    const mo = new MutationObserver(() => {
      const next = resolveScrollEl(root);
      if (next !== attached) attach(next);
    });
    mo.observe(root, { childList: true, subtree: true });

    return () => {
      mo.disconnect();
      if (attached) {
        attached.removeEventListener('scroll', handleScroll);
      }
    };
  }, [messages.length]);

  const scrollToBottom = useCallback(() => {
    userScrolledRef.current = false;
    setShowScrollToBottom(false);
    const el = resolveScrollEl(chatFlowRef.current);
    if (el) {
      el.scrollTop = el.scrollHeight;
      prevScrollHeightRef.current = el.scrollHeight;
    } else {
      prevScrollHeightRef.current = 0;
    }
  }, []);

  return { chatFlowRef, showScrollToBottom, scrollToBottom };
}
