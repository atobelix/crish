/**
 * run-task 入参归一（从 streamSession 拆出）：把 StreamRequestOptions 中可选、可能带空白
 * 或非法值的字段收敛为引擎可直接使用的值；空串 / 非正数一律视为未提供（undefined / ''）。
 */
import type { StreamRequestOptions } from '../chatApi';
import { resolveSendThinkingFields } from './readiness';

function trimmedOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveIntOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** 用户消息的 clientMessageId（去空白；空则 undefined）。 */
export function resolveUserClientMessageId(
  options: StreamRequestOptions | undefined
): string | undefined {
  return trimmedOrUndefined(options?.clientMessageId);
}

/**
 * 思考档位：调用方显式给了 thinkingWire 时原样使用（连同其 thinkingTitle）；
 * 否则按会话当前选择解析。reasoningEffort = wire 优先、title 兜底。
 */
export function resolveRunThinking(
  options: StreamRequestOptions | undefined,
  safeSessionId: string
): {
  thinkingTitle: string | undefined;
  thinkingWire: string | undefined;
  reasoningEffort: string | undefined;
} {
  const optionWire = trimmedOrUndefined(options?.thinkingWire);
  const optionTitle = trimmedOrUndefined(options?.thinkingTitle);
  let thinkingTitle: string | undefined;
  let thinkingWire: string | undefined;
  if (optionWire) {
    thinkingWire = optionWire;
    thinkingTitle = optionTitle;
  } else {
    const fields = resolveSendThinkingFields(safeSessionId, optionTitle);
    thinkingTitle = fields.thinkingTitle;
    thinkingWire = fields.thinkingWire;
  }
  return {
    thinkingTitle,
    thinkingWire,
    reasoningEffort: thinkingWire || thinkingTitle,
  };
}

/** 目标模式（goal）相关入参与助手消息 clientMessageId（显式参数优先于 options）。 */
export function resolveRunGoalOptions(
  options: StreamRequestOptions | undefined,
  assistantClientMessageId: string | undefined
): {
  goalMode: string;
  visibleGoal: string;
  maxRounds: number | undefined;
  maxStalledRounds: number | undefined;
  asstClientMessageId: string | undefined;
} {
  return {
    goalMode: typeof options?.mode === 'string' ? options.mode.trim() : '',
    visibleGoal:
      typeof options?.visibleGoal === 'string'
        ? options.visibleGoal.trim()
        : '',
    maxRounds: positiveIntOrUndefined(options?.maxRounds),
    maxStalledRounds: positiveIntOrUndefined(options?.maxStalledRounds),
    asstClientMessageId:
      trimmedOrUndefined(assistantClientMessageId) ||
      trimmedOrUndefined(options?.assistantClientMessageId),
  };
}
