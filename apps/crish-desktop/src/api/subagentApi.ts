/**
 * 协作 agent 客户端 API：steer 续聊、状态查询、独立 follow-up run。
 *
 * T03.7：send-to-subagent / get-subagent-status 为幽灵命令（Rust 侧无），
 * 显式不可用；协作运行本身经 streamViaEngine（core_run_task + 事件通道）。
 */

import type { StreamCallbacks } from './chatApi';
import { streamViaEngine } from './chatBridge';

export type CollaboratorMode = 'research' | 'implement' | 'verify';

/**
 * 向正在运行的子 agent run 注入消息。
 * T03.7：Rust 侧无 send-to-subagent，显式不可用（不静默降级）。
 */
export async function sendToSubagent(
  _subagentRunId: string,
  _message: string,
): Promise<{ ok: boolean; accepted?: boolean; error?: string }> {
  return { ok: false, error: '引擎不支持向子 agent 注入消息（send-to-subagent 不可用）' };
}

/**
 * 查询子 agent 运行状态。
 * T03.7：Rust 侧无 get-subagent-status，显式不可用（返回 null）。
 */
export async function getSubagentStatus(_subagentRunId: string): Promise<{
  status: string;
  progress?: string;
  latestError?: string;
} | null> {
  return null;
}

/**
 * 子 agent 已结束后的续聊 / 手动拉起协作者：独立 run-task，sessionId 用 agent 会话 id，
 * 事件写回 callbacks（由 UI 投影到 SessionAgent.messages）。
 */
export function streamCollaboratorRun(
  prompt: string,
  agentSessionId: string,
  callbacks: StreamCallbacks,
): () => void {
  return streamViaEngine(prompt, callbacks, agentSessionId, `agent-asst-${Date.now()}`);
}
