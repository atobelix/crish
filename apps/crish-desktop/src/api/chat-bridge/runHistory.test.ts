import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../../store/types';
import { anchorHistoryToLatestSummary } from './runHistory';

function msg(
  id: string,
  sender: string,
  metadata?: Record<string, unknown>
): SessionMessage {
  return {
    id,
    sender,
    content: id,
    ...(metadata ? { metadata } : {}),
  } as unknown as SessionMessage;
}

describe('anchorHistoryToLatestSummary', () => {
  it('空输入返回空数组', () => {
    expect(anchorHistoryToLatestSummary(undefined)).toEqual([]);
    expect(anchorHistoryToLatestSummary(null)).toEqual([]);
    expect(anchorHistoryToLatestSummary([])).toEqual([]);
  });

  it('无摘要块时原样复制（新数组）', () => {
    const input = [msg('u1', 'user'), msg('a1', 'assistant')];
    const out = anchorHistoryToLatestSummary(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('锚定最新摘要块：之前只保留 system 与折叠链消息，之后全部保留', () => {
    const input = [
      msg('sys', 'system'),
      msg('u1', 'user'),
      msg('compacted-summary-1', 'assistant'),
      msg('a1', 'assistant'),
      msg('s2', 'assistant', { isCompactedSummary: true }),
      msg('u2', 'user'),
    ];
    expect(anchorHistoryToLatestSummary(input).map((m) => m.id)).toEqual([
      'sys',
      'compacted-summary-1',
      's2',
      'u2',
    ]);
  });
});
