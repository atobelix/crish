// 时间线身份纪律（结构共享）测试：同一批 entry 引用重复构建时，
// 构成本轮未变的块必须返回同一对象引用（memo(TimelineBlockView) 浅
// 比较的命门）；被本轮条目触碰的块换新对象；合并不变量（多条目累积
// 成一个块）在缓存下逐字不变；输入分歧（条目被替换 / 缩短）时全量
// 重算，绝不吃缓存旧值。
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

const startMsg = (id: string) =>
  entry('message-start', { message: { id, role: 'assistant' } });
const delta = (id: string, text: string) =>
  entry('message-delta', {
    messageId: id,
    block: { type: 'text', text },
  });
const endMsg = (id: string, text: string) =>
  entry('message-end', {
    message: { id, role: 'assistant', blocks: [{ type: 'text', text }] },
  });

describe('buildSessionTimeline 身份纪律', () => {
  it('已封口消息块在后续构建中保持同一引用；流式尾块换新', () => {
    const head = [
      startMsg('m-1'),
      delta('m-1', '你好'),
      endMsg('m-1', '你好，世界'),
    ];
    const tailStart = startMsg('m-2');
    const d1 = delta('m-2', '半');
    const first = buildSessionTimeline([...head, tailStart, d1]);
    const second = buildSessionTimeline([
      ...head,
      tailStart,
      d1,
      delta('m-2', '句'),
    ]);
    expect(second).toHaveLength(2);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]).toMatchObject({
      id: 'm-2',
      text: '半句',
      streaming: true,
    });
  });

  it('同一输入数组重复构建 → 返回同一数组引用', () => {
    const entries = [
      startMsg('m-1'),
      delta('m-1', '你好'),
      endMsg('m-1', '你好'),
    ];
    const a = buildSessionTimeline(entries);
    const b = buildSessionTimeline(entries);
    expect(b).toBe(a);
  });

  it('工具合并累积：封口工具块保持引用且累积输出完整（多条目构成集）', () => {
    const base = [
      entry('tool-start', {
        call: { id: 't-1', toolName: 'read_file', summary: 'src/a.ts' },
      }),
      entry('tool-update', { toolCallId: 't-1', update: { text: 'line 1\n' } }),
      entry('tool-update', { toolCallId: 't-1', update: { text: 'line 2' } }),
      entry('tool-end', {
        toolCallId: 't-1',
        result: { isError: false, output: 'done' },
      }),
    ];
    const first = buildSessionTimeline(base);
    const second = buildSessionTimeline([
      ...base,
      entry('tool-start', { call: { id: 't-2', toolName: 'shell' } }),
      entry('tool-update', { toolCallId: 't-2', update: { text: 'x' } }),
    ]);
    expect(second[0]).toBe(first[0]);
    const sealed = second[0] as { output: string };
    expect(sealed.output).toContain('line 1');
    expect(sealed.output).toContain('line 2');
    expect(sealed.output).toContain('done');
    expect(second[1]).toMatchObject({ id: 't-2', status: 'running' });
  });

  it('封口只是缓存提示：迟到的 tool-update 仍按折叠语义更新该块（换新对象）', () => {
    const base = [
      entry('tool-start', { call: { id: 't-1', toolName: 'shell' } }),
      entry('tool-end', {
        toolCallId: 't-1',
        result: { isError: false, output: 'done' },
      }),
    ];
    const first = buildSessionTimeline(base);
    const second = buildSessionTimeline([
      ...base,
      entry('tool-update', { toolCallId: 't-1', update: { text: 'late' } }),
    ]);
    expect(second[0]).not.toBe(first[0]);
    expect((second[0] as { output: string }).output).toContain('late');
  });

  it('审批被 resolved 触碰时仅审批块换新，未触碰的提示块保持引用', () => {
    const base = [
      entry('approval-requested', {
        toolCallId: 'tc-1',
        toolName: 'write_file',
        summary: '写入 src/a.ts',
      }),
      entry('runtime-error', { error: 'boom' }),
    ];
    const first = buildSessionTimeline(base);
    const second = buildSessionTimeline([
      ...base,
      entry('approval-resolved', { toolCallId: 'tc-1', decision: 'approved' }),
    ]);
    expect(second[1]).toBe(first[1]);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]).toMatchObject({ kind: 'approval', status: 'approved' });
  });

  it('流式高频追加：每步仅流式尾块换新，其余块零重建', () => {
    const head = [
      startMsg('m-1'),
      delta('m-1', '你好'),
      endMsg('m-1', '你好，世界'),
      entry('tool-start', { call: { id: 't-1', toolName: 'read_file' } }),
      entry('tool-end', {
        toolCallId: 't-1',
        result: { isError: false, output: 'done' },
      }),
      entry('runtime-error', { error: 'boom' }),
    ];
    const tailStart = startMsg('m-2');
    const d1 = delta('m-2', '一');
    const first = buildSessionTimeline([...head, tailStart, d1]);
    const second = buildSessionTimeline([
      ...head,
      tailStart,
      d1,
      delta('m-2', '二'),
    ]);
    expect(second).toHaveLength(first.length);
    const changed = second.filter((block, i) => block !== first[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ id: 'm-2', text: '一二' });
  });

  it('中段条目被替换（同 seq 覆盖）→ 全量重算，不吃缓存旧值', () => {
    const start = startMsg('m-1');
    const deltaA = delta('m-1', '甲');
    const first = buildSessionTimeline([start, deltaA]);
    expect(first[0]).toMatchObject({ text: '甲' });
    const deltaB = delta('m-1', '乙');
    const second = buildSessionTimeline([start, deltaB]);
    expect(second[0]).toMatchObject({ text: '乙' });
    expect(second[0]).not.toBe(first[0]);
  });

  it('输入缩短 → 按新输入重算；之后再延长仍正确', () => {
    const start = startMsg('m-1');
    const d = delta('m-1', '全文');
    const end = endMsg('m-1', '全文');
    const long = buildSessionTimeline([start, d, end]);
    expect(long).toHaveLength(1);
    const short = buildSessionTimeline([start]);
    expect(short).toHaveLength(0);
    const again = buildSessionTimeline([start, d, end]);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ text: '全文', streaming: false });
  });

  it('解封恢复思考链：thought 块映射为专属 ReasoningBlock，耗时与 isThinking 状态流转完整', () => {
    const start = startMsg('m-r');
    const t1 = entry('message-delta', {
      messageId: 'm-r',
      block: { type: 'thought', text: '正在分析' },
    });
    const t2 = entry('message-delta', {
      messageId: 'm-r',
      block: { type: 'thought', text: '代码结构……' },
    });
    const first = buildSessionTimeline([start, t1, t2]);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: 'reasoning',
      id: 'm-r:reasoning',
      text: '正在分析代码结构……',
      streaming: true,
      isThinking: true,
    });

    // 正文到来，思考链终态封口并计算 durationMs，正文开始流式追加
    const d1 = delta('m-r', '这是');
    const second = buildSessionTimeline([start, t1, t2, d1]);
    expect(second).toHaveLength(2);
    expect(second[0]).toMatchObject({
      kind: 'reasoning',
      id: 'm-r:reasoning',
      streaming: false,
      isThinking: false,
    });
    expect(
      (second[0] as { durationMs?: number }).durationMs
    ).toBeGreaterThanOrEqual(0);
    expect(second[1]).toMatchObject({
      kind: 'message',
      id: 'm-r',
      text: '这是',
      streaming: true,
    });

    // 结构共享断言：随后的正文增量只换新正文块，已封口的思考块必须保持同一对象引用
    const d2 = delta('m-r', '回答');
    const third = buildSessionTimeline([start, t1, t2, d1, d2]);
    expect(third).toHaveLength(2);
    expect(third[0]).toBe(second[0]); // 思考块引用完全复用！
    expect(third[1]).not.toBe(second[1]);
    expect(third[1]).toMatchObject({ text: '这是回答' });
  });

  it('0 文本思考中占位防抖：即使 thought 文本尚未到达，isThinking 状态依然发射骨架块以锁死高度', () => {
    const start = startMsg('m-zero');
    const t0 = entry('message-delta', {
      messageId: 'm-zero',
      block: { type: 'thought', text: '' },
    });
    const timeline = buildSessionTimeline([start, t0]);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      kind: 'reasoning',
      id: 'm-zero:reasoning',
      text: '',
      streaming: true,
      isThinking: true,
    });
  });

  it('纯思考流不丢弃：没有正文仅有思考时，ReasoningBlock 依然完整呈现', () => {
    const start = startMsg('m-pure');
    const t = entry('message-delta', {
      messageId: 'm-pure',
      block: { type: 'thought', text: '仅思考不回复' },
    });
    const end = entry('message-end', {
      message: {
        id: 'm-pure',
        role: 'assistant',
        blocks: [{ type: 'thought', text: '仅思考不回复' }],
      },
    });
    const timeline = buildSessionTimeline([start, t, end]);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      kind: 'reasoning',
      id: 'm-pure:reasoning',
      text: '仅思考不回复',
      streaming: false,
      isThinking: false,
    });
  });
});
