// buildLocalTimeline 投影口径（统一方案 §2.1）：四态钉死——
// 完成 / 流式中 / 已停止 / 工具提示，及 system 不呈现、空正文过滤、
// 诚实标注不被空正文吞掉的边界。
import { buildLocalTimeline } from './buildLocalTimeline';
import type { LocalChatMessage } from '@/domain/types/localChat';

const msg = (
  overrides: Partial<LocalChatMessage> & Pick<LocalChatMessage, 'id' | 'role'>
): LocalChatMessage => ({ content: '', ...overrides });

describe('buildLocalTimeline', () => {
  it('完成态：user / assistant 顺序投影为 message 块（streaming=false）', () => {
    const blocks = buildLocalTimeline([
      msg({ id: 'u1', role: 'user', content: '你好' }),
      msg({ id: 'a1', role: 'assistant', content: '你好，我在。' }),
    ]);
    expect(blocks).toEqual([
      {
        kind: 'message',
        id: 'u1',
        role: 'user',
        text: '你好',
        streaming: false,
        atMs: 0,
      },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        text: '你好，我在。',
        streaming: false,
        atMs: 0,
      },
    ]);
  });

  it('流式中：streaming 透传；尚无正文的流式占位不占行', () => {
    const blocks = buildLocalTimeline([
      msg({ id: 'u1', role: 'user', content: '讲个故事' }),
      msg({ id: 'a1', role: 'assistant', content: '从前', streaming: true }),
      msg({ id: 'a2', role: 'assistant', content: '', streaming: true }),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({
      kind: 'message',
      id: 'a1',
      text: '从前',
      streaming: true,
    });
  });

  it('已停止：正文后补 muted notice「已停止生成」', () => {
    const blocks = buildLocalTimeline([
      msg({ id: 'a1', role: 'assistant', content: '一半', stopped: true }),
    ]);
    expect(blocks).toEqual([
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        text: '一半',
        streaming: false,
        atMs: 0,
      },
      {
        kind: 'notice',
        id: 'a1:stopped',
        text: '已停止生成',
        tone: 'muted',
        atMs: 0,
      },
    ]);
  });

  it('工具提示：toolCallCount 补 muted notice', () => {
    const blocks = buildLocalTimeline([
      msg({
        id: 'a1',
        role: 'assistant',
        content: '完成',
        toolCallCount: 3,
      }),
    ]);
    expect(blocks[1]).toEqual({
      kind: 'notice',
      id: 'a1:tools',
      text: '本地对话暂不支持工具调用',
      tone: 'muted',
      atMs: 0,
    });
  });

  it('停止 + 工具同现：两条标注齐发，停止在前（旧视图呈现序）', () => {
    const blocks = buildLocalTimeline([
      msg({
        id: 'a1',
        role: 'assistant',
        content: '部分',
        stopped: true,
        toolCallCount: 1,
      }),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['message', 'notice', 'notice']);
    expect(blocks[1]).toMatchObject({ id: 'a1:stopped' });
    expect(blocks[2]).toMatchObject({ id: 'a1:tools' });
  });

  it('system 消息不呈现；正文为空的完成消息不占行', () => {
    const blocks = buildLocalTimeline([
      msg({ id: 's1', role: 'system', content: '系统提示' }),
      msg({ id: 'a1', role: 'assistant', content: '   ' }),
      msg({ id: 'u1', role: 'user', content: '在吗' }),
    ]);
    expect(blocks).toEqual([
      {
        kind: 'message',
        id: 'u1',
        role: 'user',
        text: '在吗',
        streaming: false,
        atMs: 0,
      },
    ]);
  });

  it('空正文 + 工具计数：正文块不发，工具提示照常发（诚实信号不吞）', () => {
    const blocks = buildLocalTimeline([
      msg({ id: 'a1', role: 'assistant', content: '', toolCallCount: 2 }),
    ]);
    expect(blocks).toEqual([
      {
        kind: 'notice',
        id: 'a1:tools',
        text: '本地对话暂不支持工具调用',
        tone: 'muted',
        atMs: 0,
      },
    ]);
  });

  it('本地消息支持思考内容映射为 ReasoningBlock，且排在正文之前', () => {
    const blocks = buildLocalTimeline([
      {
        ...msg({ id: 'a1', role: 'assistant', content: '最终回答' }),
        reasoning: '深度分析推理中……',
      } as LocalChatMessage,
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      kind: 'reasoning',
      id: 'a1:reasoning',
      text: '深度分析推理中……',
      streaming: false,
      isThinking: false,
      atMs: 0,
    });
    expect(blocks[1]).toEqual({
      kind: 'message',
      id: 'a1',
      role: 'assistant',
      text: '最终回答',
      streaming: false,
      atMs: 0,
    });
  });

  it('本地消息 isThinking 状态映射为流式 ReasoningBlock 骨架', () => {
    const blocks = buildLocalTimeline([
      {
        ...msg({ id: 'a2', role: 'assistant', content: '', streaming: true }),
        isThinking: true,
      } as LocalChatMessage,
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      kind: 'reasoning',
      id: 'a2:reasoning',
      text: '',
      streaming: true,
      isThinking: true,
      atMs: 0,
    });
  });
});
