// event-filter 单测（T4 投影原语下沉；迁移自 mobile eventReducers.test.ts 过滤段）：
// 过滤（R2UX-05-06 过滤条数据面：只看错误 / 只看当前 run / 只看工具）
import { describe, expect, it } from 'vitest';
import {
  deriveErrorLevel,
  filterByRunId,
  filterByTypes,
  filterErrors,
  filterFeed,
} from './event-filter';
import type { FeedEntry } from './event-ring-window';
import type { EventEnvelopeFrame } from './event-envelope';

const NOW = 1_800_000_000_000;

function frame(
  overrides: Partial<EventEnvelopeFrame> & { type: string }
): EventEnvelopeFrame {
  return { sessionId: 's-1', ...overrides };
}

function entry(
  seq: number | undefined,
  overrides: Partial<FeedEntry> = {}
): FeedEntry {
  return {
    type: 'message-end',
    sessionId: 's-1',
    ...(seq !== undefined ? { sequence: seq } : {}),
    receivedAtMs: NOW,
    ...overrides,
  };
}

describe('deriveErrorLevel（F3 §5.1 错误高亮清单：五类错误源）', () => {
  it('runtime-error / run-terminal(failed) / tool-end(isError) / task-failed / security-audit(blocked)', () => {
    expect(deriveErrorLevel(frame({ type: 'runtime-error' }))).toBe(true);
    expect(
      deriveErrorLevel(frame({ type: 'run-terminal', terminal: 'failed' }))
    ).toBe(true);
    expect(
      deriveErrorLevel(frame({ type: 'run-terminal', terminal: 'completed' }))
    ).toBe(false);
    expect(
      deriveErrorLevel(frame({ type: 'tool-end', result: { isError: true } }))
    ).toBe(true);
    expect(
      deriveErrorLevel(frame({ type: 'tool-end', result: { isError: false } }))
    ).toBe(false);
    expect(deriveErrorLevel(frame({ type: 'task-failed' }))).toBe(true);
    expect(
      deriveErrorLevel(frame({ type: 'security-audit', decision: 'blocked' }))
    ).toBe(true);
    expect(
      deriveErrorLevel(frame({ type: 'security-audit', decision: 'approved' }))
    ).toBe(false);
    expect(deriveErrorLevel(frame({ type: 'message-end' }))).toBe(false);
  });
});

describe('filterErrors：只看错误', () => {
  it('错误类条目保留，其余过滤', () => {
    const items = [
      entry(1, { type: 'runtime-error' }),
      entry(2, { type: 'message-end' }),
      entry(3, { type: 'task-failed' }),
    ];
    const filtered = filterErrors(items);
    expect(filtered.map((e) => e.type)).toEqual([
      'runtime-error',
      'task-failed',
    ]);
  });
});

describe('filterByRunId：只看当前 run（无 runId 会话级/数据面条目隐藏，F3 §5.1 分组规则）', () => {
  it('按信封 runId 归属过滤', () => {
    const items = [
      entry(1, { type: 'agent-start', runId: 'r-1' }),
      entry(2, { type: 'message-end', runId: 'r-1' }),
      entry(3, { type: 'message-end', runId: 'r-2' }),
      entry(4, { type: 'task-started' }),
    ];
    const filtered = filterByRunId(items, 'r-1');
    expect(filtered.map((e) => e.runId)).toEqual(['r-1', 'r-1']);
  });
});

describe('filterByTypes：kind 白名单（只看工具）', () => {
  it('白名单类型保留', () => {
    const items = [
      entry(1, { type: 'tool-start' }),
      entry(2, { type: 'message-end' }),
      entry(3, { type: 'task-started' }),
    ];
    const filtered = filterByTypes(
      items,
      new Set(['tool-start', 'tool-end', 'task-started'])
    );
    expect(filtered.map((e) => e.type)).toEqual(['tool-start', 'task-started']);
  });
});

describe('filterFeed：三维度组合（错误 ∧ run ∧ 类型），空白名单不过滤', () => {
  it('组合过滤 + 无过滤条件原样返回', () => {
    const items = [
      entry(1, { type: 'runtime-error', runId: 'r-1' }),
      entry(2, { type: 'runtime-error', runId: 'r-2' }),
      entry(3, { type: 'message-end', runId: 'r-1' }),
    ];
    const filtered = filterFeed(items, { errorsOnly: true, runId: 'r-1' });
    expect(filtered.map((e) => e.sequence)).toEqual([1]);
    // 无过滤条件 → 原样
    expect(filterFeed(items, {})).toHaveLength(3);
    expect(filterFeed(items, { typeWhitelist: new Set() })).toHaveLength(3);
  });
});
