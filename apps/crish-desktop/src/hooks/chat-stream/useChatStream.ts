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

/**
 * 主对话流式门面（ChatCard / Composer 唯一入口，唯一实现）。
 *
 * - 会话作用域：显式 `options.sessionId` → LeafScope → 全局活跃会话（useScopedSessionId）。
 * - 通知通道：全局 toast；会话运行状态：SessionRuntimeStatusStore（按 sessionId 隔离）。
 * - 与子 Agent 面板（hooks/useAgentStream.ts → useAgentPanel）互斥；协议终止统一经
 *   sessionStreams.cancel → compositionRoot.runControl。
 */
export function useChatStream(
  options: UseChatStreamOptions
): UseChatStreamResult {
  const scopedSessionId = useScopedSessionId(options.sessionId);
  const optionsWithSession: UseChatStreamOptions = {
    ...options,
    sessionId: scopedSessionId,
  };

  const refs = useStreamBatchers();

  const wsId = options.wsId;
  const setActiveDiffSource = useTerminalStore((s) => s.setActiveDiffSource);
  const upsertSessionAgent = useSessionStore((s) => s.upsertSessionAgent);

  // 「恢复即消失」：transport 恢复 → 所有会话的 network 类失败自动清空
  //（含非活跃会话，否则切回时残留过期红条）；其余终态错误保留至用户处理。
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
    handleSilentStopGeneration,
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
    handleSilentStopGeneration,
    handleForceCancelGeneration,
  };
}
