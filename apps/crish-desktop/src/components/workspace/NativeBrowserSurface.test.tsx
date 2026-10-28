// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/workspace/NativeBrowserSurface.test.tsx
 *
 * 占位挖洞与几何同步引擎单测套件
 */

import React, { createRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
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
import { layerStackManager } from '@/components/ui';
import { toast } from '../../services/toast/toast';
import { logger } from '../../services/LoggerService';
import { resetNativeBrowserLifecyclesForTesting } from '../../api/nativeBrowserLifecycle';

// ── Mock Tauri IPC ───────────────────────────────────────────────────

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockImplementation((command: string) =>
    command.includes('browser_webview_set_hit_test')
      ? Promise.resolve({
          status: 'unsupported',
          reason: 'Native browser hit-test is not implemented',
        })
      : Promise.resolve(undefined)
  ),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

function mockVisibleSurfaceRect() {
  return vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({
      left: 20,
      top: 30,
      right: 420,
      bottom: 330,
      width: 400,
      height: 300,
      x: 20,
      y: 30,
      toJSON: () => ({}),
    } as DOMRect);
}

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
    (window as any).__TAURI_INTERNALS__ = {};
    mockInvoke.mockClear();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    layerStackManager.dispose();
    resetNativeBrowserLifecyclesForTesting();
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    layerStackManager.dispose();
    vi.restoreAllMocks();
    mockInvoke.mockReset().mockImplementation((command: string) =>
      command.includes('browser_webview_set_hit_test')
        ? Promise.resolve({
            status: 'unsupported',
            reason: 'Native browser hit-test is not implemented',
          })
        : Promise.resolve(undefined)
    );
    resetNativeBrowserLifecyclesForTesting();
  });

  it('原生 Webview 创建完成后向宿主报告 readiness', async () => {
    const onReadyChange = vi.fn();
    await act(async () => {
      render(
        <NativeBrowserSurface
          tabId="tab-ready-notification"
          onReadyChange={onReadyChange}
        />
      );
    });

    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true));
    expect(onReadyChange).toHaveBeenNthCalledWith(1, false);
  });

  it('原生 Webview 创建失败时保持 Inspector readiness 为 false', async () => {
    const onReadyChange = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockInvoke.mockImplementation((command: string) =>
      command.includes('browser_webview_create')
        ? Promise.reject(new Error('webview create failed'))
        : Promise.resolve(undefined)
    );

    await act(async () => {
      render(
        <NativeBrowserSurface
          tabId="tab-ready-failure"
          onReadyChange={onReadyChange}
        />
      );
    });

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(onReadyChange).toHaveBeenCalledTimes(1);
    expect(onReadyChange).toHaveBeenCalledWith(false);
    expect(onReadyChange).not.toHaveBeenCalledWith(true);
  });

  it('渲染纯净占位容器，并先创建原生 Webview 再同步几何', async () => {
    await act(async () => {
      render(
        <NativeBrowserSurface
          tabId="tab-test-1"
          initialUrl="https://initial.example"
        />
      );
    });

    const surface = screen.getByTestId('native-browser-surface');
    expect(surface).toBeInTheDocument();
    expect(surface.tagName.toLowerCase()).toBe('div');
    expect(surface).toHaveAttribute('data-tab-id', 'tab-test-1');
    expect(surface).toHaveAttribute('data-native-surface', 'true');

    // 绝对禁止含有 iframe
    expect(surface.querySelector('iframe')).toBeNull();

    // 挂载时触发底层原生 Webview 创建
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.stringMatching(/browser_webview_create/),
      expect.objectContaining({
        tabId: 'tab-test-1',
        initialUrl: 'https://initial.example',
        bounds: expect.objectContaining({ width: 1, height: 1 }),
        visible: false,
      })
    );

    const commandNames = mockInvoke.mock.calls.map(([command]) =>
      String(command)
    );
    const createIndex = commandNames.findIndex((command) =>
      command.includes('browser_webview_create')
    );
    const visibleIndex = commandNames.findIndex((command) =>
      command.includes('browser_webview_set_visible')
    );
    const boundsIndex = commandNames.findIndex((command) =>
      command.includes('browser_webview_set_bounds')
    );
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(boundsIndex).toBeGreaterThan(createIndex);
    expect(visibleIndex).toBe(-1);
    expect(
      commandNames
        .slice(0, createIndex)
        .some((command) => /set_bounds|set_visible/.test(command))
    ).toBe(false);
  });

  it('StrictMode 重放共享一次 create，并在成功后重放最新几何与显隐', async () => {
    mockVisibleSurfaceRect();
    let releaseCreate!: () => void;
    let signalCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    let createCalls = 0;
    mockInvoke.mockImplementation((command: string) => {
      if (command.includes('browser_webview_create')) {
        createCalls += 1;
        signalCreateStarted();
        return new Promise((resolve) => {
          releaseCreate = () => resolve(null);
        });
      }
      return Promise.resolve(undefined);
    });

    let unmount!: () => void;
    let rerender!: (ui: React.ReactElement) => void;
    await act(async () => {
      ({ unmount, rerender } = render(
        <React.StrictMode>
          <NativeBrowserSurface tabId="tab-strict-mode" isActive={false} />
        </React.StrictMode>
      ));
    });
    await createStarted;

    await act(async () => {
      rerender(
        <React.StrictMode>
          <NativeBrowserSurface tabId="tab-strict-mode" isActive />
        </React.StrictMode>
      );
    });

    expect(createCalls).toBe(1);
    expect(
      mockInvoke.mock.calls.some(([command]) =>
        /set_bounds|set_visible/.test(String(command))
      )
    ).toBe(false);

    await act(async () => {
      releaseCreate();
      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith(
          expect.stringMatching(/browser_webview_set_bounds/),
          expect.anything()
        )
      );
    });

    expect(createCalls).toBe(1);
    const createArgs = mockInvoke.mock.calls.find(([command]) =>
      String(command).includes('browser_webview_create')
    )?.[1];
    expect(createArgs).toMatchObject({ visible: false });
    const visibilityCalls = mockInvoke.mock.calls.filter(([command]) =>
      String(command).includes('browser_webview_set_visible')
    );
    expect(visibilityCalls[visibilityCalls.length - 1]?.[1]).toMatchObject({
      visible: true,
    });

    await act(async () => {
      unmount();
      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith(
          expect.stringMatching(/browser_webview_set_visible/),
          expect.objectContaining({ tabId: 'tab-strict-mode', visible: false })
        )
      );
    });
    expect(
      mockInvoke.mock.calls.some(([command]) =>
        String(command).includes('browser_webview_close')
      )
    ).toBe(false);
  });

  it('create 成功后最新 URL 对账失败仍 ready，并提供可重试错误提示', async () => {
    mockVisibleSurfaceRect();
    const toastError = vi.spyOn(toast, 'error').mockReturnValue('retry-toast');
    let releaseCreate!: () => void;
    let signalCreateStarted!: () => void;
    let allowLatestNavigation = false;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    mockInvoke.mockImplementation((command: string, args?: unknown) => {
      if (command.includes('browser_webview_create')) {
        signalCreateStarted();
        return new Promise((resolve) => {
          releaseCreate = () => resolve(null);
        });
      }
      if (
        command.includes('browser_webview_navigate') &&
        (args as { url?: string } | undefined)?.url ===
          'https://latest.example' &&
        !allowLatestNavigation
      ) {
        return Promise.reject(new Error('temporary navigation failure'));
      }
      return Promise.resolve(undefined);
    });

    let rerender!: (ui: React.ReactElement) => void;
    await act(async () => {
      ({ rerender } = render(
        <NativeBrowserSurface
          tabId="tab-create-reconcile-retry"
          initialUrl="https://first.example"
        />
      ));
    });
    await createStarted;

    await act(async () => {
      releaseCreate();
    });

    await act(async () => {
      rerender(
        <NativeBrowserSurface
          tabId="tab-create-reconcile-retry"
          initialUrl="https://latest.example"
        />
      );
    });

    await waitFor(() => expect(toastError).toHaveBeenCalled());

    const options = toastError.mock.calls.at(-1)?.[1];
    expect(options?.action?.label).toBe('重试');

    await act(async () => {
      allowLatestNavigation = true;
      await options?.action?.onClick({} as React.MouseEvent<HTMLButtonElement>);
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.stringMatching(/browser_webview_navigate/),
      expect.objectContaining({ url: 'https://latest.example' })
    );
  });

  it('create 完成前只记录 Hit-Test 目标，ready 后重放最新状态', async () => {
    mockVisibleSurfaceRect();
    const ref = createRef<NativeBrowserSurfaceHandle>();
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let releaseCreate!: () => void;
    let signalCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    mockInvoke.mockImplementation((command: string) => {
      if (command.includes('browser_webview_create')) {
        signalCreateStarted();
        return new Promise((resolve) => {
          releaseCreate = () => resolve(null);
        });
      }
      if (command.includes('browser_webview_set_hit_test')) {
        return Promise.resolve({
          status: 'unsupported',
          reason: 'Native browser hit-test is not implemented',
        });
      }
      return Promise.resolve(undefined);
    });

    await act(async () => {
      render(
        <NativeBrowserSurface ref={ref} tabId="tab-hit-test-ready-gate" />
      );
    });
    await createStarted;

    let queuedResult:
      ReturnType<NativeBrowserSurfaceHandle['setHitTest']> | undefined;
    act(() => {
      queuedResult = ref.current?.setHitTest(false);
    });
    expect(queuedResult).toEqual({ status: 'queued' });
    expect(
      mockInvoke.mock.calls.some(([command]) =>
        String(command).includes('set_hit_test')
      )
    ).toBe(false);

    await act(async () => {
      releaseCreate();
    });

    await waitFor(() =>
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('Native browser hit-test unsupported:'),
        expect.anything()
      )
    );
    let hitTestResult:
      Awaited<ReturnType<NativeBrowserSurfaceHandle['setHitTest']>> | undefined;
    await act(async () => {
      hitTestResult = await ref.current?.setHitTest(false);
    });
    expect(hitTestResult).toMatchObject({ status: 'unsupported' });
    expect(
      mockInvoke.mock.calls.some(([command]) =>
        String(command).includes('set_hit_test')
      )
    ).toBe(true);
  });

  it('Hit-Test transport 失败可见告警且不会产生未处理 rejection', async () => {
    mockVisibleSurfaceRect();
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mockInvoke.mockImplementation((command: string) =>
      command.includes('browser_webview_set_hit_test')
        ? Promise.reject(new Error('hit-test transport failed'))
        : Promise.resolve(undefined)
    );

    await act(async () => {
      render(<NativeBrowserSurface tabId="tab-hit-test-transport-error" />);
    });

    await waitFor(() =>
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(
          'Native browser hit-test error: hit-test transport failed'
        ),
        expect.anything()
      )
    );
  });

  it('create 在途时卸载会等创建完成后隐藏，不继续同步 bounds 或导航', async () => {
    mockVisibleSurfaceRect();
    let releaseCreate!: () => void;
    let signalCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    let unmount!: () => void;
    mockInvoke.mockImplementation((command: string) => {
      if (command.includes('browser_webview_create')) {
        signalCreateStarted();
        return new Promise((resolve) => {
          releaseCreate = () => resolve(null);
        });
      }
      if (command.includes('browser_webview_set_hit_test')) {
        return Promise.resolve({
          status: 'unsupported',
          reason:
            'Native browser hit-test is not implemented in the current runtime',
        });
      }
      return Promise.resolve(undefined);
    });

    await act(async () => {
      ({ unmount } = render(
        <NativeBrowserSurface
          tabId="tab-unmount-during-create"
          initialUrl="https://pending.example"
        />
      ));
    });
    await createStarted;

    await act(async () => {
      unmount();
      releaseCreate();
      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith(
          expect.stringMatching(/browser_webview_set_visible/),
          expect.objectContaining({
            tabId: 'tab-unmount-during-create',
            visible: false,
          })
        )
      );
    });

    expect(
      mockInvoke.mock.calls.some(([command]) =>
        String(command).includes('browser_webview_set_bounds')
      )
    ).toBe(false);
    expect(
      mockInvoke.mock.calls.some(([command]) =>
        String(command).includes('browser_webview_navigate')
      )
    ).toBe(false);
    expect(
      mockInvoke.mock.calls.some(([command]) =>
        String(command).includes('browser_webview_close')
      )
    ).toBe(false);
  });

  it('当 LayerStackManager 存在模态框时，展示磨砂占位底板 (Airspace 避让态)', async () => {
    let rerenderFn: (ui: React.ReactElement) => void;
    await act(async () => {
      const { rerender } = render(
        <NativeBrowserSurface tabId="tab-modal-test" />
      );
      rerenderFn = rerender;
    });

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

    // 应该展现毛玻璃磨砂底板
    await waitFor(() => {
      expect(screen.getByTestId('native-surface-scrim')).toBeInTheDocument();
    });

    // 退栈模态框
    act(() => {
      layerStackManager.unregister('settings-modal');
    });

    // 毛玻璃底板应该自动消失，原生视口恢复
    await waitFor(() => {
      expect(screen.queryByTestId('native-surface-scrim')).toBeNull();
    });
  });

  it('当 LayerStackManager 存在非模态浮层（如 Popover/Dropdown）时，同样触发 isOccluded 并展示磨砂底板避让', async () => {
    await act(async () => {
      render(<NativeBrowserSurface tabId="tab-floating-test" />);
    });

    // 初始状态无浮层，不应有 scrim 遮罩
    expect(screen.queryByTestId('native-surface-scrim')).toBeNull();

    // 压入一个非模态 Popover 浮层（如点击加号打开的 NewTabLauncherPopover）
    act(() => {
      layerStackManager.register({
        id: 'new-tab-launcher-popover',
        type: 'popover',
        modal: false,
        dismissible: true,
        onDismiss: () => {},
      });
    });

    // 应该展现毛玻璃磨砂底板（Airspace 避让）
    await waitFor(() => {
      expect(screen.getByTestId('native-surface-scrim')).toBeInTheDocument();
    });

    // 退栈浮层
    act(() => {
      layerStackManager.unregister('new-tab-launcher-popover');
    });

    // 毛玻璃底板应该自动消失
    await waitFor(() => {
      expect(screen.queryByTestId('native-surface-scrim')).toBeNull();
    });
  });

  it('支持通过 forwardRef 暴露命令式句柄', async () => {
    const ref = createRef<NativeBrowserSurfaceHandle>();
    await act(async () => {
      render(<NativeBrowserSurface ref={ref} tabId="tab-ref-test" />);
    });

    expect(ref.current).toBeDefined();
    expect(ref.current?.surfaceElement).toBeInstanceOf(HTMLDivElement);
    expect(typeof ref.current?.syncGeometry).toBe('function');
    expect(typeof ref.current?.setHitTest).toBe('function');
  });

  it('Hit-Test 看门狗保留复位链并显式报告原生能力未实现', async () => {
    const ref = createRef<NativeBrowserSurfaceHandle>();
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mockInvoke.mockImplementation((command: string) =>
      command.includes('browser_webview_set_hit_test')
        ? Promise.resolve({
            status: 'unsupported',
            reason: 'Native browser hit-test is not implemented',
          })
        : Promise.resolve(undefined)
    );
    await act(async () => {
      render(<NativeBrowserSurface ref={ref} tabId="tab-hittest-test" />);
    });

    let result:
      Awaited<ReturnType<NativeBrowserSurfaceHandle['setHitTest']>> | undefined;
    await act(async () => {
      result = await ref.current?.setHitTest(false);
    });
    expect(result).toMatchObject({ status: 'unsupported' });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Native browser hit-test unsupported:'),
      expect.anything()
    );

    mockInvoke.mockClear();
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(
      mockInvoke.mock.calls.some(([command]) =>
        String(command).includes('set_hit_test')
      )
    ).toBe(false);
  });

  it('当 tabId 发生切换时，平滑隐藏旧 Webview 并挂接新 Webview', async () => {
    mockVisibleSurfaceRect();
    let rerenderFn!: (ui: React.ReactElement) => void;
    await act(async () => {
      const { rerender } = render(<NativeBrowserSurface tabId="tab-old" />);
      rerenderFn = rerender;
    });

    mockInvoke.mockClear();

    // 切换至新 tabId
    await act(async () => {
      rerenderFn(<NativeBrowserSurface tabId="tab-new" />);
    });

    // 必须调用 set_visible(false) 隐藏旧 Webview 'tab-old'
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.stringMatching(/set_visible/),
      expect.objectContaining({ tabId: 'tab-old', visible: false })
    );

    // 必须为新 tabId 创建 Webview
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.stringMatching(/browser_webview_create/),
      expect.objectContaining({ tabId: 'tab-new' })
    );
  });

  it('卸载时只隐藏原生视口，不销毁 Tab 实例', async () => {
    mockVisibleSurfaceRect();
    let unmountFn!: () => void;
    await act(async () => {
      const { unmount } = render(
        <NativeBrowserSurface tabId="tab-unmount-test" />
      );
      unmountFn = unmount;
    });

    mockInvoke.mockClear();

    // 卸载组件
    await act(async () => {
      unmountFn();
      await Promise.resolve();
      await Promise.resolve();
    });

    // 必须隐身当前 Webview
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.stringMatching(/set_visible/),
      expect.objectContaining({ tabId: 'tab-unmount-test', visible: false })
    );
    expect(
      mockInvoke.mock.calls.some(([command]) =>
        String(command).includes('browser_webview_close')
      )
    ).toBe(false);
  });
});
