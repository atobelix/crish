// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeAll } from 'vitest';
import { ChatOverlayScrollbar } from './ChatOverlayScrollbar';

/**
 * 组件级行为：几何只读 scroller 本体；总高阶跃帧 data-smooth 落 'both'，
 * 手势窗内落 'none'；几何无变化的 scroll 事件不许改写 data-smooth
 * （否则会腰斩在途的总高过渡）。ResizeObserver 在本套件中以静默桩
 * 替身（同步由 scroll 事件驱动即可全覆盖断言面）。
 */
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

interface FakeScroller {
  el: HTMLDivElement;
  ref: React.RefObject<HTMLDivElement | null>;
  set: (patch: Partial<Geom>) => void;
}

interface Geom {
  scrollHeight: number;
  clientHeight: number;
  clientWidth: number;
  scrollTop: number;
}

function makeScroller(init: Geom): FakeScroller {
  const geom = { ...init };
  const el = document.createElement('div');
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => geom.scrollHeight },
    clientHeight: { configurable: true, get: () => geom.clientHeight },
    clientWidth: { configurable: true, get: () => geom.clientWidth },
    scrollTop: {
      configurable: true,
      get: () => geom.scrollTop,
      set: (v: number) => {
        geom.scrollTop = v;
      },
    },
  });
  const inner = document.createElement('div');
  inner.setAttribute('data-chat-list-inner', '');
  el.appendChild(inner);
  document.body.appendChild(el);
  return {
    el,
    ref: { current: el },
    set: (patch) => Object.assign(geom, patch),
  };
}

const BASE: Geom = {
  scrollHeight: 2400,
  clientHeight: 600,
  clientWidth: 800,
  scrollTop: 0,
};

describe('ChatOverlayScrollbar', () => {
  it('溢出时挂载即按 scroller 几何写入滑块尺寸/位移并置可见', () => {
    const fake = makeScroller(BASE);
    const { unmount } = render(
      <ChatOverlayScrollbar scrollerRef={fake.ref} />
    );
    const bar = document.querySelector('[data-chat-overlay-scrollbar]');
    expect(bar?.getAttribute('data-visible')).toBe('true');
    const thumb = screen.getByTestId('chat-overlay-scrollbar-thumb');
    expect(thumb.style.height).toBe('150px');
    expect(thumb.style.transform).toBe('translate3d(0, 0px, 0)');
    unmount();
  });

  it('未溢出（短内容）时整条不可见、滑块高 0', () => {
    const fake = makeScroller({ ...BASE, scrollHeight: 500 });
    const { unmount } = render(
      <ChatOverlayScrollbar scrollerRef={fake.ref} />
    );
    const bar = document.querySelector('[data-chat-overlay-scrollbar]');
    expect(bar?.getAttribute('data-visible')).toBe('false');
    const thumb = screen.getByTestId('chat-overlay-scrollbar-thumb');
    expect(thumb.style.height).toBe('0px');
    unmount();
  });

  it('纯滚动位置变化：位移直写、data-smooth=none（不平滑）', () => {
    const fake = makeScroller(BASE);
    const { unmount } = render(
      <ChatOverlayScrollbar scrollerRef={fake.ref} />
    );
    const thumb = screen.getByTestId('chat-overlay-scrollbar-thumb');
    fake.set({ scrollTop: 900 });
    fireEvent.scroll(fake.el);
    expect(thumb.style.transform).toBe('translate3d(0, 225px, 0)');
    expect(thumb.dataset.smooth).toBe('none');
    unmount();
  });

  it('总高阶跃（位置未动）：data-smooth=both 且高度过渡到新值；无变化的 scroll 不许腰斩门控', () => {
    const fake = makeScroller(BASE);
    const { unmount } = render(
      <ChatOverlayScrollbar scrollerRef={fake.ref} />
    );
    const thumb = screen.getByTestId('chat-overlay-scrollbar-thumb');
    fake.set({ scrollHeight: 1800 });
    fireEvent.scroll(fake.el);
    expect(thumb.dataset.smooth).toBe('both');
    expect(thumb.style.height).toBe('200px');
    // 几何无变化的后续 scroll 事件：不得改写 data-smooth（在途过渡保护）
    fireEvent.scroll(fake.el);
    expect(thumb.dataset.smooth).toBe('both');
    unmount();
  });

  it('手势窗内（wheel 后）的总高变化：全直写 data-smooth=none', () => {
    const fake = makeScroller(BASE);
    const { unmount } = render(
      <ChatOverlayScrollbar scrollerRef={fake.ref} />
    );
    const thumb = screen.getByTestId('chat-overlay-scrollbar-thumb');
    fireEvent.wheel(fake.el);
    fake.set({ scrollHeight: 3000 });
    fireEvent.scroll(fake.el);
    expect(thumb.dataset.smooth).toBe('none');
    expect(thumb.style.height).toBe('120px');
    unmount();
  });

  it('视口宽度变化（侧栏动画）后的总高变化：直接跟随不平滑', () => {
    const fake = makeScroller(BASE);
    const { unmount } = render(
      <ChatOverlayScrollbar scrollerRef={fake.ref} />
    );
    const thumb = screen.getByTestId('chat-overlay-scrollbar-thumb');
    fake.set({ clientWidth: 640, scrollHeight: 2000 });
    fireEvent.scroll(fake.el);
    expect(thumb.dataset.smooth).toBe('none');
    expect(thumb.style.height).toBe('180px');
    unmount();
  });
});
