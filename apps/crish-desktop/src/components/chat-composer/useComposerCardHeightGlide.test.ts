// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/chat-composer/useComposerCardHeightGlide.test.ts
 * S9 高度族 H-01/H-03：卡片高度滑翔引擎单测（框架无关部分）。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ComposerCardHeightGlide } from './useComposerCardHeightGlide';
import {
  calcAccordionDuration,
  EASE_DECELERATE,
} from '../../utils/motionTokens';

interface FakeAnimation {
  onfinish: (() => void) | null;
  cancel: ReturnType<typeof vi.fn>;
}

function makeCard(scrollHeight: number) {
  const el = document.createElement('div');
  let currentScrollHeight = scrollHeight;
  Object.defineProperty(el, 'scrollHeight', {
    get: () => currentScrollHeight,
    configurable: true,
  });
  const animations: Array<{
    frames: Keyframe[];
    options: KeyframeAnimationOptions;
    anim: FakeAnimation;
  }> = [];
  el.animate = vi.fn(
    (frames: Keyframe[] | PropertyIndexedKeyframes, options?: KeyframeAnimationOptions) => {
      const anim: FakeAnimation = { onfinish: null, cancel: vi.fn() };
      animations.push({
        frames: frames as Keyframe[],
        options: options ?? {},
        anim,
      });
      return anim as unknown as Animation;
    }
  ) as unknown as typeof el.animate;
  return {
    el,
    animations,
    setScrollHeight: (h: number) => {
      currentScrollHeight = h;
    },
  };
}

describe('ComposerCardHeightGlide', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('首次 sync 直接落位，不播动画（挂载不播）', () => {
    const { el, animations } = makeCard(100);
    const glide = new ComposerCardHeightGlide(el);
    glide.sync();
    expect(el.style.height).toBe('100px');
    expect(animations).toHaveLength(0);
  });

  it('生长：以 calcAccordionDuration 时长 + EASE_DECELERATE 从当前高滑翔到目标高，落定后写回显式高度', () => {
    const { el, animations, setScrollHeight } = makeCard(100);
    const glide = new ComposerCardHeightGlide(el);
    glide.sync();

    setScrollHeight(160);
    glide.sync();
    expect(animations).toHaveLength(1);
    expect(animations[0].frames).toEqual([
      { height: '100px' },
      { height: '160px' },
    ]);
    expect(animations[0].options.duration).toBe(
      calcAccordionDuration(60, true)
    );
    expect(animations[0].options.easing).toBe(EASE_DECELERATE);

    animations[0].anim.onfinish?.();
    expect(el.style.height).toBe('160px');
  });

  it('收缩（发送后回落）：时长走收起口径 calcAccordionDuration(delta, false)', () => {
    const { el, animations, setScrollHeight } = makeCard(180);
    const glide = new ComposerCardHeightGlide(el);
    glide.sync();

    setScrollHeight(120);
    glide.sync();
    expect(animations).toHaveLength(1);
    expect(animations[0].frames).toEqual([
      { height: '180px' },
      { height: '120px' },
    ]);
    expect(animations[0].options.duration).toBe(
      calcAccordionDuration(60, false)
    );
  });

  it('动画中途目标再变：取消旧动画并从当前呈现高重靶向，不跳回起点', () => {
    const { el, animations, setScrollHeight } = makeCard(100);
    const glide = new ComposerCardHeightGlide(el);
    glide.sync();

    setScrollHeight(160);
    glide.sync();
    setScrollHeight(220);
    glide.sync();

    expect(animations).toHaveLength(2);
    expect(animations[0].anim.cancel).toHaveBeenCalledTimes(1);
    // jsdom 读不到 WAAPI 实时呈现高（computed height 非动画值）时，
    // 引擎回落到在飞动画的目标高 160px 作为重靶向起点——不回落到
    // 动画最初的 100px 起点重播；真实浏览器下起点为动画实时值。
    expect(animations[1].frames).toEqual([
      { height: '160px' },
      { height: '220px' },
    ]);
  });

  it('目标高无变化（< 0.5px）时不播动画，直接保持落定', () => {
    const { el, animations } = makeCard(100);
    const glide = new ComposerCardHeightGlide(el);
    glide.sync();
    glide.sync();
    expect(animations).toHaveLength(0);
    expect(el.style.height).toBe('100px');
  });

  it('WAAPI 不可用时直接落位（降级不丢高度同步）', () => {
    const { el, setScrollHeight } = makeCard(100);
    const glide = new ComposerCardHeightGlide(el);
    glide.sync();
    el.animate = undefined as unknown as typeof el.animate;
    setScrollHeight(150);
    glide.sync();
    expect(el.style.height).toBe('150px');
  });

  it('自然高测不到（scrollHeight 为 0）时不接管高度', () => {
    const { el } = makeCard(0);
    const glide = new ComposerCardHeightGlide(el);
    glide.sync();
    expect(el.style.height).toBe('');
  });

  it('dispose 取消动画并清除显式高度', () => {
    const { el, animations, setScrollHeight } = makeCard(100);
    const glide = new ComposerCardHeightGlide(el);
    glide.sync();
    setScrollHeight(160);
    glide.sync();
    glide.dispose();
    expect(animations[0].anim.cancel).toHaveBeenCalledTimes(1);
    expect(el.style.height).toBe('');
  });
});
