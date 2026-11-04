// 抽屉内容挂载（M5 预挂载 → 批 D 常驻化）：布局挂载后的首个 effect
// 即挂载抽屉内容且永不卸载——无需等首次打开、更无需等 progress
// 过半；首开时内容已就位、开合全程零挂载。内容组件在此以桩替身
// （只钉挂载时机，不测其内部）。
import { readFileSync } from 'fs';
import { join } from 'path';
import { useState } from 'react';
import { act, render } from '@testing-library/react-native';
import { Keyboard, View } from 'react-native';
import { CrishDrawerLayout, drawerReleaseTarget } from './CrishDrawerLayout';
import { useDrawerActions, useDrawerController } from './DrawerContext';
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
    expect(
      drawerReleaseTarget({ startProgress: 0, progress: 0.1, velocityX: 400 })
    ).toBe(0);
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
