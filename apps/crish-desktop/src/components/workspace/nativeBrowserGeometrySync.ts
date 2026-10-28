/**
 * apps/crish-desktop/src/components/workspace/nativeBrowserGeometrySync.ts
 *
 * 原生浏览器几何同步状态、纯算法与 IPC 队列。
 */

import type { MutableRefObject, RefObject } from 'react';
import {
  browserWebviewSetBounds,
  browserWebviewSetVisible,
} from '../../api/nativeBrowserApi';
import { logger } from '../../services/LoggerService';

/** 逻辑矩形（CSS 逻辑像素，相对主窗口视口客户区） */
export interface LogicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 物理像素矩形（经设备像素比换算并严格网格规整） */
export interface PhysicalBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface GeometrySnapshot {
  logical: LogicalRect;
  physical: PhysicalBounds;
  visible: boolean;
  revision: number;
}

export interface AppliedGeometryState {
  logical?: LogicalRect;
  visible?: boolean;
}

export const BOUNDS_EPSILON = 0.5;
export const SETTLE_DEBOUNCE_MS = 50;

/**
 * 对 left、top、right、bottom 四条物理外边界分别独立四舍五入，
 * 确保非整数 DPR 下相邻面板边界连续。
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

/** 差分脏矩形检测：判断位移或尺寸变化是否小于 epsilon 阈值。 */
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

/** 判定 DOMRect 是否在当前宿主视口内有效可见。 */
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

/** 向 Rust 原生子 Webview 内核同步几何坐标。 */
export async function sendNativeBrowserBounds(
  tabId: string,
  logical: LogicalRect,
  _physical?: PhysicalBounds,
  _visible?: boolean
): Promise<void> {
  try {
    await browserWebviewSetBounds(tabId, logical);
  } catch (error) {
    logger.warn('Native browser bounds synchronization failed', {
      module: 'nativeBrowserGeometry',
      err: { message: error instanceof Error ? error.message : String(error) },
      sessionId: tabId,
    });
    throw error;
  }
}

/** 向 Rust 原生子 Webview 内核同步显隐状态。 */
export async function sendNativeBrowserVisible(
  tabId: string,
  visible: boolean
): Promise<void> {
  try {
    await browserWebviewSetVisible(tabId, visible);
  } catch (error) {
    logger.warn('Native browser visibility synchronization failed', {
      module: 'nativeBrowserGeometry',
      err: { message: error instanceof Error ? error.message : String(error) },
      sessionId: tabId,
    });
    throw error;
  }
}

type MutableRef<T> = MutableRefObject<T>;

interface GeometrySyncCoordinator {
  tabId: string;
  currentTabIdRef: MutableRef<string>;
  generationRef: MutableRef<number>;
  isReadyRef: MutableRef<boolean>;
  desiredStateRef: MutableRef<GeometrySnapshot | null>;
  appliedStateRef: MutableRef<AppliedGeometryState | null>;
  syncQueueRef: MutableRef<Promise<void>>;
  queuedSyncKeysRef: MutableRef<Set<string>>;
}

interface GeometryCommitContext extends GeometrySyncCoordinator {
  surfaceRef: RefObject<HTMLDivElement | null>;
  isActive: boolean;
  isOccluded: boolean;
  onBoundsChange?: (bounds: PhysicalBounds) => void;
  revisionRef: MutableRef<number>;
}

function isCurrentGeometryGeneration(
  coordinator: GeometrySyncCoordinator,
  generation: number
): boolean {
  return (
    coordinator.generationRef.current === generation &&
    coordinator.currentTabIdRef.current === coordinator.tabId &&
    coordinator.isReadyRef.current
  );
}

export function enqueueGeometrySync(
  coordinator: GeometrySyncCoordinator,
  snapshot: GeometrySnapshot,
  forceBounds: boolean,
  generation: number
): void {
  const {
    tabId,
    desiredStateRef,
    appliedStateRef,
    syncQueueRef,
    queuedSyncKeysRef,
  } = coordinator;
  const key = `${generation}:${snapshot.revision}`;
  if (queuedSyncKeysRef.current.has(key)) return;
  queuedSyncKeysRef.current.add(key);

  const previous = syncQueueRef.current;
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const isCurrentSnapshot = () =>
        isCurrentGeometryGeneration(coordinator, generation) &&
        desiredStateRef.current?.revision === snapshot.revision;
      if (!isCurrentSnapshot()) return;

      let applied = appliedStateRef.current;
      if (snapshot.visible === false && applied?.visible !== false) {
        await sendNativeBrowserVisible(tabId, false);
        if (!isCurrentGeometryGeneration(coordinator, generation)) return;
        applied = { ...appliedStateRef.current, visible: false };
        appliedStateRef.current = applied;
      }

      const boundsDirty =
        forceBounds ||
        !applied?.logical ||
        !isSimilarBounds(applied.logical, snapshot.logical);
      if (boundsDirty) {
        await sendNativeBrowserBounds(
          tabId,
          snapshot.logical,
          snapshot.physical,
          snapshot.visible
        );
        if (!isCurrentGeometryGeneration(coordinator, generation)) return;
        appliedStateRef.current = {
          ...appliedStateRef.current,
          logical: snapshot.logical,
        };
      }

      if (!isCurrentSnapshot()) return;
      if (snapshot.visible && appliedStateRef.current?.visible !== true) {
        await sendNativeBrowserVisible(tabId, true);
        if (isCurrentGeometryGeneration(coordinator, generation)) {
          appliedStateRef.current = {
            ...appliedStateRef.current,
            visible: true,
          };
        }
      }
    })
    .catch(() => undefined)
    .finally(() => queuedSyncKeysRef.current.delete(key));
  syncQueueRef.current = next;
}

export function commitGeometrySnapshot(
  context: GeometryCommitContext,
  force: boolean,
  enqueueSync: (
    snapshot: GeometrySnapshot,
    forceBounds: boolean,
    generation: number
  ) => void
): void {
  const {
    surfaceRef,
    isReadyRef,
    isActive,
    isOccluded,
    desiredStateRef,
    appliedStateRef,
    revisionRef,
    generationRef,
    onBoundsChange,
  } = context;
  if (!isReadyRef.current) return;
  const el = surfaceRef.current;
  if (!el) return;

  const rect = el.getBoundingClientRect();
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const visible = Boolean(isActive) && !isOccluded && isRectInViewport(rect);
  const physical = computeSnappedPhysicalBounds(rect, dpr);
  const logical: LogicalRect = {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
  const previous = desiredStateRef.current;
  const desiredChanged =
    !previous ||
    previous.visible !== visible ||
    !isSimilarBounds(previous.logical, logical, BOUNDS_EPSILON);
  let desired = previous;
  if (force || desiredChanged) {
    desired = {
      logical,
      physical,
      visible,
      revision: ++revisionRef.current,
    };
    desiredStateRef.current = desired;
    onBoundsChange?.(physical);
  }

  if (!desired) return;
  const applied = appliedStateRef.current;
  const needsSync =
    force ||
    !applied?.logical ||
    !isSimilarBounds(applied.logical, desired.logical) ||
    applied.visible !== desired.visible;
  if (needsSync) enqueueSync(desired, force, generationRef.current);
}

export function resetGeometryStateForTabId(
  tabId: string,
  currentTabIdRef: MutableRef<string>,
  generationRef: MutableRef<number>,
  desiredStateRef: MutableRef<GeometrySnapshot | null>,
  appliedStateRef: MutableRef<AppliedGeometryState | null>,
  revisionRef: MutableRef<number>,
  syncQueueRef: MutableRef<Promise<void>>,
  queuedSyncKeysRef: MutableRef<Set<string>>
): void {
  if (currentTabIdRef.current === tabId) return;
  currentTabIdRef.current = tabId;
  generationRef.current += 1;
  desiredStateRef.current = null;
  appliedStateRef.current = null;
  revisionRef.current = 0;
  syncQueueRef.current = Promise.resolve();
  queuedSyncKeysRef.current.clear();
}
