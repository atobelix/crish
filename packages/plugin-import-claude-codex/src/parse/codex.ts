/**
 * 解析 OpenAI Codex CLI rollout JSONL 为规范化 turns（纯函数，无 FS、不记录消息正文）。
 * 严格过滤系统提示词、环境样板与本地 CLI 控制命令，彻底不导入外部工具调用，仅保留用户提问、AI 思考与回复正文。
 */

import type {
  ImportImageDraft,
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
  stringsFrom,
  takeImage,
  turnHasContent,
} from './turnBuild';
import { contentItemsToText } from './toolOutput';

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
  if (typeof iso !== 'string') return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function collectCodexImages(
  content: unknown,
  lineCount: number
): ImportImageDraft[] {
  if (!Array.isArray(content)) return [];
  const images: ImportImageDraft[] = [];
  for (let index = 0; index < content.length; index++) {
    const r = asRecord(content[index]);
    if (!r) continue;
    const type = typeof r.type === 'string' ? r.type : '';
    if (type === 'image' || type === 'input_image' || r.image_url || r.source) {
      const taken = takeImage(r, `codex-img-${lineCount}-${index}`);
      if (taken && 'image' in taken) images.push(taken.image);
    }
  }
  return images;
}

function reasoningToText(payload: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const seen = new Set<string>();

  const add = (raw: unknown) => {
    const s = stringsFrom(raw);
    if (s && !seen.has(s)) {
      seen.add(s);
      parts.push(s);
    }
  };

  add(payload.summary_text);
  add(payload.summary);
  add(payload.raw_content);
  add(payload.content);

  return parts.length ? parts.join('\n\n') : undefined;
}

function isDuplicateUserTurn(
  turns: NormalizedImportTurn[],
  text: string
): boolean {
  if (turns.length === 0) return false;
  const target = text.trim();
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (!t) continue;
    if (t.role === 'assistant') {
      if (t.text || t.thinking) {
        return false;
      }
      continue;
    }
    if (t.role === 'user') {
      return t.text?.trim() === target;
    }
  }
  return false;
}

/**
 * 解析 Codex rollout 文件内容。
 */
export function parseCodexRolloutJsonl(
  content: string,
  options: ParseCodexRolloutOptions = {}
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

  // 正在构建的 assistant 轮（合并连续的 assistant 片段）
  let currentAssistant: NormalizedImportTurn | null = null;

  const flushAssistant = () => {
    if (!currentAssistant) return;
    if (currentAssistant.text && isPureBoilerplate(currentAssistant.text)) {
      delete currentAssistant.text;
      if (currentAssistant.segments) {
        currentAssistant.segments = currentAssistant.segments.filter(
          (s) => s.kind !== 'text'
        );
      }
    }
    if (!turnHasContent(currentAssistant)) {
      currentAssistant = null;
      return;
    }
    turns.push(currentAssistant);
    currentAssistant = null;
  };

  const ensureAssistant = (
    ts: number,
    idHint: string
  ): NormalizedImportTurn => {
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
      const meta = asRecord(payload.meta) ?? payload;
      if (typeof meta.id === 'string' && !sourceSessionId)
        sourceSessionId = meta.id;
      const cwdVal = meta.cwd;
      if (typeof cwdVal === 'string') cwd = cwdVal;
      skippedLineCount++; // meta 不是轮
      continue;
    }

    if (envType === 'event_msg') {
      const et = typeof payload.type === 'string' ? payload.type : '';
      if (et === 'item_completed') {
        const item = asRecord(payload.item);
        const itemType = item && typeof item.type === 'string' ? item.type : '';
        if (item && itemType === 'Reasoning') {
          const parts: string[] = [];
          const s = stringsFrom(item.summary_text);
          if (s) parts.push(s);
          const r = stringsFrom(item.raw_content);
          if (r && r !== s) parts.push(r);
          const c = stringsFrom(item.content);
          if (c && c !== s && c !== r) parts.push(c);
          const thought = parts.join('\n\n');
          if (thought) {
            pushThinking(
              ensureAssistant(ts, `codex-reason-${lineCount}`),
              thought
            );
            continue;
          }
        } else if (
          item &&
          itemType === 'Plan' &&
          typeof item.text === 'string'
        ) {
          const planText = stripBoilerplate(item.text);
          if (planText.trim() && !isPureBoilerplate(planText)) {
            pushText(ensureAssistant(ts, `codex-plan-${lineCount}`), planText);
            continue;
          }
        } else if (item && itemType === 'AgentMessage') {
          const rawAgentText = contentItemsToText(item.content, [
            'text',
            'output_text',
            'input_text',
          ]);
          const agentText = stripBoilerplate(rawAgentText);
          if (agentText.trim() && !isPureBoilerplate(agentText)) {
            pushText(
              ensureAssistant(ts, `codex-agent-${lineCount}`),
              agentText
            );
            continue;
          }
        }
      }

      let userMsgText: string | undefined;

      if (et === 'user_message') {
        if (typeof payload.message === 'string') userMsgText = payload.message;
        else if (typeof payload.text === 'string') userMsgText = payload.text;
      } else if (et === 'item_completed') {
        const item = asRecord(payload.item);
        if (item) {
          const itemType = typeof item.type === 'string' ? item.type : '';
          const itemRole = typeof item.role === 'string' ? item.role : '';
          if (
            itemType === 'UserMessage' ||
            itemType === 'user_message' ||
            itemRole === 'user'
          ) {
            if (typeof item.message === 'string') userMsgText = item.message;
            else if (typeof item.text === 'string') userMsgText = item.text;
            else if (Array.isArray(item.content)) {
              userMsgText = contentItemsToText(item.content, [
                'input_text',
                'text',
              ]);
            }
          }
        }
      }

      if (userMsgText) {
        const cleaned = stripBoilerplate(userMsgText);
        if (
          cleaned.trim() &&
          !isMeaninglessNoise(cleaned) &&
          !isSystemPromptOrAgentInstructions(cleaned) &&
          !isPureBoilerplate(cleaned)
        ) {
          if (!title) title = cleaned.trim().slice(0, 200);
          if (!isDuplicateUserTurn(turns, cleaned)) {
            flushAssistant();
            turns.push({
              id: `codex-user-${lineCount}`,
              role: 'user',
              text: cleaned,
              timestampMs: ts || Date.now(),
            });
            continue;
          }
        }
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
        const rawText = contentItemsToText(payload.content, [
          'input_text',
          'text',
        ]);
        const text = stripBoilerplate(rawText);
        const images = collectCodexImages(payload.content, lineCount);
        const isNoise =
          !text.trim() ||
          isMeaninglessNoise(text) ||
          isSystemPromptOrAgentInstructions(text) ||
          isPureBoilerplate(text);

        if (isNoise && images.length === 0) {
          skippedLineCount++;
          continue;
        }

        if (!isNoise && !title) title = text.trim().slice(0, 200);
        if (!isNoise && isDuplicateUserTurn(turns, text)) {
          const last = turns[turns.length - 1];
          if (last && last.role === 'user') {
            for (const img of images) pushImage(last, img);
          }
          continue;
        }

        flushAssistant();
        const userTurn: NormalizedImportTurn = {
          id: `codex-user-${lineCount}`,
          role: 'user',
          timestampMs: ts || Date.now(),
        };
        if (!isNoise) pushText(userTurn, text);
        for (const img of images) pushImage(userTurn, img);
        turns.push(userTurn);
        continue;
      }

      if (role === 'assistant') {
        const rawText = contentItemsToText(payload.content, [
          'output_text',
          'text',
        ]);
        const text = stripBoilerplate(rawText);
        const images = collectCodexImages(payload.content, lineCount);
        const hasValidText = Boolean(text.trim() && !isPureBoilerplate(text));
        if (!hasValidText && images.length === 0) {
          skippedLineCount++;
          continue;
        }
        const a = ensureAssistant(ts, `codex-asst-${lineCount}`);
        if (hasValidText) pushText(a, text);
        for (const img of images) pushImage(a, img);
        continue;
      }

      if (role === 'system' || role === 'developer') {
        // 系统指令与开发者提示词严禁混入对话流
        skippedLineCount++;
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
      pushThinking(ensureAssistant(ts, `codex-reason-${lineCount}`), thinking);
      continue;
    }

    // 裁决：导入上下文时彻底不导入外部工具调用，杜绝外部软件的私有命令污染 Crish 内部 Agent 的上下文
    if (
      itemType === 'function_call' ||
      itemType === 'custom_tool_call' ||
      itemType === 'tool_search_call' ||
      itemType === 'function_call_output' ||
      itemType === 'custom_tool_call_output' ||
      itemType === 'tool_search_output' ||
      itemType === 'local_shell_call' ||
      itemType === 'local_shell_call_output' ||
      itemType === 'web_search_call' ||
      itemType === 'web_search_call_output' ||
      itemType === 'image_generation_call'
    ) {
      skippedLineCount++;
      continue;
    }

    skippedLineCount++;
  }

  flushAssistant();

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
  if (
    !title ||
    isSystemPromptOrAgentInstructions(title) ||
    isPureBoilerplate(title)
  ) {
    const firstHumanUser = validTurns.find(
      (t) =>
        t.role === 'user' &&
        t.text &&
        !isSystemPromptOrAgentInstructions(t.text) &&
        !isPureBoilerplate(t.text)
    );
    if (firstHumanUser?.text) {
      title = firstHumanUser.text.trim().slice(0, 200);
    } else {
      title = undefined;
    }
  }

  return {
    source: 'codex' as const,
    sourceSessionId: sourceSessionId || options.sourceSessionId || 'unknown',
    ...(title ? { title } : {}),
    ...(cwd ? { cwd } : {}),
    ...(createdAtMs != null ? { createdAtMs } : {}),
    turns: validTurns,
    warnings,
    lineCount,
    skippedLineCount,
  };
}
