import { useEffect } from 'react';
import { useSessionStore } from '../../store/sessionStore';
import { useTerminalStore } from '../../store/terminalStore';
import { getTransport } from '../../api/transport';
import { clearNetworkFailedRuntimeStatuses } from '../../store/sessionRuntimeStatusStore';
import type { UseChatStreamOptions, UseChatStreamResult } from './types';
import { useStreamBatchers } from './useStreamBatchers';
import { useStreamCallbacks } from './useStreamCallbacks';
import { useSlashSend } from './useSlashSend';
import { useScopedSessionId } from '../../contexts/LeafScopeContext';
import {
  registerSessionRenderBuffer,
  flushAndRemoveSessionRenderBuffer,
} from './sessionStreamManager';

export interface ScopedUseChatStreamOptions extends UseChatStreamOptions {
  sessionId?: string | null;
}

/**
 * 主对话流式门面（子窗口作用域增强版）。
 * 显式接收并使用分屏 scopedSessionId，不再隐式回退全局 activeSessionId。
 */
export function useChatStream(
  options: ScopedUseChatStreamOptions
): UseChatStreamResult {
  const scopedSessionId = useScopedSessionId(options.sessionId);
  const optionsWithSession: ScopedUseChatStreamOptions = {
    ...options,
    sessionId: scopedSessionId,
  };

  const refs = useStreamBatchers();
  const { renderBufferRef } = refs;

  const wsId = options.wsId;
  const setActiveDiffSource = useTerminalStore((s) => s.setActiveDiffSource);
  const upsertSessionAgent = useSessionStore((s) => s.upsertSessionAgent);

  useEffect(() => {
    const transport = getTransport();
    const unsub = transport.onStatus((s) => {
      if (s === 'connected') clearNetworkFailedRuntimeStatuses();
    });
    return () => {
      unsub();
    };
  }, []);

  useEffect(() => {
    const renderBuffer = renderBufferRef.current;
    if (scopedSessionId && renderBuffer) {
      registerSessionRenderBuffer(scopedSessionId, renderBuffer);
    }
    return () => {
      if (scopedSessionId) {
        flushAndRemoveSessionRenderBuffer(scopedSessionId, renderBuffer);
      } else {
        renderBuffer?.stop();
      }
    };
  }, [scopedSessionId, renderBufferRef]);

  const {
    runStreamingAssistant,
    handleStopGeneration,
    handleForceCancelGeneration,
  } = useStreamCallbacks(optionsWithSession, refs, {
    wsId,
    setActiveDiffSource,
    upsertSessionAgent,
  });

  const { handleSendChat } = useSlashSend(
    optionsWithSession,
    refs,
    runStreamingAssistant
  );

  return {
    runStreamingAssistant,
    handleSendChat,
    handleStopGeneration,
    handleForceCancelGeneration,
  };
}

export { useSlashSend } from './useSlashSend';
export * from './slashSendDraftManager';
export * from './slashSendQueueHelper';
export * from './slashSendPreflight';
export type {
  ChatAttachment,
  QueuedMessage,
  UseChatStreamOptions,
  UseChatStreamResult,
  TerminalToolReason,
  TerminalToolPatch,
} from './types';
