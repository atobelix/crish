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

import {
  useLayoutEffect,
  useEffect,
  useRef,
  useCallback,
  type RefObject,
  type MutableRefObject,
} from 'react';
import {
  browserWebviewSetHitTest,
  type NativeBrowserHitTestPayload,
} from '../../api/nativeBrowserApi';
import { logger } from '../../services/LoggerService';
import { useLayerStackModalActive, useFloatingActive } from '@/components/ui';
import { ResizeObserverManager } from '../../utils/ResizeObserverManager';
import {
  SETTLE_DEBOUNCE_MS,
  commitGeometrySnapshot,
  enqueueGeometrySync,
  resetGeometryStateForTabId,
  type AppliedGeometryState,
  type GeometrySnapshot,
  type LogicalRect,
  type PhysicalBounds,
} from './nativeBrowserGeometrySync';

export { useLayerStackModalActive, useFloatingActive };
export {
  BOUNDS_EPSILON,
  SETTLE_DEBOUNCE_MS,
  computeSnappedPhysicalBounds,
  isRectInViewport,
  isSimilarBounds,
  sendNativeBrowserBounds,
  sendNativeBrowserVisible,
} from './nativeBrowserGeometrySync';
export type { LogicalRect, PhysicalBounds } from './nativeBrowserGeometrySync';

export interface NativeBoundsPayload {
  tabId: string;
  bounds: LogicalRect;
  physicalBounds: PhysicalBounds;
  visible: boolean;
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

type MutableRef<T> = MutableRefObject<T>;

function useGeometryGenerationCleanup(
  tabId: string,
  generationRef: MutableRef<number>,
  isReadyRef: MutableRef<boolean>,
  desiredStateRef: MutableRef<GeometrySnapshot | null>,
  appliedStateRef: MutableRef<AppliedGeometryState | null>,
  queuedSyncKeysRef: MutableRef<Set<string>>
): void {
  useEffect(() => {
    const generation = generationRef.current;
    const queuedSyncKeys = queuedSyncKeysRef.current;
    return () => {
      if (generationRef.current !== generation) return;
      generationRef.current += 1;
      isReadyRef.current = false;
      desiredStateRef.current = null;
      appliedStateRef.current = null;
      queuedSyncKeys.clear();
    };
  }, [
    appliedStateRef,
    desiredStateRef,
    generationRef,
    isReadyRef,
    queuedSyncKeysRef,
    tabId,
  ]);
}

function useGeometryLayoutObservers(
  surfaceRef: React.RefObject<HTMLDivElement | null>,
  scheduleSync: (immediate?: boolean) => void,
  rafIdRef: MutableRef<number | null>,
  settleTimerRef: MutableRef<ReturnType<typeof setTimeout> | null>
): void {
  useLayoutEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;

    const ro = ResizeObserverManager.getInstance();
    const handleSync = () => scheduleSync(false);
    ro.observe(el, handleSync);

    const handleWindowResize = () => scheduleSync(false);
    const handleScroll = () => scheduleSync(false);
    const handleLiveResize = () => scheduleSync(false);
    const handleSashSettled = () => scheduleSync(true);

    window.addEventListener('app:window-resize-settled', handleWindowResize);
    window.addEventListener('scroll', handleScroll, {
      passive: true,
      capture: true,
    });
    window.addEventListener('crish:layout-live-resize', handleLiveResize);
    window.addEventListener('dock-split-resizing-changed', handleSashSettled);

    const unwatchDpr = subscribeDevicePixelRatio(() => {
      scheduleSync(true);
    });

    scheduleSync(true);

    return () => {
      ro.unobserve(el, handleSync);
      window.removeEventListener(
        'app:window-resize-settled',
        handleWindowResize
      );
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('crish:layout-live-resize', handleLiveResize);
      window.removeEventListener(
        'dock-split-resizing-changed',
        handleSashSettled
      );
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
  }, [rafIdRef, scheduleSync, settleTimerRef, surfaceRef]);
}

export type NativeBrowserHitTestResult =
  | { status: 'queued' }
  | NativeBrowserHitTestPayload
  | { status: 'error'; reason: string };

/** 请求原生命中测试，并将能力状态与 transport 故障分开返回。 */
export async function sendNativeBrowserHitTest(
  tabId: string,
  hitTest: boolean
): Promise<NativeBrowserHitTestResult> {
  try {
    return await browserWebviewSetHitTest(tabId, hitTest);
  } catch (error) {
    return {
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── 几何同步 Hook ─────────────────────────────────────────────────────

export interface UseNativeBrowserGeometryOptions {
  tabId: string;
  surfaceRef: React.RefObject<HTMLDivElement | null>;
  /** 原生子 Webview 创建成功后才允许发送几何与显隐命令。 */
  isReady?: boolean;
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
  isReady = true,
  isActive = true,
  isOccluded = false,
  onBoundsChange,
}: UseNativeBrowserGeometryOptions): UseNativeBrowserGeometryResult {
  const isReadyRef = useRef(isReady);
  isReadyRef.current = isReady;

  const desiredStateRef = useRef<GeometrySnapshot | null>(null);
  const appliedStateRef = useRef<AppliedGeometryState | null>(null);
  const revisionRef = useRef(0);
  const generationRef = useRef(0);
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedSyncKeysRef = useRef(new Set<string>());

  // 当 tabId 发生切换时，必须重置上一次的状态缓存，确保新 Tab 能够无条件获得首帧几何与可见性同步
  const currentTabIdRef = useRef(tabId);
  resetGeometryStateForTabId(
    tabId,
    currentTabIdRef,
    generationRef,
    desiredStateRef,
    appliedStateRef,
    revisionRef,
    syncQueueRef,
    queuedSyncKeysRef
  );

  useGeometryGenerationCleanup(
    tabId,
    generationRef,
    isReadyRef,
    desiredStateRef,
    appliedStateRef,
    queuedSyncKeysRef
  );

  const rafIdRef = useRef<number | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enqueueSync = useCallback(
    (snapshot: GeometrySnapshot, forceBounds: boolean, generation: number) =>
      enqueueGeometrySync(
        {
          tabId,
          currentTabIdRef,
          generationRef,
          isReadyRef,
          desiredStateRef,
          appliedStateRef,
          syncQueueRef,
          queuedSyncKeysRef,
        },
        snapshot,
        forceBounds,
        generation
      ),
    [tabId]
  );

  const commitGeometry = useCallback(
    (force = false) =>
      commitGeometrySnapshot(
        {
          tabId,
          currentTabIdRef,
          generationRef,
          isReadyRef,
          desiredStateRef,
          appliedStateRef,
          syncQueueRef,
          queuedSyncKeysRef,
          surfaceRef,
          isActive,
          isOccluded,
          onBoundsChange,
          revisionRef,
        },
        force,
        enqueueSync
      ),
    [enqueueSync, isActive, isOccluded, onBoundsChange, surfaceRef, tabId]
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

  useGeometryLayoutObservers(
    surfaceRef,
    scheduleSync,
    rafIdRef,
    settleTimerRef
  );

  // 显隐或遮挡突变时立即响应
  useEffect(() => {
    scheduleSync(true);
  }, [isActive, isOccluded, isReady, scheduleSync]);

  return {
    scheduleSync,
    syncImmediate,
  };
}

// ── Hit-Test 看门狗 Hook ──────────────────────────────────────────────

export interface UseHitTestGuardResult {
  setHitTest: (
    enabled: boolean
  ) => NativeBrowserHitTestResult | Promise<NativeBrowserHitTestResult>;
  isMutedRef: RefObject<boolean>;
}

/**
 * 原生视口鼠标穿透 (Hit-Test) 状态机与自愈看门狗。
 * 创建完成前只记录目标状态，不发出可能早于 create 的 IPC。
 */
export function useHitTestGuard(
  tabId: string,
  isReady = true
): UseHitTestGuardResult {
  const isMutedRef = useRef(false);
  const isReadyRef = useRef(isReady);
  const reportedHitTestIssueTabRef = useRef<string | null>(null);
  isReadyRef.current = isReady;

  const reportResult = useCallback(
    (result: NativeBrowserHitTestResult) => {
      if (
        result.status !== 'queued' &&
        reportedHitTestIssueTabRef.current !== tabId
      ) {
        reportedHitTestIssueTabRef.current = tabId;
        logger.warn(
          `Native browser hit-test ${result.status}: ${result.reason}`,
          { module: 'nativeBrowserGeometry', sessionId: tabId }
        );
      }
      return result;
    },
    [tabId]
  );

  const setHitTest = useCallback(
    (enabled: boolean) => {
      isMutedRef.current = !enabled;
      if (!isReadyRef.current) return { status: 'queued' } as const;
      return sendNativeBrowserHitTest(tabId, enabled).then(reportResult);
    },
    [reportResult, tabId]
  );

  useEffect(() => {
    if (isReady) {
      // Ready 后重放创建期间累计的最新状态（通常为启用命中测试）。
      void sendNativeBrowserHitTest(tabId, !isMutedRef.current).then(
        reportResult
      );
    }
  }, [isReady, reportResult, tabId]);

  useEffect(() => {
    const handleSelfHeal = () => {
      if (isMutedRef.current) {
        isMutedRef.current = false;
        if (isReadyRef.current) {
          void sendNativeBrowserHitTest(tabId, true).then(reportResult);
        }
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleSelfHeal();
    };

    const handleResizingChange = (e: Event) => {
      const customEvent = e as CustomEvent<{ resizing?: boolean }>;
      if (customEvent.detail?.resizing) {
        isMutedRef.current = true;
        if (isReadyRef.current) {
          void sendNativeBrowserHitTest(tabId, false).then(reportResult);
        }
      } else {
        handleSelfHeal();
      }
    };

    window.addEventListener('pointercancel', handleSelfHeal);
    window.addEventListener('lostpointercapture', handleSelfHeal);
    window.addEventListener('blur', handleSelfHeal);
    window.addEventListener('pointerup', handleSelfHeal);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener(
      'dock-split-resizing-changed',
      handleResizingChange
    );

    return () => {
      window.removeEventListener('pointercancel', handleSelfHeal);
      window.removeEventListener('lostpointercapture', handleSelfHeal);
      window.removeEventListener('blur', handleSelfHeal);
      window.removeEventListener('pointerup', handleSelfHeal);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener(
        'dock-split-resizing-changed',
        handleResizingChange
      );

      if (isMutedRef.current) {
        isMutedRef.current = false;
        if (isReadyRef.current) {
          void sendNativeBrowserHitTest(tabId, true).then(reportResult);
        }
      }
    };
  }, [reportResult, tabId]);

  return { setHitTest, isMutedRef };
}
