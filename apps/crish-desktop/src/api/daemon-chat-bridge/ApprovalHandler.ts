import { getDesktopDaemonClient } from '../daemonClient';
import { parseErr, parseOk, type ParseResult } from '../daemonEventSchema';
import { safeParseApprovalResolved } from '../daemonEventZod';

export type ApprovalResolvedFields = {
  toolCallId: string;
  denied: boolean;
  decision: 'allow' | 'deny';
};

/**
 * approval-resolved: single ParseResult path with `ok === false` discriminant.
 * Unknown/missing decision already mapped to deny by zod; empty toolCallId fails.
 */
export function parseApprovalResolvedFields(
  event: unknown
): ParseResult<ApprovalResolvedFields> {
  const resolved = safeParseApprovalResolved(event);
  if (resolved.ok === false) {
    return parseErr(resolved.error || 'approval-resolved parse failed');
  }
  const { toolCallId, denied, decision } = resolved.data;
  const id =
    typeof toolCallId === 'string'
      ? toolCallId.trim()
      : String(toolCallId ?? '').trim();
  if (!id) {
    return parseErr('approval-resolved empty toolCallId');
  }
  return parseOk({
    toolCallId: id,
    denied: Boolean(denied),
    decision: decision === 'allow' ? ('allow' as const) : ('deny' as const),
  });
}

/**
 * 批准工具：乐观 fire-and-forget，不阻塞 UI 8s。
 * 引擎若队列无此项会静默忽略；状态以 approval-resolved / tool-end 为准。
 */
export async function daemonApproveTool(
  toolCallId: string,
  scope?: string
): Promise<void> {
  const client = getDesktopDaemonClient();
  await client.send({
    type: 'approve-tool',
    toolCallId,
    ...(scope ? { scope } : { scope: 'project' }),
  });
}

/** 拒绝工具：同样不阻塞 UI */
export async function daemonDenyTool(toolCallId: string): Promise<void> {
  const client = getDesktopDaemonClient();
  await client.send({ type: 'deny-tool', toolCallId });
}
