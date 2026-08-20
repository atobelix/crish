import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionMessage } from '../../store/types';

export interface UseChatScrollAnchorOptions {
  messages: SessionMessage[];
  _isProcessing: boolean;
  activeSessionId: string | null;
  onOpenPathInFilesPanel: (path: string) => void;
}

export function useChatScrollAnchor({
  messages,
  _isProcessing,
  activeSessionId,
  onOpenPathInFilesPanel,
}: UseChatScrollAnchorOptions) {
  const chatFlowRef = useRef<HTMLDivElement>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const scrollToBottom = useCallback(() => {
    const el = chatFlowRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setShowScrollToBottom(false);
  }, []);

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
