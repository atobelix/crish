/**
 * Progressive tool-args preview helpers (UI-only; never drives execution).
 *
 * Production path: session-loop emits `tool-update` with
 * `update.metadata.kind === 'tool-args-delta'`. Dedicated type names and
 * `tool-call phase=delta` remain as alternate/contract shapes.
 */

/** Compact mono preview char budget under the tool row. */
export const TOOL_ARGS_PREVIEW_MAX = 500;

/**
 * Truncate partial tool args for display. Code-point safe for CJK/emoji.
 * Empty/whitespace → empty string (caller decides whether to hide UI).
 */
export function truncateToolArgsPreview(
  text: string | null | undefined,
  max: number = TOOL_ARGS_PREVIEW_MAX,
): string {
  if (text == null) return '';
  const s = typeof text === 'string' ? text : String(text);
  if (!s) return '';
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : TOOL_ARGS_PREVIEW_MAX;
  // [...s] splits by code point so we do not cut mid-surrogate
  const chars = [...s];
  if (chars.length <= limit) return s;
  return chars.slice(0, limit).join('') + '…';
}

export type ToolArgsDeltaFields = {
  toolId: string;
  name: string;
  partialArgs: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Prefer first non-empty string; fall back to first string (may be empty). */
function pickString(...candidates: unknown[]): string {
  let firstString: string | undefined;
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    if (firstString === undefined) firstString = c;
    if (c.length > 0) return c;
  }
  return firstString ?? '';
}

/**
 * Session-loop production shape (agent-session-loop onToolArgsDelta sink):
 * ```
 * {
 *   type: 'tool-update',
 *   toolCallId,
 *   update: {
 *     text: argumentsText,
 *     metadata: { kind: 'tool-args-delta', toolName, argumentsText }
 *   }
 * }
 * ```
 * Ordinary progress tool-updates (no args-delta kind) return null.
 */
function parseToolUpdateArgsDelta(
  event: Record<string, unknown>,
): ToolArgsDeltaFields | null {
  const update = isRecord(event.update) ? event.update : null;
  if (!update) return null;

  const metadata = isRecord(update.metadata) ? update.metadata : null;
  const json = isRecord(update.json) ? update.json : null;
  const kind = String(metadata?.kind ?? json?.kind ?? '')
    .trim()
    .toLowerCase();
  if (kind !== 'tool-args-delta' && kind !== 'tool_args_delta') {
    return null;
  }

  const toolId = pickString(
    event.toolCallId,
    event.tool_call_id,
    event.id,
    metadata?.toolCallId,
    json?.toolCallId,
  ).trim();
  if (!toolId) return null;

  // Prefer metadata argumentsText (cumulative partial JSON); fall back to update.text
  const partialArgs = pickString(
    metadata?.argumentsText,
    metadata?.partialArgs,
    metadata?.arguments_text,
    json?.argumentsText,
    json?.partialArgs,
    typeof update.text === 'string' ? update.text : undefined,
  );

  const name =
    pickString(
      metadata?.toolName,
      metadata?.tool_name,
      metadata?.name,
      json?.toolName,
      event.toolName,
      event.name,
    ).trim() || 'tool';

  return { toolId, name, partialArgs };
}

/**
 * Extract toolId / name / partialArgs from a daemon / runtime event payload.
 * Accepts production + alternate shapes:
 * - session-loop: `{ type: 'tool-update', toolCallId, update: { text, metadata: { kind: 'tool-args-delta', argumentsText, toolName } } }`
 * - dedicated: `{ type: 'tool-args-delta', toolCallId, name?, argumentsText|partialArgs|args }`
 * - contract: `{ type: 'tool-call', phase: 'delta', toolCall: { id, toolName, argumentsText } }`
 * - top-level call bag / nested `call` / `toolCall`
 * Returns null when no tool id can be resolved (cannot attach to a row),
 * or when tool-update is ordinary progress (not args-delta).
 */
export function parseToolArgsDeltaEvent(
  event: unknown,
): ToolArgsDeltaFields | null {
  if (!isRecord(event)) return null;

  const phase = String(event.phase ?? '').toLowerCase();
  const type = String(event.type ?? event.event ?? event.kind ?? '')
    .trim()
    .toLowerCase();

  // Production path from agent-session-loop (must not require fictional type names)
  if (type === 'tool-update' || type === 'tool_update') {
    return parseToolUpdateArgsDelta(event);
  }

  // Prefer nested toolCall / call bags when present
  const nested =
    (isRecord(event.toolCall) && event.toolCall) ||
    (isRecord(event.call) && event.call) ||
    null;

  const bag: Record<string, unknown> = nested ? { ...event, ...nested } : event;

  const toolId = pickString(
    bag.toolCallId,
    bag.tool_call_id,
    bag.id,
    bag.callId,
    event.toolCallId,
    event.tool_call_id,
    event.id,
  ).trim();
  if (!toolId) return null;

  // For generic tool events, only treat phase=delta / dedicated type as args stream
  const isDedicated =
    type === 'tool-args-delta' ||
    type === 'tool_args_delta' ||
    type === 'tool-call-delta' ||
    type === 'tool_call_delta';
  const isPhaseDelta =
    phase === 'delta' &&
    (type === 'tool-call' || type === 'tool_call' || type === 'tool' || type === '');
  if (!isDedicated && !isPhaseDelta && type !== '') {
    // Unknown type with id + args text still accepted if argumentsText/partialArgs present
    const hasArgsHint =
      typeof bag.argumentsText === 'string' ||
      typeof bag.partialArgs === 'string' ||
      typeof bag.arguments_text === 'string';
    if (!hasArgsHint) return null;
  }

  let partialArgs = '';
  if (typeof bag.argumentsText === 'string') partialArgs = bag.argumentsText;
  else if (typeof bag.partialArgs === 'string') partialArgs = bag.partialArgs;
  else if (typeof bag.arguments_text === 'string') partialArgs = bag.arguments_text;
  else if (typeof bag.args === 'string') partialArgs = bag.args;
  else if (typeof bag.arguments === 'string') partialArgs = bag.arguments;
  else if (bag.arguments != null && typeof bag.arguments === 'object') {
    try {
      partialArgs = JSON.stringify(bag.arguments);
    } catch {
      partialArgs = String(bag.arguments);
    }
  } else if (bag.input != null && typeof bag.input === 'object') {
    try {
      partialArgs = JSON.stringify(bag.input);
    } catch {
      partialArgs = String(bag.input);
    }
  }

  // Empty partial is still a valid signal (tool row exists, args not yet); keep it
  const name =
    pickString(bag.toolName, bag.tool_name, bag.name, event.toolName, event.name).trim() ||
    'tool';

  return { toolId, name, partialArgs };
}
