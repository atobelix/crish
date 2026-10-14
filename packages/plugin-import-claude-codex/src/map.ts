/**
 * 将规范化外部会话映射为中立会话导入载荷（SessionImportPayload）。
 * 纯函数——不写 store、不记录消息正文；宿主侧再做 draft → SessionMessage 适配。
 * 彻底剥离外部命令工具调用，仅保留用户提问、AI 思考链与回复正文。
 */

import type {
  ImportMessageDraft,
  MapToCrishSessionOptions,
  NormalizedImportTurn,
  ParsedExternalConversation,
  SessionImportPayload,
} from './types';
import {
  isPureBoilerplate,
  isSystemPromptOrAgentInstructions,
} from './boilerplate';

let idSeq = 0;

function defaultIdFactory(): string {
  idSeq += 1;
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `import-${Date.now()}-${idSeq}`;
}

/** 从 cwd 或项目路径取文件夹标签。 */
export function folderFromCwd(
  cwd: string | undefined,
  fallback = '导入会话'
): string {
  if (!cwd || !cwd.trim()) return fallback;
  const norm = cwd.replace(/[\\/]+$/, '');
  const base = norm.split(/[\\/]/).filter(Boolean).pop();
  return base && base.trim() ? base.trim() : fallback;
}

/** 标题兜底链：严格过滤系统提示词，提取第一条真实人类提问。 */
export function pickTitle(
  parsed: ParsedExternalConversation,
  override?: string,
  firstUserText?: string
): string {
  if (override && override.trim()) {
    const o = override.trim();
    if (!isSystemPromptOrAgentInstructions(o) && !isPureBoilerplate(o)) {
      return o.slice(0, 120);
    }
  }

  if (parsed.title && parsed.title.trim()) {
    const pt = parsed.title.trim();
    if (!isSystemPromptOrAgentInstructions(pt) && !isPureBoilerplate(pt)) {
      return pt.slice(0, 120);
    }
  }

  if (firstUserText && firstUserText.trim()) {
    const fut = firstUserText.replace(/\s+/g, ' ').trim();
    if (!isSystemPromptOrAgentInstructions(fut) && !isPureBoilerplate(fut)) {
      return fut.slice(0, 80);
    }
  }

  return parsed.source === 'claude-code'
    ? 'Claude Code 导入'
    : 'Codex CLI 导入';
}

function turnToImportMessage(
  turn: NormalizedImportTurn,
  idFactory: () => string
): ImportMessageDraft {
  const msg: ImportMessageDraft = {
    id: turn.id || idFactory(),
    role: turn.role,
    timestampMs: turn.timestampMs > 0 ? turn.timestampMs : Date.now(),
  };

  if (turn.text != null && turn.text !== '') msg.text = turn.text;
  if (turn.thinking) msg.thinking = turn.thinking;
  if (turn.images && turn.images.length > 0) msg.images = turn.images;

  // 裁决：彻底不导入外部工具调用，杜绝外部软件的私有命令污染 Crish 内部 Agent 上下文
  // 纯粹只保留 thought 与 text 区块
  const blocks: NonNullable<ImportMessageDraft['blocks']> = [];
  if (msg.thinking) {
    blocks.push({ type: 'thought', content: msg.thinking });
  }
  if (msg.text) {
    blocks.push({ type: 'text', content: msg.text });
  }
  if (blocks.length) msg.blocks = blocks;

  return msg;
}

/**
 * 将解析后的外部会话映射为可导入的中立会话载荷。
 */
export function mapToCrishSession(
  parsed: ParsedExternalConversation,
  options: MapToCrishSessionOptions
): SessionImportPayload {
  const idFactory = options.idFactory ?? defaultIdFactory;
  const sessionId = options.sessionId ?? idFactory();
  const firstUser = parsed.turns.find(
    (t) =>
      t.role === 'user' &&
      t.text?.trim() &&
      !isSystemPromptOrAgentInstructions(t.text) &&
      !isPureBoilerplate(t.text)
  );
  const title = pickTitle(parsed, options.title, firstUser?.text);
  const folder =
    options.folder?.trim() ||
    folderFromCwd(
      parsed.cwd,
      parsed.source === 'claude-code' ? 'Claude Code' : 'Codex'
    );

  const messages = parsed.turns.map((t) => turnToImportMessage(t, idFactory));
  const nowMs = options.nowMs ?? Date.now();
  const createdAtMs = parsed.createdAtMs;
  const timestamp = new Date(
    createdAtMs && createdAtMs > 0 ? createdAtMs : nowMs
  ).toISOString();

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
