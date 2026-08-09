/**
 * useBrowserSession 挂载竞态测试（评审 P2 补强第 10 项）：
 * 「初始查询在途 + 事件先到」的合并语义。
 *
 * 现状（2026-08-09 读源文件 useBrowserSession.ts）：
 * 挂载时并发执行 fetchBrowserStatus() 与 listenBrowserStateEvent()，事件回调
 * 直接 applyPayload；查询回包到达后无条件 setState/setUrl —— 若事件先到而查询
 * 回包携带的是查询时刻的旧快照，旧快照会覆盖更新的事件态（挂载竞态）。
 *
 * F2（另一 Agent）正在修改 useBrowserSession.ts 修复此竞态；本文件按 F2 修复后
 * 的语义编写用例：
 *   - 查询先回、事件后到：事件态生效（两种实现均成立，恒跑）；
 *   - 事件先到、查询在途回包：事件态不被过期回包覆盖（修复语义，
 *     TODO：源文件修复合并后删除 skip 即可回归）。
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

  it.todo('竞态：事件先到、查询在途回包 → 事件态不被过期查询快照覆盖');

  it.skip(
    '竞态（F2 修复后语义，当前源未修复故跳过）：事件先到 → 查询回包（查询时刻的旧快照）不得覆盖事件态',
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
