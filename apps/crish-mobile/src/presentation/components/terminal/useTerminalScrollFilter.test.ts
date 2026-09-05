import { act, renderHook } from '@testing-library/react-native';
import {
  useTerminalScrollFilter,
} from './useTerminalScrollFilter';

describe('useTerminalScrollFilter 双门限与防死锁 Hook', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('在跟随态下有新行到达时触发 scrollToEnd', async () => {
    const scrollToEnd = jest.fn();
    const listRef = { current: { scrollToEnd } as any };
    const onFollowChange = jest.fn();

    const { rerender } = await renderHook<
      ReturnType<typeof useTerminalScrollFilter>,
      { lines: number }
    >(
      ({ lines }) =>
        useTerminalScrollFilter({
          follow: true,
          onFollowChange,
          listRef,
          lineCount: lines,
        }),
      { initialProps: { lines: 0 } }
    );

    expect(scrollToEnd).not.toHaveBeenCalled();

    await rerender({ lines: 5 });
    await act(async () => {
      jest.advanceTimersByTime(20);
    });

    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it('用户触摸拖拽（BeginDrag）时冻结自动滚底', async () => {
    const scrollToEnd = jest.fn();
    const listRef = { current: { scrollToEnd } as any };
    const onFollowChange = jest.fn();

    const { result, rerender } = await renderHook<
      ReturnType<typeof useTerminalScrollFilter>,
      { lines: number }
    >(
      ({ lines }) =>
        useTerminalScrollFilter({
          follow: true,
          onFollowChange,
          listRef,
          lineCount: lines,
        }),
      { initialProps: { lines: 5 } }
    );

    // 用户开始拖拽
    await act(async () => {
      result.current.handleScrollBeginDrag();
    });

    // 新行到达
    await rerender({ lines: 10 });
    await act(async () => {
      jest.advanceTimersByTime(20);
    });

    // 拖拽期间禁止自动滚底
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('双门限滞后滤波：距离底部 > RELEASE 阈值（64dp）时释放跟随，<= SNAP 阈值（24dp）时吸底', async () => {
    const onFollowChange = jest.fn();
    const listRef = { current: { scrollToEnd: jest.fn() } as any };

    const { result, rerender } = await renderHook<
      ReturnType<typeof useTerminalScrollFilter>,
      { follow: boolean }
    >(
      ({ follow }) =>
        useTerminalScrollFilter({
          follow,
          onFollowChange,
          listRef,
          lineCount: 10,
        }),
      { initialProps: { follow: true } }
    );

    // 向上滑动 40dp：虽然大于 24dp，但未超过 64dp，不应触发释放（防止微震荡）
    await act(async () => {
      result.current.handleScroll({
        nativeEvent: {
          contentOffset: { y: 1000 },
          contentSize: { height: 1540 },
          layoutMeasurement: { height: 500 }, // distanceFromEnd = 1540 - 1500 = 40dp
        },
      } as any);
    });
    expect(onFollowChange).not.toHaveBeenCalled();

    // 向上滑动到 80dp：超过 RELEASE_BOTTOM_THRESHOLD_DP (64dp)，释放跟随
    await act(async () => {
      result.current.handleScroll({
        nativeEvent: {
          contentOffset: { y: 960 },
          contentSize: { height: 1540 },
          layoutMeasurement: { height: 500 }, // distanceFromEnd = 80dp
        },
      } as any);
    });
    expect(onFollowChange).toHaveBeenCalledWith(false);

    // 切换到未跟随态
    await rerender({ follow: false });
    onFollowChange.mockClear();

    // 滑动到 30dp：未进入 24dp 吸底门限，保持未跟随
    await act(async () => {
      result.current.handleScroll({
        nativeEvent: {
          contentOffset: { y: 1010 },
          contentSize: { height: 1540 },
          layoutMeasurement: { height: 500 }, // distanceFromEnd = 30dp
        },
      } as any);
    });
    expect(onFollowChange).not.toHaveBeenCalled();

    // 滑动到 10dp：进入 SNAP 门限 (<= 24dp)，触发吸底跟随
    await act(async () => {
      result.current.handleScroll({
        nativeEvent: {
          contentOffset: { y: 1030 },
          contentSize: { height: 1540 },
          layoutMeasurement: { height: 500 }, // distanceFromEnd = 10dp
        },
      } as any);
    });
    expect(onFollowChange).toHaveBeenCalledWith(true);
  });
});
