// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/chat-composer/useComposerModeFlip.test.ts
 * S9 高度族 H-02：单/多行模式切换 FLIP 平移补偿单测。
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  computeFlipDelta,
  useComposerModeFlip,
} from './useComposerModeFlip';
import {
  calcAccordionDuration,
  EASE_DECELERATE,
} from '../../utils/motionTokens';

interface FakePart {
  style: Record<string, string>;
  transformHistory: string[];
  offsetWidth: number;
  getBoundingClientRect: () => {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
    x: number;
    y: number;
    toJSON: () => Record<string, never>;
  };
  setRect: (left: number, top: number) => void;
}

function makePart(left: number, top: number): FakePart {
  let rect = { left, top };
  const transformHistory: string[] = [];
  const style = new Proxy({} as Record<string, string>, {
    set(target, prop, value) {
      if (prop === 'transform') transformHistory.push(String(value));
      target[prop as string] = String(value);
      return true;
    },
  });
  return {
    style,
    transformHistory,
    offsetWidth: 120,
    getBoundingClientRect: () => ({
      left: rect.left,
      top: rect.top,
      right: rect.left + 120,
      bottom: rect.top + 28,
      width: 120,
      height: 28,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }),
    setRect: (l: number, t: number) => {
      rect = { left: l, top: t };
    },
  };
}

function makeLayoutRef(left: FakePart, right: FakePart) {
  const layout = {
    querySelector: (selector: string) => {
      if (selector.includes('"left"')) return left;
      if (selector.includes('"right"')) return right;
      return null;
    },
  };
  return {
    current: layout as unknown as HTMLElement,
  } as React.RefObject<HTMLElement | null>;
}

describe('computeFlipDelta', () => {
  it('位移 = 旧位置 - 新布局位置', () => {
    expect(
      computeFlipDelta({ left: 10, top: 100 }, { left: 10, top: 160 })
    ).toEqual({ dx: 0, dy: -60 });
    expect(
      computeFlipDelta({ left: 300, top: 50 }, { left: 40, top: 90 })
    ).toEqual({ dx: 260, dy: -40 });
  });
});

describe('useComposerModeFlip', () => {
  it('模式翻转时两组控件先逆位移到旧位置，再以高度族时长过渡回 identity', () => {
    const left = makePart(8, 100);
    const right = makePart(400, 100);
    const layoutRef = makeLayoutRef(left, right);

    const { rerender } = renderHook(
      ({ multi }: { multi: boolean }) => useComposerModeFlip(layoutRef, multi),
      { initialProps: { multi: false } }
    );

    // 切换到多行布局：两组控件落到第二行（top 100 → 164），右组同时左移
    left.setRect(8, 164);
    right.setRect(380, 164);
    rerender({ multi: true });

    const expectedDuration = calcAccordionDuration(64, true);
    expect(left.transformHistory).toEqual(['translate(0px, -64px)', '']);
    expect(left.style.transition).toBe(
      `transform ${expectedDuration}ms ${EASE_DECELERATE}`
    );
    expect(right.transformHistory).toEqual(['translate(20px, -64px)', '']);
    expect(right.style.transition).toContain('transform');
  });

  it('模式未翻转时即使位置变化也不做补偿', () => {
    const left = makePart(8, 100);
    const right = makePart(400, 100);
    const layoutRef = makeLayoutRef(left, right);
    const { rerender } = renderHook(
      ({ multi }: { multi: boolean }) => useComposerModeFlip(layoutRef, multi),
      { initialProps: { multi: false } }
    );
    left.setRect(8, 130);
    right.setRect(400, 130);
    rerender({ multi: false });
    expect(left.transformHistory).toEqual([]);
    expect(right.transformHistory).toEqual([]);
  });

  it('翻转但两组位置未变（位移 < 1px）时不加 transform', () => {
    const left = makePart(8, 100);
    const right = makePart(400, 100);
    const layoutRef = makeLayoutRef(left, right);
    const { rerender } = renderHook(
      ({ multi }: { multi: boolean }) => useComposerModeFlip(layoutRef, multi),
      { initialProps: { multi: true } }
    );
    rerender({ multi: false });
    expect(left.transformHistory).toEqual([]);
    expect(right.transformHistory).toEqual([]);
  });
});
