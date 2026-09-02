// @vitest-environment jsdom
import { render, screen, fireEvent, act } from '@testing-library/react';
import React, { createRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScrollArea, calculateSafeAreaInset } from './ScrollArea';
import { ScrollAreaHandle } from './ScrollArea.types';
import styles from './ScrollArea.module.css';

describe('ScrollArea Atomic Component (UI Layer Red Team Test Suite)', () => {
  let originalClientHeight: PropertyDescriptor | undefined;
  let originalScrollHeight: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();

    // 保存并增强 JSDOM HTMLElement.prototype 几何取值器，为视口提供真实排版基准 (高 200px, 内容 1000px)
    originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientHeight'
    );
    originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight'
    );

    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if ((this as unknown as { _customClientHeight?: number })._customClientHeight !== undefined) {
          return (this as unknown as { _customClientHeight: number })._customClientHeight;
        }
        if (
          this.getAttribute('role') === 'region' ||
          (typeof this.className === 'string' && this.className.includes(styles.viewport))
        ) {
          return 200;
        }
        return originalClientHeight?.get ? originalClientHeight.get.call(this) : 0;
      },
      set(this: HTMLElement, val: number) {
        (this as unknown as { _customClientHeight?: number })._customClientHeight = val;
      },
    });

    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if ((this as unknown as { _customScrollHeight?: number })._customScrollHeight !== undefined) {
          return (this as unknown as { _customScrollHeight: number })._customScrollHeight;
        }
        if (
          this.getAttribute('role') === 'region' ||
          (typeof this.className === 'string' && this.className.includes(styles.viewport))
        ) {
          return 1000;
        }
        return originalScrollHeight?.get ? originalScrollHeight.get.call(this) : 0;
      },
      set(this: HTMLElement, val: number) {
        (this as unknown as { _customScrollHeight?: number })._customScrollHeight = val;
      },
    });

    // 垫片 W3C Pointer Capture API
    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = vi.fn();
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = vi.fn();
    }
    if (!HTMLElement.prototype.hasPointerCapture) {
      HTMLElement.prototype.hasPointerCapture = vi.fn();
    }

    // 垫片 Element scrollTo
    if (!HTMLElement.prototype.scrollTo) {
      HTMLElement.prototype.scrollTo = vi.fn(function (
        this: HTMLElement,
        options?: ScrollToOptions | number,
        y?: number
      ) {
        if (typeof options === 'object' && options !== null) {
          if (options.top !== undefined) this.scrollTop = options.top;
          if (options.left !== undefined) this.scrollLeft = options.left;
        } else if (typeof options === 'number') {
          this.scrollLeft = options;
          if (y !== undefined) this.scrollTop = y;
        }
      });
    }

    // 垫片 window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();

    if (originalClientHeight) {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
    }
    if (originalScrollHeight) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
    }
  });

  it('TC-SA-01: 基础视口挂载与 children 渲染', () => {
    const handleRef = createRef<ScrollAreaHandle>();
    render(
      <ScrollArea
        ref={handleRef}
        as="section"
        ariaLabel="Test Viewport"
        data-testid="scroll-area"
      >
        <div data-testid="test-content">Inner Content</div>
      </ScrollArea>
    );

    const root = screen.getByTestId('scroll-area');
    expect(root.tagName.toLowerCase()).toBe('section');
    expect(screen.getByTestId('test-content')).toBeInTheDocument();
    expect(screen.getByText('Inner Content')).toBeInTheDocument();

    const region = screen.getByRole('region', { name: 'Test Viewport' });
    expect(region).toBeInTheDocument();
    expect(region.getAttribute('tabIndex')).toBe('0');

    // Handle 契约验证
    expect(handleRef.current).not.toBeNull();
    expect(handleRef.current?.getViewport()).toBe(region);
    const metrics = handleRef.current?.getMetrics();
    expect(metrics).toBeDefined();
    expect(metrics?.isAtTop).toBe(true);
  });

  it('TC-SA-02: showButtons 显隐与尺寸映射', () => {
    const { rerender } = render(
      <ScrollArea size="xs" data-testid="sa">
        <div>Content</div>
      </ScrollArea>
    );
    expect(screen.getByTestId('sa').className).toContain(styles.xs);

    rerender(
      <ScrollArea size="sm" data-testid="sa">
        <div>Content</div>
      </ScrollArea>
    );
    expect(screen.getByTestId('sa').className).toContain(styles.sm);

    rerender(
      <ScrollArea size="md" data-testid="sa">
        <div>Content</div>
      </ScrollArea>
    );
    expect(screen.getByTestId('sa').className).toContain(styles.md);

    rerender(
      <ScrollArea size="lg" data-testid="sa">
        <div>Content</div>
      </ScrollArea>
    );
    expect(screen.getByTestId('sa').className).toContain(styles.lg);

    // showButtons 显隐切换
    rerender(
      <ScrollArea size="md" showButtons={false}>
        <div>Content</div>
      </ScrollArea>
    );
    expect(screen.queryByLabelText('Scroll Up')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Scroll Down')).not.toBeInTheDocument();

    rerender(
      <ScrollArea size="md" showButtons={true}>
        <div>Content</div>
      </ScrollArea>
    );
    expect(screen.getByLabelText('Scroll Up')).toBeInTheDocument();
    expect(screen.getByLabelText('Scroll Down')).toBeInTheDocument();
  });

  it('TC-SA-03: size=\'xs\' 显式开启与默认关闭行为', () => {
    // 1. 未显式传入 showButtons 时，xs 默认无按钮
    const { rerender } = render(
      <ScrollArea size="xs">
        <div>Long Content</div>
      </ScrollArea>
    );
    expect(screen.queryByLabelText('Scroll Up')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Scroll Down')).not.toBeInTheDocument();

    // 2. 显式声明 showButtons={true} 时，允许 xs 渲染微型按钮 (M04 闭环)
    rerender(
      <ScrollArea size="xs" showButtons={true}>
        <div>Long Content</div>
      </ScrollArea>
    );
    expect(screen.getByLabelText('Scroll Up')).toBeInTheDocument();
    expect(screen.getByLabelText('Scroll Down')).toBeInTheDocument();

    // 3. 显式声明 showButtons={false} 时，sm 尺寸关闭按钮
    rerender(
      <ScrollArea size="sm" showButtons={false}>
        <div>Long Content</div>
      </ScrollArea>
    );
    expect(screen.queryByLabelText('Scroll Up')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Scroll Down')).not.toBeInTheDocument();
  });

  it('TC-SA-04: 单击步进器触发 40px 滚动', () => {
    const handleRef = createRef<ScrollAreaHandle>();
    render(
      <ScrollArea ref={handleRef} showButtons={true} stepSize={40}>
        <div>Long Content</div>
      </ScrollArea>
    );

    const downBtn = screen.getByLabelText('Scroll Down');
    const viewport = handleRef.current?.getViewport();
    if (!viewport) throw new Error('Viewport not found');

    const scrollToSpy = vi.spyOn(viewport, 'scrollTo');

    // 1. 点击向下步进按钮，触发 40px 步进
    fireEvent.pointerDown(downBtn, { button: 0 });
    expect(scrollToSpy).toHaveBeenCalledWith(
      expect.objectContaining({ top: 40, behavior: 'smooth' })
    );

    // 2. 模拟接近底部（maxScroll = 800，当前 798，微像素吸附）
    viewport.scrollTop = 798;
    fireEvent.pointerDown(downBtn, { button: 0 });
    expect(scrollToSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ top: 800, behavior: 'smooth' })
    );

    // 3. 点击向上步进按钮
    const upBtn = screen.getByLabelText('Scroll Up');
    viewport.scrollTop = 100;
    fireEvent.pointerDown(upBtn, { button: 0 });
    expect(scrollToSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ top: 60, behavior: 'smooth' })
    );
  });

  it('TC-SA-05: 持续按压触发 250ms 延迟与 20Hz 脉冲连发', () => {
    const handleRef = createRef<ScrollAreaHandle>();
    render(
      <ScrollArea ref={handleRef} showButtons={true}>
        <div>Long Content</div>
      </ScrollArea>
    );

    const downBtn = screen.getByLabelText('Scroll Down');
    const viewport = handleRef.current?.getViewport();
    if (!viewport) throw new Error('Viewport not found');

    const scrollToSpy = vi.spyOn(viewport, 'scrollTo');

    // 按下左键，立即触发首发
    fireEvent.pointerDown(downBtn, { button: 0 });
    expect(scrollToSpy).toHaveBeenCalledTimes(1);

    // 前进 200ms（未到 250ms 初延迟防抖），不应产生二次触发
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(scrollToSpy).toHaveBeenCalledTimes(1);

    // 前进至 360ms（进入 50ms 周期连发），连发激活
    act(() => {
      vi.advanceTimersByTime(160);
    });
    expect(scrollToSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

    // 连发阶段采用 'auto' 避免队列积压
    expect(scrollToSpy.mock.calls[1][0]).toEqual(
      expect.objectContaining({ behavior: 'auto' })
    );
  });

  it('TC-SA-06: 指针释放/失焦即时刚性刹车', () => {
    const handleRef = createRef<ScrollAreaHandle>();
    render(
      <ScrollArea ref={handleRef} showButtons={true}>
        <div>Long Content</div>
      </ScrollArea>
    );

    const downBtn = screen.getByLabelText('Scroll Down');
    const viewport = handleRef.current?.getViewport();
    if (!viewport) throw new Error('Viewport not found');

    const scrollToSpy = vi.spyOn(viewport, 'scrollTo');

    // 1. 测试 pointerUp 刹车
    fireEvent.pointerDown(downBtn, { button: 0 });
    act(() => {
      vi.advanceTimersByTime(360);
    });
    const callsBeforeUp = scrollToSpy.mock.calls.length;
    expect(callsBeforeUp).toBeGreaterThanOrEqual(3);

    fireEvent.pointerUp(downBtn);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(scrollToSpy.mock.calls.length).toBe(callsBeforeUp);

    // 2. 测试 pointerLeave 刹车
    fireEvent.pointerDown(downBtn, { button: 0 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.pointerLeave(downBtn);
    const callsAfterLeave = scrollToSpy.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(scrollToSpy.mock.calls.length).toBe(callsAfterLeave);

    // 3. 测试 window blur 刹车
    fireEvent.pointerDown(downBtn, { button: 0 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent(window, new Event('blur'));
    const callsAfterBlur = scrollToSpy.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(scrollToSpy.mock.calls.length).toBe(callsAfterBlur);
  });

  it('TC-SA-07: 极限位置（顶端/底端）自动刹车防越界', () => {
    const handleRef = createRef<ScrollAreaHandle>();
    render(
      <ScrollArea ref={handleRef} showButtons={true}>
        <div>Long Content</div>
      </ScrollArea>
    );

    const upBtn = screen.getByLabelText('Scroll Up');
    const downBtn = screen.getByLabelText('Scroll Down');
    const viewport = handleRef.current?.getViewport();
    if (!viewport) throw new Error('Viewport not found');

    // 1. 顶端极限：scrollTop = 0 时，Up 按钮处于 disabled 态
    expect(upBtn.className).toContain(styles.disabled);
    expect(downBtn.className).not.toContain(styles.disabled);

    // 2. 在顶端长按向上，触达顶端立即刚性刹车
    const scrollToSpy = vi.spyOn(viewport, 'scrollTo');
    fireEvent.pointerDown(upBtn, { button: 0 });
    act(() => {
      vi.advanceTimersByTime(350);
    });
    // 脉冲循环检测到 scrollTop <= 0 立即调用 rigidBrake()，不再连发
    const upCalls = scrollToSpy.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(scrollToSpy.mock.calls.length).toBe(upCalls);

    // 3. 底端极限：scrollTop = 800 (maxY)
    viewport.scrollTop = 800;
    act(() => {
      fireEvent.scroll(viewport);
    });
    expect(downBtn.className).toContain(styles.disabled);
    expect(upBtn.className).not.toContain(styles.disabled);

    // 在底端长按向下，检测到 scrollTop >= maxY 立即刚性刹车
    scrollToSpy.mockClear();
    fireEvent.pointerDown(downBtn, { button: 0 });
    act(() => {
      vi.advanceTimersByTime(350);
    });
    const downCalls = scrollToSpy.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(scrollToSpy.mock.calls.length).toBe(downCalls);
  });

  it('TC-SA-08: Pointer Capture 滑块鼠标抓取拖拽滚动', () => {
    const handleRef = createRef<ScrollAreaHandle>();
    const { container } = render(
      <ScrollArea ref={handleRef} showButtons={false} style={{ height: 200 }}>
        <div>Long Draggable Content</div>
      </ScrollArea>
    );

    const viewport = handleRef.current?.getViewport();
    if (!viewport) throw new Error('Viewport not found');

    // 触发 scroll 更新 metrics
    act(() => {
      fireEvent.scroll(viewport);
    });

    const thumb = container.querySelector(`.${styles.thumbIndicator}`) as HTMLElement;
    expect(thumb).toBeInTheDocument();

    const setCaptureSpy = vi.spyOn(thumb, 'setPointerCapture');
    const releaseCaptureSpy = vi.spyOn(thumb, 'releasePointerCapture');

    // 1. PointerDown 启动抓取拖拽
    fireEvent.pointerDown(thumb, { button: 0, clientY: 50, pointerId: 1 });
    expect(setCaptureSpy).toHaveBeenCalledWith(1);
    expect(thumb.className).toContain(styles.dragging);

    // 2. PointerMove 向下拖拽 40px
    fireEvent.pointerMove(thumb, { clientY: 90, pointerId: 1 });
    expect(viewport.scrollTop).toBeGreaterThan(0);

    // 3. PointerUp 释放捕获
    fireEvent.pointerUp(thumb, { pointerId: 1 });
    expect(releaseCaptureSpy).toHaveBeenCalledWith(1);
    expect(thumb.className).not.toContain(styles.dragging);

    // 4. 非左键点击（如右键 button: 2）不触发捕获
    setCaptureSpy.mockClear();
    fireEvent.pointerDown(thumb, { button: 2, clientY: 50, pointerId: 2 });
    expect(setCaptureSpy).not.toHaveBeenCalled();
  });

  it('TC-SA-09: radius 极端圆角 Safe Inset 动态避让', () => {
    // 1. 纯代数数学模型推导验证 (M02 闭环)
    expect(calculateSafeAreaInset(0, 2)).toBe(0);
    expect(calculateSafeAreaInset(-5, 2)).toBe(0);
    // R=8, M=2: x = 6, arcY = sqrt(64-36) = sqrt(28) ≈ 5.29, minInset = 8-5.29 = 2.71, ceil(2.71)+1 = 4
    expect(calculateSafeAreaInset(8, 2)).toBe(4);
    // R=14, M=2: x = 12, arcY = sqrt(196-144) = sqrt(52) ≈ 7.21, minInset = 14-7.21 = 6.79, ceil(6.79)+1 = 8
    expect(calculateSafeAreaInset(14, 2)).toBe(8);

    // 2. 组件 DOM 避让挂载验证
    const { container } = render(
      <ScrollArea radius={14} trackMargin={2} showButtons={true}>
        <div>Content</div>
      </ScrollArea>
    );

    const trackCol = container.querySelector(`.${styles.stepperTrackColumn}`) as HTMLElement;
    expect(trackCol).toBeInTheDocument();
    // top 与 bottom 应为 safeInset(8) + trackMargin(2) = 10px
    expect(trackCol.style.top).toBe('10px');
    expect(trackCol.style.bottom).toBe('10px');
    expect(trackCol.style.right).toBe('2px');
  });

  it('TC-SA-10: 可用轨道 < 16px 退化紧凑态降级', () => {
    const handleRef = createRef<ScrollAreaHandle>();
    const { container } = render(
      <ScrollArea ref={handleRef} radius={14} trackMargin={2} showButtons={true}>
        <div>Content</div>
      </ScrollArea>
    );

    const vp = handleRef.current?.getViewport();
    if (!vp) throw new Error('Viewport not found');

    // 1. 极端小视口高度：clientHeight = 14px (< 16px) 自动退化隐藏按钮 (M03 闭环)
    (vp as unknown as { _customClientHeight: number })._customClientHeight = 14;
    act(() => {
      fireEvent.scroll(vp);
    });

    expect(screen.queryByLabelText('Scroll Up')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Scroll Down')).not.toBeInTheDocument();
    // 全行程滑块仍保留在轨道中
    expect(container.querySelector(`.${styles.thumbIndicator}`)).toBeInTheDocument();

    // 2. 容器高度较小且圆角占用导致可用轨道算术下溢 (< 16px)
    // clientHeight = 36px, insetTop=10, insetBottom=10, btnDimension=8, safeGap=2
    // calculatedAvailableTrack = 36 - 20 - 16 - 4 = -4 < 16
    (vp as unknown as { _customClientHeight: number })._customClientHeight = 36;
    act(() => {
      fireEvent.scroll(vp);
    });
    expect(screen.queryByLabelText('Scroll Up')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Scroll Down')).not.toBeInTheDocument();

    // 3. 视口恢复正常高度 (200px) 时，自愈恢复渲染按钮
    (vp as unknown as { _customClientHeight: number })._customClientHeight = 200;
    act(() => {
      fireEvent.scroll(vp);
    });
    expect(screen.getByLabelText('Scroll Up')).toBeInTheDocument();
    expect(screen.getByLabelText('Scroll Down')).toBeInTheDocument();
  });
});
