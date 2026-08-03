/**
 * 解析 Claude Code 会话 JSONL 为规范化 turns（纯函数，无 FS、不记录消息正文）。
 *
 * 格式参考：reference/claudeCode/utils/sessionStorage*.ts、types/logs.ts
 * 本文件由宿主 apps/crish-desktop/src/api/import/parseClaudeCodeJsonl.ts 迁入，
 * 输出与迁移前实现保持字节级一致（fixture 复用既有测试数据）。
 */

import type { NormalizedImportTurn, ParsedExternalConversation } from '../types';

export type ParseClaudeCodeOptions = {
  /** 来源会话 id 兜底（文件名主干）。 */
  sourceSessionId?: string;
  /** 最大处理行数（默认不限）。 */
  maxLines?: number;
};

type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
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

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    const block = asRecord(b);
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function contentToThinking(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const b of content) {
    const block = asRecord(b);
    if (!block) continue;
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      parts.push(block.thinking);
    }
  }
  return parts.length ? parts.join('\n') : undefined;
}

function extractToolUses(content: unknown): NonNullable<NormalizedImportTurn['toolCalls']> {
  if (!Array.isArray(content)) return [];
  const out: NonNullable<NormalizedImportTurn['toolCalls']> = [];
  for (const b of content) {
    const block = b as ContentBlock;
    if (block?.type !== 'tool_use') continue;
    const id = typeof block.id === 'string' ? block.id : `tool-${out.length}`;
    const name = typeof block.name === 'string' ? block.name : 'unknown';
    let args: string | undefined;
    if (block.input != null) {
      try {
        args = typeof block.input === 'string' ? block.input : JSON.stringify(block.input);
      } catch {
        args = String(block.input);
      }
    }
    out.push({ id, name, arguments: args, status: 'running' });
  }
  return out;
}

function extractToolResults(
  content: unknown,
): Array<{ id: string; output: string; isError: boolean }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; output: string; isError: boolean }> = [];
  for (const b of content) {
    const block = b as ContentBlock;
    if (block?.type !== 'tool_result') continue;
    const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
    if (!id) continue;
    let output = '';
    if (typeof block.content === 'string') output = block.content;
    else if (Array.isArray(block.content)) output = contentToText(block.content);
    else if (block.content != null) {
      try {
        output = JSON.stringify(block.content);
      } catch {
        output = String(block.content);
      }
    }
    out.push({ id, output, isError: Boolean(block.is_error) });
  }
  return out;
}

function isToolResultOnlyUser(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((b) => asRecord(b)?.type === 'tool_result');
}

/**
 * 解析整份 Claude Code 会话文件内容。
 */
export function parseClaudeCodeJsonl(
  content: string,
  options: ParseClaudeCodeOptions = {},
): ParsedExternalConversation {
  const warnings: string[] = [];
  const turns: NormalizedImportTurn[] = [];
  // 待挂载的工具输出（按 tool_use id 索引），就近挂到最近 assistant 或合成轮。
  const pendingResults = new Map<string, { output: string; isError: boolean }>();
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let summary: string | undefined;
  let lastPrompt: string | undefined;
  let cwd: string | undefined;
  let sessionId = options.sourceSessionId ?? '';
  let createdAtMs: number | undefined;
  let lineCount = 0;
  let skippedLineCount = 0;
  const maxLines = options.maxLines ?? Number.POSITIVE_INFINITY;

  // 仍有打开工具调用的 assistant 轮索引
  const openToolAssistants: number[] = [];

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

    const type = typeof row.type === 'string' ? row.type : '';

    if (type === 'custom-title' && typeof row.customTitle === 'string') {
      customTitle = row.customTitle;
      continue;
    }
    if (type === 'ai-title' && typeof row.aiTitle === 'string') {
      aiTitle = row.aiTitle;
      continue;
    }
    if (type === 'summary' && typeof row.summary === 'string') {
      summary = row.summary;
      continue;
    }
    if (type === 'last-prompt' && typeof row.lastPrompt === 'string') {
      lastPrompt = row.lastPrompt;
      continue;
    }

    // 仅元数据 / 非会话行
    if (
      type === 'file-history-snapshot' ||
      type === 'attachment' ||
      type === 'progress' ||
      type === 'tag' ||
      type === 'agent-name' ||
      type === 'agent-color' ||
      type === 'pr-link' ||
      type === 'mode' ||
      type === 'worktree-state' ||
      type === 'content-replacement' ||
      type === 'queue-operation' ||
      type === 'system'
    ) {
      skippedLineCount++;
      continue;
    }

    if (type !== 'user' && type !== 'assistant') {
      skippedLineCount++;
      continue;
    }

    if (row.isSidechain === true) {
      skippedLineCount++;
      continue;
    }

    if (!cwd && typeof row.cwd === 'string') cwd = row.cwd;
    if (!sessionId && typeof row.sessionId === 'string') sessionId = row.sessionId;

    const ts = parseTs(row.timestamp);
    if (createdAtMs == null && ts > 0) createdAtMs = ts;

    const message = asRecord(row.message);
    if (!message) {
      skippedLineCount++;
      continue;
    }
    const contentField = message.content;
    const uuid = typeof row.uuid === 'string' ? row.uuid : `cc-${lineCount}`;

    if (type === 'user') {
      // 工具结果 → 挂到先前 assistant 的 toolCalls
      if (isToolResultOnlyUser(contentField)) {
        const results = extractToolResults(contentField);
        for (const r of results) {
          pendingResults.set(r.id, { output: r.output, isError: r.isError });
          // 从最新开始尝试挂载
          for (let i = openToolAssistants.length - 1; i >= 0; i--) {
            const turn = turns[openToolAssistants[i]!];
            if (!turn?.toolCalls) continue;
            const tc = turn.toolCalls.find((t) => t.id === r.id);
            if (tc) {
              tc.output = r.output;
              tc.isError = r.isError;
              tc.status = r.isError ? 'error' : 'success';
              break;
            }
          }
        }
        continue;
      }

      const text = contentToText(contentField);
      // 纯字符串 content 已覆盖
      if (!text.trim()) {
        // 可能混合 tool_result + text —— 先挂结果再保留文本
        const results = extractToolResults(contentField);
        for (const r of results) {
          pendingResults.set(r.id, { output: r.output, isError: r.isError });
        }
        if (!text.trim() && results.length) continue;
      }
      if (!text.trim()) {
        skippedLineCount++;
        continue;
      }
      if (!lastPrompt) lastPrompt = text.trim().slice(0, 200);
      turns.push({
        id: uuid,
        role: 'user',
        text,
        timestampMs: ts || Date.now(),
      });
      continue;
    }

    // assistant
    const text = contentToText(contentField);
    const thinking = contentToThinking(contentField);
    const toolCalls = extractToolUses(contentField);
    for (const tc of toolCalls) {
      const pending = pendingResults.get(tc.id);
      if (pending) {
        tc.output = pending.output;
        tc.isError = pending.isError;
        tc.status = pending.isError ? 'error' : 'success';
        pendingResults.delete(tc.id);
      }
    }
    if (!text.trim() && !thinking && toolCalls.length === 0) {
      skippedLineCount++;
      continue;
    }
    const turn: NormalizedImportTurn = {
      id: uuid,
      role: 'assistant',
      timestampMs: ts || Date.now(),
      ...(text.trim() ? { text } : {}),
      ...(thinking ? { thinking } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
    turns.push(turn);
    if (toolCalls.some((t) => t.status === 'running')) {
      openToolAssistants.push(turns.length - 1);
    }
  }

  // 应用剩余待挂载结果
  for (const [id, r] of pendingResults) {
    for (let i = turns.length - 1; i >= 0; i--) {
      const tc = turns[i]?.toolCalls?.find((t) => t.id === id);
      if (tc) {
        tc.output = r.output;
        tc.isError = r.isError;
        tc.status = r.isError ? 'error' : 'success';
        break;
      }
    }
  }

  const title = customTitle || aiTitle || summary || lastPrompt;

  return {
    source: 'claude-code' as const,
    sourceSessionId: sessionId || options.sourceSessionId || 'unknown',
    ...(title ? { title } : {}),
    ...(cwd ? { cwd } : {}),
    ...(createdAtMs != null ? { createdAtMs } : {}),
    turns,
    warnings,
    lineCount,
    skippedLineCount,
  };
}
