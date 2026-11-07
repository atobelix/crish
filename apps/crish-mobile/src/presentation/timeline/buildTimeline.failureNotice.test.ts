// 远程流内失败 notice 分类呈现（批 C ⑮）：run-terminal 失败帧的
// notice 主文案走本地封闭分类，原始 reason 只进 detail；完成/取消
// 形态不变。
import { buildSessionTimeline } from './buildTimeline';
import type { FeedEntry } from '@/domain/store/eventReducers';

let seq = 0;
function entry(type: string, fields: Record<string, unknown> = {}): FeedEntry {
  seq += 1;
  return {
    type,
    sessionId: 's-1',
    sequence: seq,
    receivedAtMs: 1000 + seq,
    ...fields,
  } as FeedEntry;
}

beforeEach(() => {
  seq = 0;
});

describe('run-terminal 失败 notice（分类映射）', () => {
  it('鉴权类原始串 → 分类文案主呈现，原始串进 detail', () => {
    const blocks = buildSessionTimeline([
      entry('run-terminal', {
        terminal: 'failed',
        error: 'HTTP 401 Unauthorized: invalid api key',
      }),
    ]);
    expect(blocks[0]).toMatchObject({
      kind: 'notice',
      tone: 'danger',
      detail: 'HTTP 401 Unauthorized: invalid api key',
    });
    expect((blocks[0] as { text: string }).text).toContain('鉴权失败');
    expect((blocks[0] as { text: string }).text).not.toContain(
      'invalid api key'
    );
  });

  it('映射不中的原始串 → 「运行失败（未分类）」+ detail 保留原文', () => {
    const blocks = buildSessionTimeline([
      entry('run-terminal', {
        terminal: 'failed',
        error: '引擎内部未知状况 ZQ-9',
      }),
    ]);
    expect(blocks[0]).toMatchObject({
      kind: 'notice',
      tone: 'danger',
      text: '运行失败（未分类）',
      detail: '引擎内部未知状况 ZQ-9',
    });
  });

  it('无 reason 的失败 → 「运行失败」且无 detail', () => {
    const blocks = buildSessionTimeline([
      entry('run-terminal', { terminal: 'failed' }),
    ]);
    expect(blocks[0]).toMatchObject({
      kind: 'notice',
      tone: 'danger',
      text: '运行失败',
    });
    expect((blocks[0] as { detail?: string }).detail).toBeUndefined();
  });

  it('reason 字段（非 error）同样走分类映射', () => {
    const blocks = buildSessionTimeline([
      entry('run-terminal', {
        terminal: 'failed',
        reason: 'context_length_exceeded',
      }),
    ]);
    expect((blocks[0] as { text: string }).text).toContain('上下文过长');
    expect((blocks[0] as { detail?: string }).detail).toBe(
      'context_length_exceeded'
    );
  });

  it('完成不产生时间线条目，取消形态保持克制（无 detail 注入）', () => {
    const done = buildSessionTimeline([
      entry('run-terminal', { terminal: 'completed' }),
    ]);
    expect(done).toHaveLength(0);
    const cancelled = buildSessionTimeline([
      entry('run-terminal', { terminal: 'cancelled' }),
    ]);
    expect(cancelled[0]).toMatchObject({ text: '运行已取消', tone: 'muted' });
  });
});
