/**
 * History messages builder & token budget truncation for engine runs.
 */
import type {
  MessageToolCall,
  SessionMessage,
  SessionMessageToolCallResult,
} from '../../store/types';

/**
 * History message builder / token budget truncation 的引擎对话 wire 载荷类型。
 *
 * T3 单源化（D5）：`HistoryMessage` 是「从 SessionMessage 派生的 LLM 上下文载荷」，
 * 不是第 N 套消息类型。它只保留 wire 特有字段（snake_case
 * tool_calls_json / tool_call_results_json / blocks_json）+ SessionMessage 派生字段；
 * 不复制 SessionMessage 其余超集字段。type 定义唯一在本文件。
 */
export interface HistoryMessage extends SessionMessage {
  /** 工具调用 wire JSON 串（由 SessionMessage.toolCalls 序列化） */
  tool_calls_json?: string;
  /** 工具结果回执 wire JSON 串（由 SessionMessage.toolCallResults / toolCalls 序列化） */
  tool_call_results_json?: string;
  /** 完整 AgentMessageBlock 序列 wire JSON 串 */
  blocks_json?: string;
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

/**
 * 从 SessionMessage.toolCallResults 与 SessionMessage.toolCalls 中提取全保真工具结果回执。
 * 1. 优先使用已显式存在的 toolCallResults；
 * 2. 对存在真实 output / error 的 toolCalls，若 toolCallResults 中缺漏，完整补全配对回执，
 *    确保后端水合时不丢弃真实 output，也不触发 TOOL_OUTCOME_UNKNOWN 假报错。
 */
export function resolveToolCallResults(
  toolCalls?: MessageToolCall[],
  explicitResults?: SessionMessageToolCallResult[]
): SessionMessageToolCallResult[] | undefined {
  const map = new Map<string, SessionMessageToolCallResult>();

  // 1. 先收录已有显式回执
  if (explicitResults && explicitResults.length > 0) {
    for (const r of explicitResults) {
      if (r && typeof r.id === 'string' && r.id.trim()) {
        map.set(r.id.trim(), { ...r });
      }
    }
  }

  // 2. 检查 toolCalls 中的真实 output 与 status
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      if (!tc || typeof tc.id !== 'string' || !tc.id.trim()) continue;
      const id = tc.id.trim();
      const existing = map.get(id);
      const hasOutput = typeof tc.output === 'string' && tc.output.length > 0;
      const isErr = tc.status === 'error';

      if (!existing) {
        // 如果 toolCall 具备真实 output 或标记为 error/success，补全配对回执
        if (hasOutput || isErr || tc.status === 'success') {
          map.set(id, {
            id,
            output: tc.output ?? (isErr ? 'failed' : ''),
            isError: isErr,
          });
        }
      } else {
        // 如果已存在但 output 缺失而 toolCall 上有真实 output，补全真实 output
        if (
          (existing.output === undefined || existing.output === '') &&
          hasOutput
        ) {
          existing.output = tc.output;
        }
        if (existing.isError === undefined && isErr) {
          existing.isError = true;
        }
      }
    }
  }

  return map.size > 0 ? Array.from(map.values()) : undefined;
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
    // 纯状态载体或无内容 assistant 消息不送入 LLM 历史，防止提供商 400 校验拦截
    if (
      msg.sender === 'assistant' &&
      !(msg.text || '').trim() &&
      !(msg.thinking || '').trim() &&
      (!msg.toolCalls || msg.toolCalls.length === 0)
    ) {
      continue;
    }
    // 空文本且无附件 user 消息不送入 LLM 历史，防止模型服务 400 Bad Request
    if (
      msg.sender === 'user' &&
      !(msg.text || '').trim() &&
      (!msg.attachments || msg.attachments.length === 0)
    ) {
      continue;
    }
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
    const resolvedResults = resolveToolCallResults(
      msg.toolCalls,
      msg.toolCallResults
    );
    const resultsJson = jsonFieldOrUndefined(resolvedResults);
    if (resultsJson) entry.tool_call_results_json = resultsJson;
    if (msg.status) entry.status = msg.status;
    history.push(entry);
  }
  return history.length > 0
    ? truncateHistoryWithAnchor(history, budget)
    : undefined;
}

/**
 * 锚定历史消息到最新的压缩摘要块，防止跨轮全量正文复活。
 * 保留系统消息、折叠链消息（compacted-summary-*）、最新的摘要块以及其后的所有保留消息；
 * 过滤掉最新摘要块之前已被折叠的历史正文消息。
 */
export function anchorHistoryToLatestSummary(
  messages: readonly SessionMessage[] | undefined | null
): SessionMessage[] {
  if (!messages || messages.length === 0) return [];

  let lastSummaryIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg &&
      (msg.id.startsWith('compacted-summary') ||
        Boolean(
          (msg.metadata as Record<string, unknown> | undefined)
            ?.isCompactedSummary
        ))
    ) {
      lastSummaryIdx = i;
      break;
    }
  }

  if (lastSummaryIdx === -1) {
    return [...messages];
  }

  const result: SessionMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (i >= lastSummaryIdx) {
      result.push(msg);
    } else {
      const isSystem = (msg.sender as string) === 'system';
      const isCompacted =
        msg.id.startsWith('compacted-summary') ||
        Boolean(
          (msg.metadata as Record<string, unknown> | undefined)
            ?.isCompactedSummary
        );
      if (isSystem || isCompacted) {
        result.push(msg);
      }
    }
  }

  return result;
}
