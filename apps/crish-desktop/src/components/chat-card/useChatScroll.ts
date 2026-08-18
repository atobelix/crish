import { useChatScrollAnchor } from './ChatScrollAnchor';
import type { SessionMessage } from '../../store/types';

export interface UseChatScrollOptions {
  messages: SessionMessage[];
  isProcessing: boolean;
  activeSessionId: string | null;
  onOpenPathInFilesPanel: (path: string) => void;
}

export interface UseChatScrollResult {
  chatFlowRef: React.RefObject<HTMLDivElement>;
  showScrollToBottom: boolean;
  scrollToBottom: () => void;
}

export function useChatScroll({
  messages,
  isProcessing,
  activeSessionId,
  onOpenPathInFilesPanel,
}: UseChatScrollOptions): UseChatScrollResult {
  const { chatFlowRef, showScrollToBottom, scrollToBottom } =
    useChatScrollAnchor({
      messages,
      _isProcessing: isProcessing,
      activeSessionId,
      onOpenPathInFilesPanel,
    });

  return {
    chatFlowRef,
    showScrollToBottom,
    scrollToBottom,
  };
}
