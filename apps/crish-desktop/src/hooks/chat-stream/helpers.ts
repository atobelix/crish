import type { SessionMessage } from '../../store/types';
import { getSessionById } from '../../store/sessionStore';
import {
  addMessageToolCall,
  updateMessageText,
  updateMessageThinking,
  updateMessageToolCall,
} from '../../store/storeAccess';
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

/**
 * R6 微批合并：工具终态提交在同一微任务内合并为一次落盘。
 *
 * 并行工具成簇终结时，逐个 commit 会逐个写 sessionStore → 逐个触发全量
 * 投影。改为：commit 只做字段合并并入队（同工具同窗多次提交按字段后覆前
 * 合并），微任务收尾统一 flush；同窗内后续提交以队列中的合并快照为
 * existing 基准，语义与逐个立即写入逐项等价（lite 仍在 commit 时读取，
 * 调用方随后的 clearStreamTool 不受影响）。
 *
 * 落盘边界（同步 flush，杜绝读到未落盘的中间态）：
 * - commitStreamToolsToSession 收尾、commitStreamToSession 入口；
 * - executeStreamCompletion 在 flushStreamBatchers 后（收口批显式调用）；
 * - 其余场景由微任务自动 flush（事件任务之间必然落盘）。
 */
interface PendingToolCommit {
  sessionId: string;
  messageId: string;
  toolId: string;
  /** 合并后的完整工具行快照：同窗后续提交的 existing 基准 / add 路径的落盘对象 */
  snapshot: MessageToolCall;
  /** 已存在工具的累积 partial（flush 走 updateMessageToolCall）；新建工具为 null（走 add） */
  updates: Partial<MessageToolCall> | null;
}

const pendingToolCommits = new Map<string, PendingToolCommit>();
let toolCommitFlushScheduled = false;

function pendingToolKey(
  sessionId: string,
  messageId: string,
  toolId: string
): string {
  return `${sessionId}\u0000${messageId}\u0000${toolId}`;
}

export function flushPendingToolCommits(): void {
  if (pendingToolCommits.size === 0) return;
  const entries = Array.from(pendingToolCommits.values());
  pendingToolCommits.clear();
  for (const e of entries) {
    if (e.updates) {
      updateMessageToolCall(e.sessionId, e.messageId, e.toolId, e.updates);
    } else {
      addMessageToolCall(e.sessionId, e.messageId, e.snapshot);
    }
  }
}

function scheduleToolCommitFlush(): void {
  if (toolCommitFlushScheduled) return;
  toolCommitFlushScheduled = true;
  queueMicrotask(() => {
    toolCommitFlushScheduled = false;
    flushPendingToolCommits();
  });
}

/**
 * Apply one tool patch into session messages (immer once).
 * Merges any lite-store intermediate fields so success patches that omit
 * name/args still land a complete durable row.
 *
 * T4 A3：写入统一走 `store/storeAccess` 编排单点（sessionAccess 门面），
 * 不再直写 layoutStore（单一写入通道语义，check:store-writes 对齐）。
 * R6：落盘经微批队列（见上方 PendingToolCommit 说明），本函数只合并与入队。
 */
export function commitToolPatchToSession(
  sessionId: string,
  messageId: string,
  toolId: string,
  patch: StreamToolCallPatch | StreamToolLive,
  options?: { sync?: boolean }
): void {
  // 分段封口（S3）：工具块入队前先把当前流式正文快照落块——保证批量
  // flush 时本工具的前置正文段已按序存在于 blocks，工具块只会落在段
  // 之后，绝不反超。经 upsertToolCall 的调用此前已快照过，此处同值
  // 短路为无操作；未经快照的直提路径（审批/错误补丁等）由此补齐。
  snapshotStreamTextToSession(sessionId, messageId);
  const lite = getStreamTools(sessionId, messageId)?.[toolId];
  const key = pendingToolKey(sessionId, messageId, toolId);
  const pending = pendingToolCommits.get(key);
  const existing =
    pending?.snapshot ??
    getSessionById(sessionId)
      ?.messages?.find((m) => m.id === messageId)
      ?.toolCalls?.find((t) => t.id === toolId);

  const name = patch.name || lite?.name || existing?.name || 'tool';
  const argumentsText =
    patch.arguments !== undefined
      ? patch.arguments
      : lite?.arguments !== undefined
        ? lite.arguments
        : existing?.arguments;
  const intent =
    patch.intent !== undefined
      ? patch.intent
      : lite?.intent !== undefined
        ? lite.intent
        : existing?.intent;
  const group =
    patch.group !== undefined
      ? patch.group
      : lite?.group !== undefined
        ? lite.group
        : existing?.group;
  const groupId =
    patch.groupId !== undefined
      ? patch.groupId
      : lite?.groupId !== undefined
        ? lite.groupId
        : existing?.groupId;
  const isInternal =
    patch.isInternal !== undefined
      ? patch.isInternal
      : lite?.isInternal !== undefined
        ? lite.isInternal
        : existing?.isInternal;
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
    if (intent !== undefined) updates.intent = intent;
    if (group !== undefined) updates.group = group;
    if (groupId !== undefined) updates.groupId = groupId;
    if (isInternal !== undefined) updates.isInternal = isInternal;
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
    const snapshot: MessageToolCall = { ...existing, ...updates };
    if (pending && pending.updates === null) {
      // 同窗内该工具是新建未落盘：updates 折进 add 快照，仍走 add 路径
      pending.snapshot = snapshot;
    } else {
      pendingToolCommits.set(key, {
        sessionId,
        messageId,
        toolId,
        snapshot,
        updates: { ...pending?.updates, ...updates },
      });
    }
  } else {
    const toolCall: MessageToolCall = {
      id: toolId,
      name,
      arguments: argumentsText || '',
      status,
      ...(output !== undefined ? { output } : {}),
      ...(intent !== undefined ? { intent } : {}),
      ...(group !== undefined ? { group } : {}),
      ...(groupId !== undefined ? { groupId } : {}),
      ...(isInternal !== undefined ? { isInternal } : {}),
      ...(approvalMeta !== undefined ? { approvalMeta } : {}),
      ...(diffs !== undefined ? { diffs } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(resolvedDurationMs !== undefined
        ? { durationMs: resolvedDurationMs }
        : {}),
      ...(status === 'success' || status === 'error'
        ? { finishedAt: Date.now() }
        : {}),
    };
    pendingToolCommits.set(key, {
      sessionId,
      messageId,
      toolId,
      snapshot: toolCall,
      updates: null,
    });
  }
  if (options?.sync) {
    flushPendingToolCommits();
  } else {
    scheduleToolCommitFlush();
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
  // R6 落盘边界：本函数返回前同步 flush，调用方随后的 store 读取即见终态
  flushPendingToolCommits();
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
  // R6 落盘边界：先把此前入队的工具提交同步落盘，再读/写消息正文与思考
  flushPendingToolCommits();
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
 * patches so the preceding text segment is sealed into blocks (segmented
 * bookkeeping) before the tool block lands — interleaving stays correct.
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
