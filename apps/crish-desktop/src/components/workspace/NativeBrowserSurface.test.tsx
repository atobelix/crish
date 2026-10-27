// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/workspace/NativeBrowserSurface.test.tsx
 *
 * 占位挖洞与几何同步引擎单测套件
 */

import React, { createRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  computeSnappedPhysicalBounds,
  isSimilarBounds,
  isRectInViewport,
  BOUNDS_EPSILON,
} from './nativeBrowserGeometry';
import {
  NativeBrowserSurface,
  type NativeBrowserSurfaceHandle,
} from './NativeBrowserSurface';
import { layerStackManager } from '../ui/internal/layer-stack/LayerStackManager';

// ── Mock Tauri IPC ───────────────────────────────────────────────────

const mockInvoke = vi.fn().mockResolvedValue(undefined);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe('nativeBrowserGeometry 纯几何算法测试', () => {
  describe('computeSnappedPhysicalBounds', () => {
    it('在整数缩放 (100% DPR = 1.0) 下输出精确物理矩形', () => {
      const rect = {
        left: 100,
        top: 50,
        right: 400,
        bottom: 300,
        width: 300,
        height: 250,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      } as DOMRect;

      const physical = computeSnappedPhysicalBounds(rect, 1.0);
      expect(physical).toEqual({
        x: 100,
        y: 50,
        width: 300,
        height: 250,
        scale: 1.0,
      });
    });

    it('在 Windows 125% 缩放 (DPR = 1.25) 下外边界严格独立对齐，消除缝隙', () => {
      // 场景：两相邻面板等比分割，A 在 [0, 333.333]，B 在 [333.333, 666.666]
      const paneA = {
        left: 0,
        top: 0,
        right: 333.333,
        bottom: 500,
        width: 333.333,
        height: 500,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;

      const paneB = {
        left: 333.333,
        top: 0,
        right: 666.666,
        bottom: 500,
        width: 333.333,
        height: 500,
        x: 333.333,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;

      const physA = computeSnappedPhysicalBounds(paneA, 1.25);
      const physB = computeSnappedPhysicalBounds(paneB, 1.25);

      // 验证 A 的右边界物理坐标必须严格等于 B 的左边界物理坐标
      const rightA = physA.x + physA.width;
      const leftB = physB.x;

      expect(rightA).toBe(leftB);
      // 333.333 * 1.25 = 416.666 -> Math.round = 417
      expect(rightA).toBe(417);
      expect(leftB).toBe(417);
    });

    it('在 Windows 150% 缩放 (DPR = 1.5) 下处理浮点亚像素边缘', () => {
      const rect = {
        left: 10.3,
        top: 20.7,
        right: 110.3,
        bottom: 120.7,
        width: 100,
        height: 100,
        x: 10.3,
        y: 20.7,
        toJSON: () => ({}),
      } as DOMRect;

      const phys = computeSnappedPhysicalBounds(rect, 1.5);
      // left: 10.3 * 1.5 = 15.45 -> 15
      // right: 110.3 * 1.5 = 165.45 -> 165
      // width: 165 - 15 = 150
      expect(phys.x).toBe(15);
      expect(phys.width).toBe(150);
      // top: 20.7 * 1.5 = 31.05 -> 31
      // bottom: 120.7 * 1.5 = 181.05 -> 181
      // height: 181 - 31 = 150
      expect(phys.y).toBe(31);
      expect(phys.height).toBe(150);
    });

    it('当宽高为 0 或负数时安全截断为 0，防止底层 crash', () => {
      const rect = {
        left: 100,
        top: 100,
        right: 80, // 反向或隐藏
        bottom: 100,
        width: -20,
        height: 0,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      } as DOMRect;

      const phys = computeSnappedPhysicalBounds(rect, 1.25);
      expect(phys.width).toBe(0);
      expect(phys.height).toBe(0);
    });
  });

  describe('isSimilarBounds', () => {
    it('当坐标与尺寸变动量均小于 0.5px 时返回 true（去重）', () => {
      const a = { x: 100, y: 50, width: 300, height: 200 };
      const b = { x: 100.2, y: 50.1, width: 300.3, height: 199.8 };

      expect(isSimilarBounds(a, b, BOUNDS_EPSILON)).toBe(true);
    });

    it('当任意坐标或尺寸变动量达到或超过 0.5px 时返回 false（放行）', () => {
      const a = { x: 100, y: 50, width: 300, height: 200 };
      const b = { x: 100.6, y: 50, width: 300, height: 200 };

      expect(isSimilarBounds(a, b, BOUNDS_EPSILON)).toBe(false);
    });
  });

  describe('isRectInViewport', () => {
    beforeEach(() => {
      vi.stubGlobal('innerWidth', 1920);
      vi.stubGlobal('innerHeight', 1080);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('在可视区内的矩形返回 true', () => {
      const rect = {
        left: 100,
        top: 100,
        right: 500,
        bottom: 400,
        width: 400,
        height: 300,
      } as DOMRect;

      expect(isRectInViewport(rect)).toBe(true);
    });

    it('完全超出视口或尺寸为 0 的矩形返回 false', () => {
      const offscreen = {
        left: 2000,
        top: 100,
        right: 2400,
        bottom: 400,
        width: 400,
        height: 300,
      } as DOMRect;

      expect(isRectInViewport(offscreen)).toBe(false);

      const zeroSize = {
        left: 100,
        top: 100,
        right: 100,
        bottom: 100,
        width: 0,
        height: 0,
      } as DOMRect;

      expect(isRectInViewport(zeroSize)).toBe(false);
    });
  });
});

describe('NativeBrowserSurface 组件测试', () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    layerStackManager.dispose();
  });

  afterEach(() => {
    layerStackManager.dispose();
  });

  it('渲染纯净的无 iframe 镂空 DOM 容器', () => {
    render(<NativeBrowserSurface tabId="tab-test-1" />);

    const surface = screen.getByTestId('native-browser-surface');
    expect(surface).toBeInTheDocument();
    expect(surface.tagName.toLowerCase()).toBe('div');
    expect(surface).toHaveAttribute('data-tab-id', 'tab-test-1');
    expect(surface).toHaveAttribute('data-native-surface', 'true');

    // 绝对禁止含有 iframe
    expect(surface.querySelector('iframe')).toBeNull();
  });

  it('当 LayerStackManager 存在模态框时，展示磨砂占位底板 (Airspace 避让态)', () => {
    const { rerender } = render(
      <NativeBrowserSurface tabId="tab-modal-test" />
    );

    // 初始状态无模态，不应有 scrim 遮罩
    expect(screen.queryByTestId('native-surface-scrim')).toBeNull();

    // 压入一个全局模态框
    act(() => {
      layerStackManager.register({
        id: 'settings-modal',
        type: 'modal-dialog',
        modal: true,
        dismissible: true,
        onDismiss: () => {},
      });
    });

    rerender(<NativeBrowserSurface tabId="tab-modal-test" />);

    // 应该展现毛玻璃磨砂底板
    expect(screen.getByTestId('native-surface-scrim')).toBeInTheDocument();

    // 退栈模态框
    act(() => {
      layerStackManager.unregister('settings-modal');
    });

    rerender(<NativeBrowserSurface tabId="tab-modal-test" />);

    // 毛玻璃底板应该自动消失，原生视口恢复
    expect(screen.queryByTestId('native-surface-scrim')).toBeNull();
  });

  it('支持通过 forwardRef 暴露命令式句柄', () => {
    const ref = createRef<NativeBrowserSurfaceHandle>();
    render(<NativeBrowserSurface ref={ref} tabId="tab-ref-test" />);

    expect(ref.current).toBeDefined();
    expect(ref.current?.surfaceElement).toBeInstanceOf(HTMLDivElement);
    expect(typeof ref.current?.syncGeometry).toBe('function');
    expect(typeof ref.current?.setHitTest).toBe('function');
  });

  it('Hit-Test 看门狗在异常失焦/中断时安全复位', () => {
    const ref = createRef<NativeBrowserSurfaceHandle>();
    render(<NativeBrowserSurface ref={ref} tabId="tab-hittest-test" />);

    // 模拟拖拽开始，禁用命中测试
    act(() => {
      ref.current?.setHitTest(false);
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      expect.stringMatching(/set_hit_test/),
      expect.objectContaining({ hitTest: false })
    );

    mockInvoke.mockClear();

    // 模拟窗口失焦或手势取消异常中断
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    // 看门狗必须无条件复位 hitTest: true
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.stringMatching(/set_hit_test/),
      expect.objectContaining({ hitTest: true })
    );
  });
});
