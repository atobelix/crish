// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/binary-tree/LeafDockResizer.test.tsx
 *
 * 分割线统一波次 R4 — 叶内坞 resizer 钩子级迁移真值测试
 * 1. 渲染契约：separator 语义 + 百分比 aria 域 + tabIndex（统一协议补齐）、
 *    死类名 layout-resizer* 已删除；
 * 2. 拖拽生命周期：pointerDown -> pointerMove -> pointerUp，拖中只写
 *    --leaf-dock-width（零提交），松手提交一次且值经 px 域 + 比例域双钳制；
 * 3. 全局副作用契约：叶体 is-dragging、body is-resizing / leaf-dock-resizing
 *    （shell-reset.css 契约）、iframe 指针屏蔽，结束全回收；
 * 4. 中断语义：pointercancel / blur 兜底提交当前比例；Esc 取消恢复起始宽
 *    且绝不提交（统一手势协议新增，R4 迁移钉版）；
 * 5. 键盘基线（统一协议新增）：方向键 10px / Shift 50px / Home / End；
 * 6. 中性灰呈现钉版：CSS 高亮线走 --border-color，无 accent 绿、无辉光，
 *    静止线归抽屉 border-left（R4 迁移钉版）。
 */

import React, { useRef, useState } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { LeafDockResizer } from './LeafDockResizer';

let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafSeq = 0;

function flushRaf() {
  const pending = rafQueue;
  rafQueue = [];
  pending.forEach(({ cb }) => cb(performance.now()));
}

function LeafBodyHost({
  initialRatio = 0.5,
  onCommitRatio,
  withIframe = false,
}: {
  initialRatio?: number;
  onCommitRatio: (ratio: number) => void;
  withIframe?: boolean;
}) {
  const leafBodyRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(initialRatio);
  return (
    <div ref={leafBodyRef} data-testid="leaf-body">
      <div data-testid="chat-column" />
      <LeafDockResizer
        leafBodyRef={leafBodyRef}
        widthRatio={ratio}
        onCommitRatio={(r) => {
          setRatio(r);
          onCommitRatio(r);
        }}
      />
      {withIframe ? <iframe data-testid="dock-iframe" title="dock" /> : null}
    </div>
  );
}

describe('LeafDockResizer 钩子级迁移测试套件', () => {
  let capturedPointerId: number | null = null;
  let setPointerCaptureSpy: any;
  let releasePointerCaptureSpy: any;
  let hasPointerCaptureSpy: any;

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

    capturedPointerId = null;
    setPointerCaptureSpy = vi.fn((pointerId: number) => {
      capturedPointerId = pointerId;
    });
    releasePointerCaptureSpy = vi.fn((pointerId: number) => {
      if (capturedPointerId === pointerId) capturedPointerId = null;
    });
    hasPointerCaptureSpy = vi.fn((pointerId: number) => {
      return capturedPointerId === pointerId;
    });
    HTMLDivElement.prototype.setPointerCapture = setPointerCaptureSpy;
    HTMLDivElement.prototype.releasePointerCapture = releasePointerCaptureSpy;
    HTMLDivElement.prototype.hasPointerCapture = hasPointerCaptureSpy;

    document.body.classList.remove('is-resizing', 'leaf-dock-resizing');
    document.body.removeAttribute('data-split-resizing');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.classList.remove('is-resizing', 'leaf-dock-resizing');
    document.body.removeAttribute('data-split-resizing');
    document.body.style.cursor = '';
  });

  function renderResizer({
    initialRatio = 0.5,
    bodyWidth = 1000,
    withIframe = false,
  }: {
    initialRatio?: number;
    bodyWidth?: number;
    withIframe?: boolean;
  } = {}) {
    const onCommitRatio = vi.fn();
    const utils = render(
      <LeafBodyHost
        initialRatio={initialRatio}
        onCommitRatio={onCommitRatio}
        withIframe={withIframe}
      />
    );
    const body = utils.getByTestId('leaf-body');
    Object.defineProperty(body, 'clientWidth', {
      value: bodyWidth,
      configurable: true,
    });
    const resizer = utils.container.querySelector(
      '[data-leaf-dock-resizer="true"]'
    ) as HTMLElement;
    return { ...utils, resizer, body, onCommitRatio };
  }

  describe('1. 渲染契约与无障碍基线', () => {
    it('separator 语义 + 百分比 aria 域 + tabIndex，死类名已删除', () => {
      const { resizer } = renderResizer({ initialRatio: 0.5 });

      expect(resizer.getAttribute('role')).toBe('separator');
      expect(resizer.getAttribute('aria-orientation')).toBe('vertical');
      expect(resizer.getAttribute('aria-valuemin')).toBe('20');
      expect(resizer.getAttribute('aria-valuemax')).toBe('75');
      expect(resizer.getAttribute('aria-valuenow')).toBe('50');
      expect(resizer.getAttribute('aria-label')).toBe('拖拽调整右侧工具栏宽度');
      expect(resizer.getAttribute('tabIndex')).toBe('0');
      expect(resizer.getAttribute('data-dragging')).toBe('false');
      expect(resizer.className).toMatch(/leafDockResizer/);
      expect(resizer.className).not.toContain('layout-resizer');
    });
  });

  describe('2. 拖拽生命周期与双重钳制', () => {
    it('完整手势：拖中只写 CSS 变量，松手提交一次 0.6，全局副作用全回收', () => {
      const { resizer, body, onCommitRatio } = renderResizer({
        initialRatio: 0.5,
        bodyWidth: 1000,
      });

      fireEvent.pointerDown(resizer, {
        button: 0,
        pointerId: 42,
        clientX: 500,
      });
      expect(setPointerCaptureSpy).toHaveBeenCalledWith(42);
      expect(document.body.classList.contains('is-resizing')).toBe(true);
      expect(document.body.classList.contains('leaf-dock-resizing')).toBe(true);
      expect(document.body.getAttribute('data-split-resizing')).toBe(
        'vertical'
      );
      expect(body.classList.contains('is-dragging')).toBe(true);
      expect(resizer.getAttribute('data-dragging')).toBe('true');
      expect(onCommitRatio).not.toHaveBeenCalled();

      // 指针左移 100px → 坞宽 500 + 100 = 600px（拖中零提交）
      fireEvent.pointerMove(window, { pointerId: 42, clientX: 400 });
      flushRaf();
      expect(body.style.getPropertyValue('--leaf-dock-width')).toBe('600px');
      expect(onCommitRatio).not.toHaveBeenCalled();

      fireEvent.pointerUp(window, { pointerId: 42, clientX: 400 });
      expect(releasePointerCaptureSpy).toHaveBeenCalledWith(42);
      expect(onCommitRatio).toHaveBeenCalledTimes(1);
      expect(onCommitRatio).toHaveBeenCalledWith(0.6);
      expect(document.body.classList.contains('is-resizing')).toBe(false);
      expect(document.body.classList.contains('leaf-dock-resizing')).toBe(
        false
      );
      expect(document.body.hasAttribute('data-split-resizing')).toBe(false);
      expect(body.classList.contains('is-dragging')).toBe(false);
      expect(resizer.getAttribute('data-dragging')).toBe('false');
    });

    it('px 域钳制下界：极端右移时坞宽不低于 200px，提交 0.2', () => {
      const { resizer, body, onCommitRatio } = renderResizer({
        initialRatio: 0.5,
        bodyWidth: 1000,
      });
      fireEvent.pointerDown(resizer, {
        button: 0,
        pointerId: 1,
        clientX: 500,
      });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 2500 });
      flushRaf();
      expect(body.style.getPropertyValue('--leaf-dock-width')).toBe('200px');
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 2500 });
      expect(onCommitRatio).toHaveBeenCalledTimes(1);
      expect(onCommitRatio).toHaveBeenCalledWith(0.2);
    });

    it('px 域钳制上界：极端左移时坞宽不超过叶体 70%，提交 0.7', () => {
      const { resizer, body, onCommitRatio } = renderResizer({
        initialRatio: 0.5,
        bodyWidth: 1000,
      });
      fireEvent.pointerDown(resizer, {
        button: 0,
        pointerId: 1,
        clientX: 500,
      });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: -2500 });
      flushRaf();
      expect(body.style.getPropertyValue('--leaf-dock-width')).toBe('700px');
      fireEvent.pointerUp(window, { pointerId: 1, clientX: -2500 });
      expect(onCommitRatio).toHaveBeenCalledTimes(1);
      expect(onCommitRatio).toHaveBeenCalledWith(0.7);
    });

    it('松手未移动：仍按原契约兜底提交一次当前比例', () => {
      const { resizer, onCommitRatio } = renderResizer({
        initialRatio: 0.5,
        bodyWidth: 1000,
      });
      fireEvent.pointerDown(resizer, {
        button: 0,
        pointerId: 7,
        clientX: 500,
      });
      fireEvent.pointerUp(window, { pointerId: 7, clientX: 500 });
      expect(onCommitRatio).toHaveBeenCalledTimes(1);
      expect(onCommitRatio).toHaveBeenCalledWith(0.5);
    });

    it('叶体宽以手势开始时实测为准（800px 叶体：左移 100 → 0.625）', () => {
      const { resizer, onCommitRatio } = renderResizer({
        initialRatio: 0.5,
        bodyWidth: 800,
      });
      fireEvent.pointerDown(resizer, {
        button: 0,
        pointerId: 3,
        clientX: 400,
      });
      fireEvent.pointerMove(window, { pointerId: 3, clientX: 300 });
      flushRaf();
      fireEvent.pointerUp(window, { pointerId: 3, clientX: 300 });
      expect(onCommitRatio).toHaveBeenCalledTimes(1);
      expect(onCommitRatio).toHaveBeenCalledWith(0.625);
    });

    it('拖拽期间 iframe 指针屏蔽，结束恢复', () => {
      const { resizer, getByTestId } = renderResizer({
        initialRatio: 0.5,
        bodyWidth: 1000,
        withIframe: true,
      });
      const iframe = getByTestId('dock-iframe') as HTMLElement;
      fireEvent.pointerDown(resizer, {
        button: 0,
        pointerId: 9,
        clientX: 500,
      });
      expect(iframe.style.pointerEvents).toBe('none');
      fireEvent.pointerUp(window, { pointerId: 9, clientX: 500 });
      expect(iframe.style.pointerEvents).toBe('');
    });
  });

  describe('3. 中断与取消语义', () => {
    it('pointercancel：兜底提交当前比例并回收全局状态', () => {
      const { resizer, onCommitRatio } = renderResizer({
        initialRatio: 0.5,
        bodyWidth: 1000,
      });
      fireEvent.pointerDown(resizer, {
        button: 0,
        pointerId: 1,
        clientX: 500,
      });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 400 });
      flushRaf();
      fireEvent.pointerCancel(resizer, { pointerId: 1 });
      expect(onCommitRatio).toHaveBeenCalledTimes(1);
      expect(onCommitRatio).toHaveBeenCalledWith(0.6);
      expect(document.body.classList.contains('leaf-dock-resizing')).toBe(
        false
      );
      expect(releasePointerCaptureSpy).toHaveBeenCalledWith(1);
    });

    it('窗口失焦（blur）：兜底提交当前比例并回收全局状态', () => {
      const { resizer, onCommitRatio } = renderResizer({
        initialRatio: 0.5,
        bodyWidth: 1000,
      });
      fireEvent.pointerDown(resizer, {
        button: 0,
        pointerId: 1,
        clientX: 500,
      });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 400 });
      flushRaf();
      act(() => {
        window.dispatchEvent(new Event('blur'));
      });
      expect(onCommitRatio).toHaveBeenCalledTimes(1);
      expect(onCommitRatio).toHaveBeenCalledWith(0.6);
      expect(document.body.classList.contains('leaf-dock-resizing')).toBe(
        false
      );
    });

    it('Esc 取消（统一手势协议新增）：恢复起始宽且绝不提交', () => {
      const { resizer, body, onCommitRatio } = renderResizer({
        initialRatio: 0.5,
        bodyWidth: 1000,
      });
      fireEvent.pointerDown(resizer, {
        button: 0,
        pointerId: 5,
        clientX: 500,
      });
      fireEvent.pointerMove(window, { pointerId: 5, clientX: 400 });
      flushRaf();
      expect(body.style.getPropertyValue('--leaf-dock-width')).toBe('600px');

      fireEvent.keyDown(resizer, { key: 'Escape' });

      expect(body.style.getPropertyValue('--leaf-dock-width')).toBe('500px');
      expect(onCommitRatio).not.toHaveBeenCalled();
      expect(document.body.classList.contains('is-resizing')).toBe(false);
      expect(document.body.classList.contains('leaf-dock-resizing')).toBe(
        false
      );
      expect(body.classList.contains('is-dragging')).toBe(false);
      expect(resizer.getAttribute('data-dragging')).toBe('false');
      expect(releasePointerCaptureSpy).toHaveBeenCalledWith(5);
    });
  });

  describe('4. 键盘基线（统一手势协议新增）', () => {
    it('方向键 10px / Shift 50px / Home / End 按 px 域钳制提交', () => {
      const { resizer, onCommitRatio } = renderResizer({
        initialRatio: 0.5,
        bodyWidth: 1000,
      });

      // 坞在右侧：ArrowLeft 加宽（与拖拽方向一致），ArrowRight 减宽
      fireEvent.keyDown(resizer, { key: 'ArrowLeft' });
      expect(onCommitRatio).toHaveBeenLastCalledWith(0.51);

      fireEvent.keyDown(resizer, { key: 'ArrowRight' });
      expect(onCommitRatio).toHaveBeenLastCalledWith(0.5);

      fireEvent.keyDown(resizer, { key: 'ArrowLeft', shiftKey: true });
      expect(onCommitRatio).toHaveBeenLastCalledWith(0.55);

      fireEvent.keyDown(resizer, { key: 'Home' });
      expect(onCommitRatio).toHaveBeenLastCalledWith(0.2);

      fireEvent.keyDown(resizer, { key: 'End' });
      expect(onCommitRatio).toHaveBeenLastCalledWith(0.7);
    });
  });

  describe('5. 中性灰呈现与手势收敛钉版（R4 迁移）', () => {
    it('CSS：高亮线走 --border-color 中性灰，无 accent 绿、无辉光，静止线归抽屉', () => {
      const cssSrc = readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          'BinaryTreeWorkspace.module.css'
        ),
        'utf8'
      );
      const resizerStart = cssSrc.indexOf('.leafDockResizer {');
      const drawerStart = cssSrc.indexOf('.leafDockDrawer {', resizerStart);
      expect(resizerStart).toBeGreaterThan(-1);
      expect(drawerStart).toBeGreaterThan(resizerStart);
      const resizerBlock = cssSrc.slice(resizerStart, drawerStart);
      expect(resizerBlock).toContain('var(--border-color)');
      expect(resizerBlock).not.toMatch(/--accent/);
      expect(resizerBlock).not.toMatch(/box-shadow/);
      expect(resizerBlock).not.toMatch(/#10b981/i);

      const drawerBlock = cssSrc.slice(drawerStart);
      expect(drawerBlock).toContain(
        'border-left: 1px solid var(--border-subtle)'
      );
    });

    it('源码：手势已收敛至统一 hook，组件内无自滚指针监听与捕获', () => {
      const src = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), 'LeafDockResizer.tsx'),
        'utf8'
      );
      expect(src).toContain('useSplitResize');
      expect(src).not.toMatch(/addEventListener\('pointermove'/);
      expect(src).not.toMatch(/addEventListener\('pointerup'/);
      expect(src).not.toMatch(/addEventListener\('pointercancel'/);
      expect(src).not.toContain('setPointerCapture');
      expect(src).not.toContain('layout-resizer');
    });
  });
});
