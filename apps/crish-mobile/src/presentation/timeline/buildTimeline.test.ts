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

  it('运行终态转系统提示，失败先分类映射（原始串退居详情，批 C ⑮）', () => {
    const blocks = buildSessionTimeline([
      entry('run-terminal', { terminal: 'failed', error: '工具超时' }),
    ]);
    // 「工具超时」按本地封闭分类归 network：主文案 = 分类文案，
    // 原始串只进 detail（点开才见），不再直接内联
    expect(blocks[0]).toMatchObject({
      kind: 'notice',
      tone: 'danger',
      text: '网络不可达：无法连接供应商服务，请检查网络与 Base URL。',
      detail: '工具超时',
    });
  });

  it('image 块如实入时间线：url 来源直用，落消息块之后', () => {
    const blocks = buildSessionTimeline([
      entry('message-end', {
        message: {
          id: 'm-img',
          role: 'assistant',
          blocks: [
            { type: 'text', text: '这是生成的图：' },
            {
              type: 'image',
              mimeType: 'image/png',
              url: 'https://example.com/a.png',
              alt: '示意图',
            },
          ],
        },
      }),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['message', 'image']);
    expect(blocks[1]).toMatchObject({
      kind: 'image',
      id: 'm-img:image:0',
      source: 'https://example.com/a.png',
      alt: '示意图',
    });
  });

  it('image 块 data 裸 base64 拼 data URI；完整 data URI 直用', () => {
    const blocks = buildSessionTimeline([
      entry('message-end', {
        message: {
          id: 'm-data',
          role: 'assistant',
          blocks: [
            { type: 'image', mimeType: 'image/jpeg', data: 'QUJD' },
            {
              type: 'image',
              mimeType: 'image/png',
              data: 'data:image/png;base64,REVG',
            },
          ],
        },
      }),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      source: 'data:image/jpeg;base64,QUJD',
    });
    expect(blocks[1]).toMatchObject({
      source: 'data:image/png;base64,REVG',
    });
  });

  it('image 块无可用来源 → source 为 null（呈现占位行，不静默丢弃）', () => {
    const blocks = buildSessionTimeline([
      entry('message-end', {
        message: {
          id: 'm-nosrc',
          role: 'assistant',
          blocks: [{ type: 'image', mimeType: 'image/png', alt: '缺失的图' }],
        },
      }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'image',
      source: null,
      alt: '缺失的图',
    });
  });

  it('纯图片消息（无正文）不被空消息过滤吞掉', () => {
    const blocks = buildSessionTimeline([
      entry('message-start', { message: { id: 'm-only', role: 'assistant' } }),
      entry('message-end', {
        message: {
          id: 'm-only',
          role: 'assistant',
          blocks: [
            {
              type: 'image',
              mimeType: 'image/png',
              url: 'https://example.com/only.png',
            },
          ],
        },
      }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'image', id: 'm-only:image:0' });
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

  describe('体验降噪与非空守门（移动端 UI 体验重构）', () => {
    it('纯工具调用无正文时，不生成空文本 message 块', () => {
      const blocks = buildSessionTimeline([
        entry('message-start', {
          message: { id: 'm-tool-only', role: 'assistant' },
        }),
        entry('tool-start', {
          call: {
            id: 't-only',
            toolName: 'read_file',
            summary: 'src/main.ts',
          },
        }),
        entry('tool-end', {
          toolCallId: 't-only',
          result: { isError: false, output: 'file content' },
        }),
        entry('message-end', {
          message: {
            id: 'm-tool-only',
            role: 'assistant',
            blocks: [],
          },
        }),
      ]);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.kind).toBe('tool');
      expect(blocks.some((b) => b.kind === 'message')).toBe(false);
    });

    it('全空白字符与零宽不可见字符不得进入时间线', () => {
      const blocks = buildSessionTimeline([
        entry('message-start', {
          message: { id: 'm-ghost', role: 'assistant' },
        }),
        entry('message-delta', {
          messageId: 'm-ghost',
          block: { type: 'text', text: '   \n \u200B\uFEFF  ' },
        }),
      ]);
      expect(blocks).toHaveLength(0);
    });

    it('无思考内容的思考链在收口后自动销毁，不发射空壳', () => {
      const blocks = buildSessionTimeline([
        entry('message-start', {
          message: { id: 'm-empty-think', role: 'assistant' },
        }),
        entry('message-delta', {
          messageId: 'm-empty-think',
          thought: '   \u200B  ',
        }),
        entry('message-end', {
          message: {
            id: 'm-empty-think',
            role: 'assistant',
            blocks: [{ type: 'text', text: '这是正文' }],
          },
        }),
      ]);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        kind: 'message',
        text: '这是正文',
      });
      expect(blocks.some((b) => b.kind === 'reasoning')).toBe(false);
    });

    it('run-terminal: completed 完全不产生时间线条目', () => {
      const blocks = buildSessionTimeline([
        entry('message-start', {
          message: { id: 'm-done', role: 'assistant' },
        }),
        entry('message-delta', {
          messageId: 'm-done',
          block: { type: 'text', text: '回答结束' },
        }),
        entry('message-end', {
          message: {
            id: 'm-done',
            role: 'assistant',
            blocks: [{ type: 'text', text: '回答结束' }],
          },
        }),
        entry('run-terminal', {
          terminal: 'completed',
        }),
      ]);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ kind: 'message', text: '回答结束' });
      expect(blocks.some((b) => b.kind === 'notice')).toBe(false);
    });
  });
});
