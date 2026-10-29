// 会话内继续对话：发送 runTask（固定 sessionId），维护输入 / busy / 错误。
import { useCallback, useRef, useState } from 'react';
import { useConnectionStore } from '@/adapters/hooks/useAppStore';
import {
  getQuickRunContext,
  RUN_TASK_ERROR_INTERNAL,
  runTaskErrorTextOf,
  RunTaskCommandError,
} from '@/adapters/quickRunWiring';

export interface SessionComposerFeedback {
  kind: 'idle' | 'sending' | 'error' | 'success';
  message: string | null;
}

export interface SessionComposerVm {
  connected: boolean;
  prompt: string;
  busy: boolean;
  feedback: SessionComposerFeedback;
  canSubmit: boolean;
  setPrompt: (text: string) => void;
  submit: () => Promise<boolean>;
}

export function useSessionComposer(
  sessionId: string,
  onSent?: (prompt: string, runId: string) => void
): SessionComposerVm {
  const connected = useConnectionStore((s) => s.phase === 'ready');
  const [prompt, setPromptState] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<SessionComposerFeedback>({
    kind: 'idle',
    message: null,
  });
  const busyRef = useRef(false);

  const setPrompt = useCallback((text: string) => {
    setPromptState(text);
    setFeedback((current) =>
      current.kind === 'error' ? { kind: 'idle', message: null } : current
    );
  }, []);

  const submit = useCallback(async (): Promise<boolean> => {
    const text = prompt.trim();
    if (busyRef.current || !connected || text.length === 0) return false;
    const context = getQuickRunContext();
    if (!context) {
      setFeedback({
        kind: 'error',
        message: runTaskErrorTextOf('transport.closed'),
      });
      return false;
    }
    busyRef.current = true;
    setBusy(true);
    setFeedback({ kind: 'sending', message: null });
    try {
      const result = await context.repository.runTask({
        prompt: text,
        sessionId,
        permissionMode: 'ask',
      });
      setPromptState('');
      setFeedback({ kind: 'success', message: null });
      onSent?.(text, result.runId);
      return true;
    } catch (error) {
      const code =
        error instanceof RunTaskCommandError
          ? error.code
          : RUN_TASK_ERROR_INTERNAL;
      setFeedback({ kind: 'error', message: runTaskErrorTextOf(code) });
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [connected, onSent, prompt, sessionId]);

  return {
    connected,
    prompt,
    busy,
    feedback,
    canSubmit: connected && !busy && prompt.trim().length > 0,
    setPrompt,
    submit,
  };
}
