/**
 * 审批裁决的 runId 解析（批 C 第 0 件，2026-11-03）。
 *
 * Rust 命令 `core_approve_tool` / `core_deny_tool` 的 `run_id` 为必填
 * 参数：挂起项登记在**发起申请的 run** 的审批闸门下，裁决必须带回
 * 同一个 runId 才能命中。此前各调用面只传 toolCallId，invoke 在
 * Tauri 参数层即被拒绝（见 ApprovalHandler.ts 文件内契约注记）。
 *
 * 解析顺序（先具体、后兜底）：
 * 1. 工具调用自带的申请人快照 `approvalMeta.requester.runId`
 *    ——子 agent 发起的审批（R7 归属透传）以此为准，主会话镜像面
 *    与子 agent 面板面共用同一口径；
 * 2. 调用方显式给出的 agent run（`agentRunId`，即
 *    `SessionAgent.subagentRunId`）——面板面工具调用未带归属
 *    快照时的归属来源；
 * 3. 会话当前活动 run（`sessionStreams` 注册表，onRunMeta 回填）
 *    ——主 agent 审批的常态来源（run 阻塞在审批上时流必在册）；
 * 4. 会话最近一轮 run（`SessionState.engineLastRunId`）——流注册
 *    已释放时的最后兜底。
 *
 * 全部落空返回空串：engineApproveTool / engineDenyTool 会显式抛错，
 * 调用方按既有失败回滚 + toast 收口，绝不发出必死的无 runId 请求。
 */
import { getSessionById } from '../../store/storeAccess';
import { sessionStreams } from '../sessionStreamManager';
import type { MessageToolCall } from '../../store/types';

export interface ApprovalRunIdSource {
  /** 审批所属会话（主会话；子 agent 审批传其父会话） */
  sessionId: string;
  /** 待裁决的工具调用（取其申请人归属快照，可缺省） */
  toolCall?: Pick<MessageToolCall, 'approvalMeta'> | null;
  /** 子 agent 面板面：该 agent 的 subagentRunId（可缺省） */
  agentRunId?: string | null;
}

export function resolveApprovalRunId(source: ApprovalRunIdSource): string {
  const requesterRunId = (
    source.toolCall?.approvalMeta?.requester?.runId ?? ''
  ).trim();
  if (requesterRunId) return requesterRunId;

  const agentRunId = (source.agentRunId ?? '').trim();
  if (agentRunId) return agentRunId;

  const sessionId = (source.sessionId ?? '').trim();
  if (!sessionId) return '';

  const streamRunId = (sessionStreams.get(sessionId)?.runId ?? '').trim();
  if (streamRunId) return streamRunId;

  return (getSessionById(sessionId)?.engineLastRunId ?? '').trim();
}
