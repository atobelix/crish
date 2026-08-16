/**
 * 事件 feed 过滤原语（T4 投影原语下沉 · 单源）。
 *
 * 仅 feed 展示派生（R2UX-05-06 过滤条数据面：只看错误 / 只看当前 run / 只看工具），
 * transport 无关纯函数，两端共用。
 */
import type { FeedEntry } from './event-ring-window';
import type { EventEnvelopeFrame } from './event-envelope';
import { readBool, readString } from './event-envelope';

export interface FeedFilter {
  /** 只看错误（F3 §5.1：error-entry + 错误态工具卡/任务卡 + run-header 失败态） */
  errorsOnly?: boolean;
  /** 只看当前 run（F3 §5.1；无 runId 的会话级/数据面条目被隐藏） */
  runId?: string | null;
  /** kind 白名单（只看工具等；F3 §5.1 只看工具 = tool/task/audit 类型集合） */
  typeWhitelist?: ReadonlySet<string>;
}

/**
 * 错误级派生标记（F3 §5.1 错误高亮清单；容错读取事件体）：
 * runtime-error / run-terminal(failed) / tool-end(isError) / task-failed / security-audit(blocked)
 */
export function deriveErrorLevel(frame: EventEnvelopeFrame): boolean {
  switch (frame.type) {
    case 'runtime-error':
      return true;
    case 'run-terminal':
      return readString(frame, 'terminal') === 'failed';
    case 'tool-end':
      return readBool(frame, 'result', 'isError');
    case 'task-failed':
      return true;
    case 'security-audit':
      return readString(frame, 'decision') === 'blocked';
    default:
      return false;
  }
}

/** 只看错误（F3 §5.1 过滤条「只看错误」数据面） */
export function filterErrors(entries: readonly FeedEntry[]): FeedEntry[] {
  return entries.filter((e) => deriveErrorLevel(e));
}

/** 只看当前 run（信封 runId 归属；无 runId 条目隐藏，F3 §5.1 分组规则 4 会话级区段） */
export function filterByRunId(
  entries: readonly FeedEntry[],
  runId: string
): FeedEntry[] {
  return entries.filter((e) => readString(e, 'runId') === runId);
}

/** kind 白名单过滤（只看工具等；F3 §5.1 只看工具 = 类型集合过滤） */
export function filterByTypes(
  entries: readonly FeedEntry[],
  types: ReadonlySet<string>
): FeedEntry[] {
  if (types.size === 0) return [...entries];
  return entries.filter((e) => types.has(e.type));
}

/** 组合过滤（R2UX-05-06 过滤条三维度组合：错误 ∧ run ∧ 类型） */
export function filterFeed(
  entries: readonly FeedEntry[],
  filter: FeedFilter
): FeedEntry[] {
  let out: readonly FeedEntry[] = entries;
  if (filter.errorsOnly) {
    out = filterErrors(out);
  }
  if (filter.runId != null && filter.runId !== '') {
    out = filterByRunId(out, filter.runId);
  }
  if (filter.typeWhitelist) {
    out = filterByTypes(out, filter.typeWhitelist);
  }
  return out as FeedEntry[];
}
