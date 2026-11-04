// @vitest-environment jsdom
/**
 * useChatEmptyKind 批 A 口径测试：懒壳会话水合的呈现状态机——
 * - 水合中（messagesHydrated=false）：messagesLoading=true 且 emptyKind 被压制（不闪欢迎面）；
 * - 超过 3s 等待预算仍未水合：messagesLoading=false、messagesLoadStalled=true，
 *   且 emptyKind 继续被压制（改由消息列表错误三态 + 重试出口接管，
 *   不再静默跌落 session-empty 把加载失败伪装成空会话）；
 * - 水合完成 / 已有消息：loading 与 stalled 均为 false。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useChatEmptyKind,
  type UseChatEmptyKindOptions,
} from './useChatEmptyKind';

function baseOptions(
  overrides: Partial<UseChatEmptyKindOptions> = {}
): UseChatEmptyKindOptions {
  return {
    activeSessionId: 'sess-hist-1',
    messageCount: 0,
    displayCount: 0,
    localMsgFilter: '',
    mainSurface: 'chat',
    messagesHydrated: false,
    hydratedFromEngine: false,
    engineCursor: undefined,
    engineLastRunId: undefined,
    ...overrides,
  };
}

describe('useChatEmptyKind（批 A 水合呈现口径）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('懒壳水合中：loading=true、stalled=false、emptyKind 被压制', () => {
    const { result } = renderHook(() => useChatEmptyKind(baseOptions()));
    expect(result.current.messagesLoading).toBe(true);
    expect(result.current.messagesLoadStalled).toBe(false);
    expect(result.current.emptyKind).toBeNull();
  });

  it('超 3s 仍未水合：loading=false、stalled=true、emptyKind 继续被压制', () => {
    const { result } = renderHook(() => useChatEmptyKind(baseOptions()));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.messagesLoading).toBe(false);
    expect(result.current.messagesLoadStalled).toBe(true);
    expect(result.current.emptyKind).toBeNull();
  });

  it('水合在超时前完成：loading 与 stalled 均回落，emptyKind 正常解析', () => {
    const { result, rerender } = renderHook(
      (props: UseChatEmptyKindOptions) => useChatEmptyKind(props),
      { initialProps: baseOptions() }
    );
    expect(result.current.messagesLoading).toBe(true);
    rerender(baseOptions({ messagesHydrated: true, hydratedFromEngine: true }));
    expect(result.current.messagesLoading).toBe(false);
    expect(result.current.messagesLoadStalled).toBe(false);
    expect(result.current.emptyKind).toBe('session-empty');
  });

  it('已有消息时不进入 loading / stalled', () => {
    const { result } = renderHook(() =>
      useChatEmptyKind(baseOptions({ messageCount: 3, displayCount: 3 }))
    );
    expect(result.current.messagesLoading).toBe(false);
    expect(result.current.messagesLoadStalled).toBe(false);
  });
});
