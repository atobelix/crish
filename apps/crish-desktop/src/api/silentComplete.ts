/**
 * D2-5 silent-complete-alert：检测 run「完成」但用户可见内容为空。
 *
 * Silent complete 定义（单消息可见性直接判定，V1-α）：
 * - 终态 assistant 消息在直接判定后 **无可见正文**（剥思考占位后）
 * - **无可见工具卡**
 * - 仅 hidden thinking / 占位思考 **不算** 用户可见
 *
 * V1-α（统一输入流收敛战役）：判定消费从旧旁路投影（用户视图投影模块，
 * 已随 V1-β 删除）迁移为 **SessionMessage 单路直接判定**——判定所需仅为单条
 * assistant 消息的 visibleText / thinkingPreview / tools 可见度，无需整套
 * 用户视图 DTO / hiddenBuckets / stats。行为与 metric 语义保留：
 * `recordSilentComplete` / `checkAndAlertSilentComplete` 调用点 / dev console.warn
 * 全部原样在案（迁移而非删除）。
 *
 * 纯判定不写 store、不改 run 成功语义；告警路径只记 controlMetric + dev console。
 *
 * @see docs/plans/2026-07-system-architecture-control-master-plan.md §13.2 / D2-5
 * @see docs/architecture/run-control.md §6
 */

import type { SessionMessage } from '../store/layoutStore';
import { recordSilentComplete } from './controlMetrics';
import { stripThoughtPlaceholders } from './markdownRenderLite';
import { logger } from '../services/LoggerService';

/** 静默完成原因（silent=true 时）或 not_silent */
export type SilentCompleteReason =
  'empty_visible' | 'thinking_only' | 'not_silent';

export type SilentCompleteResult = {
  silent: boolean;
  reason: SilentCompleteReason;
  /** 日志用短说明 */
  detail?: string;
  /** 参与判定的 assistant message id（若有） */
  messageId?: string;
};

function notSilent(detail?: string, messageId?: string): SilentCompleteResult {
  return {
    silent: false,
    reason: 'not_silent',
    ...(detail ? { detail } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

/** thinking 预览截断上限（语义对齐原投影模块默认 240） */
const THINKING_PREVIEW_MAX = 240;

/** 截断预览（空白归一；语义对齐原投影模块 clipPreview） */
function clipPreview(text: string, max: number): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * 单条消息的用户可见性直接判定（V1-α，纯函数）。
 * 语义对齐原用户视图投影的消费面（旧旁路投影已删）：
 * - visibleText：剥思考占位后的正文；正文缺失时回退 blocks 文本段（\n\n 连接）；
 * - thinkingPreview：剥占位思考后的 preview（截断，240）；
 * - hasTools：toolCalls 按 id 去重后是否有可见工具。
 */
export function computeAssistantVisibility(msg: SessionMessage): {
  visibleText: string;
  thinkingPreview: string;
  hasTools: boolean;
} {
  let visibleText = stripThoughtPlaceholders(msg.text || '').trim();
  if (!visibleText && msg.blocks?.length) {
    visibleText = msg.blocks
      .filter((b) => b.type === 'text' && (b.content || '').trim())
      .map((b) => stripThoughtPlaceholders(b.content || '').trim())
      .filter(Boolean)
      .join('\n\n');
  }

  const thinkingRaw = (msg.thinking || '').trim();
  const isPlaceholderThinking =
    !thinkingRaw ||
    thinkingRaw === '正在处理…' ||
    thinkingRaw === '正在思考中...';
  const thinkingPreview = isPlaceholderThinking
    ? ''
    : clipPreview(thinkingRaw, THINKING_PREVIEW_MAX);

  let hasTools = false;
  const seen = new Set<string>();
  for (const tc of msg.toolCalls || []) {
    if (!tc?.id || seen.has(tc.id)) continue;
    seen.add(tc.id);
    hasTools = true;
  }

  return { visibleText, thinkingPreview, hasTools };
}

/**
 * 从 SessionMessage（finalize 后）直接判定静默完成。
 * 纯函数：不写 ModelView / store；不依赖用户视图投影（V1-α）。
 */
export function isSilentCompleteFromSessionMessage(
  msg: SessionMessage | null | undefined
): SilentCompleteResult {
  if (!msg) return notSilent('no_message');
  if (msg.sender !== 'assistant') {
    return notSilent('not_assistant', msg.id);
  }

  const { visibleText, thinkingPreview, hasTools } =
    computeAssistantVisibility(msg);
  const hasVisible = !!visibleText;
  if (hasVisible || hasTools) {
    return notSilent(hasVisible ? 'has_visible_text' : 'has_tools', msg.id);
  }

  if (thinkingPreview) {
    return {
      silent: true,
      reason: 'thinking_only',
      detail: 'assistant finished with only hidden thinking',
      messageId: msg.id,
    };
  }

  return {
    silent: true,
    reason: 'empty_visible',
    detail: 'assistant finished with no user-visible content',
    messageId: msg.id,
  };
}

/**
 * 统一入口：接受 SessionMessage（V1-α 后仅单路，用户视图 DTO 分支已随
 * 旧旁路投影删除）。
 * → `{ silent, reason }`。
 */
export function isSilentComplete(
  input: SessionMessage | null | undefined,
  opts?: { messageId?: string }
): SilentCompleteResult {
  if (input == null) return notSilent('no_input');
  if (opts?.messageId && input.id !== opts.messageId) {
    return notSilent('message_id_mismatch', input.id);
  }
  return isSilentCompleteFromSessionMessage(input);
}

// ── 告警 side-effect（metric + dev console）─────────────────────────

/** 已 warn 过的 messageId，避免同消息刷屏 */
const warnedMessageIds = new Set<string>();

/** 单测重置 warn 去重表 */
export function resetSilentCompleteWarned(): void {
  warnedMessageIds.clear();
}

function isDevEnabled(force?: boolean): boolean {
  if (force) return true;
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return (
    typeof process !== 'undefined' && process.env.NODE_ENV === 'development'
  );
}

export type SilentCompleteAlertMeta = {
  sessionId?: string;
  runId?: string;
  messageId?: string;
  /** 单测强制 console + 始终记 metric 的 dev 路径已由 metric 无条件记录 */
  forceConsole?: boolean;
  /** 关闭 console（仍记 metric） */
  silentConsole?: boolean;
};

/**
 * 若 result.silent：记 `silent_complete` metric；dev 下 console.warn once（按 messageId）。
 * 不抛、不改 run 状态。
 */
export function alertSilentComplete(
  result: SilentCompleteResult,
  meta?: SilentCompleteAlertMeta
): void {
  if (!result.silent) return;

  recordSilentComplete();

  if (meta?.silentConsole) return;
  if (!isDevEnabled(meta?.forceConsole)) return;

  const mid = meta?.messageId || result.messageId || '';
  if (mid && warnedMessageIds.has(mid)) return;
  if (mid) warnedMessageIds.add(mid);

  const sid = meta?.sessionId ? ` session=${meta.sessionId}` : '';
  const rid = meta?.runId ? ` run=${meta.runId}` : '';
  const midPart = mid ? ` message=${mid}` : '';

  logger.warn(
    `[silent-complete] ${result.reason}: run completed with no user-visible content` +
      `${sid}${rid}${midPart}` +
      (result.detail ? ` (${result.detail})` : ''),
    {
      module: 'silent-complete',
    },
  );
}

/**
 * 便捷：从 finalize 后的 SessionMessage 判定并告警。
 * @returns 判定结果（无论是否 silent）
 */
export function checkAndAlertSilentComplete(
  msg: SessionMessage | null | undefined,
  meta?: SilentCompleteAlertMeta
): SilentCompleteResult {
  const result = isSilentCompleteFromSessionMessage(msg);
  alertSilentComplete(result, {
    ...meta,
    messageId: meta?.messageId || result.messageId || msg?.id,
  });
  return result;
}
