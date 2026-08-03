/**
 * 将规范化外部会话映射为中立会话导入载荷（SessionImportPayload）。
 * 纯函数——不写 store、不记录消息正文；宿主侧再做 draft → SessionMessage 适配。
 * 由宿主 apps/crish-desktop/src/api/import/mapToCrishSession.ts 迁入，输出语义一致。
 */

import type {
  ImportMessageDraft,
  ImportToolCallDraft,
  MapToCrishSessionOptions,
  NormalizedImportTurn,
  ParsedExternalConversation,
  SessionImportPayload,
} from './types';

let idSeq = 0;

function defaultIdFactory(): string {
  idSeq += 1;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `import-${Date.now()}-${idSeq}`;
}

/** 从 cwd 或项目路径取文件夹标签。 */
export function folderFromCwd(cwd: string | undefined, fallback = '导入会话'): string {
  if (!cwd || !cwd.trim()) return fallback;
  const norm = cwd.replace(/[\\/]+$/, '');
  const base = norm.split(/[\\/]/).filter(Boolean).pop();
  return base && base.trim() ? base.trim() : fallback;
}

/** 标题兜底链。 */
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
): ImportToolCallDraft[] {
  return tools.map((t) => {
    const status: ImportToolCallDraft['status'] =
      t.status === 'error' || t.isError
        ? 'error'
        : t.status === 'running' && t.output == null
          ? 'success'
          : 'success';
    const tc: ImportToolCallDraft = {
      id: t.id,
      name: t.name,
      status,
    };
    if (t.arguments != null) tc.arguments = t.arguments;
    if (t.output != null) tc.output = t.output;
    return tc;
  });
}

function turnToImportMessage(
  turn: NormalizedImportTurn,
  idFactory: () => string,
): ImportMessageDraft {
  const msg: ImportMessageDraft = {
    id: turn.id || idFactory(),
    role: turn.role,
    timestampMs: turn.timestampMs > 0 ? turn.timestampMs : Date.now(),
  };
  if (turn.text != null && turn.text !== '') msg.text = turn.text;
  if (turn.thinking) msg.thinking = turn.thinking;
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    msg.toolCalls = mapToolCalls(turn.toolCalls);
    const blocks: NonNullable<ImportMessageDraft['blocks']> = [];
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
 * 将解析后的外部会话映射为可导入的中立会话载荷。
 */
export function mapToCrishSession(
  parsed: ParsedExternalConversation,
  options: MapToCrishSessionOptions,
): SessionImportPayload {
  const idFactory = options.idFactory ?? defaultIdFactory;
  const sessionId = options.sessionId ?? idFactory();
  const firstUser = parsed.turns.find((t) => t.role === 'user' && t.text?.trim());
  const title = pickTitle(parsed, options.title, firstUser?.text);
  const folder =
    options.folder?.trim() ||
    folderFromCwd(parsed.cwd, parsed.source === 'claude-code' ? 'Claude Code' : 'Codex');

  const messages = parsed.turns.map((t) => turnToImportMessage(t, idFactory));
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
