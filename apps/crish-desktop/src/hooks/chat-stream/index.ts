import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useLayoutStore } from '../../store/layoutStore';
import type { UseChatStreamOptions, UseChatStreamResult, RunNotice } from './types';
import { useStreamBatchers } from './useStreamBatchers';
import { useStreamCallbacks } from './useStreamCallbacks';
import { useSlashSend } from './useSlashSend';

export function useChatStream(
  options: UseChatStreamOptions
): UseChatStreamResult {
  const refs = useStreamBatchers();
  const { renderBufferRef } = refs;

  const wsId = options.wsId;
  const setActiveDiffSource = useLayoutStore((s) => s.setActiveDiffSource);
  const upsertSessionAgent = useLayoutStore((s) => s.upsertSessionAgent);

  const [runNotice, setRunNotice] = useState<RunNotice | null>(null);
  const runNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRunNoticeTimer = useCallback(() => {
    if (runNoticeTimerRef.current != null) {
      clearTimeout(runNoticeTimerRef.current);
      runNoticeTimerRef.current = null;
    }
  }, []);

  const dismissRunNotice = useCallback(() => {
    clearRunNoticeTimer();
    setRunNotice(null);
  }, [clearRunNoticeTimer]);

  const pushRunNotice = useCallback(
    (notice: RunNotice, ttlMs = 8000) => {
      clearRunNoticeTimer();
      setRunNotice(notice);
      const delay = Math.floor(Number(ttlMs));
      if (!Number.isFinite(delay) || delay <= 0) return;
      runNoticeTimerRef.current = setTimeout(() => {
        runNoticeTimerRef.current = null;
        setRunNotice(null);
      }, delay);
    },
    [clearRunNoticeTimer]
  );

  useEffect(() => {
    return () => {
      if (runNoticeTimerRef.current != null) {
        clearTimeout(runNoticeTimerRef.current);
      }
      renderBufferRef.current?.stop();
    };
  }, [clearRunNoticeTimer, renderBufferRef]);

  const { runStreamingAssistant, handleStopGeneration } = useStreamCallbacks(
    options,
    refs,
    { pushRunNotice, dismissRunNotice },
    { wsId, setActiveDiffSource: setActiveDiffSource as (source: any) => void, upsertSessionAgent },
  );

  const { handleSendChat } = useSlashSend(options, refs, runStreamingAssistant);

  const setRunNoticePublic: Dispatch<SetStateAction<RunNotice | null>> =
    useCallback(
      (action) => {
        setRunNotice((prev) => {
          const next = typeof action === 'function' ? action(prev) : action;
          if (next == null) clearRunNoticeTimer();
          return next;
        });
      },
      [clearRunNoticeTimer]
    );

  return {
    runNotice,
    setRunNotice: setRunNoticePublic,
    runStreamingAssistant,
    handleSendChat,
    handleStopGeneration,
  };
}
