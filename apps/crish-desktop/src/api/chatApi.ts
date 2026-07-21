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
import type { FileDiff, MessageToolApprovalMeta } from '../store/types';

import type { SessionMessage, SessionState } from '../store/layoutStore';
import {
  hydrateSessionsFromDisk,
  loadSessionBody,
  saveSessionBody,
} from './sessionPersistence';

export const fetchSessionsApi = async (): Promise<SessionState[]> => {
  const { sessions } = hydrateSessionsFromDisk();
  return sessions;
};

export const saveMessageToDb = (
  sessionId: string,
  message: SessionMessage
): void => {
  if (!sessionId) return;
  const current = loadSessionBody(sessionId);
  const existingIdx = current.findIndex((m) => m.id === message.id);
  let updated: SessionMessage[];
  if (existingIdx >= 0) {
    updated = [...current];
    updated[existingIdx] = message;
  } else {
    updated = [...current, message];
  }
  saveSessionBody(sessionId, updated);
};

export const withdrawMessageFromDb = (
  sessionId: string,
  messageId: string
): void => {
  if (!sessionId || !messageId) return;
  const current = loadSessionBody(sessionId);
  const idx = current.findIndex((m) => m.id === messageId);
  if (idx !== -1) {
    const updated = current.slice(0, idx);
    saveSessionBody(sessionId, updated);
  }
};

/** OpenAI-style multimodal content part (user turn) */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
      /** 展示名，便于调试 / 未来引擎侧落盘 */
      name?: string;
      mime?: string;
    };

/** 轻量附件元数据（不重复塞 dataUrl） */
export type StreamAttachmentMeta = {
  name: string;
  mime?: string;
  kind: 'image' | 'text' | 'file';
};

/**
 * 流式请求扩展：结构化图片 / 附件元数据。
 * 文本协议仍用 prompt；有 hasImages 时同时下发 content，供引擎视觉通路使用。
 * Goal 字段透传到 run-task（mode/visibleGoal/maxRounds/maxStalledRounds），触发引擎 driveGoalRun。
 */
export type StreamRequestOptions = {
  content?: ChatContentPart[];
  hasImages?: boolean;
  attachments?: StreamAttachmentMeta[];
  systemPrompt?: string;
  tools?: Array<{
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
  }>;
  messages?: Array<{
    role: string;
    content: string | ChatContentPart[];
    reasoning_content?: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }>;
  /** 关流超时（毫秒），用于等待 inflight approval 结束后自动关流。默认 8000ms。 */
  finishTimeoutMs?: number;
  /**
   * run-task mode（如 `goal`）。与 permissionMode 不同：此处走引擎编排模式。
   * `/goal` 或 session.goalMode.active 时应为 `goal`。
   */
  mode?: string;
  /** 引擎可见目标文案（driveGoalRun visibleGoal） */
  visibleGoal?: string;
  /** 引擎 goal 最大轮数（默认与引擎 DEFAULT_GOAL_MAX_ROUNDS=12 对齐） */
  maxRounds?: number;
  /** 引擎 stall 上限（默认 2） */
  maxStalledRounds?: number;
};

export interface StreamCallbacks {
  onThought: (thought: string) => void;
  onToolStart: (
    toolId: string,
    name: string,
    args: string,
    explanation: string
  ) => void;
  onToolSuccess: (toolId: string, output: string, diffs?: FileDiff[]) => void;
  onToolError: (toolId: string, error: string) => void;
  onChunk: (chunk: string) => void;
  onComplete: () => void;
  /**
   * 运行级错误（网络/配置/中断等）。禁止写入助手正文，由 UI toast 展示。
   */
  /** kind=分类；detail=诊断第二行（控制台/横幅） */
  onRunError?: (message: string, kind?: string, detail?: string) => void;
  onToolPendingApproval?: (
    toolId: string,
    name: string,
    args: string,
    explanation: string,
    approvalMeta?: MessageToolApprovalMeta
  ) => void;
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
    status: 'completed' | 'failed' | 'stopped';
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
  assistantMsgId?: string,
  options?: StreamRequestOptions
) => {
  if (!shouldUseMockStream(prompt)) {
    const sid = sessionId || `sess-${Date.now()}`;
    const aid = assistantMsgId || `asst-${Date.now()}`;
    // Prefer real backend for desktop product path
    void getDesktopDaemonClient();
    return streamViaDaemon(prompt, callbacks, sid, aid, options);
  }
  return streamMockAssistantResponse(
    prompt,
    callbacks,
    sessionId,
    assistantMsgId,
    options
  );
};
