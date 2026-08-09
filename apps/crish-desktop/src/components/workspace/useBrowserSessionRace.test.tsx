/**
 * useBrowserSession 挂载竞态测试（评审 P2 补强第 10 项）：
 * 「初始查询在途 + 事件先到」的合并语义。
 *
 * 源文件 useBrowserSession.ts（F2 修复已合并）语义：挂载时**先订阅事件、再查询
 * 初始状态**；事件回调置 eventSeen 标记——查询回包到达时若事件已先到（回包为
 * 查询时刻的旧快照），丢弃回包不覆盖事件态（挂载竞态修复）。本文件按该语义
 * 编写用例：
 *   - 查询先回、事件后到：事件态生效（两种实现均成立，恒跑）；
 *   - 事件先到、查询在途回包：事件态不被过期回包覆盖（修复语义）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { mockTauriCommand } from '../../test-setup';
import { useBrowserSession } from './useBrowserSession';
import {
  BROWSER_STATE_EVENT,
  BROWSER_STATUS_CMD,
} from '../../api/browserSessionApi';

type TauriEventHandler = (e: { payload?: unknown }) => void;

const eventMock = vi.hoisted(() => ({
  listen: vi.fn(),
  handlers: new Map<string, TauriEventHandler>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: eventMock.listen,
}));

function emitBrowserEvent(payload: unknown): void {
  for (const handler of eventMock.handlers.values()) {
    handler({ payload });
  }
}

describe('useBrowserSession 挂载竞态（查询在途 × 事件先到）', () => {
  const toast = vi.fn();

  beforeEach(() => {
    toast.mockClear();
    eventMock.handlers.clear();
    eventMock.listen.mockImplementation(
      async (event: string, handler: TauriEventHandler): Promise<() => void> => {
        eventMock.handlers.set(event, handler);
        return () => {
          eventMock.handlers.delete(event);
        };
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('查询先回、事件后到：事件态覆盖查询快照（两种实现均成立）', async () => {
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({
      state: 'idle' as const,
    }));
    const { result } = renderHook(() => useBrowserSession({ onShowToast: toast }));
    await waitFor(() => expect(result.current.state).toBe('idle'));
    await waitFor(() => expect(eventMock.handlers.has(BROWSER_STATE_EVENT)).toBe(true));

    // 事件后到：以事件为最新真相
    act(() => emitBrowserEvent({ state: 'running', url: 'https://a.b' }));
    expect(result.current.state).toBe('running');
    expect(result.current.url).toBe('https://a.b');
  });

  it(
    '竞态（F2 修复语义）：事件先到 → 查询回包（查询时刻的旧快照）不得覆盖事件态',
    async () => {
      // 门控查询：回包延迟到事件之后释放（模拟引擎慢响应）
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      mockTauriCommand(
        BROWSER_STATUS_CMD,
        () => gate.then(() => ({ state: 'idle' as const })),
      );
      const { result } = renderHook(() => useBrowserSession({ onShowToast: toast }));
      await waitFor(() => expect(eventMock.handlers.has(BROWSER_STATE_EVENT)).toBe(true));

      // 事件先到：引擎广播真实状态
      act(() => emitBrowserEvent({ state: 'running', url: 'https://a.b' }));
      expect(result.current.state).toBe('running');

      // 释放查询：回包携带查询时刻的旧快照（idle）
      await act(async () => {
        release();
        await gate;
      });
      // 修复语义：事件态优先，过期回包不得覆盖
      expect(result.current.state).toBe('running');
      expect(result.current.url).toBe('https://a.b');
      expect(toast).not.toHaveBeenCalled();
    },
  );
});
