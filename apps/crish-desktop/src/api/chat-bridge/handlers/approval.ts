import {
  parseErr,
  parseOk,
  type ParseResult,
} from '../../engineEventSchema';
import {
  safeParseApprovalResolved,
} from '../../engineEventZod';

export type ApprovalResolvedFields = {
  toolCallId: string;
  denied: boolean;
  decision: 'allow' | 'deny';
};

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
