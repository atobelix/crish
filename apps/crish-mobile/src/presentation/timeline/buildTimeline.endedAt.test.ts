// 工具结束时刻数据面单测（批 B：工具组总时长的地基）：tool-end 在
// 「已有草稿」与「无草稿直建」两条路径都落 endedAtMs；运行中未定。
import { buildSessionTimeline, type ToolBlock } from './buildTimeline';
import type { FeedEntry } from '@/domain/store/eventReducers';

function entry(
  type: string,
  receivedAtMs: number,
  fields: Record<string, unknown> = {}
): FeedEntry {
  return {
    type,
    sessionId: 's-1',
    sequence: receivedAtMs,
    receivedAtMs,
    ...fields,
  } as FeedEntry;
}

describe('buildSessionTimeline · endedAtMs（批 B）', () => {
  it('已有草稿路径：tool-end 落 endedAtMs = 结束事件接收时刻', () => {
    const blocks = buildSessionTimeline([
      entry('tool-start', 2000, {
        call: { id: 't-1', toolName: 'read_file' },
      }),
      entry('tool-end', 9500, {
        toolCallId: 't-1',
        result: { isError: false, output: 'ok' },
      }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'tool',
      id: 't-1',
      atMs: 2000,
      endedAtMs: 9500,
      status: 'done',
    });
  });

  it('无草稿直建路径：tool-end 直建块 atMs 与 endedAtMs 同为事件时刻', () => {
    const blocks = buildSessionTimeline([
      entry('tool-end', 4000, {
        toolCallId: 't-9',
        result: { isError: true, output: 'boom' },
      }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'tool',
      id: 't-9',
      atMs: 4000,
      endedAtMs: 4000,
      status: 'error',
    });
  });

  it('运行中的工具块 endedAtMs 未定（undefined）', () => {
    const blocks = buildSessionTimeline([
      entry('tool-start', 2000, {
        call: { id: 't-2', toolName: 'shell' },
      }),
    ]);
    const tool = blocks[0] as ToolBlock;
    expect(tool.status).toBe('running');
    expect(tool.endedAtMs).toBeUndefined();
  });
});
