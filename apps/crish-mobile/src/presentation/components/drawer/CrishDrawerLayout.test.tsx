// 抽屉内容挂载（M5 预挂载 → 批 D 常驻化）：布局挂载后的首个 effect
// 即挂载抽屉内容且永不卸载——无需等首次打开、更无需等 progress
// 过半；首开时内容已就位、开合全程零挂载。内容组件在此以桩替身
// （只钉挂载时机，不测其内部）。
import { readFileSync } from 'fs';
import { join } from 'path';
import { useState } from 'react';
import { act, render } from '@testing-library/react-native';
import { Keyboard, View } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import * as Reanimated from 'react-native-reanimated';
import { CrishDrawerLayout, drawerReleaseTarget } from './CrishDrawerLayout';
import { useDrawerActions, useDrawerController } from './DrawerContext';
import * as drawerFocus from './drawerFocus';
import { useOpenDrawer } from '@/presentation/navigation/useOpenDrawer';

jest.mock('./CrishDrawerContent', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View: MockView } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    CrishDrawerContent: () =>
      React.createElement(MockView, { testID: 'drawer-content-stub' }),
  };
});

describe('CrishDrawerLayout 内容挂载（M5 → 批 D 常驻）', () => {
  it('未打开抽屉时，布局挂载后内容已常驻挂载', async () => {
    const view = await render(
      <CrishDrawerLayout>
        <View testID="main-child" />
      </CrishDrawerLayout>
    );
    // 等待首个 effect 落点
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(view.getByTestId('drawer-content-stub')).toBeTruthy();
    expect(view.getByTestId('main-child')).toBeTruthy();
  });

  it('开合全程内容不卸载（常驻闩：动画期间零挂载/零换装）', async () => {
    let triggerOpen: () => void = () => {};
    let triggerClose: () => void = () => {};
    function Probe() {
      const actions = useDrawerActions();
      triggerOpen = actions.open;
      triggerClose = actions.close;
      return null;
    }
    const view = await render(
      <CrishDrawerLayout>
        <Probe />
      </CrishDrawerLayout>
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(view.getByTestId('drawer-content-stub')).toBeTruthy();
    await act(async () => {
      triggerOpen();
    });
    expect(view.getByTestId('drawer-content-stub')).toBeTruthy();
    await act(async () => {
      triggerClose();
    });
    // 关闭落定后内容仍在（下次打开零挂载）
    expect(view.getByTestId('drawer-content-stub')).toBeTruthy();
  });

  it('动画期呈现白名单：底层面板仅 transform 微视差、顶层卡片仅 transform 位移与 borderRadius（源码钉死，绝无 Scrim 遮罩）', () => {
    const source = readFileSync(
      join(__dirname, 'CrishDrawerLayout.tsx'),
      'utf8'
    );
    const bodies = [
      ...source.matchAll(/useAnimatedStyle\(\(\) => \(\{([\s\S]*?)\}\)\)/g),
    ].map((m) => m[1]!);
    // 本文件全部逐帧样式 = 底层抽屉面板 + 顶层主卡片两处
    expect(bodies.length).toBe(2);
    // 绝无黑色遮罩 Scrim
    expect(source).not.toMatch(/theme\.colors\.scrim/);
    expect(source).not.toMatch(/scrimAnimatedStyle/);
    for (const body of bodies) {
      const topLevelKeys = [...body.matchAll(/^ {4}([A-Za-z]+):/gm)].map(
        (m) => m[1]
      );
      for (const key of topLevelKeys) {
        expect(['transform', 'borderRadius']).toContain(key);
      }
    }
    expect(bodies.some((b) => b.includes('translateX'))).toBe(true);
    expect(bodies.some((b) => b.includes('borderRadius'))).toBe(true);
  });
});

// 松手落点判定（2026-11-02 用户投诉钉案）：旧口径 = 单一位置阈值
// 0.45 + 速度只认向右——开拖 144dp、关拖 176dp（抽屉宽 320dp 换算），
// 左甩再快也不认。新口径：相对起始行程 0.25（≈80dp）翻转 + 双向
// ±400dp/s 快划定案。
describe('drawerReleaseTarget 松手落点判定', () => {
  it('自关闭慢拖：过 0.25 行程才开，未达弹回', () => {
    expect(
      drawerReleaseTarget({ startProgress: 0, progress: 0.2, velocityX: 0 })
    ).toBe(0);
    expect(
      drawerReleaseTarget({ startProgress: 0, progress: 0.3, velocityX: 0 })
    ).toBe(1);
  });

  it('自打开慢拖：拖回 0.25 行程即关（旧口径要拖到 0.45 以下＝0.55 行程）', () => {
    expect(
      drawerReleaseTarget({ startProgress: 1, progress: 0.8, velocityX: 0 })
    ).toBe(1);
    expect(
      drawerReleaseTarget({ startProgress: 1, progress: 0.7, velocityX: 0 })
    ).toBe(0);
  });

  it('短促快划关抽屉：位移极小、左向速度过阈 → 关（旧口径完全不读左向速度）', () => {
    expect(
      drawerReleaseTarget({ startProgress: 1, progress: 0.95, velocityX: -500 })
    ).toBe(0);
  });

  it('短促快划开抽屉：位移极小、右向速度过阈 → 开', () => {
    expect(
      drawerReleaseTarget({ startProgress: 0, progress: 0.05, velocityX: 500 })
    ).toBe(1);
  });

  it('速度优先于位置：打开态被拖到中途后右向快划 → 仍回全开', () => {
    expect(
      drawerReleaseTarget({ startProgress: 1, progress: 0.6, velocityX: 500 })
    ).toBe(1);
    expect(
      drawerReleaseTarget({ startProgress: 0, progress: 0.4, velocityX: -500 })
    ).toBe(0);
  });

  it('速度恰在阈值上不算快划，落回行程判定', () => {
    expect(
      drawerReleaseTarget({ startProgress: 1, progress: 0.95, velocityX: -400 })
    ).toBe(1);
  });
});

// Card Push 原型层叠卡片推移架构与手势解耦：
// - 主界面作为顶层圆角卡片向右推开，底层抽屉面板微视差展露；
// - 绝无黑色遮罩层（Scrim），纯靠色阶差与大圆角产生立体感；
// - 点击主卡片即可收起抽屉；
// - 手势与动画期间不触发 isOpen 中途更新，仅在落定后同步。
describe('Card Push 原型层叠卡片推移架构与手势解耦', () => {
  it('主界面作为顶层卡片推开，底层抽屉微视差，无黑色遮罩，支持点击主卡片收起', async () => {
    const view = await render(
      <CrishDrawerLayout>
        <View testID="main-child" />
      </CrishDrawerLayout>
    );
    expect(view.getByTestId('main-child')).toBeTruthy();
    expect(view.getByTestId('drawer-tap-dismiss')).toBeTruthy();
  });

  it('open() 会在启动动画前优先收起软键盘并失焦', async () => {
    const dismissSpy = jest.spyOn(Keyboard, 'dismiss');
    let triggerOpen: () => void = () => {};
    function OpenProbe() {
      const actions = useDrawerActions();
      triggerOpen = actions.open;
      return null;
    }
    await render(
      <CrishDrawerLayout>
        <OpenProbe />
      </CrishDrawerLayout>
    );
    await act(async () => {
      triggerOpen();
    });
    expect(dismissSpy).toHaveBeenCalled();
    dismissSpy.mockRestore();
  });

  it('状态面 isOpen 仅在动画落定后同步，避免拖动中途重新计算会话分组', async () => {
    const seenIsOpen: boolean[] = [];
    let triggerOpen: () => void = () => {};
    let triggerClose: () => void = () => {};
    function StatusProbe() {
      const controller = useDrawerController();
      triggerOpen = controller.open;
      triggerClose = controller.close;
      seenIsOpen.push(controller.isOpen);
      return null;
    }
    await render(
      <CrishDrawerLayout>
        <StatusProbe />
      </CrishDrawerLayout>
    );
    expect(seenIsOpen[seenIsOpen.length - 1]).toBe(false);

    await act(async () => {
      triggerOpen();
    });
    expect(seenIsOpen[seenIsOpen.length - 1]).toBe(true);

    await act(async () => {
      triggerClose();
    });
    expect(seenIsOpen[seenIsOpen.length - 1]).toBe(false);
  });
});

// 动作面稳定性（C-PERF）：旧形态单一 controller 含 isOpen——动画
// 中点（progress 过 0.5）isOpen 翻转 → controller 换 identity →
// 全体消费方在动画中段重渲染。拆分后 actions 不随 isOpen 变：
// 跨重渲染恒为同一对象，useOpenDrawer 的回调随之稳定，纯动作
// 消费方（汉堡钮/导航回调）不再被翻转惊动。
describe('抽屉动作面稳定性（C-PERF）', () => {
  it('actions 与开抽屉回调跨重渲染保持同一引用', async () => {
    const seenActions: unknown[] = [];
    const seenOpenCallbacks: unknown[] = [];
    let bump: () => void = () => {};
    function Probe() {
      const [, setTick] = useState(0);
      bump = () => setTick((t) => t + 1);
      seenActions.push(useDrawerActions());
      seenOpenCallbacks.push(useOpenDrawer());
      return null;
    }
    await render(
      <CrishDrawerLayout>
        <Probe />
      </CrishDrawerLayout>
    );
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        bump();
      });
    }
    expect(seenActions.length).toBeGreaterThanOrEqual(4);
    for (const a of seenActions) expect(a).toBe(seenActions[0]);
    expect(seenOpenCallbacks.length).toBeGreaterThanOrEqual(4);
    for (const cb of seenOpenCallbacks) expect(cb).toBe(seenOpenCallbacks[0]);
  });

  it('容器外 useDrawerActions 返回稳定 no-op（深链安全口径不变）', async () => {
    const seen: unknown[] = [];
    function OutsideProbe() {
      seen.push(useDrawerActions());
      return null;
    }
    const view = await render(<OutsideProbe />);
    await view.rerender(<OutsideProbe />);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const a of seen) expect(a).toBe(seen[0]);
  });
});

describe('CrishDrawerLayout 侧滑手势重塑与即时接管（手到即停/极速让位/键盘异步收起）', () => {
  it('源码铁律：FAIL_DY 调整为 12dp，杜绝首帧触碰跨线程调度，闭合态 75% 限制与打开态仅向左收起', () => {
    const source = readFileSync(
      join(__dirname, 'CrishDrawerLayout.tsx'),
      'utf8'
    );
    expect(source).toMatch(/const FAIL_DY = 12;/);
    const touchesDownMatch = source.match(
      /\.onTouchesDown\(\(event\) => \{([\s\S]*?)\}\)/
    );
    expect(touchesDownMatch).toBeTruthy();
    expect(touchesDownMatch![1]).toContain('cancelAnimation(progress)');
    expect(touchesDownMatch![1]).not.toMatch(/runOnJS\(mountContent\)/);
    expect(touchesDownMatch![1]).not.toMatch(
      /runOnJS\(dismissKeyboardAndBlur\)/
    );

    expect(source).toMatch(
      /\.onStart\(\(\) => \{[\s\S]*?dismissKeyboardAndBlur[\s\S]*?\}\)/
    );
    expect(source).toContain('touchStartX.value > width * 0.75');
    expect(source).toContain('dx < -10');
    expect(source).toContain('dx < -ACTIVATION_DX && absDx > absDy * 0.7');
    expect(source).toContain('else if (dx > ACTIVATION_DX)');
  });

  it('手势全生命周期行为：手到即停(cancelAnimation)、极速让位(FAIL_DY=12)、闭合区范围限制与打开态单向收起', async () => {
    const capturedPan: any = {};
    const panSpy = jest.spyOn(Gesture, 'Pan').mockImplementation(() => {
      const handler: any = {
        manualActivation: jest.fn(() => handler),
        onTouchesDown: jest.fn((cb) => {
          capturedPan.onTouchesDown = cb;
          return handler;
        }),
        onTouchesMove: jest.fn((cb) => {
          capturedPan.onTouchesMove = cb;
          return handler;
        }),
        onStart: jest.fn((cb) => {
          capturedPan.onStart = cb;
          return handler;
        }),
        onUpdate: jest.fn((cb) => {
          capturedPan.onUpdate = cb;
          return handler;
        }),
        onEnd: jest.fn((cb) => {
          capturedPan.onEnd = cb;
          return handler;
        }),
      };
      return handler;
    });

    const cancelAnimationSpy = jest.spyOn(Reanimated, 'cancelAnimation');
    const dismissSpy = jest.spyOn(drawerFocus, 'dismissKeyboardAndBlur');

    let triggerOpen: () => void = () => {};
    function Probe() {
      const actions = useDrawerActions();
      triggerOpen = actions.open;
      return null;
    }

    await render(
      <CrishDrawerLayout>
        <Probe />
      </CrishDrawerLayout>
    );

    expect(capturedPan.onTouchesDown).toBeDefined();
    expect(capturedPan.onTouchesMove).toBeDefined();
    expect(capturedPan.onStart).toBeDefined();

    // 1. onTouchesDown 必须触发 cancelAnimation 实现手到即停，且严禁触发跨线程 dismissKeyboardAndBlur
    dismissSpy.mockClear();
    cancelAnimationSpy.mockClear();
    capturedPan.onTouchesDown({ allTouches: [{ x: 50, y: 100 }] });
    expect(cancelAnimationSpy).toHaveBeenCalledWith(
      expect.objectContaining({ value: expect.anything() })
    );
    expect(dismissSpy).not.toHaveBeenCalled();

    // 2. onStart 仅在确认为开抽屉手势时异步收起键盘
    capturedPan.onStart();
    expect(dismissSpy).toHaveBeenCalledTimes(1);

    // 3. onTouchesMove - 纵向极速让位（absDy > 12 且 absDy > absDx）
    const smVertical = { fail: jest.fn(), activate: jest.fn() };
    capturedPan.onTouchesMove({ allTouches: [{ x: 55, y: 115 }] }, smVertical); // dx = 5, dy = 15
    expect(smVertical.fail).toHaveBeenCalledTimes(1);
    expect(smVertical.activate).not.toHaveBeenCalled();

    // 4. onTouchesMove - 关闭态触碰超过左侧 75% 宽度直接失败（假设屏幕宽 750dp，750 * 0.75 = 562.5）
    capturedPan.onTouchesDown({ allTouches: [{ x: 600, y: 100 }] });
    const smEdge = { fail: jest.fn(), activate: jest.fn() };
    capturedPan.onTouchesMove({ allTouches: [{ x: 630, y: 102 }] }, smEdge); // dx = 30
    expect(smEdge.fail).toHaveBeenCalledTimes(1);
    expect(smEdge.activate).not.toHaveBeenCalled();

    // 5. onTouchesMove - 关闭态左滑快速失败（dx < -10）
    capturedPan.onTouchesDown({ allTouches: [{ x: 50, y: 100 }] });
    const smLeft = { fail: jest.fn(), activate: jest.fn() };
    capturedPan.onTouchesMove({ allTouches: [{ x: 35, y: 100 }] }, smLeft); // dx = -15
    expect(smLeft.fail).toHaveBeenCalledTimes(1);
    expect(smLeft.activate).not.toHaveBeenCalled();

    // 6. onTouchesMove - 关闭态有效右滑激活抽屉（dx > 14 且 dx > absDy * 0.7）
    capturedPan.onTouchesDown({ allTouches: [{ x: 50, y: 100 }] });
    const smOpen = { fail: jest.fn(), activate: jest.fn() };
    capturedPan.onTouchesMove({ allTouches: [{ x: 75, y: 102 }] }, smOpen); // dx = 25, dy = 2
    expect(smOpen.activate).toHaveBeenCalledTimes(1);
    expect(smOpen.fail).not.toHaveBeenCalled();

    // 7. 打开态手势：仅向左收起（dx < -14 && absDx > absDy * 0.7）激活；向右拖动（dx > 14）失败
    await act(async () => {
      triggerOpen();
    });

    capturedPan.onTouchesDown({ allTouches: [{ x: 300, y: 100 }] });
    // 向左拖动收起
    const smClose = { fail: jest.fn(), activate: jest.fn() };
    capturedPan.onTouchesMove({ allTouches: [{ x: 270, y: 102 }] }, smClose); // dx = -30
    expect(smClose.activate).toHaveBeenCalledTimes(1);
    expect(smClose.fail).not.toHaveBeenCalled();

    // 向右拖动失败
    const smRightFail = { fail: jest.fn(), activate: jest.fn() };
    capturedPan.onTouchesMove(
      { allTouches: [{ x: 330, y: 102 }] },
      smRightFail
    ); // dx = 30
    expect(smRightFail.fail).toHaveBeenCalledTimes(1);
    expect(smRightFail.activate).not.toHaveBeenCalled();

    panSpy.mockRestore();
    cancelAnimationSpy.mockRestore();
    dismissSpy.mockRestore();
  });
});
