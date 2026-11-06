// @vitest-environment jsdom
/**
 * 跟进二守卫：流式尾正文段挂载必带 startTime 且 fade 触发。
 *
 * 实测背景（2026-11-06 收口会话探针）：首段正文挂载时即带 startTime、
 * fade 正常触发；其后各段先以无 startTime 的空容器挂载（合成流式尾项
 * tailTextItem 不带 startTime），落块后同键同节点才补上 startTime——
 * 入场钩子一次判定后永不重判，于是后几段永失入场。
 *
 * 本测试钉住修复后的两点：
 * 1. 尾项合成时即带开始时刻（data-start-time 存在且在实况窗内），
 *    挂载瞬间 data-entering="true"（fade 触发）；
 * 2. 分段记账块落块后，同键块项接替同一 DOM 节点（不卸载重建），
 *    data-start-time 更新为块自身的 startTime，入场态保持。
 */
import React from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MessageContent } from './MessageContent';
import { _resetToolRevealStateForTesting } from '../chat-tool-call/toolRevealState';
import type { SessionMessage } from '../../store/types';

describe('MessageContent 流式尾正文段 startTime（跟进二）', () => {
  beforeEach(() => {
    _resetToolRevealStateForTesting();
  });

  it('工具后的流式尾段挂载即带 startTime 且 fade 触发；落块后同节点接替', () => {
    const now = Date.now();
    const streamText = '第二段正文正在流式输出。';
    const baseMsg: SessionMessage = {
      id: 'msg-tail-1',
      sender: 'assistant',
      text: '',
      thinking: '先想一下。',
      status: 'processing',
      timestamp: now - 6000,
      toolCalls: [
        {
          id: 'tc-1',
          name: 'list_files',
          status: 'success',
          arguments: '{}',
          startedAt: now - 5000,
          finishedAt: now - 4000,
          durationMs: 1000,
          output: 'a\nb',
        },
      ],
      blocks: [
        {
          type: 'thought',
          id: 'thought-turn-0',
          content: '先想一下。',
          turnIndex: 0,
          startTime: now - 6000,
          durationMs: 1000,
        },
        { type: 'tool_call', id: 'tc-1' },
      ],
    };

    const rendered = render(
      <MessageContent msg={baseMsg} streamText={streamText} isThinkingMsg />
    );
    const tailEl = rendered.container.querySelector('[data-kind="text"]');
    expect(tailEl).not.toBeNull();
    const tailStart = tailEl?.getAttribute('data-start-time');
    expect(tailStart).not.toBeNull();
    const tailStartMs = Number(tailStart);
    expect(Number.isFinite(tailStartMs)).toBe(true);
    // 开始时刻即尾段首次出现的时间（实况窗内），不是消息起始时间
    expect(Date.now() - tailStartMs).toBeLessThan(2000);
    expect(tailStartMs).toBeGreaterThan(now - 6000);
    expect(tailEl?.getAttribute('data-entering')).toBe('true');

    // 分段记账块落块：同键块项接替同一 DOM 节点
    const blockStart = Date.now();
    const landedMsg: SessionMessage = {
      ...baseMsg,
      text: streamText,
      blocks: [
        ...(baseMsg.blocks ?? []),
        {
          type: 'text',
          id: 'text-seg-0',
          content: streamText,
          turnIndex: 0,
          startTime: blockStart,
        },
      ],
    };
    rendered.rerender(
      <MessageContent msg={landedMsg} streamText={streamText} isThinkingMsg />
    );
    const landedEl = rendered.container.querySelector('[data-kind="text"]');
    expect(landedEl).toBe(tailEl);
    expect(landedEl?.getAttribute('data-start-time')).toBe(
      String(blockStart)
    );
    expect(landedEl?.getAttribute('data-entering')).toBe('true');
    rendered.unmount();
  });
});
