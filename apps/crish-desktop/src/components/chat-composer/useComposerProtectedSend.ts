import { useCallback } from 'react';
import type { ChatAttachment } from '../../hooks/useChatStream';

export interface UseComposerProtectedSendOptions {
  chatInput: string;
  setChatInput: (v: string) => void;
  attachments: ChatAttachment[];
  onSend: () => void;
}

/**
 * 草稿原子保护 hook：
 * 在前置校验失败或 IPC 发送未成功时，自动将已发送的内容原地回填至输入框
 */
export function useComposerProtectedSend({
  chatInput,
  setChatInput,
  attachments,
  onSend,
}: UseComposerProtectedSendOptions): () => Promise<void> {
  return useCallback(async () => {
    const rawInput = chatInput;
    if (!rawInput.trim() && attachments.length === 0) return;

    try {
      await Promise.resolve(onSend());
    } catch (err) {
      console.warn('[ChatComposer] send failed, restoring draft:', err);
      if (rawInput) {
        setChatInput(rawInput);
        try {
          const { getCompositionRoot } =
            await import('../../app/compositionRoot');
          const root = getCompositionRoot();
          const activeSessionId =
            root.session.getActiveSessionId?.() ??
            root.session.getState().activeSessionId;
          if (activeSessionId) {
            root.session.getState().setComposerDraft(activeSessionId, rawInput);
          }
        } catch {
          /* swallow-ok: 草稿持久化失败不阻断回填 */
        }
      }
    }
  }, [attachments.length, chatInput, onSend, setChatInput]);
}
