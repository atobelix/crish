// @vitest-environment jsdom
/**
 * useConnectionStatus 单测（D2 单真源化，T-E 批次 5）。
 *
 * 真源 = errorStore.connectionStatus；四态投影 + isConnectionReady 判定。
 * 经公开订阅面（useSyncExternalStore）驱动，直接操作 errorStore 单例状态。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { errorStore } from '../services/ErrorStore';
import { isConnectionReady, useConnectionStatus } from './useConnectionStatus';

const INITIAL = errorStore.getState().connectionStatus;

beforeEach(() => {
  errorStore.setConnectionStatus(INITIAL);
});

afterEach(() => {
  errorStore.setConnectionStatus(INITIAL);
});

describe('useConnectionStatus — errorStore 四态投影', () => {
  it('connected → 返回 connected，isConnectionReady = true', () => {
    const { result } = renderHook(() => useConnectionStatus());
    act(() => {
      errorStore.setConnectionStatus('connected');
    });
    expect(result.current).toBe('connected');
    expect(isConnectionReady(result.current)).toBe(true);
  });

  it('reconnecting → 投影「重连中」判定（isConnectionReady = false，不再折叠为离线）', () => {
    const { result } = renderHook(() => useConnectionStatus());
    act(() => {
      errorStore.setConnectionStatus('reconnecting');
    });
    expect(result.current).toBe('reconnecting');
    expect(isConnectionReady(result.current)).toBe(false);
  });

  it('waiting → 投影「连接中」（isConnectionReady = false）', () => {
    const { result } = renderHook(() => useConnectionStatus());
    act(() => {
      errorStore.setConnectionStatus('waiting');
    });
    expect(result.current).toBe('waiting');
    expect(isConnectionReady(result.current)).toBe(false);
  });

  it('disconnected → 投影「离线」', () => {
    const { result } = renderHook(() => useConnectionStatus());
    act(() => {
      errorStore.setConnectionStatus('disconnected');
    });
    expect(result.current).toBe('disconnected');
    expect(isConnectionReady(result.current)).toBe(false);
  });

  it('状态未变化不触发订阅者（setConnectionStatus 同值跳过）', () => {
    let renders = 0;
    renderHook(() => {
      renders++;
      return useConnectionStatus();
    });
    act(() => {
      errorStore.setConnectionStatus('connected');
    });
    const before = renders;
    act(() => {
      errorStore.setConnectionStatus('connected'); // 同值：ErrorStore 内部跳过
    });
    expect(renders).toBe(before);
  });
});
