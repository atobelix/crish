// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/hooks/useSplitResize.test.tsx
 *
 * 统一分栏拖拽 hook 契约测试：手势协议（捕获/rAF 节流/提交模式）、
 * Esc 取消、键盘步进、双击复位、折叠阈值、body 单一协议与 live CSS 变量。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useSplitResize,
  type UseSplitResizeOptions,
  type UseSplitResizeResult,
} from './useSplitResize';

let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafSeq = 0;

function flushRaf() {
  const pending = rafQueue;
  rafQueue = [];
  pending.forEach(({ cb }) => cb(performance.now()));
}

beforeEach(() => {
  rafQueue = [];
  rafSeq = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafSeq += 1;
    rafQueue.push({ id: rafSeq, cb });
    return rafSeq;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQueue = rafQueue.filter((entry) => entry.id !== id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.style.cursor = '';
  document.body.removeAttribute('data-split-resizing');
});

interface HarnessProps {
  options: Omit<UseSplitResizeOptions, 'value' | 'onCommit'> & {
    initialValue: number;
    onCommit?: UseSplitResizeOptions['onCommit'];
  };
  resultRef: { current: UseSplitResizeResult | null };
  varTargetRef?: React.RefObject<HTMLDivElement | null>;
}

function Harness({ options, resultRef }: HarnessProps) {
  const [value, setValue] = useState(options.initialValue);
  const result = useSplitResize({
    ...options,
    value,
    onCommit: (next) => {
      setValue(next);
      options.onCommit?.(next);
    },
  });
  resultRef.current = result;
  return <div data-testid="sep" {...result.separatorProps} />;
}

function setup(options: HarnessProps['options']): {
  resultRef: { current: UseSplitResizeResult | null };
  sep: HTMLElement;
} {
  const resultRef: { current: UseSplitResizeResult | null } = {
    current: null,
  };
  render(<Harness options={options} resultRef={resultRef} />);
  return { resultRef, sep: screen.getByTestId('sep') };
}

const BASE = { min: 100, max: 400, initialValue: 200 };

describe('useSplitResize', () => {
  it('separatorProps 携带完整 aria 基线', () => {
    const { sep } = setup({ ...BASE });
    expect(sep).toHaveAttribute('role', 'separator');
    expect(sep).toHaveAttribute('aria-orientation', 'vertical');
    expect(sep).toHaveAttribute('aria-valuemin', '100');
    expect(sep).toHaveAttribute('aria-valuemax', '400');
    expect(sep).toHaveAttribute('aria-valuenow', '200');
    expect(sep).toHaveAttribute('tabIndex', '0');
  });

  it('release 模式：拖中只更新 live ref（零提交），松手一次性提交钳制值', () => {
    const onCommit = vi.fn();
    const onLiveChange = vi.fn();
    const { resultRef, sep } = setup({ ...BASE, onCommit, onLiveChange });

    fireEvent.pointerDown(sep, { button: 0, pointerId: 7, clientX: 100 });
    expect(resultRef.current?.dragging).toBe(true);
    expect(document.body.getAttribute('data-split-resizing')).toBe('vertical');
    expect(document.body.style.cursor).toBe('col-resize');

    fireEvent.pointerMove(window, { pointerId: 7, clientX: 150 });
    flushRaf();
    expect(resultRef.current?.liveValueRef.current).toBe(250);
    expect(resultRef.current?.rawValueRef.current).toBe(250);
    expect(onLiveChange).toHaveBeenCalledWith(250);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(window, { pointerId: 7, clientX: 150 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(250);
    expect(resultRef.current?.dragging).toBe(false);
    expect(document.body.hasAttribute('data-split-resizing')).toBe(false);
    expect(document.body.style.cursor).toBe('');
  });

  it('拖拽越界：raw 保留原始值，live 与提交均钳制', () => {
    const onCommit = vi.fn();
    const { resultRef, sep } = setup({ ...BASE, onCommit });
    fireEvent.pointerDown(sep, { button: 0, pointerId: 3, clientX: 0 });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 999 });
    flushRaf();
    expect(resultRef.current?.rawValueRef.current).toBe(1199);
    expect(resultRef.current?.liveValueRef.current).toBe(400);
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 999 });
    expect(onCommit).toHaveBeenCalledWith(400);
  });

  it('axisSign=-1：指针正向移动时尺寸减小', () => {
    const { resultRef, sep } = setup({ ...BASE, axisSign: -1 });
    fireEvent.pointerDown(sep, { button: 0, pointerId: 5, clientX: 100 });
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 150 });
    flushRaf();
    expect(resultRef.current?.liveValueRef.current).toBe(150);
    fireEvent.pointerUp(window, { pointerId: 5, clientX: 150 });
  });

  it('live 模式：拖中 rAF 节流实时提交', () => {
    const onCommit = vi.fn();
    const { sep } = setup({ ...BASE, commitMode: 'live', onCommit });
    fireEvent.pointerDown(sep, { button: 0, pointerId: 9, clientX: 0 });
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 30 });
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 60 });
    flushRaf();
    expect(onCommit).toHaveBeenCalledWith(260);
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 60 });
  });

  it('Esc 取消：恢复起始值、不提交', () => {
    const onCommit = vi.fn();
    const { resultRef, sep } = setup({ ...BASE, onCommit });
    fireEvent.pointerDown(sep, { button: 0, pointerId: 11, clientX: 0 });
    fireEvent.pointerMove(window, { pointerId: 11, clientX: 80 });
    flushRaf();
    expect(resultRef.current?.liveValueRef.current).toBe(280);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(resultRef.current?.liveValueRef.current).toBe(200);
    expect(resultRef.current?.dragging).toBe(false);
  });

  it('键盘：方向键步进 / Shift 大步 / Home / End 立即提交', () => {
    const onCommit = vi.fn();
    const { sep } = setup({ ...BASE, onCommit });
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenLastCalledWith(210);
    fireEvent.keyDown(sep, { key: 'ArrowRight', shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(260);
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(onCommit).toHaveBeenLastCalledWith(250);
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(onCommit).toHaveBeenLastCalledWith(100);
    fireEvent.keyDown(sep, { key: 'End' });
    expect(onCommit).toHaveBeenLastCalledWith(400);
  });

  it('双击复位：提交 defaultValue 并回调 onReset', () => {
    const onCommit = vi.fn();
    const onReset = vi.fn();
    const { sep } = setup({ ...BASE, defaultValue: 260, onCommit, onReset });
    fireEvent.keyDown(sep, { key: 'End' });
    expect(onCommit).toHaveBeenLastCalledWith(400);
    fireEvent.doubleClick(sep);
    expect(onCommit).toHaveBeenLastCalledWith(260);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('折叠阈值：原始值跌破 collapseBelow 松手触发 onCollapse 而非提交', () => {
    const onCommit = vi.fn();
    const onCollapse = vi.fn();
    const { sep } = setup({
      ...BASE,
      collapseBelow: 150,
      onCommit,
      onCollapse,
    });
    fireEvent.pointerDown(sep, { button: 0, pointerId: 13, clientX: 200 });
    fireEvent.pointerMove(window, { pointerId: 13, clientX: 120 });
    flushRaf();
    fireEvent.pointerUp(window, { pointerId: 13, clientX: 120 });
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('liveCssVar：拖中写入钳制尺寸，结束移除', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const { sep } = setup({
      ...BASE,
      liveCssVar: { name: '--test-live', target: () => target },
    });
    fireEvent.pointerDown(sep, { button: 0, pointerId: 17, clientX: 0 });
    fireEvent.pointerMove(window, { pointerId: 17, clientX: 40 });
    flushRaf();
    expect(target.style.getPropertyValue('--test-live')).toBe('240px');
    fireEvent.pointerUp(window, { pointerId: 17, clientX: 40 });
    expect(target.style.getPropertyValue('--test-live')).toBe('');
    target.remove();
  });

  it('horizontal：沿 Y 拖拽、body 协议与光标随方向', () => {
    const { resultRef, sep } = setup({ ...BASE, orientation: 'horizontal' });
    fireEvent.pointerDown(sep, { button: 0, pointerId: 19, clientY: 50 });
    expect(document.body.getAttribute('data-split-resizing')).toBe(
      'horizontal'
    );
    expect(document.body.style.cursor).toBe('row-resize');
    fireEvent.pointerMove(window, { pointerId: 19, clientY: 90 });
    flushRaf();
    expect(resultRef.current?.liveValueRef.current).toBe(240);
    fireEvent.pointerUp(window, { pointerId: 19, clientY: 90 });
  });

  it('disabled：不可聚焦、指针与键盘均不响应', () => {
    const onCommit = vi.fn();
    const { resultRef, sep } = setup({ ...BASE, disabled: true, onCommit });
    expect(sep).toHaveAttribute('tabIndex', '-1');
    fireEvent.pointerDown(sep, { button: 0, pointerId: 23, clientX: 0 });
    expect(resultRef.current?.dragging).toBe(false);
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(onCommit).not.toHaveBeenCalled();
  });
});
