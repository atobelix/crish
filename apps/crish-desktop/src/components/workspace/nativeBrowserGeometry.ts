/**
 * apps/crish-desktop/src/components/workspace/nativeBrowserGeometry.ts
 *
 * 原生子 Webview 几何测量、外边界物理对齐与双相同步引擎
 *
 * 遵循《docs/native-browser-overhaul/audits/03-frontend-geometry-and-airspace-audit.md》审计规范：
 * 1. 采用外边界独立四舍五入算法，从数学上彻底根除 Windows 125%/150%/175% 缩放下的 1px 细线接缝与边框吞噬；
 * 2. rAF 单槽队列动态相（Live Phase）+ 50ms 静态收敛相（Settled Phase）；
 * 3. 0.5px 差分脏矩形去重（Dirty Epsilon Check），拦截 IPC 洪峰；
 * 4. 监听 WM_DPICHANGED (matchMedia resolution) 响应跨屏拖拽 DPI 突变；
 * 5. Hit-Test 状态机看门狗，防范手势中断穿透死锁。
 */

import { useLayoutEffect, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useLayerStackModalActive } from '../ui/internal/layer-stack/LayerStackManager';
import { ResizeObserverManager } from '../../utils/ResizeObserverManager';

export { useLayerStackModalActive };

// ── 类型定义 ─────────────────────────────────────────────────────────

/**
 * 逻辑矩形（CSS 逻辑像素，相对主窗口视口客户区）
 */
export interface LogicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 物理像素矩形（经设备像素比换算并严格网格规整）
 */
export interface PhysicalBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

/**
 * 几何同步负载
 */
export interface NativeBoundsPayload {
  tabId: string;
  bounds: LogicalRect;
  physicalBounds: PhysicalBounds;
  visible: boolean;
}

export const BOUNDS_EPSILON = 0.5;
export const SETTLE_DEBOUNCE_MS = 50;

// ── 核心纯算法 ───────────────────────────────────────────────────────

/**
 * 工业级物理外边界规整算法 (Boundary-Independent Grid Snapping)
 *
 * 对 left, top, right, bottom 四条物理外边界分别独立执行四舍五入：
 *   physLeft = round(left * dpr)
 *   physRight = round((left + width) * dpr)
 *   physWidth = max(0, physRight - physLeft)
 *
 * 数学证明保证：相邻面板 A 与 B (A.right === B.left) 其物理像素边界必然连续，
 * 彻底消除非整数 DPR 下加法累积产生的 1px 白线接缝与边框重叠。
 */
export function computeSnappedPhysicalBounds(
  rect: DOMRect,
  dpr: number
): PhysicalBounds {
  const safeDpr = dpr > 0 ? dpr : 1;

  const physLeft = Math.round(rect.left * safeDpr);
  const physTop = Math.round(rect.top * safeDpr);
  const physRight = Math.round(rect.right * safeDpr);
  const physBottom = Math.round(rect.bottom * safeDpr);

  return {
    x: physLeft,
    y: physTop,
    width: Math.max(0, physRight - physLeft),
    height: Math.max(0, physBottom - physTop),
    scale: safeDpr,
  };
}

/**
 * 差分脏矩形检测：判断位移或尺寸变化是否小于 epsilon 阈值
 */
export function isSimilarBounds(
  prev: { x: number; y: number; width: number; height: number },
  next: { x: number; y: number; width: number; height: number },
  epsilon = BOUNDS_EPSILON
): boolean {
  return (
    Math.abs(prev.x - next.x) < epsilon &&
    Math.abs(prev.y - next.y) < epsilon &&
    Math.abs(prev.width - next.width) < epsilon &&
    Math.abs(prev.height - next.height) < epsilon
  );
}

/**
 * 判定 DOMRect 是否在当前宿主视口内有效可见
 */
export function isRectInViewport(rect: DOMRect): boolean {
  if (typeof window === 'undefined') return false;
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0
  );
}

/**
 * 订阅设备像素比 (DPR) 变化（如用户将窗口拖拽至不同缩放倍率的显示器）
 */
export function subscribeDevicePixelRatio(onChange: () => void): () => void {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return () => {};
  }

  let mql: MediaQueryList | null = null;
  let disposed = false;

  const handleDprChange = () => {
    if (disposed) return;
    updateListener();
    onChange();
  };

  const updateListener = () => {
    if (mql) {
      mql.removeEventListener('change', handleDprChange);
    }
    const dpr = window.devicePixelRatio || 1;
    mql = window.matchMedia(`(resolution: ${dpr}dppx)`);
    mql.addEventListener('change', handleDprChange);
  };

  updateListener();

  return () => {
    disposed = true;
    if (mql) {
      mql.removeEventListener('change', handleDprChange);
      mql = null;
    }
  };
}

// ── IPC 传输桥 ───────────────────────────────────────────────────────

/**
 * 向 Rust 原生子 Webview 内核同步几何坐标
 */
export async function sendNativeBrowserBounds(
  tabId: string,
  logical: LogicalRect,
  physical: PhysicalBounds,
  visible: boolean
): Promise<void> {
  try {
    await invoke('browser_webview_set_bounds', {
      tabId,
      tab_id: tabId,
      bounds: logical,
    });
  } catch {
    // 兼容分维方案中的别名命令
    try {
      await invoke('workbench_sync_native_browser_bounds', {
        payload: {
          browserId: tabId,
          tabId,
          x: physical.x,
          y: physical.y,
          width: physical.width,
          height: physical.height,
          scale: physical.scale,
          visible,
        },
      });
    } catch {
      // 容错吸收未就绪阶段调用
    }
  }
}

/**
 * 向 Rust 原生子 Webview 内核同步显隐状态
 */
export async function sendNativeBrowserVisible(
  tabId: string,
  visible: boolean
): Promise<void> {
  try {
    await invoke('browser_webview_set_visible', {
      tabId,
      tab_id: tabId,
      visible,
    });
  } catch {
    try {
      await invoke('workbench_set_browser_visible', {
        browserId: tabId,
        tabId,
        visible,
      });
    } catch {
      // 容错吸收
    }
  }
}

/**
 * 向 Rust 原生子 Webview 内核切换鼠标穿透 (Hit-Test)
 */
export async function sendNativeBrowserHitTest(
  tabId: string,
  hitTest: boolean
): Promise<void> {
  try {
    await invoke('browser_webview_set_hit_test', {
      tabId,
      tab_id: tabId,
      hitTest,
      hit_test: hitTest,
    });
  } catch {
    try {
      await invoke('workbench_set_browser_hit_test', {
        browserId: tabId,
        tabId,
        hitTest,
      });
    } catch {
      // 容错吸收
    }
  }
}

/**
 * 向 Rust 原生子 Webview 内核请求导航至指定 URL
 */
export async function sendNativeBrowserNavigate(
  tabId: string,
  url: string
): Promise<void> {
  if (!url || url === 'about:blank') return;
  try {
    await invoke('browser_webview_navigate', {
      tabId,
      tab_id: tabId,
      url,
    });
  } catch {
    // 容错吸收
  }
}

/**
 * 向 Rust 原生子 Webview 内核请求关闭并销毁实例
 */
export async function sendNativeBrowserClose(tabId: string): Promise<void> {
  try {
    await invoke('browser_webview_close', {
      tabId,
      tab_id: tabId,
    });
  } catch {
    try {
      await invoke('workbench_destroy_browser', {
        browserId: tabId,
        tabId,
      });
    } catch {
      // 容错吸收
    }
  }
}

// ── 几何同步 Hook ─────────────────────────────────────────────────────

export interface UseNativeBrowserGeometryOptions {
  tabId: string;
  surfaceRef: React.RefObject<HTMLDivElement | null>;
  isActive?: boolean;
  isOccluded?: boolean;
  onBoundsChange?: (bounds: PhysicalBounds) => void;
}

export interface UseNativeBrowserGeometryResult {
  scheduleSync: (immediate?: boolean) => void;
  syncImmediate: () => void;
}

/**
 * 原生浏览器双相几何同步 Hook
 */
export function useNativeBrowserGeometry({
  tabId,
  surfaceRef,
  isActive = true,
  isOccluded = false,
  onBoundsChange,
}: UseNativeBrowserGeometryOptions): UseNativeBrowserGeometryResult {
  const lastStateRef = useRef<{
    logical: LogicalRect;
    physical: PhysicalBounds;
    visible: boolean;
  } | null>(null);

  const rafIdRef = useRef<number | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitGeometry = useCallback(
    (force = false) => {
      const el = surfaceRef.current;
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const dpr =
        typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

      const inViewport = isRectInViewport(rect);
      const isVisible = Boolean(isActive) && !isOccluded && inViewport;

      const physical = computeSnappedPhysicalBounds(rect, dpr);
      const logical: LogicalRect = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };

      const prevState = lastStateRef.current;
      if (!force && prevState) {
        const isVisibilityChanged = prevState.visible !== isVisible;
        if (!isVisibilityChanged) {
          if (!isVisible) {
            // 保持不可见状态，无需重复发送
            return;
          }
          // 可见状态下，检查位移与尺寸变动量是否达到差分阈值
          if (isSimilarBounds(prevState.logical, logical, BOUNDS_EPSILON)) {
            return;
          }
        }
      }

      lastStateRef.current = { logical, physical, visible: isVisible };

      onBoundsChange?.(physical);
      void sendNativeBrowserBounds(tabId, logical, physical, isVisible);

      if (!prevState || prevState.visible !== isVisible) {
        void sendNativeBrowserVisible(tabId, isVisible);
      }
    },
    [isActive, isOccluded, onBoundsChange, surfaceRef, tabId]
  );

  const scheduleSync = useCallback(
    (immediate = false) => {
      if (immediate) {
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        commitGeometry(true);
        return;
      }

      // 1. 动态相：rAF 单槽调度，本帧若已排队则直接保留，不重复创建
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          commitGeometry(false);
        });
      }

      // 2. 静态收敛相：50ms 防抖，连续变动停止后校准最终亚像素精度
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
      }
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        commitGeometry(true);
      }, SETTLE_DEBOUNCE_MS);
    },
    [commitGeometry]
  );

  const syncImmediate = useCallback(() => {
    scheduleSync(true);
  }, [scheduleSync]);

  // 布局与尺寸监听
  useLayoutEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;

    const ro = ResizeObserverManager.getInstance();
    const handleSync = () => scheduleSync(false);
    ro.observe(el, handleSync);

    const handleWindowResize = () => scheduleSync(false);
    const handleScroll = () => scheduleSync(false);
    const handleLiveResize = () => scheduleSync(false);

    window.addEventListener('app:window-resize-settled', handleWindowResize);
    window.addEventListener('scroll', handleScroll, {
      passive: true,
      capture: true,
    });
    window.addEventListener('crish:layout-live-resize', handleLiveResize);

    const unwatchDpr = subscribeDevicePixelRatio(() => {
      scheduleSync(true);
    });

    // 挂载首帧立即测量
    scheduleSync(true);

    return () => {
      ro.unobserve(el, handleSync);
      window.removeEventListener(
        'app:window-resize-settled',
        handleWindowResize
      );
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('crish:layout-live-resize', handleLiveResize);
      unwatchDpr();

      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };
  }, [scheduleSync, surfaceRef]);

  // 显隐或遮挡突变时立即响应
  useEffect(() => {
    scheduleSync(true);
  }, [isActive, isOccluded, scheduleSync]);

  return {
    scheduleSync,
    syncImmediate,
  };
}

// ── Hit-Test 看门狗 Hook ──────────────────────────────────────────────

export interface UseHitTestGuardResult {
  setHitTest: (enabled: boolean) => void;
  isMutedRef: React.RefObject<boolean>;
}

/**
 * 原生视口鼠标穿透 (Hit-Test) 状态机与自愈看门狗
 *
 * 监听 pointercancel / blur / lostpointercapture / Escape，
 * 彻底防止手势中断时子 HWND 永久陷入透明穿透死锁。
 */
export function useHitTestGuard(tabId: string): UseHitTestGuardResult {
  const isMutedRef = useRef(false);

  const setHitTest = useCallback(
    (enabled: boolean) => {
      isMutedRef.current = !enabled;
      void sendNativeBrowserHitTest(tabId, enabled);
    },
    [tabId]
  );

  useEffect(() => {
    const handleSelfHeal = () => {
      if (isMutedRef.current) {
        isMutedRef.current = false;
        void sendNativeBrowserHitTest(tabId, true);
      }
    };

    window.addEventListener('pointercancel', handleSelfHeal);
    window.addEventListener('lostpointercapture', handleSelfHeal);
    window.addEventListener('blur', handleSelfHeal);
    window.addEventListener('pointerup', handleSelfHeal);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleSelfHeal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointercancel', handleSelfHeal);
      window.removeEventListener('lostpointercapture', handleSelfHeal);
      window.removeEventListener('blur', handleSelfHeal);
      window.removeEventListener('pointerup', handleSelfHeal);
      window.removeEventListener('keydown', handleKeyDown);

      // 卸载时恢复正常交互
      if (isMutedRef.current) {
        isMutedRef.current = false;
        void sendNativeBrowserHitTest(tabId, true);
      }
    };
  }, [tabId]);

  return {
    setHitTest,
    isMutedRef,
  };
}
