import { getTransport } from '../transport';
import { parseErr, parseOk, type ParseResult } from '../engineEventSchema';

export type ApprovalResolvedFields = {
  toolCallId: string;
  denied: boolean;
  decision: 'allow' | 'deny';
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * approval-resolved：单一 ParseResult 路径，ok === false 判别。
 * 决策映射（P1 权限归一 D4：旧 PermissionDecision{behavior} 对象解析已删）：
 * - 字符串 approved/allow → 放行；denied/expired/deny → 拒绝；
 * - 非字符串 / 未知 / 缺失决策一律拒绝（绝不伪造放行）；
 * - 空 toolCallId 判失败。
 */
export function parseApprovalResolvedFields(
  event: unknown
): ParseResult<ApprovalResolvedFields> {
  if (!isRecord(event)) {
    return parseErr('approval-resolved payload is not an object');
  }
  const toolCallId = String(
    event.toolCallId ?? event.requestId ?? event.id ?? ''
  ).trim();
  if (!toolCallId) {
    return parseErr('approval-resolved missing toolCallId');
  }
  const decision = event.decision;
  let allowed = false;
  let denied = false;
  if (typeof decision === 'string') {
    const d = decision.trim().toLowerCase();
    if (d === 'approved' || d === 'allow') {
      allowed = true;
    } else if (d === 'denied' || d === 'expired' || d === 'deny') {
      denied = true;
    }
  }
  // Unknown / missing / object-shaped decision → treat as deny (never forge allow)
  if (!allowed && !denied) denied = true;
  return parseOk({
    toolCallId,
    denied,
    decision: allowed ? ('allow' as const) : ('deny' as const),
  });
}

/**
 * 批准工具：乐观 fire-and-forget，不阻塞 UI 8s。
 * IPC 通道：transport.send('core_approve_tool') 命令名直发（T18 后无 WS type 翻译）。
 * 引擎若队列无此项会静默忽略；状态以 approval-resolved / tool-end 为准。
 */
export async function engineApproveTool(
  toolCallId: string,
  scope?: string
): Promise<void> {
  await getTransport().send('core_approve_tool', {
    toolCallId,
    ...(scope ? { scope } : { scope: 'project' }),
  });
}

/** 拒绝工具：同样不阻塞 UI（transport.send('core_deny_tool') 命令名直发） */
export async function engineDenyTool(toolCallId: string): Promise<void> {
  await getTransport().send('core_deny_tool', { toolCallId });
}
