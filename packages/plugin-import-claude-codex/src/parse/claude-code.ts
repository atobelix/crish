/**
 * 解析 Claude Code 会话 JSONL 为规范化 turns（纯函数，无 FS、不记录消息正文）。
 * 严格过滤系统提示词、环境样板与本地 CLI 控制命令，彻底不导入外部工具调用，仅保留用户提问、AI 思考与回复正文。
 */

import type {
  NormalizedImportTurn,
  ParsedExternalConversation,
} from '../types';
import {
  isMeaninglessNoise,
  isPureBoilerplate,
  isSystemPromptOrAgentInstructions,
  stripBoilerplate,
} from '../boilerplate';
import {
  pushImage,
  pushText,
  pushThinking,
  takeImage,
  turnHasContent,
} from './turnBuild';

export type ParseClaudeCodeOptions = {
  /** 来源会话 id 兜底（文件名主干）。 */
  sourceSessionId?: string;
  /** 最大处理行数（默认不限）。 */
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

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    const block = asRecord(b);
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string')
      parts.push(block.text);
  }
  return parts.join('\n');
}

/** 按内容块原文顺序写入同一条助手轮（思考 / 正文 / 图片；彻底跳过工具调用）。 */
function absorbAssistantContent(
  turn: NormalizedImportTurn,
  content: unknown,
  lineCount: number
): void {
  const visit = (block: Record<string, unknown>, index: number) => {
    const type = typeof block.type === 'string' ? block.type : '';
    if (type === 'thinking' && typeof block.thinking === 'string') {
      pushThinking(turn, block.thinking);
      return;
    }
    if (type === 'redacted_thinking') {
      pushThinking(turn, '思考内容未保留');
      return;
    }
    if (type === 'text' && typeof block.text === 'string') {
      const cleaned = stripBoilerplate(block.text);
      if (cleaned && !isPureBoilerplate(cleaned)) {
        pushText(turn, cleaned);
      }
      return;
    }
    if (type === 'tool_use' || type === 'tool_result') {
      // 裁决：导入上下文时彻底不导入外部工具调用，杜绝外部软件的私有命令污染 Crish 内部 Agent 的上下文
      return;
    }
    if (
      type === 'image' ||
      block.source != null ||
      typeof block.image_url === 'string'
    ) {
      const taken = takeImage(block, `cc-img-${lineCount}-${index}`);
      if (taken && 'image' in taken) pushImage(turn, taken.image);
      else if (taken && 'omitted' in taken)
        pushText(turn, '图片过大，预览未嵌入');
    }
  };

  if (typeof content === 'string') {
    const cleaned = stripBoilerplate(content);
    if (cleaned && !isPureBoilerplate(cleaned)) {
      pushText(turn, cleaned);
    }
  } else if (Array.isArray(content)) {
    content.forEach((b, index) => {
      const block = asRecord(b);
      if (block) visit(block, index);
    });
  }
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
  options: ParseClaudeCodeOptions = {}
): ParsedExternalConversation {
  const warnings: string[] = [];
  const turns: NormalizedImportTurn[] = [];
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

  let canMergeAssistant = false;

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
      if (!isSystemPromptOrAgentInstructions(row.customTitle)) {
        customTitle = row.customTitle;
      }
      continue;
    }
    if (type === 'ai-title' && typeof row.aiTitle === 'string') {
      if (!isSystemPromptOrAgentInstructions(row.aiTitle)) {
        aiTitle = row.aiTitle;
      }
      continue;
    }
    if (type === 'summary' && typeof row.summary === 'string') {
      if (!isSystemPromptOrAgentInstructions(row.summary)) {
        summary = row.summary;
      }
      continue;
    }
    if (type === 'last-prompt' && typeof row.lastPrompt === 'string') {
      if (!isSystemPromptOrAgentInstructions(row.lastPrompt)) {
        lastPrompt = row.lastPrompt;
      }
      continue;
    }

    // 仅元数据 / 系统行处理
    if (type === 'system') {
      const subtype = typeof row.subtype === 'string' ? row.subtype : '';
      if (subtype === 'local_command') {
        // 彻底过滤本地控制命令（如 /model 等），避免残留空白气泡
        skippedLineCount++;
        continue;
      }

      const visible = subtype === 'api_error' || subtype === 'informational';
      const sysText = typeof row.content === 'string' ? row.content.trim() : '';
      const cleanedSys = sysText ? stripBoilerplate(sysText) : '';

      if (visible && cleanedSys && !isPureBoilerplate(cleanedSys)) {
        const ts = parseTs(row.timestamp);
        const uuid =
          typeof row.uuid === 'string' ? row.uuid : `cc-sys-${lineCount}`;
        const prev = turns[turns.length - 1];
        const target: NormalizedImportTurn =
          prev && prev.role === 'assistant'
            ? prev
            : {
                id: uuid,
                role: 'assistant',
                timestampMs: ts || Date.now(),
              };
        pushText(target, cleanedSys);
        if (target !== prev) turns.push(target);
        canMergeAssistant = false;
        continue;
      }
      skippedLineCount++;
      continue;
    }

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
      type === 'queue-operation'
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
    if (!sessionId && typeof row.sessionId === 'string')
      sessionId = row.sessionId;

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
      canMergeAssistant = false;
      // 纯工具执行结果行不导入为用户提问
      if (isToolResultOnlyUser(contentField)) {
        skippedLineCount++;
        continue;
      }

      const rawUserText = contentToText(contentField);
      const cleaned = stripBoilerplate(rawUserText);
      const isNoise =
        !cleaned.trim() ||
        isMeaninglessNoise(cleaned) ||
        isSystemPromptOrAgentInstructions(cleaned) ||
        isPureBoilerplate(cleaned);

      const userTurn: NormalizedImportTurn = {
        id: uuid,
        role: 'user',
        timestampMs: ts || Date.now(),
      };
      if (!isNoise) pushText(userTurn, cleaned);

      if (Array.isArray(contentField)) {
        contentField.forEach((b, index) => {
          const block = asRecord(b);
          if (
            !block ||
            block.type === 'tool_result' ||
            block.type === 'tool_use'
          )
            return;
          if (block.type === 'image' || block.source != null) {
            const taken = takeImage(block, `cc-user-img-${lineCount}-${index}`);
            if (taken && 'image' in taken) pushImage(userTurn, taken.image);
            else if (taken && 'omitted' in taken)
              pushText(userTurn, '图片过大，预览未嵌入');
          }
        });
      }

      if (!turnHasContent(userTurn)) {
        skippedLineCount++;
        continue;
      }

      if (
        userTurn.text &&
        !lastPrompt &&
        !isSystemPromptOrAgentInstructions(userTurn.text)
      ) {
        lastPrompt = userTurn.text.trim().slice(0, 200);
      }
      turns.push(userTurn);
      continue;
    }

    // 同一用户回合内连续的助手行合并成一条，彻底排除外部工具调用
    const prev = turns[turns.length - 1];
    const canMerge = canMergeAssistant && prev?.role === 'assistant';
    const turn: NormalizedImportTurn = canMerge
      ? prev!
      : {
          id: uuid,
          role: 'assistant',
          timestampMs: ts || Date.now(),
        };

    absorbAssistantContent(turn, contentField, lineCount);

    if (turn.text && isPureBoilerplate(turn.text)) {
      delete turn.text;
      if (turn.segments) {
        turn.segments = turn.segments.filter((s) => s.kind !== 'text');
      }
    }

    if (!turnHasContent(turn)) {
      skippedLineCount++;
      continue;
    }

    if (turn !== prev) turns.push(turn);
    canMergeAssistant = true;
  }

  // 过滤空轮：纯保留有实质文本、思考或图片的轮次，彻底排除纯工具调用的无意义空白轮
  const validTurns = turns.filter((t) => {
    if (t.role === 'assistant' && t.text && isPureBoilerplate(t.text)) {
      delete t.text;
      if (t.segments) {
        t.segments = t.segments.filter((s) => s.kind !== 'text');
      }
    }
    return turnHasContent(t);
  });

  // 标题提取：若既有标题属于系统样板，跳过并提取第一条真实人类提问
  let titleCandidate = customTitle || aiTitle || summary;
  if (
    titleCandidate &&
    (isSystemPromptOrAgentInstructions(titleCandidate) ||
      isPureBoilerplate(titleCandidate))
  ) {
    titleCandidate = undefined;
  }

  if (!titleCandidate) {
    const firstHumanTurn = validTurns.find(
      (t) =>
        t.role === 'user' &&
        t.text &&
        !isSystemPromptOrAgentInstructions(t.text) &&
        !isPureBoilerplate(t.text)
    );
    if (firstHumanTurn?.text) {
      titleCandidate = firstHumanTurn.text.trim().slice(0, 200);
    } else if (lastPrompt && !isSystemPromptOrAgentInstructions(lastPrompt)) {
      titleCandidate = lastPrompt.trim().slice(0, 200);
    }
  }

  const title = titleCandidate;

  return {
    source: 'claude-code' as const,
    sourceSessionId: sessionId || options.sourceSessionId || 'unknown',
    ...(title ? { title } : {}),
    ...(cwd ? { cwd } : {}),
    ...(createdAtMs != null ? { createdAtMs } : {}),
    turns: validTurns,
    warnings,
    lineCount,
    skippedLineCount,
  };
}
