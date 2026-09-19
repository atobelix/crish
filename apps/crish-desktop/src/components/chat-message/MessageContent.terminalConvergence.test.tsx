// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/chat-message/MessageContent.terminalConvergence.test.tsx
 *
 * 【终态收敛契约】2026-09-11 用户裁决：
 *   「ai 回复正文的总结之后，只显示工作时长和总结内容」
 *
 * 断言目标（全链路宿主侧物证）：
 *   ① 流式执行期：过程段直出展开（铁律二），用户可见思考与工具明细；
 *   ② 总结正文抵达 / 轮次闭合：过程段自动收拢（铁律一），
 *      页面最终只外露「工作时间」控制栏 + 总结正文，过程明细挂
 *      `hidden="until-found"`（DOM 常驻，非卸载）；
 *   ③ 用户手动展开过的分段被「钉住」，终态收敛不得无声冲掉用户裁决；
 *   ④ 【铁律四】子代理段在任何阶段都不得被收起。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { expandMessageProcess } from './searchExpandBridge';
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

function Harness({
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

function tool(id: string, name: string) {
  return {
    id,
    name,
    status: 'success' as const,
    arguments: '{"path":"main.rs"}',
    output: 'fn main() {}',
  };
}

describe('终态收敛：总结抵达后只外露工作时长与总结正文', () => {
  beforeEach(() => {
    useStreamingStore.setState({ byKey: Object.create(null) });
  });

  it('流式执行期直出展开 → 总结正文抵达后自动收拢（DOM 常驻 hidden=until-found）', () => {
    cleanup();
    const sessionId = 'sess-conv-1';
    const msgId = 'msg-conv-1';

    // 阶段 1：流式执行中，两条工具调用，尚无总结正文
    const liveMsg: SessionMessage = {
      id: msgId,
      sender: 'assistant',
      status: 'processing',
      toolCalls: [tool('t-1', 'read_file'), tool('t-2', 'search_code')],
      blocks: [
        { type: 'tool_call', id: 't-1' },
        { type: 'tool_call', id: 't-2' },
      ],
    };

    const { container, rerender } = render(
      <Harness msg={liveMsg} isThinkingMsg={false} sessionId={sessionId} />
    );

    const slot = container.querySelector('[data-testid^="process-slot-"]');
    expect(slot, '过程段内容槽必须存在于 DOM').not.toBeNull();
    // 断言 ①：执行期直出展开（铁律二），不挂 hidden
    expect(slot?.getAttribute('hidden')).toBeNull();

    // 阶段 2：总结正文抵达，轮次闭合
    const closedMsg: SessionMessage = {
      ...liveMsg,
      status: 'completed',
      text: '已完成分析，读取了 main.rs 并全仓检索完毕。',
      blocks: [
        { type: 'tool_call', id: 't-1' },
        { type: 'tool_call', id: 't-2' },
        { type: 'text', content: '已完成分析，读取了 main.rs 并全仓检索完毕。' },
      ],
    };

    rerender(<Harness msg={closedMsg} isThinkingMsg={false} sessionId={sessionId} />);

    // 2026-09-19 用户裁决：彻底去除工作完成后的整体内容折叠，过程明细默认保持展开直出
    const slotAfter = container.querySelector('[data-testid^="process-slot-"]');
    expect(slotAfter, '过程段节点必须常驻').not.toBeNull();
    expect(slotAfter?.getAttribute('hidden')).toBeNull();

    // 断言 ③：总结正文照常外露
    expect(container.textContent).toContain('已完成分析');
    // 断言 ④：控制栏承载工作时长
    const bar = container.querySelector('[data-testid^="process-toggle-"]');
    expect(bar).not.toBeNull();
    expect(bar?.textContent ?? '').toMatch(/已完成\s/);
  });

  it('用户手动展开过的分段被钉住：终态收敛不得无声冲掉用户裁决', () => {
    cleanup();
    const sessionId = 'sess-conv-2';
    const msgId = 'msg-conv-2';

    const liveMsg: SessionMessage = {
      id: msgId,
      sender: 'assistant',
      status: 'processing',
      toolCalls: [tool('t-1', 'read_file'), tool('t-2', 'search_code')],
      blocks: [
        { type: 'tool_call', id: 't-1' },
        { type: 'tool_call', id: 't-2' },
      ],
    };

    const { container, rerender } = render(
      <Harness msg={liveMsg} isThinkingMsg={false} sessionId={sessionId} />
    );

    const bar = container.querySelector('[data-testid^="process-toggle-"]');
    const sectionId = (bar?.getAttribute('data-testid') ?? '').replace('process-toggle-', '');
    expect(sectionId).not.toBe('');

    // 用户先折叠、再手动展开 —— 显式交互即钉住
    act(() => {
      fireEvent.click(container.querySelector(`[data-testid="process-toggle-${sectionId}"]`)!);
    });
    act(() => {
      fireEvent.click(container.querySelector(`[data-testid="process-toggle-${sectionId}"]`)!);
    });

    const closedMsg: SessionMessage = {
      ...liveMsg,
      status: 'completed',
      text: '总结内容。',
      blocks: [
        { type: 'tool_call', id: 't-1' },
        { type: 'tool_call', id: 't-2' },
        { type: 'text', content: '总结内容。' },
      ],
    };

    rerender(<Harness msg={closedMsg} isThinkingMsg={false} sessionId={sessionId} />);

    // 断言：用户裁决优先，段保持展开（无 hidden）
    const slotAfter = container.querySelector(`[data-testid="process-slot-${sectionId}"]`);
    expect(slotAfter?.getAttribute('hidden')).toBeNull();
  });

  /**
   * 判别力说明：本用例证明宿主展开态字典必须为每个分段持键。
   * 若改为「惰性键（用户交互才写）」，消息级检索展开命令将无处落键，
   * 段落永远打不开——这是本测试真正守住的回归面。
   */
  it('检索穿透：手动收拢后消息级展开命令必须能重新打开该段', () => {
    cleanup();
    const sessionId = 'sess-conv-4';
    const msgId = 'msg-conv-4';

    const msg: SessionMessage = {
      id: msgId,
      sender: 'assistant',
      status: 'completed',
      text: '结论。',
      toolCalls: [tool('t-1', 'read_file'), tool('t-2', 'search_code')],
      blocks: [
        { type: 'tool_call', id: 't-1' },
        { type: 'tool_call', id: 't-2' },
        { type: 'text', content: '结论。' },
      ],
    };

    const { container } = render(
      <Harness msg={msg} isThinkingMsg={false} sessionId={sessionId} />
    );

    const bar = container.querySelector('[data-testid^="process-toggle-"]');
    const sectionId = (bar?.getAttribute('data-testid') ?? '').replace('process-toggle-', '');
    const slot = container.querySelector('[data-testid^="process-slot-"]');
    // 2026-09-19 用户裁决：终态默认展开直出
    expect(slot?.getAttribute('hidden')).toBeNull();

    // 用户手动收拢该段
    act(() => {
      fireEvent.click(container.querySelector(`[data-testid="process-toggle-${sectionId}"]`)!);
    });
    expect(slot?.getAttribute('hidden')).toBe('until-found');

    // 消息级展开命令重新打开
    act(() => {
      expandMessageProcess(msgId);
    });

    expect(slot?.getAttribute('hidden')).toBeNull();
  });

  it('断言：无正文的纯工具终态段同样默认展开直出（2026-09-19 用户裁决）', () => {
    cleanup();
    const sessionId = 'sess-conv-3';
    const msgId = 'msg-conv-3';

    const msg: SessionMessage = {
      id: msgId,
      sender: 'assistant',
      status: 'completed',
      toolCalls: [tool('t-1', 'read_file'), tool('t-2', 'search_code')],
      blocks: [
        { type: 'tool_call', id: 't-1' },
        { type: 'tool_call', id: 't-2' },
      ],
    };

    const { container } = render(
      <Harness msg={msg} isThinkingMsg={false} sessionId={sessionId} />
    );

    const slot = container.querySelector('[data-testid^="process-slot-"]');
    expect(slot).not.toBeNull();
    // 彻底去除工作完成后的整体内容折叠，无正文纯工具段同样平铺直出
    expect(slot?.getAttribute('hidden')).toBeNull();
  });
});
