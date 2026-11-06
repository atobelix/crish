import { renderHook } from '@testing-library/react-native';
import {
  configureInteractionTimingForTest,
  readInteractionRecordsForTest,
} from '@/presentation/perf/interactionTiming';
import {
  SESSION_ROW_LONG_PRESS_DELAY_MS,
  useSessionRowActions,
} from './useSessionRowActions';

describe('会话行长按阈值与稳定回调', () => {
  afterEach(() => {
    configureInteractionTimingForTest();
  });

  it('长按等待保持系统默认，不缩短到滚动误触区间', () => {
    expect(SESSION_ROW_LONG_PRESS_DELAY_MS).toBe(500);
    expect(SESSION_ROW_LONG_PRESS_DELAY_MS).toBeGreaterThanOrEqual(400);
  });

  it('父级重渲染不更换回调，短按与长按都读到最新身份', async () => {
    const firstPress = jest.fn();
    const nextPress = jest.fn();
    const firstLongPress = jest.fn();
    const nextLongPress = jest.fn();
    const visualIn = jest.fn();
    const visualOut = jest.fn();
    const view = await renderHook(
      (props: {
        rowId: string;
        onPress: (id: string) => void;
        onLongPress: (id: string) => void;
      }) =>
        useSessionRowActions({
          ...props,
          timingName: 'session-row-long-press',
          onPressInVisual: visualIn,
          onPressOutVisual: visualOut,
        }),
      {
        initialProps: {
          rowId: 's-1',
          onPress: firstPress,
          onLongPress: firstLongPress,
        },
      }
    );
    const first = view.result.current;
    expect(first.delayLongPress).toBe(SESSION_ROW_LONG_PRESS_DELAY_MS);
    await view.rerender({
      rowId: 's-2',
      onPress: nextPress,
      onLongPress: nextLongPress,
    });
    expect(view.result.current.onPress).toBe(first.onPress);
    expect(view.result.current.onLongPress).toBe(first.onLongPress);
    expect(view.result.current.onPressIn).toBe(first.onPressIn);
    view.result.current.onPress();
    expect(nextPress).toHaveBeenCalledWith('s-2');
    expect(firstPress).not.toHaveBeenCalled();
    expect(nextLongPress).not.toHaveBeenCalled();
    view.result.current.onLongPress();
    expect(nextLongPress).toHaveBeenCalledWith('s-2');
    expect(firstLongPress).not.toHaveBeenCalled();
  });

  it('长按只记到请求相位，抬手取消不留记录', async () => {
    configureInteractionTimingForTest({
      enabled: true,
      now: () => 20,
      sink: () => undefined,
    });
    const view = await renderHook(() =>
      useSessionRowActions({
        rowId: 's-3',
        onPress: jest.fn(),
        onLongPress: jest.fn(),
        timingName: 'session-row-long-press',
        onPressInVisual: jest.fn(),
        onPressOutVisual: jest.fn(),
      })
    );
    view.result.current.onPressIn();
    view.result.current.onLongPress();
    const records = readInteractionRecordsForTest();
    expect(records).toEqual([
      expect.objectContaining({
        name: 'session-row-long-press',
        completion: 'request',
        visibility: 'not-visible',
      }),
    ]);
    view.result.current.onPressIn();
    view.result.current.onPressOut();
    expect(readInteractionRecordsForTest()).toHaveLength(1);
  });

  it('没有长按入口时，长按回调什么也不打开', async () => {
    const onPress = jest.fn();
    const view = await renderHook(() =>
      useSessionRowActions({
        rowId: 's-4',
        onPress,
        timingName: 'chat-row-long-press',
        onPressInVisual: jest.fn(),
        onPressOutVisual: jest.fn(),
      })
    );
    view.result.current.onLongPress();
    view.result.current.onPress();
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith('s-4');
  });
});
