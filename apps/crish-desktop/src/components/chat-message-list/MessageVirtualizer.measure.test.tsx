// @vitest-environment jsdom
/**
 * 静止会话里滚动改变可见切片后，新挂上的行必须被 ResizeObserverManager 观察，
 * 并由该回调调用 setActual。这是唯一测量通道。
 */
import React from 'react';
import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../../store/types';
import { VirtualScrollManager } from '../../api/VirtualScrollManager';
import { MessageVirtualizer } from './MessageVirtualizer';
import type { MessageVirtualizerProps } from './messageVirtualizerMemo';
import { useStableRowMeasureRef } from './messageVirtualizerMeasure';

const { observe, unobserve } = vi.hoisted(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
}));

vi.mock('../../utils/ResizeObserverManager', () => ({
  ResizeObserverManager: {
    getInstance: () => ({ observe, unobserve }),
  },
}));

vi.mock('../../services/toast/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), toast: { show: vi.fn() } }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

function userMessages(count: number): SessionMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `u-${i}`,
    sender: 'user' as const,
    timestamp: 1_000 + i,
    text: `hi ${i}`,
  }));
}

function propsFor(messages: SessionMessage[]): MessageVirtualizerProps {
  return {
    messages,
    activeSessionId: 'sess-static',
    navigation: {
      onOpenDiff: vi.fn(),
      onOpenPath: vi.fn(),
      onOpenTerminal: vi.fn(),
    },
    composer: { onSetChatInput: vi.fn(), onSendFollowUp: vi.fn() },
    generation: { onRegenerate: vi.fn(), onBranch: vi.fn() },
    pins: {
      pinnedItems: [],
      jumpToPinned: vi.fn(),
      togglePin: vi.fn(),
    },
    flowControl: {
      hideThinkingBlock: false,
      inPlanMode: false,
      planApproved: false,
      lastAssistantId: null,
      showAllMessages: true,
    },
    interaction: {
      expandedUserMsgs: {},
      onToggleExpandUser: vi.fn(),
      dismissedFollowUps: {},
      handleDismissFollowUp: vi.fn(),
      handleMarkdownClick: vi.fn(),
      toolStackProps: {
        activeSessionId: 'sess-static',
        agents: [],
        expandedTools: {},
        onToggleTool: vi.fn(),
        approvalBusy: false,
        actions: {},
      },
    },
    searchHighlightQuery: '',
  };
}

function observedIds(): Set<string> {
  const ids = new Set<string>();
  for (const call of observe.mock.calls) {
    const el = call[0] as HTMLElement | undefined;
    const id = el?.dataset?.vindex;
    if (id) ids.add(id);
  }
  return ids;
}

describe('MessageVirtualizer row measurement', () => {
  beforeEach(() => {
    observe.mockClear();
    unobserve.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps one callback ref per row id across renders', () => {
    const setActual = vi.fn();
    const { result, rerender } = renderHook(
      ({ ids }: { ids: readonly string[] }) =>
        useStableRowMeasureRef(setActual, ids),
      { initialProps: { ids: ['a', 'b'] } }
    );
    const first = result.current('a');
    rerender({ ids: ['a', 'b', 'c'] });
    expect(result.current('a')).toBe(first);
    expect(result.current('b')).toBe(result.current('b'));
  });

  it('observes rows that mount when a static session scrolls, then setActual', () => {
    const setActual = vi.spyOn(VirtualScrollManager.prototype, 'setActual');
    const messages = userMessages(100);
    const { getByTestId } = render(
      <MessageVirtualizer {...propsFor(messages)} />
    );

    const before = observedIds();
    expect(before.size).toBeGreaterThan(0);
    expect(before.has('u-90')).toBe(false);

    const scroller = getByTestId('chat-scroll-container');
    Object.defineProperties(scroller, {
      scrollTop: { configurable: true, get: () => 5000 },
      scrollHeight: { configurable: true, get: () => 20000 },
      clientHeight: { configurable: true, get: () => 600 },
    });
    act(() => {
      fireEvent.scroll(scroller);
    });

    const after = observedIds();
    const mounted = [...after].filter((id) => !before.has(id));
    expect(mounted.length).toBeGreaterThan(0);
    const freshId = mounted[0]!;
    const entry = observe.mock.calls.find(
      (call) => (call[0] as HTMLElement).dataset?.vindex === freshId
    );
    expect(entry).toBeTruthy();
    const el = entry![0] as HTMLElement;
    const onEntry = entry![1] as (obs: ResizeObserverEntry) => void;
    Object.defineProperty(el, 'offsetHeight', {
      configurable: true,
      value: 180,
    });

    act(() => {
      onEntry({
        target: el,
        contentRect: { height: 180 },
      } as ResizeObserverEntry);
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(setActual).toHaveBeenCalledWith(freshId, 180);
    setActual.mockRestore();
  });
});
