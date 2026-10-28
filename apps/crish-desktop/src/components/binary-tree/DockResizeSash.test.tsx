// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/binary-tree/DockResizeSash.test.tsx
 *
 * Phase 2 任务 C — 右坞内部分割线高性能拖拽引擎真值测试
 * 1. 验证 Sash 初始几何位置与 class（horizontal / vertical）；
 * 2. 模拟 pointerDown -> pointerMove -> pointerUp：断言 onCommitRatio 在 pointerUp 时被且仅被调用一次，且提交值正确钳制在 [0.2, 0.8]；
 * 3. 验证极端位移（拖拽超出 1000px）时提交值绝不溢出 0.8 / 0.2；
 * 4. 验证 PointerCapture 正常捕获与释放；
 * 5. 验证 >= 16px 物理防碰撞死区缓冲（Deadzone Buffer）；
 * 6. 验证窗格最小像素保护（宽 >= 120px，高 >= 80px）；
 * 7. 验证拖拽期间 document.body.classList.contains('dock-split-resizing')，松手后移除；
 * 8. 验证双击 50/50 快速均分与键盘微调。
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import {
  DockResizeSash,
  calculateClampedRatio,
  flatDockBranchEqual,
  MIN_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  DEADZONE_BUFFER_PX,
} from './DockResizeSash';
import type { FlatDockBranch } from './flattenDockTree';

function makeHorizontalBranch(
  over: Partial<FlatDockBranch> = {}
): FlatDockBranch {
  const splitRatio = over.splitRatio ?? 0.5;
  const rect = over.rect ?? { x: 0, y: 0, width: 1, height: 1 };
  return {
    branchId: 'b_h1',
    direction: 'horizontal',
    splitRatio,
    rect,
    sash: {
      id: 'sash_b_h1',
      x: rect.x + rect.width * splitRatio,
      y: rect.y,
      length: rect.height,
      direction: 'horizontal',
    },
    ...over,
  };
}

function makeVerticalBranch(
  over: Partial<FlatDockBranch> = {}
): FlatDockBranch {
  const splitRatio = over.splitRatio ?? 0.5;
  const rect = over.rect ?? { x: 0, y: 0, width: 1, height: 1 };
  return {
    branchId: 'b_v1',
    direction: 'vertical',
    splitRatio,
    rect,
    sash: {
      id: 'sash_b_v1',
      x: rect.x,
      y: rect.y + rect.height * splitRatio,
      length: rect.width,
      direction: 'vertical',
    },
    ...over,
  };
}

describe('DockResizeSash 高性能拖拽引擎测试套件', () => {
  let capturedPointerId: number | null = null;
  let setPointerCaptureSpy: any;
  let releasePointerCaptureSpy: any;
  let hasPointerCaptureSpy: any;

  beforeEach(() => {
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

    // 清理 body 可能遗留的 class
    document.body.classList.remove('dock-split-resizing');
  });

  afterEach(() => {
    cleanup();
    document.body.classList.remove('dock-split-resizing');
    vi.restoreAllMocks();
  });

  function renderSashHarness(
    branch: FlatDockBranch,
    onCommitRatio = vi.fn(),
    containerWidth = 600,
    containerHeight = 400
  ) {
    const containerRef = React.createRef<HTMLDivElement>();
    const TestHost = () => {
      return (
        <div
          ref={containerRef}
          data-testid="dock-container"
          style={{
            position: 'relative',
            width: `${containerWidth}px`,
            height: `${containerHeight}px`,
          }}
        >
          <div
            data-dock-leaf-id="pane-left"
            style={{
              position: 'absolute',
              left: '0%',
              top: '0%',
              width: '50%',
              height: '100%',
            }}
          />
          <div
            data-dock-leaf-id="pane-right"
            style={{
              position: 'absolute',
              left: '50%',
              top: '0%',
              width: '50%',
              height: '100%',
            }}
          />
          <DockResizeSash
            branch={branch}
            containerRef={containerRef}
            onCommitRatio={onCommitRatio}
          />
        </div>
      );
    };

    const utils = render(<TestHost />);

    if (containerRef.current) {
      vi.spyOn(containerRef.current, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: containerWidth,
        height: containerHeight,
        right: containerWidth,
        bottom: containerHeight,
        x: 0,
        y: 0,
        toJSON: () => {},
      });
      Object.defineProperty(containerRef.current, 'clientWidth', {
        value: containerWidth,
        configurable: true,
      });
      Object.defineProperty(containerRef.current, 'clientHeight', {
        value: containerHeight,
        configurable: true,
      });
    }

    const sash = utils.container.querySelector(
      '[role="separator"]'
    ) as HTMLElement;
    return { ...utils, sash, containerRef, onCommitRatio };
  }

  describe('1. 初始几何位置与 class 样式', () => {
    it('水平分屏（horizontal）：拥有 horizontal 类，cursor: col-resize 属性，style 准确设置 left/top/height', () => {
      const branch = makeHorizontalBranch({ splitRatio: 0.5 });
      const { sash } = renderSashHarness(branch);

      expect(sash).toBeTruthy();
      expect(sash.getAttribute('data-direction')).toBe('horizontal');
      expect(sash.getAttribute('aria-orientation')).toBe('vertical');
      expect(sash.className).toMatch(/horizontal/);

      // 验证 inline style 百分比定位
      expect(sash.style.left).toBe('50%');
      expect(sash.style.top).toBe('0%');
      expect(sash.style.height).toBe('100%');
    });

    it('垂直分屏（vertical）：拥有 vertical 类，cursor: row-resize 属性，style 准确设置 top/left/width', () => {
      const branch = makeVerticalBranch({ splitRatio: 0.4 });
      const { sash } = renderSashHarness(branch);

      expect(sash).toBeTruthy();
      expect(sash.getAttribute('data-direction')).toBe('vertical');
      expect(sash.getAttribute('aria-orientation')).toBe('horizontal');
      expect(sash.className).toMatch(/vertical/);

      // 验证 inline style 百分比定位
      expect(sash.style.top).toBe('40%');
      expect(sash.style.left).toBe('0%');
      expect(sash.style.width).toBe('100%');
    });
  });

  describe('2. 拖拽生命周期与 PointerCapture 捕获/释放', () => {
    it('pointerDown -> pointerMove -> pointerUp 完整手势：onCommitRatio 仅在 pointerUp 时被调用一次', () => {
      const onCommitRatio = vi.fn();
      const branch = makeHorizontalBranch({ splitRatio: 0.5 });
      const { sash } = renderSashHarness(branch, onCommitRatio, 600, 400);

      // 1. pointerDown 启动
      fireEvent.pointerDown(sash, {
        button: 0,
        pointerId: 42,
        clientX: 300,
        clientY: 200,
      });

      expect(setPointerCaptureSpy).toHaveBeenCalledWith(42);
      expect(document.body.classList.contains('dock-split-resizing')).toBe(
        true
      );
      expect(sash.getAttribute('data-resizing')).toBe('true');
      expect(onCommitRatio).not.toHaveBeenCalled();

      // 2. pointerMove 移动 +60px（60 / 600 = +0.1，预期比例 0.6）
      fireEvent.pointerMove(sash, {
        pointerId: 42,
        clientX: 360,
        clientY: 200,
      });

      // 拖拽移动中绝不调用 onCommitRatio（零 Zustand 写状态）
      expect(onCommitRatio).not.toHaveBeenCalled();

      // 3. pointerUp 释放
      fireEvent.pointerUp(sash, {
        pointerId: 42,
        clientX: 360,
        clientY: 200,
      });

      expect(releasePointerCaptureSpy).toHaveBeenCalledWith(42);
      expect(document.body.classList.contains('dock-split-resizing')).toBe(
        false
      );
      expect(sash.getAttribute('data-resizing')).toBeNull();

      // onCommitRatio 仅且仅被调用一次，提交比例精确为 0.6
      expect(onCommitRatio).toHaveBeenCalledTimes(1);
      expect(onCommitRatio).toHaveBeenCalledWith('b_h1', 0.6);
    });

    it('测试 PointerCapture 正常捕获与释放断言', () => {
      const branch = makeHorizontalBranch();
      const { sash } = renderSashHarness(branch);

      fireEvent.pointerDown(sash, {
        button: 0,
        pointerId: 99,
        clientX: 100,
        clientY: 100,
      });
      expect(setPointerCaptureSpy).toHaveBeenCalledTimes(1);
      expect(setPointerCaptureSpy).toHaveBeenCalledWith(99);

      fireEvent.pointerUp(sash, { pointerId: 99, clientX: 100, clientY: 100 });
      expect(releasePointerCaptureSpy).toHaveBeenCalledTimes(1);
      expect(releasePointerCaptureSpy).toHaveBeenCalledWith(99);
    });
  });

  describe('3. 极端位移安全钳制（绝不溢出 [0.2, 0.8]）', () => {
    it('向右极端拖拽超出 +1000px：提交值绝不溢出 0.8', () => {
      const onCommitRatio = vi.fn();
      const branch = makeHorizontalBranch({ splitRatio: 0.5 });
      const { sash } = renderSashHarness(branch, onCommitRatio, 600, 400);

      fireEvent.pointerDown(sash, {
        button: 0,
        pointerId: 1,
        clientX: 300,
        clientY: 200,
      });
      fireEvent.pointerMove(sash, {
        pointerId: 1,
        clientX: 1300,
        clientY: 200,
      }); // +1000px
      fireEvent.pointerUp(sash, { pointerId: 1, clientX: 1300, clientY: 200 });

      expect(onCommitRatio).toHaveBeenCalledTimes(1);
      const [, finalRatio] = onCommitRatio.mock.calls[0];
      expect(finalRatio).toBe(0.8);
      expect(finalRatio).toBeLessThanOrEqual(MAX_SPLIT_RATIO);
    });

    it('向左极端拖拽超出 -1000px：提交值绝不下溢 0.2', () => {
      const onCommitRatio = vi.fn();
      const branch = makeHorizontalBranch({ splitRatio: 0.5 });
      const { sash } = renderSashHarness(branch, onCommitRatio, 600, 400);

      fireEvent.pointerDown(sash, {
        button: 0,
        pointerId: 1,
        clientX: 300,
        clientY: 200,
      });
      fireEvent.pointerMove(sash, {
        pointerId: 1,
        clientX: -700,
        clientY: 200,
      }); // -1000px
      fireEvent.pointerUp(sash, { pointerId: 1, clientX: -700, clientY: 200 });

      expect(onCommitRatio).toHaveBeenCalledTimes(1);
      const [, finalRatio] = onCommitRatio.mock.calls[0];
      expect(finalRatio).toBe(0.2);
      expect(finalRatio).toBeGreaterThanOrEqual(MIN_SPLIT_RATIO);
    });
  });

  describe('4. 物理死区防碰撞缓冲（Deadzone Buffer >= 16px）与最小像素保护', () => {
    it('左右分屏且分支贴近容器左侧时：垂直分割线距离左边缘必须保持 >= 16px', () => {
      // 模拟窄容器 100px，分支宽 50px（覆盖 [0, 0.5]）
      // 16px 死区对应 16 / 50 = 0.32，低于 0.32 将被硬性拦截
      const ratio = calculateClampedRatio({
        direction: 'horizontal',
        deltaPx: -50,
        initialRatio: 0.5,
        branchRect: { x: 0, y: 0, width: 0.5, height: 1 },
        containerRect: { width: 100, height: 200 },
        deadzoneBufferPx: DEADZONE_BUFFER_PX,
        minChildPx: 10, // 减小干扰，专测死区
      });

      expect(ratio).toBeGreaterThanOrEqual(0.32);
      // 绝对像素位置：(0 + 0.5 * ratio) * 100 >= 16px
      const sashPixelX = (0 + 0.5 * ratio) * 100;
      expect(sashPixelX).toBeGreaterThanOrEqual(16);
    });

    it('窗格最小像素保护：水平窗格宽 >= 120px，垂直窗格高 >= 80px', () => {
      // 水平分屏：容器宽 300px，子窗格至少 120px，比例被保护在 [120/300, 180/300] = [0.4, 0.6]
      const ratioH = calculateClampedRatio({
        direction: 'horizontal',
        deltaPx: -200,
        initialRatio: 0.5,
        branchRect: { x: 0, y: 0, width: 1, height: 1 },
        containerRect: { width: 300, height: 300 },
        minChildPx: 120,
      });
      expect(ratioH).toBe(0.4);

      // 垂直分屏：容器高 200px，子窗格至少 80px，比例被保护在 [80/200, 120/200] = [0.4, 0.6]
      const ratioV = calculateClampedRatio({
        direction: 'vertical',
        deltaPx: 150,
        initialRatio: 0.5,
        branchRect: { x: 0, y: 0, width: 1, height: 1 },
        containerRect: { width: 300, height: 200 },
        minChildPx: 80,
      });
      expect(ratioV).toBe(0.6);
    });
  });

  describe('5. 异常中断与失焦快速自愈', () => {
    it('窗口失焦（window blur）：安全收敛拖拽状态并提交当前比例', () => {
      const onCommitRatio = vi.fn();
      const branch = makeHorizontalBranch({ splitRatio: 0.5 });
      const { sash } = renderSashHarness(branch, onCommitRatio, 600, 400);

      fireEvent.pointerDown(sash, {
        button: 0,
        pointerId: 1,
        clientX: 300,
        clientY: 200,
      });
      expect(document.body.classList.contains('dock-split-resizing')).toBe(
        true
      );

      // 模拟窗口失焦
      act(() => {
        window.dispatchEvent(new Event('blur'));
      });

      expect(document.body.classList.contains('dock-split-resizing')).toBe(
        false
      );
      expect(onCommitRatio).toHaveBeenCalledTimes(1);
    });

    it('指针取消（pointercancel）：安全收敛拖拽状态并释放 PointerCapture', () => {
      const onCommitRatio = vi.fn();
      const branch = makeHorizontalBranch({ splitRatio: 0.5 });
      const { sash } = renderSashHarness(branch, onCommitRatio, 600, 400);

      fireEvent.pointerDown(sash, {
        button: 0,
        pointerId: 1,
        clientX: 300,
        clientY: 200,
      });
      expect(document.body.classList.contains('dock-split-resizing')).toBe(
        true
      );

      fireEvent.pointerCancel(sash, { pointerId: 1 });

      expect(document.body.classList.contains('dock-split-resizing')).toBe(
        false
      );
      expect(releasePointerCaptureSpy).toHaveBeenCalledWith(1);
      expect(onCommitRatio).toHaveBeenCalledTimes(1);
    });
  });

  describe('6. 快捷操作（双击均分 50/50 与键盘微调）', () => {
    it('双击 sash：快速提交 50/50 均分比例（0.5）', () => {
      const onCommitRatio = vi.fn();
      const branch = makeHorizontalBranch({ splitRatio: 0.7 });
      const { sash } = renderSashHarness(branch, onCommitRatio);

      fireEvent.doubleClick(sash);

      expect(onCommitRatio).toHaveBeenCalledTimes(1);
      expect(onCommitRatio).toHaveBeenCalledWith('b_h1', 0.5);
    });

    it('键盘 Arrow 方向键微调：ArrowLeft/Right 正确增减比例', () => {
      const onCommitRatio = vi.fn();
      const branch = makeHorizontalBranch({ splitRatio: 0.5 });
      const { sash } = renderSashHarness(branch, onCommitRatio, 500, 400);

      fireEvent.keyDown(sash, { key: 'ArrowRight' });
      expect(onCommitRatio).toHaveBeenCalledWith('b_h1', 0.52);

      fireEvent.keyDown(sash, { key: 'ArrowLeft' });
      expect(onCommitRatio).toHaveBeenCalledWith('b_h1', 0.48);
    });
  });

  describe('7. flatDockBranchEqual 与 React.memo 比较', () => {
    it('相同引用与相同几何值均判定相等', () => {
      const b1 = makeHorizontalBranch();
      const b2 = makeHorizontalBranch();
      expect(flatDockBranchEqual(b1, b1)).toBe(true);
      expect(flatDockBranchEqual(b1, b2)).toBe(true);
    });

    it('splitRatio 或 rect 变更时判定不相等', () => {
      const b1 = makeHorizontalBranch({ splitRatio: 0.5 });
      const b2 = makeHorizontalBranch({ splitRatio: 0.6 });
      expect(flatDockBranchEqual(b1, b2)).toBe(false);

      const b3 = makeHorizontalBranch({
        rect: { x: 0.1, y: 0, width: 0.9, height: 1 },
      });
      expect(flatDockBranchEqual(b1, b3)).toBe(false);
    });
  });
});
