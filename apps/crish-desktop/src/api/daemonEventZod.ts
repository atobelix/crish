/**
 * Zod-based daemon event validation for the desktop bridge.
 * Prefer these parsers; fall back to daemonEventSchema.ts light parsers if needed.
 *
 * Aligns with agent-runtime + daemon WS shapes:
 * - tool-start.call (ToolBatchCall): { id, toolName, summary, input }
 * - tool-end.result (ToolBatchResult): { id, toolName, output, isError }
 * - approval-requested nested: { request: { toolCallId, toolName, parameters, summary, metadata? } }
 * - approval-requested flat WS: { toolCallId, toolName, input, summary, risk?, metadata? }
 * - approval-resolved: decision string | PermissionDecision { behavior }
 * - run-terminal: { terminal, error? }
 *
 * ParseResult 收窄：与 daemonEventSchema 共用 isParseOk / isParseErr / parseOk / parseErr。
 */

import { z } from 'zod';
import {
  isParseErr,
  isParseOk,
  parseErr,
  parseOk,
  type ParseErr,
  type ParseOk,
  type ParseResult,
} from './daemonEventSchema';

export type { ParseErr, ParseOk, ParseResult };
export { isParseErr, isParseOk, parseErr, parseOk };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringifyUnknown(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Zod 首条 issue → 非空 error 文案（喂给 parseErr） */
function firstIssue(err: z.ZodError): string {
  const msg = err.issues[0]?.message ?? err.message;
  return typeof msg === 'string' && msg.trim() ? msg.trim() : 'zod parse failed';
}

/**
 * 将 ZodSafeParseResult 收成 ParseResult。
 * 成功/失败均走 parseOk/parseErr，保证 ok 字面量 + error 非空，调用方可 isParseOk 收窄。
 */
function fromZodSafeParse<T>(
  r: { success: true; data: T } | { success: false; error: z.ZodError },
): ParseResult<T> {
  if (r.success === true) return parseOk(r.data);
  return parseErr(firstIssue(r.error));
}

/**
 * Normalize tool args from protocol aliases.
 * ToolBatchCall uses `input`; PermissionRequest uses `parameters`;
 * some projections use arguments/args (string or object).
 */
function normalizeToolArgs(call: Record<string, unknown>): string {
  if (typeof call.arguments === 'string') return call.arguments;
  if (typeof call.args === 'string') return call.args;
  if (call.arguments != null) return stringifyUnknown(call.arguments);
  // Prefer parameters then input (both appear on approval / tool paths)
  for (const k of ['parameters', 'input', 'args'] as const) {
    const v = call[k];
    if (v == null) continue;
    if (typeof v === 'string') return v;
    return stringifyUnknown(v);
  }
  return '';
}

function extractResultPath(r: Record<string, unknown>): string | undefined {
  if (typeof r.path === 'string' && r.path.trim()) return r.path.trim();
  if (typeof r.filePath === 'string' && r.filePath.trim()) return r.filePath.trim();
  if (r.output && typeof r.output === 'object' && !Array.isArray(r.output)) {
    const o = r.output as Record<string, unknown>;
    if (typeof o.path === 'string' && o.path.trim()) return o.path.trim();
    if (typeof o.filePath === 'string' && o.filePath.trim()) return o.filePath.trim();
  }
  return undefined;
}

/** Envelope: at least a non-empty type string (aliases: event, kind). */
export const daemonEventEnvelopeSchema = z.custom<Record<string, unknown>>(isRecord, {
  message: 'daemon event is not an object',
}).transform((event, ctx) => {
  const type = String(event.type ?? event.event ?? event.kind ?? '').trim();
  if (!type) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'daemon event missing type' });
    return z.NEVER;
  }
  return { type, raw: event };
});

export type DaemonEventEnvelope = z.infer<typeof daemonEventEnvelopeSchema>;

/**
 * Tool-call fields: require id + name (aliases for both).
 * Optional arguments / input / args / parameters → normalized string `args`.
 */
export const toolCallSchema = z.custom<Record<string, unknown>>(isRecord, {
  message: 'tool-call payload is not an object',
}).transform((call, ctx) => {
  const id = String(call.id ?? call.toolCallId ?? call.tool_call_id ?? '').trim();
  const name = String(call.name ?? call.toolName ?? call.tool_name ?? '').trim();
  if (!id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tool-call missing id' });
    return z.NEVER;
  }
  if (!name) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tool-call missing name' });
    return z.NEVER;
  }

  const args = normalizeToolArgs(call);
  const explanation = String(
    call.explanation ?? call.description ?? call.summary ?? '',
  ).trim();

  return { id, name, args, explanation };
});

export type DaemonToolCallZod = z.infer<typeof toolCallSchema>;

/**
 * Tool-result basics: id, text, isError, optional path.
 * Lenient: missing id is empty string (bridge may still drop empty ids).
 */
export const toolResultSchema = z.unknown().transform((result) => {
  const r = isRecord(result) ? result : {};
  // Prefer toolCallId (batch result) then id; snake_case last
  const id = String(r.toolCallId ?? r.id ?? r.tool_call_id ?? '').trim();
  // isError flag, or truthy error field (string/object) marks failure
  const isError = Boolean(r.isError) || (r.error != null && r.error !== false);
  let text = '';
  if (typeof r.output === 'string') {
    text = r.output;
  } else if (r.output && typeof r.output === 'object' && !Array.isArray(r.output)) {
    const o = r.output as Record<string, unknown>;
    text = typeof o.text === 'string' ? o.text : stringifyUnknown(o);
  } else if (typeof r.text === 'string') {
    text = r.text;
  } else if (r.error != null && r.error !== false) {
    text = typeof r.error === 'string' ? r.error : stringifyUnknown(r.error);
  }
  const filePath = extractResultPath(r);
  return { id, text, isError, ...(filePath ? { filePath } : {}) };
});

export type DaemonToolResultZod = z.infer<typeof toolResultSchema>;

/**
 * Approval-requested payload (nested AgentEvent.request or flat daemon WS).
 * Runtime: parameters; daemon broadcast: input (same bag).
 */
export const approvalRequestSchema = z.custom<Record<string, unknown>>(isRecord, {
  message: 'approval request is not an object',
}).transform((raw, ctx) => {
  const req =
    raw.request && isRecord(raw.request) ? (raw.request as Record<string, unknown>) : raw;
  const toolCallId = String(req.toolCallId ?? req.id ?? req.requestId ?? '').trim();
  const toolName = String(req.toolName ?? req.name ?? '').trim();
  if (!toolCallId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'approval missing toolCallId' });
    return z.NEVER;
  }
  if (!toolName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'approval missing toolName' });
    return z.NEVER;
  }
  const explanation = String(
    req.summary ?? req.reason ?? req.message ?? toolName,
  ).trim();
  // Runtime PermissionRequest.parameters; daemon WS ApprovalRequestedMessage.input
  const parameters = isRecord(req.parameters)
    ? (req.parameters as Record<string, unknown>)
    : isRecord(req.input)
      ? (req.input as Record<string, unknown>)
      : undefined;
  // Keep raw + inject normalized parameters so extractApprovalCommandArgs sees both shapes
  const rawNorm: Record<string, unknown> = parameters
    ? { ...req, parameters, ...(isRecord(req.input) ? {} : { input: parameters }) }
    : { ...req };
  return {
    toolCallId,
    toolName,
    explanation,
    parameters,
    raw: rawNorm,
  };
});

export type DaemonApprovalRequestZod = z.infer<typeof approvalRequestSchema>;

/**
 * approval-resolved: daemon WS uses decision: approved|denied|expired;
 * nested AgentEvent uses PermissionDecision { behavior: allow|deny|ask }.
 */
export const approvalResolvedSchema = z.custom<Record<string, unknown>>(isRecord, {
  message: 'approval-resolved payload is not an object',
}).transform((event, ctx) => {
  const toolCallId = String(
    event.toolCallId ?? event.requestId ?? event.id ?? '',
  ).trim();
  if (!toolCallId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'approval-resolved missing toolCallId' });
    return z.NEVER;
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
  } else if (decision && isRecord(decision)) {
    const behavior = String(decision.behavior ?? '').trim().toLowerCase();
    if (behavior === 'allow') allowed = true;
    else if (behavior === 'deny' || behavior === 'ask') denied = true;
  }
  // Unknown / missing decision → treat as deny (never forge allow)
  if (!allowed && !denied) denied = true;
  return {
    toolCallId,
    allowed,
    denied,
    decision: allowed ? ('allow' as const) : ('deny' as const),
    raw: event,
  };
});

export type DaemonApprovalResolvedZod = z.infer<typeof approvalResolvedSchema>;

/** run-terminal / run-completed / run-failed terminal status. */
export const runTerminalSchema = z.custom<Record<string, unknown>>(isRecord, {
  message: 'run-terminal payload is not an object',
}).transform((event) => {
  const type = String(event.type ?? event.event ?? event.kind ?? '').trim();
  const terminal = String(event.terminal ?? '').trim().toLowerCase();
  const failed =
    type === 'run-failed' ||
    terminal === 'failed' ||
    terminal === 'error' ||
    terminal === 'cancelled' ||
    terminal === 'canceled';
  const error =
    event.error != null
      ? event.error
      : typeof event.message === 'string'
        ? event.message
        : undefined;
  return { type, terminal, failed, error, raw: event };
});

export type DaemonRunTerminalZod = z.infer<typeof runTerminalSchema>;

export function safeParseDaemonEvent(
  event: unknown,
): ParseResult<DaemonEventEnvelope> {
  return fromZodSafeParse(daemonEventEnvelopeSchema.safeParse(event));
}

export function safeParseToolCall(call: unknown): ParseResult<DaemonToolCallZod> {
  return fromZodSafeParse(toolCallSchema.safeParse(call));
}

export function safeParseToolResult(
  result: unknown,
): ParseResult<DaemonToolResultZod> {
  return fromZodSafeParse(toolResultSchema.safeParse(result));
}

export function safeParseApprovalRequest(
  event: unknown,
): ParseResult<DaemonApprovalRequestZod> {
  return fromZodSafeParse(approvalRequestSchema.safeParse(event));
}

export function safeParseApprovalResolved(
  event: unknown,
): ParseResult<DaemonApprovalResolvedZod> {
  return fromZodSafeParse(approvalResolvedSchema.safeParse(event));
}

export function safeParseRunTerminal(
  event: unknown,
): ParseResult<DaemonRunTerminalZod> {
  return fromZodSafeParse(runTerminalSchema.safeParse(event));
}
