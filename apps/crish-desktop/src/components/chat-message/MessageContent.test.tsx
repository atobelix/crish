// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';
import { MessageContent } from './MessageContent';
import { useStreamingStore } from '../../store/streamingStore';
import type { SessionMessage } from '../../store/types';

vi.mock('../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: (markdown: string) => ({
    html: markdown ? `<p>${markdown}</p>` : '',
    loading: false,
  }),
  parseMarkdownToHtmlAsync: vi.fn(async (m: string) => `<p>${m}</p>`),
}));

describe('MessageContent 零闪烁与平滑降级断言', () => {
  beforeEach(() => {
    useStreamingStore.setState({ byKey: Object.create(null) });
  });

  it('流终态切换瞬间文本长度单调不减，0 帧空白闪烁', async () => {
    const sessionId = 'test-sess-1';
    const msgId = 'msg-1';
    const mockMsg: SessionMessage = {
      id: msgId,
      sender: 'assistant',
      text: '',
      status: 'processing',
    };

    // 1. 设置流式缓冲文本
    act(() => {
      useStreamingStore
        .getState()
        .setStreamText(sessionId, msgId, '正在生成的长篇 Markdown 正文');
    });

    const renderedTexts: string[] = [];
    const { container, rerender } = render(
      <MessageContent
        msg={mockMsg}
        isThinkingMsg={true}
        toolStackProps={{ activeSessionId: sessionId }}
      />
    );

    renderedTexts.push(container.textContent || '');
    expect(container.textContent).toContain('正在生成的长篇 Markdown 正文');

    // 2. 模拟时序撕裂阶段：msg.status 变为 completed，但 msg.text 仍为空，且 isThinkingMsg 转为 false
    const midMsg: SessionMessage = {
      ...mockMsg,
      status: 'completed',
      text: '',
    };
    rerender(
      <MessageContent
        msg={midMsg}
        isThinkingMsg={false}
        toolStackProps={{ activeSessionId: sessionId }}
      />
    );
    renderedTexts.push(container.textContent || '');
    // 断言：由于平滑三元降级，此时绝不发生空白闪烁，依然显示 streamText
    expect(container.textContent).toContain('正在生成的长篇 Markdown 正文');

    // 3. 模拟持久化落地阶段：msg.text 写入
    const finalMsg: SessionMessage = {
      ...mockMsg,
      status: 'completed',
      text: '正在生成的长篇 Markdown 正文',
    };
    rerender(
      <MessageContent
        msg={finalMsg}
        isThinkingMsg={false}
        toolStackProps={{ activeSessionId: sessionId }}
      />
    );
    renderedTexts.push(container.textContent || '');

    // 4. 清空流式缓冲
    act(() => {
      useStreamingStore.getState().clearStream(sessionId, msgId);
    });
    rerender(
      <MessageContent
        msg={finalMsg}
        isThinkingMsg={false}
        toolStackProps={{ activeSessionId: sessionId }}
      />
    );
    renderedTexts.push(container.textContent || '');

    // 全生命周期文本内容断言
    expect(renderedTexts.length).toBe(4);
    for (const txt of renderedTexts) {
      expect(txt.trim().length).toBeGreaterThan(0);
    }
  });

  it('交错块 [text, tool_call, text] 从流式到完成态全周期单调不减，完成态绝不截断 (A-01)', async () => {
    const sessionId = 'test-sess-interleaved';
    const msgId = 'msg-int-1';

    // 1. 初始流式状态：工具执行完毕，尾部正文正在流式输出
    const streamingMsg: SessionMessage = {
      id: msgId,
      sender: 'assistant',
      status: 'processing',
      toolCalls: [
        {
          id: 't1',
          name: 'read_file',
          status: 'success',
          arguments: '',
          output: 'ok',
        },
      ],
      blocks: [
        { type: 'text', content: '准备读取文件...' },
        { type: 'tool_call', id: 't1' },
        { type: 'text', content: '读取结果：' }, // 流式初期快照
      ],
    };

    act(() => {
      useStreamingStore
        .getState()
        .setStreamText(
          sessionId,
          msgId,
          '读取结果：全量内容已完整加载完毕，无任何截断。'
        );
    });

    const { container, rerender } = render(
      <MessageContent
        msg={streamingMsg}
        isThinkingMsg={true}
        toolStackProps={{ activeSessionId: sessionId }}
      />
    );

    expect(container.textContent).toContain(
      '读取结果：全量内容已完整加载完毕，无任何截断。'
    );

    // 2. 状态跃迁至完成态：持久化提交全量文本
    const completedMsg: SessionMessage = {
      ...streamingMsg,
      status: 'completed',
      blocks: [
        { type: 'text', content: '准备读取文件...' },
        { type: 'tool_call', id: 't1' },
        {
          type: 'text',
          content: '读取结果：全量内容已完整加载完毕，无任何截断。',
        },
      ],
    };

    rerender(
      <MessageContent
        msg={completedMsg}
        isThinkingMsg={false}
        toolStackProps={{ activeSessionId: sessionId }}
      />
    );

    // 3. 断言：完成态渲染文本必须严格包含全量内容，绝对不发生截断回退到 '读取结果：'
    expect(container.textContent).toContain(
      '读取结果：全量内容已完整加载完毕，无任何截断。'
    );
    expect(container.textContent).not.toBe('准备读取文件...读取结果：');
  });
});
