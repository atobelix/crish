import { useEffect } from 'react';
import { useSessionStore } from '../../store/sessionStore';
import { useTerminalStore } from '../../store/terminalStore';
import { getTransport } from '../../api/transport';
import { clearNetworkFailedRuntimeStatuses } from '../../store/sessionRuntimeStatusStore';
import type { UseChatStreamOptions, UseChatStreamResult } from './types';
import { useStreamBatchers } from './useStreamBatchers';
import { useStreamCallbacks } from './useStreamCallbacks';
import { useSlashSend } from './useSlashSend';

/**
 * 主对话流式门面（单轨收敛版）。
 *
 * 通知通道：全局浮层（toast，顶部居中）；会话运行状态：SessionRuntimeStatusStore
 * （按 sessionId 隔离，切会话即不再展示，原会话状态保留至其自愈/关闭）。
 * 旧 run-notice 横幅控制器（createRunNoticeController / RunNotice）已整体删除
 * （docs/chat-notice-convergence §2.0/§2.4）。
 */
export function useChatStream(
  options: UseChatStreamOptions
): UseChatStreamResult {
  const refs = useStreamBatchers();
  const { renderBufferRef } = refs;

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

  useEffect(() => {
    const renderBuffer = renderBufferRef.current;
    return () => {
      renderBuffer?.stop();
    };
  }, [renderBufferRef]);

  const {
    runStreamingAssistant,
    handleStopGeneration,
    handleForceCancelGeneration,
  } = useStreamCallbacks(options, refs, {
    wsId,
    setActiveDiffSource,
    upsertSessionAgent,
  });

  const { handleSendChat } = useSlashSend(options, refs, runStreamingAssistant);

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
