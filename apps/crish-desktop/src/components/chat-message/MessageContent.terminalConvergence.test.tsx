// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/chat-message/MessageContent.terminalConvergence.test.tsx
 *
 * 【终态收敛契约】2026-09-11 用户裁决为源，2026-11-01 过程组规格更新：
 *   「ai 回复正文的总结之后，只显示工作时长和总结内容」
 *
 * 断言目标（全链路宿主侧物证）：
 *   ① 流式执行期：过程组直出展开，用户可见思考与工具明细；
 *   ② 总结正文抵达 / 轮次闭合：过程组按〔同组 §3.3〕组级默认表自动
 *      折为组头一行（工作时间 + 分布 + 失败数 + 子 agent 数），页面
 *      只外露组头 + 总结正文，过程明细挂 `hidden="until-found"`
 *      （DOM 常驻，非卸载——保持挂载裁决不变）；
 *   ③ 用户手动开合过的组被「钉住」，默认表永不覆盖用户裁决；
 *   ④ 子代理分派卡是组内条目（R9 形态）：组折叠时随组整体收拢，
 *      不再有「子代理段永不折叠」的段级豁免——2026-09-19 铁律四的
 *      段级形态随段形态消亡而退役，其「分派关系必须可见」本意由
 *      组头常驻的子 agent 计数承载。
 *
 * 历史注记：2026-09-19 两条裁决（去除工作完成后的整体折叠、终态
 * 默认展开直出）曾覆盖 ①② 的折叠面，已被 2026-11-01 规格取代；
 * 「DOM 常驻不卸载」面继续有效，由 ② 的 until-found 承载。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  render,
  act,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { expandMessageProcess } from './searchExpandBridge';
import { MessageContent } from './MessageContent';
import { useStreamMessageViewModel } from './streamMessageViewModel';
import { useStreamingStore } from '../../store/streamingStore';
import type { SessionMessage } from '../../store/types';

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
    // 夹具自带真实耗时：组头工作时长断言（④）以此为据；无任何时间
    // 线索时组头按 R-C 口径退化为裸词干，不造假时长。
    startedAt: 1_700_000_000_000,
    durationMs: 2_000,
  };
}

describe('终态收敛：总结抵达后只外露工作时长与总结正文', () => {
  beforeEach(() => {
    useStreamingStore.setState({ byKey: Object.create(null) });
  });

  it('流式执行期直出展开 → 总结正文抵达后自动收拢（DOM 常驻 hidden=until-found）', async () => {
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
        {
          type: 'text',
          content: '已完成分析，读取了 main.rs 并全仓检索完毕。',
        },
      ],
    };

    rerender(
      <Harness msg={closedMsg} isThinkingMsg={false} sessionId={sessionId} />
    );

    // R8 §3.3 组级默认表：轮次封口 → 过程组自动折为组头一行，
    // 明细 DOM 常驻 hidden=until-found（不卸载）。hidden 在收合动画
    // （AN1 协同，120–450ms）完成后才挂载，故异步等其收敛——展开态
    // 本身（data-expanded）于封口帧即翻转，动画后 hidden 落位。
    const slotAfter = container.querySelector('[data-testid^="process-slot-"]');
    expect(slotAfter, '过程段节点必须常驻').not.toBeNull();
    await waitFor(() =>
      expect(slotAfter?.getAttribute('hidden')).toBe('until-found')
    );

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
    const sectionId = (bar?.getAttribute('data-testid') ?? '').replace(
      'process-toggle-',
      ''
    );
    expect(sectionId).not.toBe('');

    // 用户先折叠、再手动展开 —— 显式交互即钉住
    act(() => {
      fireEvent.click(
        container.querySelector(`[data-testid="process-toggle-${sectionId}"]`)!
      );
    });
    act(() => {
      fireEvent.click(
        container.querySelector(`[data-testid="process-toggle-${sectionId}"]`)!
      );
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

    rerender(
      <Harness msg={closedMsg} isThinkingMsg={false} sessionId={sessionId} />
    );

    // 断言：用户裁决优先，段保持展开（无 hidden）
    const slotAfter = container.querySelector(
      `[data-testid="process-slot-${sectionId}"]`
    );
    expect(slotAfter?.getAttribute('hidden')).toBeNull();
  });

  /**
   * 判别力说明：本用例证明宿主展开态字典必须为每个分段持键。
   * 若改为「惰性键（用户交互才写）」，消息级检索展开命令将无处落键，
   * 段落永远打不开——这是本测试真正守住的回归面。
   */
  it('检索穿透：终态默认折叠下消息级展开命令必须能打开该组，手动收拢后仍可再开', async () => {
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
    const sectionId = (bar?.getAttribute('data-testid') ?? '').replace(
      'process-toggle-',
      ''
    );
    const slot = container.querySelector('[data-testid^="process-slot-"]');
    // R8 §3.3：终态消息过程组默认折叠（组头一行），明细 until-found 常驻
    expect(slot?.getAttribute('hidden')).toBe('until-found');

    // 消息级展开命令打开该组
    act(() => {
      expandMessageProcess(msgId);
    });
    expect(slot?.getAttribute('hidden')).toBeNull();

    // 用户手动收拢后，展开命令仍必须能重新打开（持键判别力不变）
    act(() => {
      fireEvent.click(
        container.querySelector(`[data-testid="process-toggle-${sectionId}"]`)!
      );
    });
    await waitFor(() =>
      expect(slot?.getAttribute('hidden')).toBe('until-found')
    );
    act(() => {
      expandMessageProcess(msgId);
    });
    expect(slot?.getAttribute('hidden')).toBeNull();
  });

  it('断言：无正文的纯工具终态组同样按默认表折叠为组头一行（R8 §3.3）', () => {
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
    // 无答复段不改变组级口径：终态组默认折叠，组头常驻、明细常驻 DOM
    expect(slot?.getAttribute('hidden')).toBe('until-found');
    const bar = container.querySelector('[data-testid^="process-toggle-"]');
    expect(bar).not.toBeNull();
  });
});
