import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface UseChatAutoScrollResult {
  chatFlowRef: RefObject<HTMLDivElement | null>;
  showScrollToBottom: boolean;
  /** 用户点「回到最新」：恢复自动滚底并滚到末尾 */
  scrollToBottom: () => void;
}

/**
 * 对话流智能滚底：用户未上滑时跟随 messages 更新；上滑后显示 FAB。
 * chatFlowRef 挂在 .chat-doc-flow 上，供路径点击等共用。
 */
export function useChatAutoScroll(messages: unknown[]): UseChatAutoScrollResult {
  const chatFlowRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // Smart scroll: auto-scroll only when user hasn't manually scrolled up
  useEffect(() => {
    const el = chatFlowRef.current;
    if (!el || userScrolledRef.current) return;
    el.scrollTop = el.scrollHeight;
    setShowScrollToBottom(false);
  }, [messages]);

  // Detect user scroll-up to stop auto-scroll
  useEffect(() => {
    const el = chatFlowRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      if (atBottom) {
        userScrolledRef.current = false;
        setShowScrollToBottom(false);
      } else {
        userScrolledRef.current = true;
        setShowScrollToBottom(true);
      }
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToBottom = useCallback(() => {
    userScrolledRef.current = false;
    setShowScrollToBottom(false);
    if (chatFlowRef.current) {
      chatFlowRef.current.scrollTop = chatFlowRef.current.scrollHeight;
    }
  }, []);

  return { chatFlowRef, showScrollToBottom, scrollToBottom };
}
