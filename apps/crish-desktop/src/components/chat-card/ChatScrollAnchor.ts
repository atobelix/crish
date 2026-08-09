import { useEffect } from 'react';
import type { SessionMessage } from '../../store/types';
import { useChatAutoScroll } from '../../hooks/useChatAutoScroll';

export interface UseChatScrollAnchorOptions {
  messages: SessionMessage[];
  isProcessing: boolean;
  activeSessionId: string | null;
  onOpenPathInFilesPanel: (path: string) => void;
}

export function useChatScrollAnchor({
  messages,
  isProcessing,
  activeSessionId,
  onOpenPathInFilesPanel,
}: UseChatScrollAnchorOptions) {
  const { chatFlowRef, showScrollToBottom, scrollToBottom } =
    useChatAutoScroll(messages, isProcessing);

  useEffect(() => {
    const root = chatFlowRef.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const btn = t?.closest?.('.md-path-link') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const path = btn.getAttribute('data-path') || btn.textContent || '';
      if (!path.trim()) return;
      onOpenPathInFilesPanel(path.trim());
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [messages.length, activeSessionId, chatFlowRef, onOpenPathInFilesPanel]);

  return {
    chatFlowRef,
    showScrollToBottom,
    scrollToBottom,
  };
}
