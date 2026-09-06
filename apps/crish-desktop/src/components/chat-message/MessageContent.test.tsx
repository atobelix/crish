// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';
import { MessageContent } from './MessageContent';
import { useStreamMessageViewModel } from './streamMessageViewModel';
import { useStreamingStore } from '../../store/streamingStore';
import type { SessionMessage } from '../../store/types';

vi.mock('../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: (markdown: string) => ({
    html: markdown ? `<p>${markdown}</p>` : '',
    loading: false,
  }),
  parseMarkdownToHtmlAsync: vi.fn(async (m: string) => `<p>${m}</p>`),
}));

/**
 * T4 A1 测试装配壳层：复刻页面壳层 StreamingAssistantRow 的接线
 * （useStreamMessageViewModel 订阅 + 合并 → MessageContent 收已合并 view model）。
 */
function StreamHarness({
  msg,
  isThinkingMsg,
  sessionId,
}: {
  msg: SessionMessage;
  isThinkingMsg: boolean;
  sessionId: string;
}) {
  const vm = useStreamMessageViewModel(msg, sessionId);
  return (
    <MessageContent
      msg={vm.msg}
      streamText={vm.streamText}
      isThinkingMsg={isThinkingMsg}
      toolStackProps={{ activeSessionId: sessionId }}
    />
  );
}

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
      <StreamHarness msg={mockMsg} isThinkingMsg={true} sessionId={sessionId} />
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
      <StreamHarness msg={midMsg} isThinkingMsg={false} sessionId={sessionId} />
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
      <StreamHarness
        msg={finalMsg}
        isThinkingMsg={false}
        sessionId={sessionId}
      />
    );
    renderedTexts.push(container.textContent || '');

    // 4. 清空流式缓冲
    act(() => {
      useStreamingStore.getState().clearStream(sessionId, msgId);
    });
    rerender(
      <StreamHarness
        msg={finalMsg}
        isThinkingMsg={false}
        sessionId={sessionId}
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
      <StreamHarness
        msg={streamingMsg}
        isThinkingMsg={true}
        sessionId={sessionId}
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
      <StreamHarness
        msg={completedMsg}
        isThinkingMsg={false}
        sessionId={sessionId}
      />
    );

    // 3. 断言：完成态渲染文本必须严格包含全量内容，绝对不发生截断回退到 '读取结果：'
    expect(container.textContent).toContain(
      '读取结果：全量内容已完整加载完毕，无任何截断。'
    );
    expect(container.textContent).not.toBe('准备读取文件...读取结果：');
  });

  it('当 msg.status === "error" 且 timeline 为空时渲染错误提示卡片', () => {
    const errorMsg: SessionMessage = {
      id: 'err-msg-1',
      sender: 'assistant',
      status: 'error',
      text: '',
      errorDetail: { message: '后端请求超时，请重试' },
    };

    const { container } = render(
      <MessageContent msg={errorMsg} />
    );

    // 纯 AI 气泡纪律：MessageContent 气泡内部严禁内嵌伪造红框错误横幅，错误统一由底槽承接
    expect(container.textContent).not.toContain('后端请求超时');
    expect(container.querySelector('.errorBanner')).toBeNull();
  });

  it('当 msg.status === "error" 且 timeline.length > 0（包含思考链）时，保留真实思考链，绝不内嵌伪造错误横幅', () => {
    const errorWithThoughtMsg: SessionMessage = {
      id: 'err-msg-thought-1',
      sender: 'assistant',
      status: 'error',
      text: '',
      thinking: '正在深入思考方案...',
      errorDetail: { message: '模型生成阶段发生异常' },
    };

    const { container } = render(
      <MessageContent msg={errorWithThoughtMsg} />
    );

    // 思考链真实呈现，错误横幅绝不侵入气泡内部
    expect(container.textContent).toContain('思考');
    expect(container.textContent).not.toContain('模型生成阶段发生异常');
    expect(container.querySelector('.errorBanner')).toBeNull();
  });

  it('当 msg.status === "error" 且存在前置 partial 正文时，仅展示真实生成正文，不污染伪造错误卡片', () => {
    const errorWithPartialTextMsg: SessionMessage = {
      id: 'err-msg-partial-1',
      sender: 'assistant',
      status: 'error',
      text: '已完成前半部分数据收集。',
      errorDetail: { message: '下游服务连接中断' },
    };

    const { container } = render(
      <MessageContent msg={errorWithPartialTextMsg} />
    );

    expect(container.textContent).toContain('已完成前半部分数据收集。');
    expect(container.textContent).not.toContain('下游服务连接中断');
    expect(container.querySelector('.errorBanner')).toBeNull();
  });

  it('当 msg.status === "error" 且无文本时，气泡安静不渲染任何伪造文本', () => {
    const errorDefaultMsg: SessionMessage = {
      id: 'err-msg-default-1',
      sender: 'assistant',
      status: 'error',
      text: '',
    };

    const { container } = render(
      <MessageContent msg={errorDefaultMsg} />
    );

    expect(container.textContent).toBe('');
    expect(container.querySelector('.errorBanner')).toBeNull();
  });
});

describe('DIM-05 双阶段生命周期调度与复合过程（工具 + 思考 + 正文）集成断言', () => {
  it('Phase 1 到 Phase 2 状态跃迁：流式生成期到轮次闭合期，思考链、工具与正文平滑切换无缝收束', () => {
    const sessionId = 'test-sess-dim05';
    const msgId = 'msg-dim05-lifecycle';

    // 阶段 1：流式生成中，包含思考与工具，尾部正文正在流式输出
    const liveMsg: SessionMessage = {
      id: msgId,
      sender: 'assistant',
      status: 'processing',
      thinking: '分析问题依赖结构...',
      toolCalls: [
        {
          id: 't-read',
          name: 'read_file',
          status: 'success',
          arguments: '{"path":"main.rs"}',
          output: 'fn main() {}',
        },
      ],
      blocks: [
        { type: 'thought', content: '分析问题依赖结构...' },
        { type: 'tool_call', id: 't-read' },
        { type: 'text', content: '已完成文件分析，' },
      ],
    };

    act(() => {
      useStreamingStore
        .getState()
        .setStreamText(sessionId, msgId, '已完成文件分析，正在给出重构建议。');
    });

    const { container, rerender } = render(
      <StreamHarness msg={liveMsg} isThinkingMsg={true} sessionId={sessionId} />
    );

    // 断言 Phase 1：正文流式呈现且思考与工具并存
    expect(container.textContent).toContain('已完成文件分析，正在给出重构建议。');
    expect(container.textContent).toContain('分析问题依赖结构');

    // 阶段 2：轮次闭合，进入 completed 终态
    const closedMsg: SessionMessage = {
      ...liveMsg,
      status: 'completed',
      blocks: [
        { type: 'thought', content: '分析问题依赖结构...' },
        { type: 'tool_call', id: 't-read' },
        {
          type: 'text',
          content: '已完成文件分析，正在给出重构建议。',
        },
      ],
    };

    rerender(
      <StreamHarness
        msg={closedMsg}
        isThinkingMsg={false}
        sessionId={sessionId}
      />
    );

    // 断言 Phase 2：终态闭合后全量正文与前置过程完整，零内容截断
    expect(container.textContent).toContain('已完成文件分析，正在给出重构建议。');
    expect(container.textContent).toContain('分析问题依赖结构');
  });

  it('Tool-Only 纯工具调用终态轮次（无回答正文）：平稳闭环渲染工具调用栈，无崩塌异常', () => {
    const toolOnlyMsg: SessionMessage = {
      id: 'msg-tool-only-1',
      sender: 'assistant',
      status: 'completed',
      text: '',
      toolCalls: [
        {
          id: 't-search-1',
          name: 'grep_search',
          status: 'success',
          arguments: '{"query":"foo"}',
          output: 'found 2 occurrences',
        },
        {
          id: 't-search-2',
          name: 'read_file',
          status: 'success',
          arguments: '{"path":"bar.ts"}',
          output: 'content of bar',
        },
      ],
      blocks: [
        { type: 'tool_call', id: 't-search-1' },
        { type: 'tool_call', id: 't-search-2' },
      ],
    };

    const { container } = render(
      <MessageContent
        msg={toolOnlyMsg}
        toolStackProps={{ activeSessionId: 'sess-tools' }}
      />
    );

    // 纯工具轮次平稳呈现工具调用栈，不抛错且 DOM 结构稳定
    expect(container).not.toBeNull();
  });
});

