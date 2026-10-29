// 审批历史日期分组测试。
import { groupHistoryByDay } from './approvalHistoryScreen';
import type { ApprovalRecord } from '@/domain/types/domain';

function record(id: string, resolvedAtMs: number): ApprovalRecord {
  return {
    toolCallId: id,
    toolName: 'tool',
    sessionId: 's-1',
    runId: null,
    decision: 'approved',
    channel: 'mobile',
    resolvedAtMs,
  };
}

describe('groupHistoryByDay', () => {
  const now = new Date(2026, 9, 28, 12, 0, 0).getTime();
  const day = 86_400_000;

  it('按今天 / 昨天 / 日期分组，最新在前', () => {
    const sections = groupHistoryByDay(
      [
        record('a', now - 2 * day),
        record('b', now - 1000),
        record('c', now - day),
      ],
      now
    );
    expect(sections.map((s) => s.title)).toEqual([
      '今天',
      '昨天',
      '2026/10/26',
    ]);
    expect(sections[0]!.data[0]!.toolCallId).toBe('b');
  });

  it('空历史 → 空分组', () => {
    expect(groupHistoryByDay([], now)).toEqual([]);
  });
});
