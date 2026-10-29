import type { SessionMessage } from '../../store/types';
import { getSessionById } from '../../store/sessionStore';
import {
  addMessageToolCall,
  updateMessageText,
  updateMessageThinking,
  updateMessageToolCall,
} from '../../api/storeAccess';
import { stripThoughtPlaceholders } from '../../api/markdownRenderLite';
import { requestMarkdownResult } from '../../api/markdownRenderScheduler';
import {
  clearStream,
  clearStreamTools,
  getStreamText,
  getStreamThinking,
  getStreamTools,
  type StreamToolLive,
} from '../../store/streamingStore';
import type { MessageToolCall } from '../../store/types';
import type { StreamToolCallPatch } from '../../api/streamTextBatcher';
import { TOOL_OUTPUT_BYTE_CAP } from '../../api/perfBudgets';
import type { TerminalToolReason, TerminalToolPatch } from './types';

type PublishToolDiffsFn =
  typeof import('../../api/publishToolDiffs').publishToolDiffs;
let _publishToolDiffs: PublishToolDiffsFn | null = null;
let _publishToolDiffsLoading: Promise<PublishToolDiffsFn | null> | null = null;

function preloadPublishToolDiffs(): void {
  if (_publishToolDiffs || _publishToolDiffsLoading) return;
  _publishToolDiffsLoading = import('../../api/publishToolDiffs')
    .then((m) => {
      _publishToolDiffs = m.publishToolDiffs;
      return m.publishToolDiffs;
    })
    .catch(() => {
      _publishToolDiffsLoading = null;
      return null;
    });
}

function publishToolDiffsLazy(files: Parameters<PublishToolDiffsFn>[0]): void {
  if (_publishToolDiffs) {
    _publishToolDiffs(files);
    return;
  }
  void import('../../api/publishToolDiffs')
    .then((m) => {
      _publishToolDiffs = m.publishToolDiffs;
      m.publishToolDiffs(files);
    })
    .catch(() => {
      /* ignore */
    });
}

export function scheduleFinalMarkdownHtml(
  sessionId: string,
  messageId: string,
  fullText: string,
  options?: {
    /** true = fullText 已由调用方预清理（N6 单次化，08-detail 3.3），不再二次 strip */
    preCleaned?: boolean;
  }
): void {
  // N6：complete 路径已预清理（onComplete 算一次 strip），本处不再重复；
  // 未预清理调用方（stop 等）保持原行为
  const cleaned = options?.preCleaned
    ? fullText || ''
    : stripThoughtPlaceholders(fullText || '');
  if (!cleaned.trim()) return;
  void requestMarkdownResult(cleaned, 'chat')
    .then((result) => {
      const html = result?.html;
      if (!html) return;
      const msg = getSessionById(sessionId)?.messages?.find(
        (m: SessionMessage) => m.id === messageId
      );
      if (!msg) return;
      const now = msg.text || '';
      const nowClean = stripThoughtPlaceholders(now);
      if (nowClean !== cleaned && now !== cleaned && now !== fullText) return;
      const textToKeep = nowClean === cleaned ? now || cleaned : cleaned;
      updateMessageText(sessionId, messageId, textToKeep, html);
    })
    .catch(() => {
      /* Worker fail: AsyncMarkdown sync fallback */
    });
}

/**
 * Apply one tool patch into session messages (immer once).
 * Merges any lite-store intermediate fields so success patches that omit
 * name/args still land a complete durable row.
 *
 * T4 A3：写入统一走 `api/storeAccess` 编排单点（sessionAccess 门面），
 * 不再直写 layoutStore（单一写入通道语义，check:store-writes 对齐）。
 */
export function commitToolPatchToSession(
  sessionId: string,
  messageId: string,
  toolId: string,
  patch: StreamToolCallPatch | StreamToolLive
): void {
  const lite = getStreamTools(sessionId, messageId)?.[toolId];
  const existing = getSessionById(sessionId)
    ?.messages?.find((m) => m.id === messageId)
    ?.toolCalls?.find((t) => t.id === toolId);

  const name = patch.name || lite?.name || existing?.name || 'tool';
  const argumentsText =
    patch.arguments !== undefined
      ? patch.arguments
      : lite?.arguments !== undefined
        ? lite.arguments
        : existing?.arguments;
  const explanation =
    patch.explanation !== undefined
      ? patch.explanation
      : lite?.explanation !== undefined
        ? lite.explanation
        : existing?.explanation;
  const status = (patch.status ||
    lite?.status ||
    existing?.status ||
    'running') as MessageToolCall['status'];
  let output =
    patch.output !== undefined
      ? patch.output
      : lite?.output !== undefined
        ? lite.output
        : existing?.output;
  // D5 / U-OUT-FE：store 写入 hardCap（与 Rust 同源 TOOL_OUTPUT_BYTE_CAP）
  if (typeof output === 'string' && output.length > TOOL_OUTPUT_BYTE_CAP) {
    output =
      output.slice(0, TOOL_OUTPUT_BYTE_CAP) +
      `\n…[truncated ${output.length - TOOL_OUTPUT_BYTE_CAP} chars]`;
  }
  const approvalMeta =
    'approvalMeta' in patch && patch.approvalMeta !== undefined
      ? patch.approvalMeta
      : lite?.approvalMeta !== undefined
        ? lite.approvalMeta
        : existing?.approvalMeta;
  const diffs =
    'diffs' in patch && patch.diffs !== undefined
      ? patch.diffs
      : existing?.diffs;
  const startedAt =
    'startedAt' in patch && patch.startedAt !== undefined
      ? patch.startedAt
      : lite?.startedAt !== undefined
        ? lite.startedAt
        : existing?.startedAt;
  const durationMs =
    'durationMs' in patch && patch.durationMs !== undefined
      ? patch.durationMs
      : lite?.durationMs !== undefined
        ? lite.durationMs
        : existing?.durationMs;
  let resolvedDurationMs = durationMs;
  if (
    resolvedDurationMs === undefined &&
    (status === 'success' || status === 'error') &&
    typeof startedAt === 'number' &&
    startedAt > 0
  ) {
    resolvedDurationMs = Math.max(0, Date.now() - startedAt);
  }

  if (existing) {
    const updates: Partial<MessageToolCall> = {};
    if (patch.name !== undefined || (!existing.name && name))
      updates.name = name;
    if (argumentsText !== undefined) updates.arguments = argumentsText;
    if (explanation !== undefined) updates.explanation = explanation;
    if (status !== undefined) updates.status = status;
    if (output !== undefined) updates.output = output;
    if (approvalMeta !== undefined) updates.approvalMeta = approvalMeta;
    if (diffs !== undefined) updates.diffs = diffs;
    if (startedAt !== undefined) updates.startedAt = startedAt;
    if (resolvedDurationMs !== undefined)
      updates.durationMs = resolvedDurationMs;
    if (status === 'success' || status === 'error') {
      updates.finishedAt = Date.now();
    }
    updateMessageToolCall(sessionId, messageId, toolId, updates);
  } else {
    addMessageToolCall(sessionId, messageId, {
      id: toolId,
      name,
      arguments: argumentsText || '',
      status,
      ...(output !== undefined ? { output } : {}),
      ...(explanation !== undefined ? { explanation } : {}),
      ...(approvalMeta !== undefined ? { approvalMeta } : {}),
      ...(diffs !== undefined ? { diffs } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(resolvedDurationMs !== undefined
        ? { durationMs: resolvedDurationMs }
        : {}),
      ...(status === 'success' || status === 'error'
        ? { finishedAt: Date.now() }
        : {}),
    });
  }
}

/**
 * Flush remaining intermediate tools from streamingStore into session messages,
 * then clear the lite tools map (text/thinking left intact unless clearStream).
 */
export function commitStreamToolsToSession(
  sessionId: string,
  messageId: string
): void {
  const tools = getStreamTools(sessionId, messageId);
  if (!tools) return;
  for (const toolId of Object.keys(tools)) {
    const patch = tools[toolId];
    if (!patch) continue;
    commitToolPatchToSession(sessionId, messageId, toolId, patch);
  }
  clearStreamTools(sessionId, messageId);
}

/**
 * 将热路径 streamingStore 正文一次提交进会话消息（按 messageId update）。
 * 不 addMessage、不产生第二行同语义助手消息；提交后可选 clear 流缓冲。
 * 用于 complete / cancel / 需落盘的工具前快照。
 * Also commits any intermediate lite tools before clear.
 */
export function commitStreamToSession(
  sessionId: string,
  messageId: string,
  options?: {
    /** Override text (e.g. buffer.currentText / streamedFullText). */
    text?: string | null | undefined;
    /** When true, also commit thinking from streaming store. Default true. */
    commitThinking?: boolean;
    /** When true (default), also commit intermediate tools. */
    commitTools?: boolean;
    /** When true (default), clear streaming store entry after commit. */
    clear?: boolean;
  }
): string {
  if (options?.commitThinking !== false) {
    const thinking = getStreamThinking(sessionId, messageId);
    if (thinking != null && thinking !== '') {
      const msg = getSessionById(sessionId)?.messages?.find(
        (m: SessionMessage) => m.id === messageId
      );
      if (msg?.thinking !== thinking) {
        updateMessageThinking(sessionId, messageId, thinking);
      }
    }
  }
  if (options?.commitTools !== false) {
    commitStreamToolsToSession(sessionId, messageId);
  }
  const fromStore = getStreamText(sessionId, messageId) || '';
  // Prefer non-empty override; empty string falls through to streaming store.
  const text = options?.text || fromStore || '';
  if (text) {
    const msg = getSessionById(sessionId)?.messages?.find(
      (m: SessionMessage) => m.id === messageId
    );
    if (msg?.text !== text) {
      updateMessageText(sessionId, messageId, text);
    }
  }
  // 2. 关键时序闭环：严禁同步 clearStream()！
  // 必须将清理推迟至微任务（queueMicrotask），确保 React 18 完成对 sessionStore 的 DOM 挂载，
  // 杜绝组件在切换瞬间因 streamingStore 为空而发生白屏闪烁。
  if (options?.clear !== false) {
    queueMicrotask(() => {
      clearStream(sessionId, messageId);
    });
  }
  return text;
}

/**
 * Snapshot current stream text into the session store WITHOUT clearing the
 * streaming entry (UI keeps reading the live buffer). Used before tool
 * patches so streamTextOffset / blocks stay correct for interleaving.
 *
 * T4.2（R-05）：同值短路——streamText 与现有 msg.text 相同时跳过
 * updateMessageText（工具开始调用时文本常未变，避免无谓 messages 引用
 * 变更 → 全链重渲染）。
 */
export function snapshotStreamTextToSession(
  sessionId: string,
  messageId: string,
  fallbackText?: string
): string {
  const text = getStreamText(sessionId, messageId) || fallbackText || '';
  if (text) {
    const msg = getSessionById(sessionId)?.messages?.find(
      (m) => m.id === messageId
    );
    if (msg?.text !== text) {
      updateMessageText(sessionId, messageId, text);
    }
  }
  return text;
}

/**
 * 流式思考快照提交至 sessionStore。
 * 在工具启动前或首个正文 token 抵达（思考结束、吐字开始）时调用，
 * 锁定当前思考轮次的真实思考耗时（durationMs），杜绝后续吐字阶段的耗时污染思考耗时。
 */
export function snapshotStreamThinkingToSession(
  sessionId: string,
  messageId: string
): string | undefined {
  const thinking = getStreamThinking(sessionId, messageId);
  if (thinking && thinking.trim()) {
    const msg = getSessionById(sessionId)?.messages?.find(
      (m: SessionMessage) => m.id === messageId
    );
    if (msg?.thinking !== thinking) {
      const lastThought =
        msg?.thinkingTurns?.[msg.thinkingTurns.length - 1] ||
        msg?.blocks?.filter((b) => b.type === 'thought').pop();
      const activeTurn = lastThought?.turnIndex ?? 0;
      updateMessageThinking(sessionId, messageId, thinking, activeTurn);
    }
    return thinking;
  }
  return undefined;
}

/**
 * 软收口耗时固化：为「缺失 durationMs 的未终结工具」按真实挂钟补齐终点。
 *
 * 口径（锚定唯一权威时钟）：
 * - 已有正值 `durationMs` → 不产出（后端回报优先，保持原值）；
 * - 缺失且存在 `startedAt` → `now - startedAt`；
 * - 两者皆无 → 不产出（禁止伪造 0）。
 */
export function resolveTerminalDurationMs(
  tc: { startedAt?: number | undefined; durationMs?: number | undefined },
  now: number
): number | undefined {
  if (typeof tc.durationMs === 'number' && tc.durationMs > 0) return undefined;
  if (typeof tc.startedAt !== 'number' || tc.startedAt <= 0) return undefined;
  return Math.max(0, now - tc.startedAt);
}

export function buildTerminalToolPatches(
  toolCalls:
    | Array<{
        id: string;
        status?: string | undefined;
        output?: string | undefined;
        startedAt?: number | undefined;
        durationMs?: number | undefined;
      }>
    | null
    | undefined,
  reason: TerminalToolReason
): TerminalToolPatch[] {
  if (!toolCalls?.length) return [];
  const out: TerminalToolPatch[] = [];
  const now = Date.now();
  for (const tc of toolCalls) {
    if (!tc?.id) continue;
    if (tc.status !== 'running' && tc.status !== 'pending_approval') continue;
    const existing = (tc.output || '').trim();
    const durationMs = resolveTerminalDurationMs(tc, now);
    if (reason === 'stop') {
      out.push({
        id: tc.id,
        status: 'error',
        output: existing || '已停止',
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      continue;
    }
    if (tc.status === 'pending_approval') {
      out.push({
        id: tc.id,
        status: 'error',
        output:
          existing ||
          (reason === 'error' ? '运行失败时仍待确认' : '回合结束时仍待确认'),
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      continue;
    }
    const placeholder = !existing || /^(执行中|运行中)…?$/.test(existing);
    const fallback =
      reason === 'error'
        ? '运行失败时工具未返回结果'
        : '回合结束时工具未返回结果';
    out.push({
      id: tc.id,
      status: 'error',
      output: placeholder ? fallback : existing,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }
  return out;
}

export { preloadPublishToolDiffs, publishToolDiffsLazy };
