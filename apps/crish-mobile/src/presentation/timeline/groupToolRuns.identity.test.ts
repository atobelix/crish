// groupToolRuns 身份纪律：一个工具组的构成集（成员工具块引用序列）
// 不变时，组块必须返回同一对象引用；构成集任一成员换新 / 增长 / 缩短
// 即换新组块。非工具块原样透传（引用不变，本套件一并钉死）。
import type { ReasoningBlock, TimelineBlock, ToolBlock } from './buildTimeline';
import {
  groupToolRuns,
  isToolRunActive,
  isToolRunSealed,
} from './groupToolRuns';

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

describe('groupToolRuns 身份纪律', () => {
  it('已封口组（后随消息块）保持引用；尾组随成员换新而换新', () => {
    const a = tool('a', 'done', 1);
    const b = tool('b', 'done', 2);
    const cRunning = tool('c', 'running', 3);
    const out1 = groupToolRuns([a, b, message, cRunning]);
    const cDone: ToolBlock = { ...cRunning, status: 'done' };
    const out2 = groupToolRuns([a, b, message, cDone]);
    expect(out2[0]).toBe(out1[0]);
    expect(out2[1]).toBe(message);
    expect(out2[2]).not.toBe(out1[2]);
    if (out2[2]?.kind !== 'toolRun') throw new Error('应为 toolRun');
    expect(out2[2].tools[0]).toBe(cDone);
    expect(out2[2].running).toBe(0);
  });

  it('尾组增长（新工具追加）→ 组块换新且成员完整；已封口组不受影响', () => {
    const a = tool('a', 'done', 1);
    const b = tool('b', 'done', 2);
    const c = tool('c', 'done', 3);
    const out1 = groupToolRuns([a, b, message, c]);
    const d = tool('d', 'done', 4);
    const out2 = groupToolRuns([a, b, message, c, d]);
    expect(out2[0]).toBe(out1[0]);
    expect(out2[2]).not.toBe(out1[2]);
    if (out2[2]?.kind !== 'toolRun') throw new Error('应为 toolRun');
    expect(out2[2].tools.map((t) => t.id)).toEqual(['c', 'd']);
    expect(out2[2].latest.id).toBe('d');
  });

  it('同一输入重复分组 → 已封口组与再次调用结果逐元素同引用', () => {
    const a = tool('a', 'done', 1);
    const b = tool('b', 'error', 2);
    const input = [a, b, message];
    const out1 = groupToolRuns(input);
    const out2 = groupToolRuns(input);
    expect(out2[0]).toBe(out1[0]);
    expect(out2[1]).toBe(out1[1]);
  });

  it('构成集校验：同锚点、成员缩短 → 换新组块（不误用长组缓存）', () => {
    const a = tool('a', 'done', 1);
    const b = tool('b', 'done', 2);
    const long = groupToolRuns([a, b]);
    const short = groupToolRuns([a]);
    expect(short[0]).not.toBe(long[0]);
    if (short[0]?.kind !== 'toolRun') throw new Error('应为 toolRun');
    expect(short[0].tools).toHaveLength(1);
    expect(short[0].tools[0]).toBe(a);
  });

  it('流式进行中态 vs 终态封口规约：running / success / error 状态精确判定', () => {
    const tRunning1 = tool('t1', 'running', 1);
    const tRunning2 = tool('t2', 'running', 2);
    const outRunning = groupToolRuns([tRunning1, tRunning2]);
    const runActive = outRunning[0];
    if (runActive?.kind !== 'toolRun') throw new Error('应为 toolRun');
    expect(runActive.status).toBe('running');
    expect(runActive.active).toBe(true);
    expect(runActive.isSealed).toBe(false);
    expect(isToolRunActive(runActive)).toBe(true);
    expect(isToolRunSealed(runActive)).toBe(false);
    expect(runActive.activeTool?.id).toBe('t1');

    // 终态全成功封口
    const tDone1: ToolBlock = { ...tRunning1, status: 'done' };
    const tDone2: ToolBlock = { ...tRunning2, status: 'done' };
    const outSuccess = groupToolRuns([tDone1, tDone2]);
    const runSuccess = outSuccess[0];
    if (runSuccess?.kind !== 'toolRun') throw new Error('应为 toolRun');
    expect(runSuccess.status).toBe('success');
    expect(runSuccess.active).toBe(false);
    expect(runSuccess.isSealed).toBe(true);
    expect(isToolRunActive(runSuccess)).toBe(false);
    expect(isToolRunSealed(runSuccess)).toBe(true);

    // 终态含失败封口
    const tError1: ToolBlock = { ...tRunning1, status: 'error' };
    const outError = groupToolRuns([tError1, tDone2]);
    const runError = outError[0];
    if (runError?.kind !== 'toolRun') throw new Error('应为 toolRun');
    expect(runError.status).toBe('error');
    expect(runError.active).toBe(false);
    expect(runError.isSealed).toBe(true);
  });

  it('ReasoningBlock 透传并打断工具聚合，且保持对象引用不变', () => {
    const reasoning: ReasoningBlock = {
      kind: 'reasoning',
      id: 'r-1',
      text: '分析中',
      streaming: false,
      isThinking: false,
      atMs: 2,
    };
    const t1 = tool('t1', 'done', 1);
    const t2 = tool('t2', 'done', 3);
    const out = groupToolRuns([t1, reasoning, t2]);
    expect(out).toHaveLength(3);
    expect(out.map((b) => b.kind)).toEqual(['toolRun', 'reasoning', 'toolRun']);
    expect(out[1]).toBe(reasoning); // 保持同一引用
  });
});
