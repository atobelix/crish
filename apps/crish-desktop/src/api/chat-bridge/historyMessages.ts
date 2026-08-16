/**
 * History messages builder & token budget truncation for engine runs.
 */
import type { SessionMessage } from '../../store/types';

/**
 * History message builder / token budget truncation 的引擎对话 wire 载荷类型。
 *
 * T3 单源化（D5）：`HistoryMessage` 是「从 SessionMessage 派生的 LLM 上下文载荷」，
 * 不是第 N 套消息类型。它只保留 wire 特有字段（snake_case
 * tool_calls_json / tool_call_results_json）+ SessionMessage 派生字段；
 * 不复制 SessionMessage 其余超集字段。type 定义唯一在本文件。
 */
export interface HistoryMessage extends SessionMessage {
  /** 工具调用 wire JSON 串（由 SessionMessage.toolCalls 序列化） */
  tool_calls_json?: string;
  /** 工具结果回执 wire JSON 串（由 SessionMessage.toolCallResults 序列化） */
  tool_call_results_json?: string;
}

export const HISTORY_TOKEN_BUDGET = 200_000;
export const HISTORY_MESSAGE_TOKEN_OVERHEAD = 8;

export function estimateTextTokens(text: string | undefined): number {
  if (!text || text.length === 0) return 0;
  let tokens = 0;
  let wordChars = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const isSep =
      code <= 0x20 ||
      (code >= 0x21 && code <= 0x2f) ||
      (code >= 0x3a && code <= 0x40) ||
      (code >= 0x5b && code <= 0x60) ||
      (code >= 0x7b && code <= 0x7e);
    if (code < 0x80) {
      if (isSep) {
        if (wordChars > 0) {
          tokens += Math.ceil(wordChars / 4);
          wordChars = 0;
        }
        tokens += 1;
      } else {
        wordChars += 1;
      }
    } else {
      if (wordChars > 0) {
        tokens += Math.ceil(wordChars / 4);
        wordChars = 0;
      }
      tokens += 1;
    }
  }
  if (wordChars > 0) tokens += Math.ceil(wordChars / 4);
  return Math.max(tokens, 1);
}

export function estimateHistoryMessageTokens(msg: HistoryMessage): number {
  return (
    estimateTextTokens(msg.text) +
    estimateTextTokens(msg.thinking) +
    estimateTextTokens(msg.tool_calls_json) +
    estimateTextTokens(msg.tool_call_results_json) +
    HISTORY_MESSAGE_TOKEN_OVERHEAD
  );
}

function isHistoryEligible(msg: SessionMessage): boolean {
  return msg.status === undefined || msg.status === 'completed';
}

function jsonFieldOrUndefined<T>(value: T[] | undefined): string | undefined {
  if (!value || value.length === 0) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    /* swallow-ok: 序列化失败返回 undefined */
    return undefined;
  }
}

export function truncateHistoryWithAnchor(
  history: HistoryMessage[],
  budget: number
): HistoryMessage[] {
  const perMessageTokens = history.map(estimateHistoryMessageTokens);
  const total = perMessageTokens.reduce((sum, n) => sum + n, 0);
  if (total <= budget) return history;
  const anchorIdx = history.findIndex((m) => m.sender === 'user');
  const anchorEnd = anchorIdx === -1 ? 0 : anchorIdx;
  const headTokens = perMessageTokens
    .slice(0, anchorEnd + 1)
    .reduce((sum, n) => sum + n, 0);
  let tailStart = anchorEnd + 1;
  let tailTokens = total - headTokens;
  while (tailStart < history.length && headTokens + tailTokens > budget) {
    tailTokens -= perMessageTokens[tailStart] ?? 0;
    tailStart += 1;
  }
  return [...history.slice(0, anchorEnd + 1), ...history.slice(tailStart)];
}

export function buildHistoryMessages(
  messages: readonly SessionMessage[] | undefined | null,
  opts?: { tokenBudget?: number; excludeId?: string }
): HistoryMessage[] | undefined {
  const source = messages ?? [];
  const rawBudget = opts?.tokenBudget;
  const budget =
    typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget > 0
      ? Math.floor(rawBudget)
      : HISTORY_TOKEN_BUDGET;
  const excludeId = opts?.excludeId;
  const history: HistoryMessage[] = [];
  for (const msg of source) {
    if (
      (msg.sender !== 'user' && msg.sender !== 'assistant') ||
      !isHistoryEligible(msg)
    )
      continue;
    if (excludeId && msg.id === excludeId) continue;
    const entry: HistoryMessage = {
      id: msg.id,
      sender: msg.sender,
      timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
    };
    if (typeof msg.text === 'string' && msg.text.length > 0)
      entry.text = msg.text;
    if (typeof msg.thinking === 'string' && msg.thinking.length > 0)
      entry.thinking = msg.thinking;
    const toolCallsJson = jsonFieldOrUndefined(msg.toolCalls);
    if (toolCallsJson) entry.tool_calls_json = toolCallsJson;
    const resultsJson = jsonFieldOrUndefined(msg.toolCallResults);
    if (resultsJson) entry.tool_call_results_json = resultsJson;
    if (msg.status) entry.status = msg.status;
    history.push(entry);
  }
  return history.length > 0
    ? truncateHistoryWithAnchor(history, budget)
    : undefined;
}
