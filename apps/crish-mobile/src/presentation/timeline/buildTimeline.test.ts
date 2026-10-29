// 会话时间线投影测试：消息聚合 / 工具状态 / 审批 / 系统提示 / 噪声过滤。
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

describe('buildSessionTimeline', () => {
  it('聚合 message-delta 并用 message-end 终稿覆盖', () => {
    const blocks = buildSessionTimeline([
      entry('message-start', { message: { id: 'm-1', role: 'assistant' } }),
      entry('message-delta', {
        messageId: 'm-1',
        block: { type: 'text', text: '你好' },
      }),
      entry('message-delta', {
        messageId: 'm-1',
        block: { type: 'text', text: '，世界' },
      }),
      entry('message-end', {
        message: {
          id: 'm-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: '你好，世界！' }],
        },
      }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'message',
      id: 'm-1',
      text: '你好，世界！',
      streaming: false,
    });
  });

  it('工具调用按 id 合并输出并落终态', () => {
    const blocks = buildSessionTimeline([
      entry('tool-start', {
        call: { id: 't-1', toolName: 'read_file', summary: 'src/a.ts' },
      }),
      entry('tool-update', {
        toolCallId: 't-1',
        update: { text: 'line 1\n' },
      }),
      entry('tool-update', {
        toolCallId: 't-1',
        update: { text: 'line 2' },
      }),
      entry('tool-end', {
        toolCallId: 't-1',
        result: { isError: false, output: 'done' },
      }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'tool',
      id: 't-1',
      toolName: 'read_file',
      status: 'done',
    });
    expect((blocks[0] as { output: string }).output).toContain('line 1');
    expect((blocks[0] as { output: string }).output).toContain('done');
  });

  it('工具失败标记 error', () => {
    const blocks = buildSessionTimeline([
      entry('tool-start', { call: { id: 't-2', toolName: 'shell' } }),
      entry('tool-end', { toolCallId: 't-2', result: { isError: true } }),
    ]);
    expect(blocks[0]).toMatchObject({ kind: 'tool', status: 'error' });
  });

  it('审批请求与处理结果落同一块', () => {
    const blocks = buildSessionTimeline([
      entry('approval-requested', {
        toolCallId: 'tc-1',
        toolName: 'write_file',
        summary: '写入 src/a.ts',
      }),
      entry('approval-resolved', { toolCallId: 'tc-1', decision: 'approved' }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'approval',
      id: 'tc-1',
      status: 'approved',
    });
  });

  it('运行终态转系统提示，失败带原因', () => {
    const blocks = buildSessionTimeline([
      entry('run-terminal', { terminal: 'failed', error: '工具超时' }),
    ]);
    expect(blocks[0]).toMatchObject({
      kind: 'notice',
      tone: 'danger',
      text: '运行失败：工具超时',
    });
  });

  it('空正文消息不占位；未知事件忽略', () => {
    const blocks = buildSessionTimeline([
      entry('message-start', { message: { id: 'm-empty', role: 'assistant' } }),
      entry('cache-stats-updated', {}),
      entry('runtime-error', { error: 'boom' }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'notice', tone: 'danger' });
  });
});
