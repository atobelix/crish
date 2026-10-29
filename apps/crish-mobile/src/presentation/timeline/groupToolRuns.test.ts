// groupToolRuns 单测：相邻工具折叠、被其他块打断、运行 / 失败计数、锚点 id。
import type { TimelineBlock, ToolBlock } from './buildTimeline';
import { groupToolRuns } from './groupToolRuns';

function tool(
  id: string,
  status: ToolBlock['status'] = 'done',
  atMs = 1
): ToolBlock {
  return {
    kind: 'tool',
    id,
    toolName: 'read_file',
    summary: id,
    status,
    output: '',
    atMs,
  };
}

const message: TimelineBlock = {
  kind: 'message',
  id: 'm-1',
  role: 'assistant',
  text: '好的',
  streaming: false,
  atMs: 5,
};

describe('groupToolRuns', () => {
  it('空输入 → 空输出', () => {
    expect(groupToolRuns([])).toEqual([]);
  });

  it('相邻工具折叠为一组，锚点为首个工具 id', () => {
    const out = groupToolRuns([tool('a', 'done', 1), tool('b', 'done', 2)]);
    expect(out).toHaveLength(1);
    const run = out[0];
    expect(run?.kind).toBe('toolRun');
    if (run?.kind !== 'toolRun') return;
    expect(run.id).toBe('a');
    expect(run.atMs).toBe(1);
    expect(run.tools.map((t) => t.id)).toEqual(['a', 'b']);
    expect(run.latest.id).toBe('b');
  });

  it('非工具块打断折叠并原样透传', () => {
    const out = groupToolRuns([tool('a'), message, tool('b')]);
    expect(out.map((b) => b.kind)).toEqual(['toolRun', 'message', 'toolRun']);
    expect(out[1]).toBe(message);
  });

  it('统计运行中与失败数', () => {
    const out = groupToolRuns([
      tool('a', 'error'),
      tool('b', 'done'),
      tool('c', 'running'),
    ]);
    const run = out[0];
    if (run?.kind !== 'toolRun') throw new Error('应为 toolRun');
    expect(run.running).toBe(1);
    expect(run.failed).toBe(1);
  });

  it('单个工具也折叠成摘要', () => {
    const out = groupToolRuns([message, tool('solo')]);
    expect(out[1]?.kind).toBe('toolRun');
  });
});
