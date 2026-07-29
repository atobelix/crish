/**
 * Parse OpenAI Codex CLI rollout JSONL into normalized turns.
 * Pure function — no FS, no logging of message bodies.
 *
 * Format refs: reference/codex-cli/codex-rs/app-server/tests/common/rollout.rs
 *              protocol/src/models.rs (ResponseItem, ContentItem)
 */

import type { NormalizedImportTurn, ParsedExternalConversation } from './types';

export type ParseCodexRolloutOptions = {
  sourceSessionId?: string;
  maxLines?: number;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function parseTs(iso: unknown): number {
  if (typeof iso === 'string') {
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function contentItemsToText(content: unknown, kinds: string[]): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    const r = asRecord(item);
    if (!r) continue;
    const t = typeof r.type === 'string' ? r.type : '';
    if (!kinds.includes(t)) continue;
    if (typeof r.text === 'string') parts.push(r.text);
  }
  return parts.join('\n');
}

function reasoningToText(payload: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const summary = payload.summary;
  if (Array.isArray(summary)) {
    for (const s of summary) {
      const r = asRecord(s);
      if (r && typeof r.text === 'string') parts.push(r.text);
      else if (typeof s === 'string') parts.push(s);
    }
  }
  const content = payload.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      const r = asRecord(c);
      if (r && typeof r.text === 'string') parts.push(r.text);
    }
  }
  return parts.length ? parts.join('\n') : undefined;
}

function outputToString(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  // FunctionCallOutputPayload may be { content: string } or content_items
  const r = asRecord(output);
  if (r) {
    if (typeof r.content === 'string') return r.content;
    if (typeof r.body === 'string') return r.body;
    if (Array.isArray(r.content_items)) {
      return contentItemsToText(r.content_items, ['input_text', 'output_text', 'text']);
    }
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/**
 * Parse Codex rollout file content.
 */
export function parseCodexRolloutJsonl(
  content: string,
  options: ParseCodexRolloutOptions = {},
): ParsedExternalConversation {
  const warnings: string[] = [];
  const turns: NormalizedImportTurn[] = [];
  let sourceSessionId = options.sourceSessionId ?? '';
  let cwd: string | undefined;
  let title: string | undefined;
  let createdAtMs: number | undefined;
  let lineCount = 0;
  let skippedLineCount = 0;
  const maxLines = options.maxLines ?? Number.POSITIVE_INFINITY;

  // Current assistant turn being built (merge consecutive assistant pieces)
  let currentAssistant: NormalizedImportTurn | null = null;

  const flushAssistant = () => {
    if (!currentAssistant) return;
    // drop empty
    if (
      !currentAssistant.text?.trim() &&
      !currentAssistant.thinking &&
      !(currentAssistant.toolCalls && currentAssistant.toolCalls.length)
    ) {
      currentAssistant = null;
      return;
    }
    turns.push(currentAssistant);
    currentAssistant = null;
  };

  const ensureAssistant = (ts: number, idHint: string): NormalizedImportTurn => {
    if (!currentAssistant) {
      currentAssistant = {
        id: idHint,
        role: 'assistant',
        timestampMs: ts || Date.now(),
      };
    }
    return currentAssistant;
  };

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (lineCount >= maxLines) {
      warnings.push('maxLines reached; remaining lines skipped');
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    lineCount++;

    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      skippedLineCount++;
      continue;
    }

    const envType = typeof row.type === 'string' ? row.type : '';
    const ts = parseTs(row.timestamp);
    if (createdAtMs == null && ts > 0) createdAtMs = ts;
    const payload = asRecord(row.payload) ?? {};

    if (envType === 'session_meta') {
      // payload may be SessionMetaLine { meta, git } or flat meta
      const meta = asRecord(payload.meta) ?? payload;
      if (typeof meta.id === 'string' && !sourceSessionId) sourceSessionId = meta.id;
      const cwdVal = meta.cwd;
      if (typeof cwdVal === 'string') cwd = cwdVal;
      skippedLineCount++; // meta is not a turn
      continue;
    }

    if (envType === 'event_msg') {
      // optional first-user preview only; skip as turns (response_item is source of truth)
      const et = typeof payload.type === 'string' ? payload.type : '';
      if (et === 'user_message' && typeof payload.message === 'string' && !title) {
        title = payload.message.slice(0, 200);
      }
      skippedLineCount++;
      continue;
    }

    if (envType !== 'response_item') {
      skippedLineCount++;
      continue;
    }

    const itemType = typeof payload.type === 'string' ? payload.type : '';

    if (itemType === 'message') {
      const role = typeof payload.role === 'string' ? payload.role : '';
      if (role === 'user') {
        flushAssistant();
        const text = contentItemsToText(payload.content, ['input_text', 'text']);
        if (!text.trim()) {
          skippedLineCount++;
          continue;
        }
        if (!title) title = text.trim().slice(0, 200);
        turns.push({
          id: `codex-user-${lineCount}`,
          role: 'user',
          text,
          timestampMs: ts || Date.now(),
        });
        continue;
      }
      if (role === 'assistant' || role === 'system') {
        // system → treat as assistant commentary for import readability
        const text = contentItemsToText(payload.content, ['output_text', 'text']);
        if (!text.trim()) {
          skippedLineCount++;
          continue;
        }
        const a = ensureAssistant(ts, `codex-asst-${lineCount}`);
        a.text = a.text ? `${a.text}\n${text}` : text;
        continue;
      }
      skippedLineCount++;
      continue;
    }

    if (itemType === 'reasoning') {
      const thinking = reasoningToText(payload);
      if (!thinking) {
        skippedLineCount++;
        continue;
      }
      const a = ensureAssistant(ts, `codex-reason-${lineCount}`);
      a.thinking = a.thinking ? `${a.thinking}\n${thinking}` : thinking;
      continue;
    }

    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      const callId =
        (typeof payload.call_id === 'string' && payload.call_id) ||
        (typeof payload.id === 'string' && payload.id) ||
        `call-${lineCount}`;
      const name =
        (typeof payload.name === 'string' && payload.name) ||
        'tool';
      let args: string | undefined;
      if (typeof payload.arguments === 'string') args = payload.arguments;
      else if (typeof payload.input === 'string') args = payload.input;
      else if (payload.arguments != null) {
        try {
          args = JSON.stringify(payload.arguments);
        } catch {
          args = String(payload.arguments);
        }
      }
      const a = ensureAssistant(ts, `codex-asst-${lineCount}`);
      if (!a.toolCalls) a.toolCalls = [];
      a.toolCalls.push({
        id: callId,
        name,
        arguments: args,
        status: 'running',
      });
      continue;
    }

    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
      const output = outputToString(payload.output);
      const isError =
        payload.success === false ||
        (typeof payload.status === 'string' && payload.status === 'error');

      // Prefer current assistant buffer (local alias avoids odd CF narrowing to never)
      const openTools =
        currentAssistant == null
          ? undefined
          : (currentAssistant as NormalizedImportTurn).toolCalls;
      if (openTools && openTools.length > 0) {
        const tc = openTools.find((t) => t.id === callId);
        if (tc) {
          tc.output = output;
          tc.isError = isError;
          tc.status = isError ? 'error' : 'success';
          continue;
        }
      }
      // Search flushed turns
      for (let i = turns.length - 1; i >= 0; i--) {
        const tc = turns[i]?.toolCalls?.find((t) => t.id === callId);
        if (tc) {
          tc.output = output;
          tc.isError = isError;
          tc.status = isError ? 'error' : 'success';
          break;
        }
      }
      continue;
    }

    // local_shell_call, web_search_call, etc. — best-effort as tool
    if (
      itemType === 'local_shell_call' ||
      itemType === 'web_search_call' ||
      itemType === 'image_generation_call'
    ) {
      const callId =
        (typeof payload.call_id === 'string' && payload.call_id) ||
        (typeof payload.id === 'string' && payload.id) ||
        `shell-${lineCount}`;
      const a = ensureAssistant(ts, `codex-asst-${lineCount}`);
      if (!a.toolCalls) a.toolCalls = [];
      let args: string | undefined;
      if (payload.action != null) {
        try {
          args = JSON.stringify(payload.action);
        } catch {
          args = String(payload.action);
        }
      }
      a.toolCalls.push({
        id: callId,
        name: itemType,
        arguments: args,
        status:
          typeof payload.status === 'string' && payload.status === 'completed'
            ? 'success'
            : 'running',
      });
      continue;
    }

    skippedLineCount++;
  }

  flushAssistant();

  // Mark any still-running tools as success if no output (incomplete rollout)
  for (const t of turns) {
    if (!t.toolCalls) continue;
    for (const tc of t.toolCalls) {
      if (tc.status === 'running' && tc.output == null) {
        // leave as running → map layer will coerce to success with empty output
      }
    }
  }

  return {
    source: 'codex' as const,
    sourceSessionId: sourceSessionId || options.sourceSessionId || 'unknown',
    ...(title ? { title } : {}),
    ...(cwd ? { cwd } : {}),
    ...(createdAtMs != null ? { createdAtMs } : {}),
    turns,
    warnings,
    lineCount,
    skippedLineCount,
  };
}
