/**
 * D2-5 silent-complete-alert：检测 run「完成」但用户可见内容为空。
 *
 * Silent complete 定义（UserView 语义）：
 * - 终态 assistant 消息在投影后 **无 visibleText**
 * - **无 tool 卡**
 * - 仅 hidden thinking / 占位思考 **不算** 用户可见
 *
 * 纯判定不写 store、不改 run 成功语义；告警路径只记 controlMetric + dev console。
 *
 * @see docs/plans/2026-07-system-architecture-control-master-plan.md §13.2 / D2-5
 * @see docs/architecture/run-control.md §6
 */

import type { SessionMessage } from '../store/layoutStore';
import { recordSilentComplete } from './controlMetrics';
import {
  projectSessionMessageToUserView,
  type UserViewDto,
  type UserViewMessage,
} from './messageUserProjection';

/** 静默完成原因（silent=true 时）或 not_silent */
export type SilentCompleteReason =
  | 'empty_visible'
  | 'thinking_only'
  | 'not_silent';

export type SilentCompleteResult = {
  silent: boolean;
  reason: SilentCompleteReason;
  /** 日志用短说明 */
  detail?: string;
  /** 参与判定的 assistant message id（若有） */
  messageId?: string;
};

function notSilent(
  detail?: string,
  messageId?: string
): SilentCompleteResult {
  return {
    silent: false,
    reason: 'not_silent',
    ...(detail ? { detail } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

/**
 * 单条 UserView 消息是否为静默完成（仅 assistant 有意义）。
 * user 消息恒为 not_silent。
 */
export function isSilentCompleteUserViewMessage(
  msg: UserViewMessage | null | undefined
): SilentCompleteResult {
  if (!msg) return notSilent('no_message');
  if (msg.sender !== 'assistant') {
    return notSilent('not_assistant', msg.id);
  }

  const hasVisible = !!(msg.visibleText || '').trim();
  const hasTools = (msg.tools?.length ?? 0) > 0;
  if (hasVisible || hasTools) {
    return notSilent(
      hasVisible ? 'has_visible_text' : 'has_tools',
      msg.id
    );
  }

  const hasThinking = !!(msg.thinkingPreview || '').trim();
  if (hasThinking) {
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
 * 从 UserView DTO 取目标 assistant（messageId 或最后一条 assistant）判定。
 */
export function isSilentCompleteFromUserView(
  dto: UserViewDto | null | undefined,
  opts?: { messageId?: string }
): SilentCompleteResult {
  if (!dto?.messages?.length) return notSilent('empty_projection');
  const id = opts?.messageId?.trim();
  let target: UserViewMessage | undefined;
  if (id) {
    target = dto.messages.find((m) => m.id === id);
    if (!target) return notSilent('message_not_found', id);
  } else {
    for (let i = dto.messages.length - 1; i >= 0; i--) {
      const m = dto.messages[i];
      if (m?.sender === 'assistant') {
        target = m;
        break;
      }
    }
    if (!target) return notSilent('no_assistant_in_projection');
  }
  return isSilentCompleteUserViewMessage(target);
}

/**
 * 从 SessionMessage（finalize 后）投影再判定。
 * 纯函数：不写 ModelView / store。
 */
export function isSilentCompleteFromSessionMessage(
  msg: SessionMessage | null | undefined
): SilentCompleteResult {
  if (!msg) return notSilent('no_message');
  if (msg.sender !== 'assistant') {
    return notSilent('not_assistant', msg.id);
  }
  const { message } = projectSessionMessageToUserView(msg);
  return isSilentCompleteUserViewMessage(message);
}

/**
 * 统一入口：接受 UserView 消息 / DTO / SessionMessage。
 * → `{ silent, reason }`。
 */
export function isSilentComplete(
  input:
    | UserViewMessage
    | UserViewDto
    | SessionMessage
    | null
    | undefined,
  opts?: { messageId?: string }
): SilentCompleteResult {
  if (input == null) return notSilent('no_input');

  // UserViewDto：有 stats + messages + hiddenBuckets
  if (
    typeof input === 'object' &&
    'stats' in input &&
    'messages' in input &&
    Array.isArray((input as UserViewDto).messages)
  ) {
    return isSilentCompleteFromUserView(input as UserViewDto, opts);
  }

  // SessionMessage：sender user|assistant 且通常有 text 字段、无 visibleText
  if (
    typeof input === 'object' &&
    'sender' in input &&
    !('visibleText' in input) &&
    ((input as SessionMessage).sender === 'user' ||
      (input as SessionMessage).sender === 'assistant')
  ) {
    const sm = input as SessionMessage;
    if (opts?.messageId && sm.id !== opts.messageId) {
      return notSilent('message_id_mismatch', sm.id);
    }
    return isSilentCompleteFromSessionMessage(sm);
  }

  // UserViewMessage
  if (
    typeof input === 'object' &&
    'sender' in input &&
    'visibleText' in input
  ) {
    return isSilentCompleteUserViewMessage(input as UserViewMessage);
  }

  return notSilent('unknown_input');
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
   
  console.warn(
    `[silent-complete] ${result.reason}: run completed with no user-visible content` +
      `${sid}${rid}${midPart}` +
      (result.detail ? ` (${result.detail})` : '')
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
