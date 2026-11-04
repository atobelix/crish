import { act, renderHook } from '@testing-library/react-native';
import { useTransitionSettled } from './useTransitionSettled';

describe('useTransitionSettled 转场落定 Hook（方案 21 流畅度门）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('初始状态为 false，在 InteractionManager 完成或 delayMs 到期后变为 true', async () => {
    const { result } = await renderHook(() => useTransitionSettled(350));
    expect(result.current).toBe(false);

    // 推进时间至超时兜底
    await act(async () => {
      jest.advanceTimersByTime(350);
    });

    expect(result.current).toBe(true);
  });

  it('key 变动时重置为 false，随后重新落定', async () => {
    const currentKey = 'session-1';
    const { result, rerender } = await renderHook(
      (props?: { key: string }) => useTransitionSettled(350, props?.key),
      { initialProps: { key: currentKey } }
    );

    await act(async () => {
      jest.advanceTimersByTime(350);
    });
    expect(result.current).toBe(true);

    // key 切换到新会话
    await act(async () => {
      rerender({ key: 'session-2' });
    });
    expect(result.current).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(350);
    });
    expect(result.current).toBe(true);
  });

  it('组件卸载时清理定时器与任务', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const { unmount } = await renderHook(() => useTransitionSettled(350));
    await act(async () => {
      unmount();
    });
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
