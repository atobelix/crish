/**
 * Chat streaming API surface.
 *
 * Production path: streamViaDaemon (daemon WebSocket).
 * Demo path: mock sessions + stream pipeline live in chatApi.demo.ts.
 */
import { streamViaDaemon } from './daemonChatBridge';
import { getDesktopDaemonClient } from './daemonClient';
import {
  shouldUseMockStream,
  streamMockAssistantResponse,
} from './chatApi.demo';

// Demo mock session DB helpers — stable public names re-exported from demo module
export {
  fetchSessionsApi,
  saveMessageToDb,
  withdrawMessageFromDb,
} from './chatApi.demo';

export interface StreamCallbacks {
  onThought: (thought: string) => void;
  onToolStart: (toolId: string, name: string, args: string, explanation: string) => void;
  onToolSuccess: (toolId: string, output: string, diffs?: any[]) => void;
  onToolError: (toolId: string, error: string) => void;
  onChunk: (chunk: string) => void;
  onComplete: () => void;
  /**
   * 运行级错误（网络/配置/中断等）。禁止写入助手正文，由 UI toast 展示。
   */
  onRunError?: (message: string, kind?: string) => void;
  onToolPendingApproval?: (toolId: string, name: string, args: string, explanation: string) => void;
  onTerminalLine?: (line: string) => void;
  /** H3：暴露 runId 以便拉取 snapshot usage */
  onRunMeta?: (meta: { runId: string }) => void;
  /** 审批结果（含完全访问自动放行） */
  onApprovalResolved?: (toolCallId: string, decision: 'allow' | 'deny') => void;
  /** 协作子 agent 生命周期（侧栏列表 / 面板） */
  onSubagentStarted?: (info: {
    subagentId: string;
    subagentRunId: string;
    parentRunId: string;
    parentToolCallId?: string;
    description: string;
    mode: string;
  }) => void;
  onSubagentEvent?: (info: {
    subagentId: string;
    subagentRunId: string;
    event: Record<string, unknown>;
  }) => void;
  onSubagentEnded?: (info: {
    subagentId: string;
    subagentRunId: string;
    status: 'completed' | 'failed';
    summary?: string;
  }) => void;
}

/**
 * Stream assistant response.
 * Prefer daemon WebSocket when available; mock only for demo commands or crish_use_mock=1.
 */
export const streamAssistantResponseApi = (
  prompt: string,
  callbacks: StreamCallbacks,
  sessionId?: string,
  assistantMsgId?: string
) => {
  if (!shouldUseMockStream(prompt)) {
    const sid = sessionId || `sess-${Date.now()}`;
    const aid = assistantMsgId || `asst-${Date.now()}`;
    // Prefer real backend for desktop product path
    void getDesktopDaemonClient();
    return streamViaDaemon(prompt, callbacks, sid, aid);
  }
  return streamMockAssistantResponse(prompt, callbacks, sessionId, assistantMsgId);
};
