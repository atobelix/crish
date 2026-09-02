import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionStore } from '../../store/sessionStore';
import { COMPOSER_SEED_EVENT, takeComposerSeed } from '../../api/composerSeed';

export interface UseChatInputOptions {
  activeSessionId: string | null;
}

export interface UseChatInputResult {
  chatInput: string;
  setChatInput: (textOrFn: React.SetStateAction<string>) => void;
  isComposing: boolean;
  setIsComposing: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useChatInput({
  activeSessionId,
}: UseChatInputOptions): UseChatInputResult {
  const setComposerDraft = useSessionStore((s) => s.setComposerDraft);

  const [chatInput, setChatInputState] = useState('');
  const [isComposing, setIsComposing] = useState(false);

  const activeSessionIdRef = useRef(activeSessionId);
  const draftPersistTimerRef = useRef<number | null>(null);
  const pendingDraftRef = useRef<{ sid: string; text: string } | null>(null);

  const flushComposerDraft = useCallback(() => {
    if (draftPersistTimerRef.current != null) {
      window.clearTimeout(draftPersistTimerRef.current);
      draftPersistTimerRef.current = null;
    }
    const pending = pendingDraftRef.current;
    pendingDraftRef.current = null;
    if (pending) {
      setComposerDraft(pending.sid, pending.text);
    }
  }, [setComposerDraft]);

  const scheduleComposerDraft = useCallback(
    (sid: string, text: string) => {
      pendingDraftRef.current = { sid, text };
      if (draftPersistTimerRef.current != null) {
        window.clearTimeout(draftPersistTimerRef.current);
      }
      draftPersistTimerRef.current = window.setTimeout(() => {
        draftPersistTimerRef.current = null;
        const pending = pendingDraftRef.current;
        pendingDraftRef.current = null;
        if (pending) setComposerDraft(pending.sid, pending.text);
      }, 350);
    },
    [setComposerDraft]
  );

  useEffect(() => {
    flushComposerDraft();
    activeSessionIdRef.current = activeSessionId;
    const seed = takeComposerSeed();
    const restored = seed || (activeSessionId
      ? useSessionStore.getState().composerDrafts[activeSessionId] || ''
      : '');
    setChatInputState(restored);
  }, [activeSessionId, flushComposerDraft]);

  useEffect(() => {
    const onLeave = () => flushComposerDraft();
    window.addEventListener('beforeunload', onLeave);
    const onVis = () => {
      if (document.visibilityState === 'hidden') onLeave();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
      document.removeEventListener('visibilitychange', onVis);
      flushComposerDraft();
    };
  }, [flushComposerDraft]);

  const setChatInput = useCallback(
    (textOrFn: React.SetStateAction<string>) => {
      const sid = activeSessionIdRef.current;
      setChatInputState((prev) => {
        const next = typeof textOrFn === 'function' ? textOrFn(prev) : textOrFn;
        if (sid) {
          queueMicrotask(() => scheduleComposerDraft(sid, next));
        }
        return next;
      });
    },
    [scheduleComposerDraft]
  );

  useEffect(() => {
    const apply = (text: string) => {
      const t = text.trim();
      if (!t) return;
      setChatInput(t);
    };
    const seed = takeComposerSeed();
    if (seed) apply(seed);
    const onSeed = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string }>).detail;
      if (detail?.text) apply(detail.text);
    };
    window.addEventListener(COMPOSER_SEED_EVENT, onSeed);
    return () => window.removeEventListener(COMPOSER_SEED_EVENT, onSeed);
  }, [setChatInput]);

  return {
    chatInput,
    setChatInput,
    isComposing,
    setIsComposing,
  };
}
