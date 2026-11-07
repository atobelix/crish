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

describe('CrishDrawerLayout 侧滑手势重塑与即时接管（手到即停/纵向去噪让位/键盘异步收起）', () => {
  it('源码铁律：FAIL_DY 为 12dp 且判 fail 须多采样确认，杜绝首帧触碰跨线程调度，闭合态全域起手（无起始线、无反向瞬时判死）与打开态仅向左收起，onFinalize 收口在位', () => {
    const source = readFileSync(
      join(__dirname, 'CrishDrawerLayout.tsx'),
      'utf8'
    );
    expect(source).toMatch(/const FAIL_DY = 12;/);
    // FAIL_DY 去噪（2026-11-05 返工）：单采样即时定案已废除，纵向占优
    // 须连续 FAIL_DY_CONFIRM_SAMPLES 个采样点成立才判 fail
    expect(source).toMatch(/const FAIL_DY_CONFIRM_SAMPLES = 3;/);
    expect(source).toContain('failDyStreak.value >= FAIL_DY_CONFIRM_SAMPLES');
    // 生命周期收口（题 8 冻结链根治）：onFinalize 必须在手势链上
    expect(source).toContain('.onFinalize(');
    expect(source).toContain('endHandled');
    const touchesDownMatch = source.match(
      /\.onTouchesDown\(\(event\) => \{([\s\S]*?)\}\)/
    );
    expect(touchesDownMatch).toBeTruthy();
    expect(touchesDownMatch![1]).toContain('cancelAnimation(progress)');
    expect(touchesDownMatch![1]).not.toMatch(/runOnJS\(mountContent\)/);
    expect(touchesDownMatch![1]).not.toMatch(
      /runOnJS\(dismissKeyboardAndBlur\)/
    );
    // 多指纪律（2026-11-05 卡手修复 S-D）：仅单指按下重置基准
    expect(touchesDownMatch![1]).toContain('allTouches.length !== 1');

    expect(source).toMatch(
      /\.onStart\(\(\) => \{[\s\S]*?dismissKeyboardAndBlur[\s\S]*?\}\)/
    );
    // 起始线与反向瞬时判死已拆除（2026-11-07 E 步复现定案）：关闭态
    // 不得再按起手位置（屏宽 75%）或 dx < -10 在 onTouchesMove 里瞬时
    // 判 fail——两条都是复现坐实的「经常打不开」首因；关闭态判 fail
    // 只允许来自上方纵向三采样让位
    expect(source).not.toMatch(/touchStartX\.value > width \* 0\.75/);
    expect(source).not.toMatch(/if \(dx < -10\)/);
    expect(source).toContain('dx < -ACTIVATION_DX && absDx > absDy * 0.7');
    // 打开态右摇不判死（2026-11-05 卡手修复 S-C）：旧 `dx > ACTIVATION_DX
    // → fail()` 永久放弃手势的策略已删除——不激活即不消费触摸，方向回摆
    // 可再激活；按 pointer id 钉死首触（S-D 移动取触点）
    expect(source).not.toContain('else if (dx > ACTIVATION_DX)');
    expect(source).toContain(
      'event.allTouches.find((t) => t.id === gesturePointerId.value)'
    );
    expect(source).not.toContain('onTouchStart={handleDrawerClose}');
  });

  it('手势全生命周期行为：手到即停(cancelAnimation)、纵向去噪让位(FAIL_DY=12×3 采样)、闭合态全域起手与反向不判死、打开态单向收起', async () => {
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
        onTouchesUp: jest.fn(() => handler),
        onTouchesCancelled: jest.fn(() => handler),
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
        onFinalize: jest.fn((cb) => {
          capturedPan.onFinalize = cb;
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

    // 3. onTouchesMove - 纵向让位去噪（absDy > 12 且 absDy > absDx 须
    //    连续 3 个采样点成立才判 fail；单帧/双帧纵向抖动不定案、不激活）
    const smVertical = { fail: jest.fn(), activate: jest.fn() };
    capturedPan.onTouchesMove({ allTouches: [{ x: 55, y: 115 }] }, smVertical); // dx = 5, dy = 15（第 1 采样）
    expect(smVertical.fail).not.toHaveBeenCalled();
    capturedPan.onTouchesMove({ allTouches: [{ x: 55, y: 118 }] }, smVertical); // dy = 18（第 2 采样）
    expect(smVertical.fail).not.toHaveBeenCalled();
    capturedPan.onTouchesMove({ allTouches: [{ x: 55, y: 121 }] }, smVertical); // dy = 21（第 3 采样，定案）
    expect(smVertical.fail).toHaveBeenCalledTimes(1);
    expect(smVertical.activate).not.toHaveBeenCalled();

    // 3b. 去噪清零：纵向占优中间夹一个非纵向采样，计数重新起算
    capturedPan.onTouchesDown({ allTouches: [{ x: 50, y: 100 }] });
    const smReset = { fail: jest.fn(), activate: jest.fn() };
    capturedPan.onTouchesMove({ allTouches: [{ x: 55, y: 115 }] }, smReset); // 纵向 1
    capturedPan.onTouchesMove({ allTouches: [{ x: 55, y: 118 }] }, smReset); // 纵向 2
    capturedPan.onTouchesMove({ allTouches: [{ x: 58, y: 103 }] }, smReset); // dx = 8, dy = 3：条件消散，清零
    capturedPan.onTouchesMove({ allTouches: [{ x: 55, y: 115 }] }, smReset); // 纵向 1（重新起算）
    capturedPan.onTouchesMove({ allTouches: [{ x: 55, y: 118 }] }, smReset); // 纵向 2
    expect(smReset.fail).not.toHaveBeenCalled();
    capturedPan.onTouchesMove({ allTouches: [{ x: 55, y: 121 }] }, smReset); // 纵向 3，定案
    expect(smReset.fail).toHaveBeenCalledTimes(1);

    // 4. onTouchesMove - 关闭态右半屏起手横向右滑激活（2026-11-07 E 步
    //    复现定案：旧口径起手在屏宽 75% 以右首个采样即 fail——屏幕宽
    //    750dp 时 75% 线 = 562.5，x=600 起手 dx=30 的纯横向开抽屉意图
    //    被判死；起始线拆除后内容区全域可起手）
    capturedPan.onTouchesDown({ allTouches: [{ x: 600, y: 100 }] });
    const smEdge = { fail: jest.fn(), activate: jest.fn() };
    capturedPan.onTouchesMove({ allTouches: [{ x: 630, y: 102 }] }, smEdge); // dx = 30
    expect(smEdge.activate).toHaveBeenCalledTimes(1);
    expect(smEdge.fail).not.toHaveBeenCalled();

    // 5. onTouchesMove - 关闭态先左偏再回摆右滑不判死（2026-11-07 E 步
    //    复现定案：旧口径 dx < -10 首个采样即 fail，「先轻微左偏再向
    //    右」的起手整条作废；拆除后与打开态 S-C 同口径——反向摇摆不
    //    激活也不判死，回摆越过激活门仍可激活）
    capturedPan.onTouchesDown({ allTouches: [{ x: 50, y: 100 }] });
    const smLeft = { fail: jest.fn(), activate: jest.fn() };
    capturedPan.onTouchesMove({ allTouches: [{ x: 35, y: 100 }] }, smLeft); // dx = -15
    expect(smLeft.fail).not.toHaveBeenCalled();
    expect(smLeft.activate).not.toHaveBeenCalled();
    capturedPan.onTouchesMove({ allTouches: [{ x: 90, y: 102 }] }, smLeft); // dx = +40：回摆激活
    expect(smLeft.activate).toHaveBeenCalledTimes(1);
    expect(smLeft.fail).not.toHaveBeenCalled();

    // 5b. onTouchesMove - 右半屏起手纵向滑仍须满 3 采样才判 fail（起始
    //     线拆除后纵向列表优先不削弱：不得因起手位置被瞬时判死）
    capturedPan.onTouchesDown({ allTouches: [{ x: 600, y: 100 }] });
    const smEdgeVertical = { fail: jest.fn(), activate: jest.fn() };
    capturedPan.onTouchesMove({ allTouches: [{ x: 605, y: 116 }] }, smEdgeVertical); // 纵向 1
    capturedPan.onTouchesMove({ allTouches: [{ x: 606, y: 120 }] }, smEdgeVertical); // 纵向 2
    expect(smEdgeVertical.fail).not.toHaveBeenCalled();
    capturedPan.onTouchesMove({ allTouches: [{ x: 607, y: 124 }] }, smEdgeVertical); // 纵向 3，定案
    expect(smEdgeVertical.fail).toHaveBeenCalledTimes(1);
    expect(smEdgeVertical.activate).not.toHaveBeenCalled();

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

    // 向右拖动（2026-11-05 卡手修复 S-C）：不激活也不判死——手势保持未消费
    // 状态，方向回摆后仍可激活左移；松手时手势未激活即不产生任何落位
    const smRightHold = { fail: jest.fn(), activate: jest.fn() };
    capturedPan.onTouchesMove(
      { allTouches: [{ x: 330, y: 102 }] },
      smRightHold
    ); // dx = 30
    expect(smRightHold.fail).not.toHaveBeenCalled();
    expect(smRightHold.activate).not.toHaveBeenCalled();

    panSpy.mockRestore();
    cancelAnimationSpy.mockRestore();
    dismissSpy.mockRestore();
  });
});

describe('CrishDrawerLayout 物理弹簧动效与 GPU 零重排契约（任务单元 T4）', () => {
  it('源码契约：全量采用 withSpring + theme.motion.spring.drawer，彻底杜绝 withTiming 贝塞尔暴冲', () => {
    const source = readFileSync(
      join(__dirname, 'CrishDrawerLayout.tsx'),
      'utf8'
    );
    expect(source).not.toMatch(/\bwithTiming\(/);
    expect(source).not.toMatch(/\bEasing\b/);
    expect(source).toMatch(/\bwithSpring\(/);

    const springMatches = [...source.matchAll(/withSpring\(([\s\S]*?)\)/g)];
    expect(springMatches.length).toBeGreaterThanOrEqual(3);
    for (const match of springMatches) {
      expect(match[1]).toContain('theme.motion.spring.drawer');
      expect(match[1]).toContain('overshootClamping: true');
    }

    expect(source).toContain('normalizedVelocity');
    expect(source).toContain('velocity: normalizedVelocity');
  });

  it('GPU 零重排契约：主卡片圆角采用阶跃常量契约，严禁逐帧动态插值', () => {
    const source = readFileSync(
      join(__dirname, 'CrishDrawerLayout.tsx'),
      'utf8'
    );
    expect(source).not.toMatch(/borderRadius:\s*interpolate\(/);
    expect(source).toMatch(
      /borderRadius:\s*progress\.value\s*<=\s*0\.005\s*\?\s*0\s*:\s*theme\.radius\.sheet/
    );
  });

  it('运行时动效验证：open / close 与手势释放正确调用 withSpring 并传递参数', async () => {
    const withSpringSpy = jest.spyOn(Reanimated, 'withSpring');
    const capturedPan: Record<string, any> = {};
    const panSpy = jest.spyOn(Gesture, 'Pan').mockImplementation(() => {
      const handler: any = {
        manualActivation: jest.fn(() => handler),
        onTouchesDown: jest.fn(() => handler),
        onTouchesMove: jest.fn(() => handler),
        onTouchesUp: jest.fn(() => handler),
        onTouchesCancelled: jest.fn(() => handler),
        onStart: jest.fn(() => handler),
        onUpdate: jest.fn(() => handler),
        onEnd: jest.fn((cb) => {
          capturedPan.onEnd = cb;
          return handler;
        }),
        onFinalize: jest.fn(() => handler),
      };
      return handler;
    });

    let triggerOpen: () => void = () => {};
    let triggerClose: () => void = () => {};
    function Probe() {
      const actions = useDrawerActions();
      triggerOpen = actions.open;
      triggerClose = actions.close;
      return null;
    }

    await render(
      <CrishDrawerLayout>
        <Probe />
      </CrishDrawerLayout>
    );

    // 1. open() 触发 withSpring
    withSpringSpy.mockClear();
    await act(async () => {
      triggerOpen();
    });
    expect(withSpringSpy).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        damping: 30,
        stiffness: 260,
        mass: 1,
        overshootClamping: true,
      }),
      expect.any(Function)
    );

    // 2. close() 触发 withSpring
    withSpringSpy.mockClear();
    await act(async () => {
      triggerClose();
    });
    expect(withSpringSpy).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        damping: 30,
        stiffness: 260,
        mass: 1,
        overshootClamping: true,
      }),
      expect.any(Function)
    );

    // 3. pan.onEnd 注入 normalizedVelocity
    withSpringSpy.mockClear();
    expect(capturedPan.onEnd).toBeDefined();
    capturedPan.onEnd({ velocityX: 600 });
    expect(withSpringSpy).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        damping: 30,
        stiffness: 260,
        mass: 1,
        overshootClamping: true,
        velocity: expect.any(Number),
      }),
      expect.any(Function)
    );

    withSpringSpy.mockRestore();
    panSpy.mockRestore();
  });
});

// 生命周期收口（2026-11-05 返工，题 8 冻结链 + 激活跳变）：
// - 落定动画在飞时落指 cancelAnimation 把 progress 停在中间值，手势
//   若未激活结束/被判 fail，onEnd 永不触发——onFinalize 必须就近落位；
// - onEnd 已收口时 onFinalize 不得二次落位（防双重收口）；
// - 已在落定位（0/1）时 onFinalize 不得无谓起弹簧；
// - onUpdate 首帧捕获激活点位移为偏移，激活瞬间 progress 零跳变。
describe('CrishDrawerLayout 生命周期收口（onFinalize）与激活零跳变', () => {
  function capturePan() {
    const capturedPan: Record<string, any> = {};
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
        onTouchesUp: jest.fn(() => handler),
        onTouchesCancelled: jest.fn(() => handler),
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
        onFinalize: jest.fn((cb) => {
          capturedPan.onFinalize = cb;
          return handler;
        }),
      };
      return handler;
    });
    return { capturedPan, panSpy };
  }

  /** 驱动一次「激活并拖到中途」：落指(50,100) → 右移激活 → 拖拽位移序列 */
  function driveToMidDrag(capturedPan: Record<string, any>) {
    capturedPan.onTouchesDown({ allTouches: [{ id: 1, x: 50, y: 100 }] });
    const sm = { fail: jest.fn(), activate: jest.fn() };
    capturedPan.onTouchesMove({ allTouches: [{ id: 1, x: 75, y: 102 }] }, sm);
    expect(sm.activate).toHaveBeenCalled();
    capturedPan.onStart({ translationX: 25 });
    // 首帧 translationX=25 即激活点（捕获为偏移，progress 保持 0）
    capturedPan.onUpdate({ translationX: 25 });
    // 再拖 160dp（maxTranslate=320 时 progress = 160/320 = 0.5）
    capturedPan.onUpdate({ translationX: 185 });
  }

  it('手势链包含 onFinalize 收口', async () => {
    const { capturedPan, panSpy } = capturePan();
    await render(
      <CrishDrawerLayout>
        <View testID="main-child" />
      </CrishDrawerLayout>
    );
    expect(capturedPan.onFinalize).toBeDefined();
    panSpy.mockRestore();
  });

  it('冻结链收口：拖到中途后手势未走 onEnd（fail/取消），onFinalize 就近落位起弹簧', async () => {
    const { capturedPan, panSpy } = capturePan();
    const withSpringSpy = jest.spyOn(Reanimated, 'withSpring');
    await render(
      <CrishDrawerLayout>
        <View testID="main-child" />
      </CrishDrawerLayout>
    );
    driveToMidDrag(capturedPan);
    withSpringSpy.mockClear();
    // 不调用 onEnd，直接 onFinalize（模拟 fail/系统取消路径）
    capturedPan.onFinalize();
    // progress=0.5、自起始 0：就近落位 → 目标 1（行程口径 0.5 > 0.25）
    expect(withSpringSpy).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ overshootClamping: true }),
      expect.any(Function)
    );
    withSpringSpy.mockRestore();
    panSpy.mockRestore();
  });

  it('防双重收口：onEnd 已落位后 onFinalize 不再起弹簧', async () => {
    const { capturedPan, panSpy } = capturePan();
    const withSpringSpy = jest.spyOn(Reanimated, 'withSpring');
    await render(
      <CrishDrawerLayout>
        <View testID="main-child" />
      </CrishDrawerLayout>
    );
    driveToMidDrag(capturedPan);
    capturedPan.onEnd({ velocityX: 0 });
    expect(withSpringSpy).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ overshootClamping: true }),
      expect.any(Function)
    );
    withSpringSpy.mockClear();
    capturedPan.onFinalize();
    expect(withSpringSpy).not.toHaveBeenCalled();
    withSpringSpy.mockRestore();
    panSpy.mockRestore();
  });

  it('已在落定位时 onFinalize 不起无谓弹簧', async () => {
    const { capturedPan, panSpy } = capturePan();
    const withSpringSpy = jest.spyOn(Reanimated, 'withSpring');
    await render(
      <CrishDrawerLayout>
        <View testID="main-child" />
      </CrishDrawerLayout>
    );
    withSpringSpy.mockClear();
    capturedPan.onFinalize();
    expect(withSpringSpy).not.toHaveBeenCalled();
    withSpringSpy.mockRestore();
    panSpy.mockRestore();
  });

  it('激活零跳变：首帧位移被捕获为偏移，小行程松手弹回（旧换算会误判过 0.25 行程）', async () => {
    const { capturedPan, panSpy } = capturePan();
    const withSpringSpy = jest.spyOn(Reanimated, 'withSpring');
    await render(
      <CrishDrawerLayout>
        <View testID="main-child" />
      </CrishDrawerLayout>
    );
    capturedPan.onTouchesDown({ allTouches: [{ id: 1, x: 50, y: 100 }] });
    const sm = { fail: jest.fn(), activate: jest.fn() };
    capturedPan.onTouchesMove({ allTouches: [{ id: 1, x: 75, y: 102 }] }, sm);
    capturedPan.onStart({ translationX: 25 });
    capturedPan.onUpdate({ translationX: 25 }); // 激活帧：progress 仍为 0
    capturedPan.onUpdate({ translationX: 95 }); // 实际行程 70dp → progress 70/320 ≈ 0.22
    withSpringSpy.mockClear();
    capturedPan.onEnd({ velocityX: 0 });
    // progress ≈ 0.22 未过 0.25 行程 → 弹回 0；旧换算（95/320 ≈ 0.30）会误开
    expect(withSpringSpy).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ overshootClamping: true }),
      expect.any(Function)
    );
    expect(withSpringSpy).not.toHaveBeenCalledWith(
      1,
      expect.anything(),
      expect.anything()
    );
    withSpringSpy.mockRestore();
    panSpy.mockRestore();
  });
});
