/**
 * Map normalized external conversation → Crish SessionMessage[] payload.
 * Pure function — no store mutation, no logging of bodies.
 */

import type { MessageToolCall, SessionMessage } from '../../store/types';
import type {
  ImportedCrishSession,
  MapToCrishSessionOptions,
  NormalizedImportTurn,
  ParsedExternalConversation,
} from './types';

let idSeq = 0;

function defaultIdFactory(): string {
  idSeq += 1;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `import-${Date.now()}-${idSeq}`;
}

/** Folder label from cwd or project path. */
export function folderFromCwd(cwd: string | undefined, fallback = '导入会话'): string {
  if (!cwd || !cwd.trim()) return fallback;
  const norm = cwd.replace(/[\\/]+$/, '');
  const base = norm.split(/[\\/]/).filter(Boolean).pop();
  return base && base.trim() ? base.trim() : fallback;
}

/** Title fallback chain. */
export function pickTitle(
  parsed: ParsedExternalConversation,
  override?: string,
  firstUserText?: string,
): string {
  if (override && override.trim()) return override.trim().slice(0, 120);
  if (parsed.title && parsed.title.trim()) return parsed.title.trim().slice(0, 120);
  if (firstUserText && firstUserText.trim()) {
    return firstUserText.replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  return parsed.source === 'claude-code' ? 'Claude Code 导入' : 'Codex CLI 导入';
}

function mapToolCalls(
  tools: NonNullable<NormalizedImportTurn['toolCalls']>,
): MessageToolCall[] {
  return tools.map((t) => {
    const status: MessageToolCall['status'] =
      t.status === 'error' || t.isError
        ? 'error'
        : t.status === 'running' && t.output == null
          ? 'success'
          : 'success';
    const tc: MessageToolCall = {
      id: t.id,
      name: t.name,
      status,
    };
    if (t.arguments != null) tc.arguments = t.arguments;
    if (t.output != null) tc.output = t.output;
    return tc;
  });
}

function turnToSessionMessage(
  turn: NormalizedImportTurn,
  idFactory: () => string,
): SessionMessage {
  const msg: SessionMessage = {
    id: turn.id || idFactory(),
    sender: turn.role,
    timestamp: turn.timestampMs > 0 ? turn.timestampMs : Date.now(),
    status: 'completed',
  };
  if (turn.text != null && turn.text !== '') msg.text = turn.text;
  if (turn.thinking) msg.thinking = turn.thinking;
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    msg.toolCalls = mapToolCalls(turn.toolCalls);
    const blocks: NonNullable<SessionMessage['blocks']> = [];
    if (msg.text) {
      blocks.push({ type: 'text', content: msg.text });
    }
    for (const tc of msg.toolCalls) {
      blocks.push({ type: 'tool_call', id: tc.id });
    }
    if (blocks.length) msg.blocks = blocks;
  }
  return msg;
}

/**
 * Map a parsed external conversation into an importable Crish session payload.
 */
export function mapToCrishSession(
  parsed: ParsedExternalConversation,
  options: MapToCrishSessionOptions,
): ImportedCrishSession {
  const idFactory = options.idFactory ?? defaultIdFactory;
  const sessionId = options.sessionId ?? idFactory();
  const firstUser = parsed.turns.find((t) => t.role === 'user' && t.text?.trim());
  const title = pickTitle(parsed, options.title, firstUser?.text);
  const folder =
    options.folder?.trim() ||
    folderFromCwd(parsed.cwd, parsed.source === 'claude-code' ? 'Claude Code' : 'Codex');

  const messages = parsed.turns.map((t) => turnToSessionMessage(t, idFactory));
  const nowMs = options.nowMs ?? Date.now();
  const createdAtMs = parsed.createdAtMs;
  const timestamp = new Date(createdAtMs && createdAtMs > 0 ? createdAtMs : nowMs).toISOString();

  const warnings = [...parsed.warnings];
  if (messages.length === 0) {
    warnings.push('No importable messages found in transcript');
  }

  return {
    source: parsed.source,
    sourcePath: options.sourcePath,
    sourceSessionId: parsed.sourceSessionId,
    sessionId,
    title,
    folder,
    timestamp,
    messages,
    ...(createdAtMs != null ? { createdAtMs } : {}),
    warnings,
  };
}
