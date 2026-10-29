import { useEffect, useRef } from 'react';
import { useSessionStore } from '../../store/sessionStore';
import { useTerminalStore } from '../../store/terminalStore';
import { getTransport } from '../../api/transport';
import { clearNetworkFailedRuntimeStatuses } from '../../store/sessionRuntimeStatusStore';
import type { UseChatStreamOptions, UseChatStreamResult } from './types';
import { useStreamBatchers } from './useStreamBatchers';
import { useStreamCallbacks } from './useStreamCallbacks';
import { useSlashSend } from './useSlashSend';
import { useScopedSessionId } from '../../contexts/LeafScopeContext';
import { sessionStreams } from '../../api/sessionStreamManager';

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

  const {
    runStreamingAssistant,
    handleStopGeneration,
    handleForceCancelGeneration,
  } = useStreamCallbacks(optionsWithSession, refs, {
    wsId,
    setActiveDiffSource,
    upsertSessionAgent,
  });

  // goal 续写 / 排队 drain 的启动器：以本视图会话登记进 sessionStreams，卸载 / 切会话时解绑
  const runStreamingAssistantRef = useRef(runStreamingAssistant);
  useEffect(() => {
    runStreamingAssistantRef.current = runStreamingAssistant;
  });
  useEffect(() => {
    if (!scopedSessionId) return undefined;
    return sessionStreams.bindStarter(scopedSessionId, (sid, text, userMsgId) =>
      runStreamingAssistantRef.current(text, userMsgId, sid)
    );
  }, [scopedSessionId]);

  const { handleSendChat } = useSlashSend(
    optionsWithSession,
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
