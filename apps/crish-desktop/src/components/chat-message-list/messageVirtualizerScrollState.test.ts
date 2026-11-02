// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useStickToBottomFollow,
  type StickToBottomFollowParams,
} from './messageVirtualizerScrollState';

type Vs = StickToBottomFollowParams['vs'];

const MESSAGES: unknown[] = [{ id: 'm1' }];

function makeVs(perform: (el: HTMLElement, top: number) => void): Vs {
  return {
    scrollTop: 0,
    viewportHeight: 400,
    performProgrammaticScroll: perform,
  } as unknown as Vs;
}

interface StickProps {
  vs: Vs;
  totalHeight: number;
}

describe('R2：useStickToBottomFollow 不再随 vs 对象身份变化重跑', () => {
  it('新 vs 对象（字段同值）不重跑 effect、不再读 scrollHeight；totalHeight 变化才重跑', () => {
    let scrollHeightReads = 0;
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', {
      configurable: true,
      get: () => {
        scrollHeightReads += 1;
        return 1400;
      },
    });
    Object.defineProperty(el, 'clientHeight', {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      value: 0,
      writable: true,
    });

    const perform1 = vi.fn();
    const perform2 = vi.fn();
    const vs1 = makeVs(perform1);
    const vs2 = makeVs(perform2);

    // 其余依赖在真实宿主中均为稳定引用（refs / useCallback / useState setter），
    // 测试夹具同样保持稳定，单独隔离 vs 身份这一个变量。
    const containerRef = { current: el };
    const isAtBottomRef = { current: true };
    const observedTopRef = { current: 0 };
    const setIsAtBottom = () => {};
    const isAnchorLocked = () => false;

    // renderHook 回调即被测 hook 的夹具包装：以 use 前缀命名成合规的自定义
    // Hook 形态，rules-of-hooks 才认可其内部的 hook 调用（原名 invoke 触发该
    // 规则报错）。函数体与调用口径不变，纯命名调整。
    const useStickFollow = (p: StickProps) =>
      useStickToBottomFollow({
        containerRef,
        vs: p.vs,
        messages: MESSAGES as StickToBottomFollowParams['messages'],
        initialScroll: 'bottom',
        isSessionSwitch: false,
        totalHeight: p.totalHeight,
        isAnchorLocked,
        isAtBottomRef,
        setIsAtBottom,
        observedTopRef,
      });

    const { rerender } = renderHook(useStickFollow, {
      initialProps: { vs: vs1, totalHeight: 1000 },
    });

    // 挂载：effect 执行一次 —— 读 scrollHeight 一次并吸底
    expect(scrollHeightReads).toBe(1);
    expect(perform1).toHaveBeenCalledTimes(1);
    expect(perform1).toHaveBeenCalledWith(el, 1000);

    // 宿主重渲染并传入全新 vs 对象（字段同值）：effect 不得重跑
    rerender({ vs: vs2, totalHeight: 1000 });
    rerender({ vs: makeVs(perform2), totalHeight: 1000 });
    expect(scrollHeightReads).toBe(1);
    expect(perform2).not.toHaveBeenCalled();

    // 真实变化（totalHeight）：effect 重跑，读布局一次，并使用最新 vs 快照
    rerender({ vs: vs2, totalHeight: 1200 });
    expect(scrollHeightReads).toBe(2);
    expect(perform2).toHaveBeenCalledTimes(1);
    expect(perform2).toHaveBeenCalledWith(el, 1000);
  });
});
