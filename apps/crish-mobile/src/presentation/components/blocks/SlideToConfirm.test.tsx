// SlideToConfirm 组件测试（方案 A：注入式手势状态机 + PanResponder 事件序列驱动）
// - 驱动方式：向渲染出的滑轨 View 直接派发真实 PanResponder panHandlers（onStartShouldSetResponder
//   Capture / onMoveShouldSetResponderCapture / onResponderGrant / onResponderMove / onResponderRelease /
//   onResponderTerminate），手势事件用合成 touchHistory 构造（对齐 RN PanResponder._updateGestureStateOnMove
//   的 touchBank 单触点结构），gestureState.dx/dy 由 RN 包装器真实累加——测试的是完整生产接线；
// - Animated.spring（视觉回弹）mock 为同步完成：回弹逻辑由状态机承载（slideConfirmMachine 全量单测），
//   组件测试只验证机器状态与回调，避免真实 rAF 在 act 外触发产生噪音；
// - AccessibilityInfo（reduce-motion 探测）mock 为永不 resolve：默认走滑轨形态，测试可显式注入 reduceMotion。
import { AccessibilityInfo, Animated, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import SlideToConfirm from './SlideToConfirm';

// ---------- 测试基建 ----------

beforeAll(() => {
  // 视觉回弹（Animated spring）mock：同步到位 + 完成回调（逻辑断言不依赖动画帧）
  jest.spyOn(Animated, 'spring').mockImplementation(((
    value: Animated.Value,
    config: { toValue?: number }
  ) => ({
    start: (cb?: (r: { finished: boolean }) => void) => {
      if (typeof config.toValue === 'number') value.setValue(config.toValue);
      cb?.({ finished: true });
    },
    stop: () => {},
    reset: () => {},
  })) as unknown as typeof Animated.spring);
  // reduce-motion 探测：永不 resolve → 稳定走滑轨形态（降级路径测试用 reduceMotion prop 注入）
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockReturnValue(new Promise(() => {}) as never);
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() } as never);
});

function panEvent(
  pageX: number,
  pageY: number,
  t: number,
  prevPageX: number,
  prevPageY: number
): unknown {
  return {
    nativeEvent: {
      touches: [{ pageX, pageY, identifier: 1 }],
      changedTouches: [],
    },
    touchHistory: {
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: t,
      touchBank: [
        {
          touchActive: true,
          currentPageX: pageX,
          currentPageY: pageY,
          previousPageX: prevPageX,
          previousPageY: prevPageY,
          currentTimeStamp: t,
          previousTimeStamp: t - 1,
          startPageX: 0,
          startPageY: 0,
          touchID: 1,
        },
      ],
    },
  };
}

type TrackInstance = ReturnType<typeof screen.getByTestId>;

async function fireHandler(track: TrackInstance, name: string, evt: unknown) {
  await act(async () => {
    (track.props as Record<string, (...args: unknown[]) => unknown>)[name]?.(
      evt
    );
  });
}

interface PanPoint {
  x: number;
  y: number;
}

/**
 * 驱动一次完整滑动手势（真实 PanResponder 包装 + 合成 touchHistory 事件）：
 * 起点 → 移动协商（capture 更新 gestureState → bubble 仲裁）→ grant → 逐点 move → [release]。
 * 每事件独立 act（组件 ref 镜像在两次 act 之间随重渲染刷新，事件间状态才可见）。
 * 返回仲裁结果（是否劫持触摸）。
 */
async function performGesture(
  track: TrackInstance,
  points: Array<PanPoint>,
  start: PanPoint = { x: 10, y: 22 },
  t0 = 100,
  release = true
): Promise<boolean> {
  const startEvt = panEvent(start.x, start.y, t0, start.x, start.y);
  await fireHandler(track, 'onStartShouldSetResponderCapture', startEvt);
  await fireHandler(track, 'onStartShouldSetResponder', startEvt);

  const claimPoint = points[0] ?? start;
  const claimEvt = panEvent(
    claimPoint.x,
    claimPoint.y,
    t0 + 1,
    start.x,
    start.y
  );
  await fireHandler(track, 'onMoveShouldSetResponderCapture', claimEvt);
  const claimed = track.props.onMoveShouldSetResponder?.(claimEvt) ?? false;
  await fireHandler(track, 'onResponderGrant', claimEvt);

  let t = t0 + 1;
  let prev = claimPoint;
  for (const point of points.slice(1)) {
    t += 1;
    await fireHandler(
      track,
      'onResponderMove',
      panEvent(point.x, point.y, t, prev.x, prev.y)
    );
    prev = point;
  }
  if (!release) {
    return claimed; // 停在 release 前（供 armed 中途断言）
  }
  t += 1;
  await fireHandler(
    track,
    'onResponderRelease',
    panEvent(prev.x, prev.y, t, prev.x, prev.y)
  );
  return claimed;
}

async function layoutTrack(width: number) {
  const track = screen.getByTestId('slide-track');
  await act(async () => {
    track.props.onLayout({
      nativeEvent: { layout: { width, height: 44, x: 0, y: 0 } },
    });
  });
}

function progressValue(): number {
  const value = screen.getByTestId('slide-track').props.accessibilityValue as {
    now?: number;
  };
  return value.now ?? 0;
}

describe('SlideToConfirm 渲染（L2 滑轨形态，F2 §5.3）', () => {
  it('默认渲染滑轨：文案「⟶ 滑动以允许」+ 无障碍「允许此请求」+ 进度 0', async () => {
    await render(<SlideToConfirm onConfirm={jest.fn()} />);

    // 未传 testID → 默认 slide-to-confirm
    const track = screen.getByTestId('slide-to-confirm');
    expect(track).toBeTruthy();
    expect(screen.getByTestId('slide-label').props.children).toBe(
      '⟶ 滑动以允许'
    );
    expect(track.props.accessibilityLabel).toBe('允许此请求');
    expect(track.props.accessibilityValue.now).toBe(0);
    expect(track.props.accessibilityRole).toBe('button');
  });

  it('testID / accessibilityLabel / label 透传', async () => {
    await render(
      <SlideToConfirm
        onConfirm={jest.fn()}
        testID="slide-track"
        accessibilityLabel="允许此请求（delete_file）"
        label="⟶ 滑动以允许（高风险需滑动）"
      />
    );

    expect(screen.getByTestId('slide-track')).toBeTruthy();
    expect(screen.getByTestId('slide-label').props.children).toBe(
      '⟶ 滑动以允许（高风险需滑动）'
    );
    expect(screen.getByTestId('slide-track').props.accessibilityLabel).toBe(
      '允许此请求（delete_file）'
    );
  });
});

describe('SlideToConfirm 滑动触发（F2 §5.3：滑过 70% 才可抬起触发）', () => {
  it('拖动过阈值（约 70.3%）→ 松手确认态 → 抬起触发一次 onConfirm', async () => {
    const onConfirm = jest.fn();
    await render(<SlideToConfirm onConfirm={onConfirm} testID="slide-track" />);
    await layoutTrack(300); // usable = 300 - 44 = 256，阈值 dx = 179.2

    const track = screen.getByTestId('slide-track');
    const claimed = await performGesture(
      track,
      [
        { x: 30, y: 22 },
        { x: 130, y: 22 }, // +100 → 39.1%
        { x: 210, y: 22 }, // +80 → 70.3% → armed
      ],
      { x: 10, y: 22 },
      100,
      false // 停在 release 前：断言「松手确认」态
    );
    expect(claimed).toBe(true); // 水平位移优先仲裁劫持（R2UX §2.1）
    expect(screen.getByText('松手确认')).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();

    await fireHandler(
      track,
      'onResponderRelease',
      panEvent(210, 22, 104, 210, 22)
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('拖动未过阈值（约 58.6%）→ 抬起回弹：不触发、进度归零', async () => {
    const onConfirm = jest.fn();
    await render(<SlideToConfirm onConfirm={onConfirm} testID="slide-track" />);
    await layoutTrack(300);

    await performGesture(screen.getByTestId('slide-track'), [
      { x: 30, y: 22 },
      { x: 180, y: 22 }, // +150 → 58.6% → 未 armed
    ]);

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByText('松手确认')).toBeNull();
    expect(progressValue()).toBe(0); // 回弹（idle）
  });

  it('精确边界：699/1000 不触发（回弹），700/1000 触发', async () => {
    const onConfirm = jest.fn();
    await render(<SlideToConfirm onConfirm={onConfirm} testID="slide-track" />);
    await layoutTrack(1044); // usable = 1000，阈值 dx = 700

    // 手势一：699 → 69.9% → 抬起回弹
    await performGesture(
      screen.getByTestId('slide-track'),
      [
        { x: 30, y: 22 },
        { x: 729, y: 22 },
      ],
      { x: 10, y: 22 },
      100
    );
    expect(onConfirm).not.toHaveBeenCalled();
    expect(progressValue()).toBe(0);

    // 手势二：700 → 恰好 70% → 抬起触发
    await performGesture(
      screen.getByTestId('slide-track'),
      [
        { x: 30, y: 22 },
        { x: 730, y: 22 },
      ],
      { x: 10, y: 22 },
      200
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('拖动到 100% 进度不自动触发——「抬起触发」语义，松手才触发', async () => {
    const onConfirm = jest.fn();
    await render(<SlideToConfirm onConfirm={onConfirm} testID="slide-track" />);
    await layoutTrack(300);

    // 手动序列（每事件独立 act）：grant + moves 推到 100%（不 release），断言拖动中不触发
    const track = screen.getByTestId('slide-track');
    const startEvt = panEvent(10, 22, 100, 10, 22);
    const claimEvt = panEvent(30, 22, 101, 10, 22);
    const move1 = panEvent(130, 22, 102, 30, 22);
    const move2 = panEvent(286, 22, 103, 130, 22); // +256 → 100%
    await fireHandler(track, 'onStartShouldSetResponderCapture', startEvt);
    await fireHandler(track, 'onMoveShouldSetResponderCapture', claimEvt);
    await fireHandler(track, 'onResponderGrant', claimEvt);
    await fireHandler(track, 'onResponderMove', move1);
    await fireHandler(track, 'onResponderMove', move2);

    expect(progressValue()).toBe(100);
    expect(screen.getByText('松手确认')).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled(); // 100% 不自动触发

    await fireHandler(
      track,
      'onResponderRelease',
      panEvent(286, 22, 104, 286, 22)
    );
    expect(onConfirm).toHaveBeenCalledTimes(1); // 抬起才触发
  });
});

describe('SlideToConfirm 冲突仲裁（R2UX §2.1 水平位移优先）', () => {
  it('纵向位移为主时不劫持触摸，机器不进入拖动', async () => {
    const onConfirm = jest.fn();
    await render(<SlideToConfirm onConfirm={onConfirm} testID="slide-track" />);
    await layoutTrack(300);

    const claimed = await performGesture(
      screen.getByTestId('slide-track'),
      [{ x: 12, y: 52 }] // dx=2、dy=30 → 纵向为主
    );
    expect(claimed).toBe(false);
    expect(progressValue()).toBe(0);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('位移不足 12dp 不劫持触摸（起点附近抖动回吐父级）', async () => {
    const onConfirm = jest.fn();
    await render(<SlideToConfirm onConfirm={onConfirm} testID="slide-track" />);
    await layoutTrack(300);

    const claimed = await performGesture(
      screen.getByTestId('slide-track'),
      [{ x: 21, y: 22 }] // dx=11 < 12
    );
    expect(claimed).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('SlideToConfirm busy 锁定（R2UX-04-03 / F2 §9.3-3）', () => {
  it('disabled 期间：不劫持、滑动序列无效、onConfirm 不被调用', async () => {
    const onConfirm = jest.fn();
    await render(
      <SlideToConfirm onConfirm={onConfirm} testID="slide-track" disabled />
    );
    await layoutTrack(300);

    const claimed = await performGesture(screen.getByTestId('slide-track'), [
      { x: 30, y: 22 },
      { x: 210, y: 22 },
    ]);
    expect(claimed).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(progressValue()).toBe(0);
  });

  it('disabled 视觉：accessibilityState.disabled + 半透明（opacity 0.5，M4 §6.2-4）', async () => {
    await render(
      <SlideToConfirm onConfirm={jest.fn()} testID="slide-track" disabled />
    );

    const track = screen.getByTestId('slide-track');
    expect(track.props.accessibilityState.disabled).toBe(true);
    const flat = StyleSheet.flatten(track.props.style) as { opacity?: number };
    expect(flat.opacity).toBe(0.5);
  });

  it('disabled 期间已打开的两段式确认弹窗强制关闭（防双点）', async () => {
    const { rerender } = await render(
      <SlideToConfirm onConfirm={jest.fn()} testID="slide-track" />
    );
    await act(async () => {
      screen.getByTestId('slide-track').props.onAccessibilityTap();
    });
    expect(screen.getByTestId('slide-confirm-dialog')).toBeTruthy();

    await rerender(
      <SlideToConfirm onConfirm={jest.fn()} testID="slide-track" disabled />
    );
    expect(screen.queryByTestId('slide-confirm-dialog')).toBeNull();
  });
});

describe('SlideToConfirm 手势终止（terminate → 回弹不触发）', () => {
  it('armed 状态被终止 → 回弹回 idle，onConfirm 不被调用', async () => {
    const onConfirm = jest.fn();
    await render(<SlideToConfirm onConfirm={onConfirm} testID="slide-track" />);
    await layoutTrack(300);

    const track = screen.getByTestId('slide-track');
    const startEvt = panEvent(10, 22, 100, 10, 22);
    const claimEvt = panEvent(30, 22, 101, 10, 22);
    const move1 = panEvent(130, 22, 102, 30, 22);
    const move2 = panEvent(210, 22, 103, 130, 22); // +180 → armed
    await fireHandler(track, 'onStartShouldSetResponderCapture', startEvt);
    await fireHandler(track, 'onMoveShouldSetResponderCapture', claimEvt);
    await fireHandler(track, 'onResponderGrant', claimEvt);
    await fireHandler(track, 'onResponderMove', move1);
    await fireHandler(track, 'onResponderMove', move2);
    expect(screen.getByText('松手确认')).toBeTruthy();

    await fireHandler(
      track,
      'onResponderTerminate',
      panEvent(210, 22, 104, 210, 22)
    );
    expect(onConfirm).not.toHaveBeenCalled();
    expect(progressValue()).toBe(0);
  });
});

describe('SlideToConfirm reduce-motion 降级（R2UX §4.4-3 / M4 §8.4）', () => {
  it('reduceMotion 时渲染「允许」按钮而非滑轨', async () => {
    await render(
      <SlideToConfirm onConfirm={jest.fn()} testID="slide-track" reduceMotion />
    );

    expect(screen.getByTestId('slide-track')).toBeTruthy();
    expect(screen.getByText('允许')).toBeTruthy();
    expect(screen.queryByTestId('slide-thumb')).toBeNull();
  });

  it('两段式：点允许 → 确认框 → 确认放行 → onConfirm 触发一次', async () => {
    const onConfirm = jest.fn();
    await render(
      <SlideToConfirm onConfirm={onConfirm} testID="slide-track" reduceMotion />
    );

    await fireEvent.press(screen.getByTestId('slide-track'));
    expect(screen.getByTestId('slide-confirm-dialog')).toBeTruthy();
    expect(screen.getByText('允许后将立即执行，不可撤销')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('slide-confirm-accept'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('slide-confirm-dialog')).toBeNull();
  });

  it('两段式：取消 / 遮罩不触发 onConfirm', async () => {
    const onConfirm = jest.fn();
    await render(
      <SlideToConfirm onConfirm={onConfirm} testID="slide-track" reduceMotion />
    );

    await fireEvent.press(screen.getByTestId('slide-track'));
    await fireEvent.press(screen.getByTestId('slide-confirm-cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId('slide-confirm-dialog')).toBeNull();

    await fireEvent.press(screen.getByTestId('slide-track'));
    await fireEvent.press(screen.getByTestId('dialog-backdrop'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId('slide-confirm-dialog')).toBeNull();
  });

  it('reduceMotion + disabled：按钮禁用不可点', async () => {
    await render(
      <SlideToConfirm
        onConfirm={jest.fn()}
        testID="slide-track"
        reduceMotion
        disabled
      />
    );

    await fireEvent.press(screen.getByTestId('slide-track'));
    expect(screen.queryByTestId('slide-confirm-dialog')).toBeNull();
  });
});

describe('SlideToConfirm 读屏等价路径（R2UX §4.1-3：读屏用户不执行滑动）', () => {
  it('读屏激活（onAccessibilityTap）→ 两段式确认 → 确认放行触发', async () => {
    const onConfirm = jest.fn();
    await render(<SlideToConfirm onConfirm={onConfirm} testID="slide-track" />);

    await act(async () => {
      screen.getByTestId('slide-track').props.onAccessibilityTap();
    });
    expect(screen.getByTestId('slide-confirm-dialog')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('slide-confirm-accept'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
