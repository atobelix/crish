// @vitest-environment jsdom
/**
 * TimerCronSection 定时 / Cron 展示区段测试（L2）。
 *
 * 覆盖点：
 * - 空态：无任何 timer/cron 事件 → 空态提示（不渲染 0 噪音）；
 * - 有数据：活跃定时器数 / Cron 累计触发 / 最近事件行（类型标签 + id + 时间）；
 * - 事件驱动更新：真实事件路径（onTimerFired / onCronFired）→ 摘要 →
 *   useSyncExternalStore 重渲（不 mock 被测逻辑，不 props 注入数据）；
 * - 最近事件列表有界展示（≤ 3 条）。
 *
 * mock 面：无——组件仅消费 taskEventHandlers 摘要（真实事件链路）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { TimerCronSection } from './TimerCronSection';
import {
  onTimerFired,
  onTimerCancelled,
  onCronFired,
  clearDataPlaneStateForTests,
} from '../../api/chat-bridge/handlers/taskEventHandlers';
import type { HandlerEnv } from '../../api/chat-bridge/handlers/handlerEnv';
import type { StreamState } from '../../api/chat-bridge/handlers/streamState';
import type { StreamCallbacks } from '../../api/chatApi';
import { ApprovalFlowMachine } from '../../api/approvalFlowMachine';

function makeEnv(): HandlerEnv {
  const state: StreamState = {
    cancelled: false,
    finished: false,
    assistantText: '',
    assistantThought: '',
    unsub: null,
    endTimer: null,
  };
  const callbacks: StreamCallbacks = {
    onThought: vi.fn(),
    onToolStart: vi.fn(),
    onToolSuccess: vi.fn(),
    onToolError: vi.fn(),
    onChunk: vi.fn(),
    onComplete: vi.fn(),
  };
  return {
    state,
    approvalFlow: new ApprovalFlowMachine(),
    callbacks,
    runId: 'run-test',
    sessionId: 'sess-test',
    finish: vi.fn(),
    tryResumeFinish: vi.fn(),
  };
}

function envelope<T>(type: string, event: Record<string, unknown>): T {
  return {
    kind: 'engine',
    type,
    originalType: type,
    event: { type, sessionId: 'sess-test', ...event },
    raw: { type, ...event },
  } as unknown as T;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  clearDataPlaneStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
  clearDataPlaneStateForTests();
});

describe('TimerCronSection 空态', () => {
  it('无任何 timer/cron 事件 → 空态提示（不渲染计数与统计）', () => {
    render(<TimerCronSection />);
    expect(screen.getByTestId('timer-cron-empty')).toHaveTextContent(
      '暂无定时器 / Cron 活动',
    );
    expect(screen.queryByTestId('timer-cron-stats')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '定时 / Cron' })).toBeInTheDocument();
  });
});

describe('TimerCronSection 事件驱动更新', () => {
  it('timer-fired 事件到达 → 活跃定时器统计 + 最近事件行渲染', () => {
    const env = makeEnv();
    const { unmount } = render(<TimerCronSection />);
    expect(screen.getByTestId('timer-cron-empty')).toBeInTheDocument();

    act(() => {
      onTimerFired(
        env,
        envelope('timer-fired', { timerId: 'tm1', prompt: '检查构建' }),
      );
    });

    expect(screen.queryByTestId('timer-cron-empty')).not.toBeInTheDocument();
    const stats = screen.getByTestId('timer-cron-stats');
    expect(stats).toHaveTextContent('活跃定时器');
    expect(stats).toHaveTextContent('1');
    expect(screen.getByTestId('timer-cron-event')).toHaveTextContent(
      '定时器触发 tm1',
    );
    // 头部计数：timer + cron 累计
    expect(screen.getByLabelText('累计 1 次定时与 Cron 触发')).toBeInTheDocument();
    unmount();
  });

  it('cron-fired 事件到达 → Cron 累计触发统计 + 迭代序号展示', () => {
    const env = makeEnv();
    const { unmount } = render(<TimerCronSection />);

    act(() => {
      onCronFired(
        env,
        envelope('cron-fired', {
          cronId: 'c1',
          prompt: 'p',
          expression: '* * * * *',
          iteration: 2,
        }),
      );
    });

    const stats = screen.getByTestId('timer-cron-stats');
    expect(stats).toHaveTextContent('Cron 触发');
    expect(stats).toHaveTextContent('1 次');
    expect(screen.getByTestId('timer-cron-event')).toHaveTextContent(
      'Cron 触发 c1 · 第 2 次',
    );
    unmount();
  });

  it('timer-cancelled 到达 → 活跃定时器数回落（事件视角近似）', () => {
    const env = makeEnv();
    const { unmount } = render(<TimerCronSection />);

    act(() => {
      onTimerFired(env, envelope('timer-fired', { timerId: 'tm1' }));
      onTimerFired(env, envelope('timer-fired', { timerId: 'tm2' }));
    });
    expect(screen.getByTestId('timer-cron-stats')).toHaveTextContent('活跃定时器');
    expect(screen.getByTestId('timer-cron-stats')).toHaveTextContent('2');

    act(() => {
      onTimerCancelled(
        env,
        envelope('timer-cancelled', { timerId: 'tm1', reason: 'x' }),
      );
    });
    expect(screen.getByTestId('timer-cron-stats')).toHaveTextContent('活跃定时器');
    expect(screen.getByTestId('timer-cron-stats')).toHaveTextContent('1');
    unmount();
  });

  it('最近事件列表有界：超过 3 条仅展示最新 3 条（环形缓冲透出）', () => {
    const env = makeEnv();
    const { unmount } = render(<TimerCronSection />);

    act(() => {
      for (let i = 0; i < 5; i++) {
        onTimerFired(env, envelope('timer-fired', { timerId: `tm${i}` }));
      }
    });

    expect(screen.getAllByTestId('timer-cron-event')).toHaveLength(3);
    const lines = screen
      .getAllByTestId('timer-cron-event')
      .map((el) => el.textContent);
    expect(lines[0]).toContain('tm4'); // 最新在前
    expect(lines[2]).toContain('tm2'); // 最早被淘汰
    unmount();
  });
});
