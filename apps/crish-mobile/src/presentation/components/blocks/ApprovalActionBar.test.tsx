// ApprovalActionBar 组件测试（R2UX-04-03 busy 防双点 / R2UX-04-07 布局 / 双阶段确认 / F2 §5.3 L2 滑动确认）：
// - L1：允许单击流、拒绝二次确认流（确认发送/取消不发送）、busy 期间防双点与弹窗关闭、按钮恒位布局；
// - L2（dangerLevel === 2）：允许改为「滑动以允许」滑轨——单击不决策、滑动过 70% 阈值抬起触发、
//   未过阈值回弹不触发、busy 锁定；拒绝保持单点 + 二次确认；
// - L2 手势驱动：向渲染出的滑轨 View 派发真实 PanResponder panHandlers 包装（合成 touchHistory
//   单触点事件，RN PanResponder 内部 gestureState 真实累加），与 SlideToConfirm.test 同一驱动方式；
// - Animated.spring（视觉回弹）与 AccessibilityInfo（reduce-motion 探测）mock：与 SlideToConfirm.test 同口径。
// 注：@testing-library/react-native v14 render/fireEvent/rerender 为异步 API，全部 await
import { AccessibilityInfo, Animated, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import ApprovalActionBar from './ApprovalActionBar';

beforeAll(() => {
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

/** 驱动一次完整滑动手势（起点 → 协商 → grant → moves → release），返回仲裁是否劫持 */
async function performGesture(
  track: TrackInstance,
  waypoints: Array<{ x: number; y: number }>,
  start: { x: number; y: number } = { x: 10, y: 22 },
  t0 = 100
): Promise<boolean> {
  const startEvt = panEvent(start.x, start.y, t0, start.x, start.y);
  await fireHandler(track, 'onStartShouldSetResponderCapture', startEvt);
  await fireHandler(track, 'onStartShouldSetResponder', startEvt);

  const claimPoint = waypoints[0] ?? start;
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
  for (const point of waypoints.slice(1)) {
    t += 1;
    await fireHandler(
      track,
      'onResponderMove',
      panEvent(point.x, point.y, t, prev.x, prev.y)
    );
    prev = point;
  }
  t += 1;
  await fireHandler(
    track,
    'onResponderRelease',
    panEvent(prev.x, prev.y, t, prev.x, prev.y)
  );
  return claimed;
}

async function layoutAllowTrack(width: number) {
  const track = screen.getByTestId('approval-allow');
  await act(async () => {
    track.props.onLayout({
      nativeEvent: { layout: { width, height: 44, x: 0, y: 0 } },
    });
  });
}

describe('ApprovalActionBar 允许流（F2 §5.2 L1 单击即决策）', () => {
  it('点击允许触发一次 onAllow', async () => {
    const onAllow = jest.fn();
    const onDeny = jest.fn();
    await render(
      <ApprovalActionBar busy={false} onAllow={onAllow} onDeny={onDeny} />
    );

    await fireEvent.press(screen.getByTestId('approval-allow'));
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(onDeny).not.toHaveBeenCalled();
  });
});

describe('ApprovalActionBar 拒绝双阶段确认（任务书 R2-04 / F2 §5.3 安全模式）', () => {
  it('确认拒绝后触发一次 onDeny 并关闭弹窗', async () => {
    const onAllow = jest.fn();
    const onDeny = jest.fn();
    await render(
      <ApprovalActionBar busy={false} onAllow={onAllow} onDeny={onDeny} />
    );

    await fireEvent.press(screen.getByTestId('approval-deny'));
    expect(screen.getByTestId('approval-deny-dialog')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('deny-confirm'));
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onAllow).not.toHaveBeenCalled();
    expect(screen.queryByTestId('approval-deny-dialog')).toBeNull();
  });

  it('取消不发送：弹窗关闭且 onDeny 不被调用', async () => {
    const onDeny = jest.fn();
    await render(
      <ApprovalActionBar busy={false} onAllow={jest.fn()} onDeny={onDeny} />
    );

    await fireEvent.press(screen.getByTestId('approval-deny'));
    await fireEvent.press(screen.getByTestId('deny-cancel'));
    expect(onDeny).not.toHaveBeenCalled();
    expect(screen.queryByTestId('approval-deny-dialog')).toBeNull();
  });

  it('遮罩点击等价取消（M4 §6.3）', async () => {
    const onDeny = jest.fn();
    await render(
      <ApprovalActionBar busy={false} onAllow={jest.fn()} onDeny={onDeny} />
    );

    await fireEvent.press(screen.getByTestId('approval-deny'));
    await fireEvent.press(screen.getByTestId('dialog-backdrop'));
    expect(onDeny).not.toHaveBeenCalled();
    expect(screen.queryByTestId('approval-deny-dialog')).toBeNull();
  });
});

describe('ApprovalActionBar busy 防双点（R2UX-04-03 / F2 §9.3-3）', () => {
  it('busy 期间点击允许无效', async () => {
    const onAllow = jest.fn();
    await render(
      <ApprovalActionBar busy onAllow={onAllow} onDeny={jest.fn()} />
    );

    await fireEvent.press(screen.getByTestId('approval-allow'));
    expect(onAllow).not.toHaveBeenCalled();
  });

  it('busy 期间点击拒绝不弹出确认弹窗', async () => {
    const onDeny = jest.fn();
    await render(
      <ApprovalActionBar busy onAllow={jest.fn()} onDeny={onDeny} />
    );

    await fireEvent.press(screen.getByTestId('approval-deny'));
    expect(screen.queryByTestId('approval-deny-dialog')).toBeNull();
    expect(onDeny).not.toHaveBeenCalled();
  });

  it('busy 期间已打开的确认弹窗强制关闭（防双点）', async () => {
    const { rerender } = await render(
      <ApprovalActionBar busy={false} onAllow={jest.fn()} onDeny={jest.fn()} />
    );
    await fireEvent.press(screen.getByTestId('approval-deny'));
    expect(screen.getByTestId('approval-deny-dialog')).toBeTruthy();

    await rerender(
      <ApprovalActionBar busy onAllow={jest.fn()} onDeny={jest.fn()} />
    );
    expect(screen.queryByTestId('approval-deny-dialog')).toBeNull();
  });

  it('busy 视觉：双按钮禁用 + 允许按钮 loading 态', async () => {
    await render(
      <ApprovalActionBar busy onAllow={jest.fn()} onDeny={jest.fn()} />
    );
    expect(
      screen.getByTestId('approval-allow').props.accessibilityState.disabled
    ).toBe(true);
    expect(
      screen.getByTestId('approval-deny').props.accessibilityState.disabled
    ).toBe(true);
  });
});

describe('ApprovalActionBar 布局（R2UX-04-07 / F2 §9.3-1 / M4 §6.2-1）', () => {
  it('拒绝恒左、允许恒右（子序固定）', async () => {
    await render(
      <ApprovalActionBar busy={false} onAllow={jest.fn()} onDeny={jest.fn()} />
    );
    const bar = screen.getByTestId('approval-action-bar');
    const children = bar.props.children as Array<{
      props: { testID?: string };
    }>;
    expect(children[0]?.props.testID).toBe('approval-deny');
    expect(children[1]?.props.testID).toBe('approval-allow');
  });

  it('双按钮间距 ≥48dp', async () => {
    await render(
      <ApprovalActionBar busy={false} onAllow={jest.fn()} onDeny={jest.fn()} />
    );
    const bar = screen.getByTestId('approval-action-bar');
    const flat = StyleSheet.flatten(bar.props.style);
    expect((flat as { gap?: number }).gap ?? 0).toBeGreaterThanOrEqual(48);
  });

  it('无障碍 label 带工具名（R2UX-04-10「类型 + 摘要」）', async () => {
    await render(
      <ApprovalActionBar
        busy={false}
        onAllow={jest.fn()}
        onDeny={jest.fn()}
        toolName="delete_file"
      />
    );
    expect(screen.getByTestId('approval-allow').props.accessibilityLabel).toBe(
      '允许此请求（delete_file）'
    );
    expect(screen.getByTestId('approval-deny').props.accessibilityLabel).toBe(
      '拒绝此请求（delete_file）'
    );
  });
});

describe('ApprovalActionBar L2 滑动确认（F2 §5.3 / §15-4 安全条款 / R2UX §3.2）', () => {
  it('L2 渲染：允许改为「滑动以允许」滑轨 + 不可撤销提示，拒绝仍为按钮', async () => {
    await render(
      <ApprovalActionBar
        busy={false}
        onAllow={jest.fn()}
        onDeny={jest.fn()}
        dangerLevel={2}
      />
    );

    // 滑轨形态（L2 允许不可点按的视觉载体）
    expect(screen.getByTestId('approval-allow')).toBeTruthy();
    expect(screen.getByText('⟶ 滑动以允许')).toBeTruthy();
    // 滑动前提示「允许后将立即执行，不可撤销」（F2 §9.3-5 / R2UX §3.2）
    expect(screen.getByTestId('l2-warning')).toBeTruthy();
    expect(screen.getByText('允许后将立即执行，不可撤销')).toBeTruthy();
    // 拒绝保持单点按钮
    expect(screen.getByTestId('approval-deny')).toBeTruthy();
  });

  it('L2 允许不可点按：单击滑轨不触发 onAllow（R2UX §2.4-3）', async () => {
    const onAllow = jest.fn();
    await render(
      <ApprovalActionBar
        busy={false}
        onAllow={onAllow}
        onDeny={jest.fn()}
        dangerLevel={2}
      />
    );

    await fireEvent.press(screen.getByTestId('approval-allow'));
    expect(onAllow).not.toHaveBeenCalled();
  });

  it('L2 滑动过阈值（约 70.3%）抬起 → 触发一次 onAllow', async () => {
    const onAllow = jest.fn();
    await render(
      <ApprovalActionBar
        busy={false}
        onAllow={onAllow}
        onDeny={jest.fn()}
        dangerLevel={2}
      />
    );
    await layoutAllowTrack(300); // usable = 256，阈值 dx = 179.2

    const claimed = await performGesture(screen.getByTestId('approval-allow'), [
      { x: 30, y: 22 },
      { x: 130, y: 22 }, // +100 → 39.1%
      { x: 210, y: 22 }, // +80 → 70.3% → armed → 抬起触发
    ]);
    expect(claimed).toBe(true);
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(
      screen.getByTestId('approval-allow').props.accessibilityValue.now
    ).toBe(100);
  });

  it('L2 未过阈值（约 58.6%）抬起 → 回弹不触发', async () => {
    const onAllow = jest.fn();
    await render(
      <ApprovalActionBar
        busy={false}
        onAllow={onAllow}
        onDeny={jest.fn()}
        dangerLevel={2}
      />
    );
    await layoutAllowTrack(300);

    await performGesture(screen.getByTestId('approval-allow'), [
      { x: 30, y: 22 },
      { x: 180, y: 22 }, // +150 → 58.6%
    ]);
    expect(onAllow).not.toHaveBeenCalled();
    expect(
      screen.getByTestId('approval-allow').props.accessibilityValue.now
    ).toBe(0);
  });

  it('L2 busy 锁定：滑轨禁用、滑动序列无效、onAllow 不被调用', async () => {
    const onAllow = jest.fn();
    await render(
      <ApprovalActionBar
        busy
        onAllow={onAllow}
        onDeny={jest.fn()}
        dangerLevel={2}
      />
    );
    await layoutAllowTrack(300);

    const track = screen.getByTestId('approval-allow');
    expect(track.props.accessibilityState.disabled).toBe(true);

    const claimed = await performGesture(track, [
      { x: 30, y: 22 },
      { x: 210, y: 22 },
    ]);
    expect(claimed).toBe(false);
    expect(onAllow).not.toHaveBeenCalled();
    expect(track.props.accessibilityValue.now).toBe(0);
  });

  it('L2 布局：拒绝整行在上、滑轨整行在下（F2 §5.1 线框），垂直间距 12', async () => {
    await render(
      <ApprovalActionBar
        busy={false}
        onAllow={jest.fn()}
        onDeny={jest.fn()}
        dangerLevel={2}
      />
    );

    const bar = screen.getByTestId('approval-action-bar');
    const flat = StyleSheet.flatten(bar.props.style) as {
      flexDirection?: string;
      gap?: number;
    };
    expect(flat.flexDirection).toBe('column');
    expect(flat.gap).toBe(12);
    const children = bar.props.children as Array<{
      props: { testID?: string };
    }>;
    expect(children[0]?.props.testID).toBe('approval-deny');
    expect(children[1]?.props.testID).toBe('approval-allow-column');
  });

  it('L2 无障碍：滑轨暴露为「允许」按钮 + 读屏两段式确认放行（R2UX §4.1-3）', async () => {
    const onAllow = jest.fn();
    await render(
      <ApprovalActionBar
        busy={false}
        onAllow={onAllow}
        onDeny={jest.fn()}
        dangerLevel={2}
        toolName="delete_file"
      />
    );

    const track = screen.getByTestId('approval-allow');
    expect(track.props.accessibilityRole).toBe('button');
    expect(track.props.accessibilityLabel).toBe('允许此请求（delete_file）');

    await act(async () => {
      track.props.onAccessibilityTap();
    });
    expect(screen.getByTestId('slide-confirm-dialog')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('slide-confirm-accept'));
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it('L2 拒绝流不受影响：二次确认后触发 onDeny', async () => {
    const onDeny = jest.fn();
    await render(
      <ApprovalActionBar
        busy={false}
        onAllow={jest.fn()}
        onDeny={onDeny}
        dangerLevel={2}
      />
    );

    await fireEvent.press(screen.getByTestId('approval-deny'));
    await fireEvent.press(screen.getByTestId('deny-confirm'));
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('approval-deny-dialog')).toBeNull();
  });
});
