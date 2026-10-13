/**
 * 二叉树 resize 控制器 — 处理 branch 分割线的拖拽调整 (Stage 06 Gated Resizing)。
 *
 * 核心机制：
 * 1. sash 挂在 branch 的两个 child 之间，方向由 branch.direction 决定
 * 2. 拖拽启动时通过 collectSubtreeLeafIds(root, branchId) 精准识别受物理形变影响的叶子集合
 * 3. 仅对受影响的叶子调用 ResizeObserverManager.suspendPanes(affectedLeafIds) 并标记 data-gated-resizing="true"，
 *    彻底拔除 document.body.classList.add('tree-resizing') 全局广播，100% 放行后台独立窗格推流与全局浮层
 * 4. 拖拽期间只写 CSS / DOM（--live-ratio-{branchId} + 叶子/sash 几何），零 Zustand Store 写入、零 React 重渲染
 * 5. pointerup 时一次性提交 store 并调用 resumePanes(affectedLeafIds) 启动 8ms 时间预算分片排空
 * 6. 联合 200ms WindowBlurWatchdog（监听 blur / pointercancel / lostpointercapture）实现异常中断快速自愈
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCompositionRoot } from '../app/compositionRoot';
import { findNodeById, isBranch } from '../store/layout-tree';
import {
  flattenTree,
  resizeBranch as resizeBranchTree,
} from '../store/layout-tree/operations';
import { collectSubtreeLeafIds } from '../store/layout-tree/topology';
import { clampSplitRatio } from '../store/layout-tree/types';
import { disableIframePointerEvents } from '../utils/dragOverlay';
import {
  ResizeObserverManager,
  WindowBlurWatchdog,
} from '../utils/ResizeObserverManager';
import { clampSplitRatioForParent, parentPxAlongAxis } from './treeResizeClamp';

// ── Hook 签名 ───────────────────────────────────────────────────────

/** branch rect 占比（0-1，相对 canvas）— 来自 flattenTree */
export interface BranchRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UseTreeResizeResult {
  /** 当前正在 resize 的 branch id（null 表示未在 resize） */
  resizingBranchId: string | null;
  /** 启动 resize（sash pointerdown 时调用，传入 branch.rect 占比） */
  startResize: (
    branchId: string,
    branchRect: BranchRect,
    e: React.PointerEvent
  ) => void;
  /** 取消 resize（不提交 store；恢复 store 几何） */
  cancelResize: () => void;
}

// ── 内部类型 ─────────────────────────────────────────────────────────

interface ResizeCtx {
  branchId: string;
  direction: 'horizontal' | 'vertical';
  /** 受本次分支拖拽物理形变影响的叶子节点 ID 集合 */
  affectedLeafIds: string[];
  /** branch 在屏幕上的像素 rect（启动时一次性计算） */
  pixelRect: { left: number; top: number; width: number; height: number };
  /** 手势开始时的 splitRatio（取消时无需写 store） */
  startRatio: number;
  /** 最近一次 rAF 应用的 ratio（pointerup 提交用） */
  lastRatio: number;
  /** 是否发生过实际移动（用于决定是否 commit） */
  didMove: boolean;
  pointerId: number;
  captureEl: HTMLElement;
  canvas: HTMLElement;
  liveCssVar: string;
  restoreIframes: () => void;
}

function escapeCssIdent(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}

// ── 纯 DOM 实时布局（不写 store） ────────────────────────────────────

function liveRatioVarName(branchId: string): string {
  return `--live-ratio-${branchId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/**
 * S4.3：live resize 期间缓存 leaf/sash DOM，避免每帧 N 次 querySelector。
 * 手势结束（commit / cancel）必须 clearLiveResizeDomCache。
 */
interface LiveResizeDomMap {
  leaves: Map<string, HTMLElement>;
  branches: Map<string, HTMLElement>;
}

let liveResizeDomMap: LiveResizeDomMap | null = null;

/** 单次扫描 canvas 下 data-leaf-id / data-branch-id（导出供测） */
export function collectLiveResizeDomMap(
  root: ParentNode = document
): LiveResizeDomMap {
  const leaves = new Map<string, HTMLElement>();
  const branches = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>('[data-leaf-id]').forEach((el) => {
    const id = el.getAttribute('data-leaf-id');
    if (id) leaves.set(id, el);
  });
  root.querySelectorAll<HTMLElement>('[data-branch-id]').forEach((el) => {
    const id = el.getAttribute('data-branch-id');
    if (id) branches.set(id, el);
  });
  return { leaves, branches };
}

function getLiveResizeDomMap(): LiveResizeDomMap {
  if (!liveResizeDomMap) liveResizeDomMap = collectLiveResizeDomMap();
  return liveResizeDomMap;
}

/** 手势结束时丢弃 DOM map（导出供测 / 兜底） */
export function clearLiveResizeDomCache(): void {
  liveResizeDomMap = null;
}

/** 将 flatten 结果写到 leaf / sash 的 inline style（不触发 React） */
function paintFlatLayout(
  leaves: ReturnType<typeof flattenTree>['leaves'],
  branches: ReturnType<typeof flattenTree>['branches'],
  domMap?: LiveResizeDomMap | null
): void {
  const map = domMap ?? getLiveResizeDomMap();

  for (const leaf of leaves) {
    let el = map.leaves.get(leaf.leafId);
    if (!el) {
      el =
        document.querySelector<HTMLElement>(
          `[data-leaf-id="${escapeCssIdent(leaf.leafId)}"]`
        ) ?? undefined;
      if (el) map.leaves.set(leaf.leafId, el);
    }
    if (!el) continue;
    const { rect } = leaf;
    el.style.top = `${rect.y * 100}%`;
    el.style.left = `${rect.x * 100}%`;
    el.style.width = `${rect.width * 100}%`;
    el.style.height = `${rect.height * 100}%`;
  }

  for (const branch of branches) {
    let el = map.branches.get(branch.branchId);
    if (!el) {
      el =
        document.querySelector<HTMLElement>(
          `[data-branch-id="${escapeCssIdent(branch.branchId)}"]`
        ) ?? undefined;
      if (el) map.branches.set(branch.branchId, el);
    }
    if (!el) continue;
    const { rect, splitRatio, direction } = branch;
    if (direction === 'horizontal') {
      el.style.left = `${(rect.x + rect.width * splitRatio) * 100}%`;
      el.style.top = `${rect.y * 100}%`;
      el.style.height = `${rect.height * 100}%`;
      el.style.width = '';
    } else {
      el.style.top = `${(rect.y + rect.height * splitRatio) * 100}%`;
      el.style.left = `${rect.x * 100}%`;
      el.style.width = `${rect.width * 100}%`;
      el.style.height = '';
    }
  }
}

function getActiveCollapsedDomain(): 'tool' | undefined {
  const root = getCompositionRoot();
  const tab = root.shell.getState().getActiveTab();
  const collapsed = tab?.dock
    ? tab.dock.collapsed
    : root.tree.getState().toolColumnCollapsed;
  return collapsed ? 'tool' : undefined;
}

/** 按给定 ratio 本地重算 flatten 结果，写入 leaf / sash 的 inline style */
function applyLiveLayout(branchId: string, ratio: number): void {
  const state = getCompositionRoot().tree.getState();
  const liveTree = resizeBranchTree(state.tree, branchId, ratio);
  const flat = flattenTree(liveTree.root, {
    collapsedDomain: getActiveCollapsedDomain(),
  });
  paintFlatLayout(flat.leaves, flat.branches);
}

/** 用当前 store 树几何覆盖 DOM（取消手势时恢复，无 React re-render） */
function restoreLayoutFromStore(): void {
  const state = getCompositionRoot().tree.getState();
  const flat = flattenTree(state.tree.root, {
    collapsedDomain: getActiveCollapsedDomain(),
  });
  paintFlatLayout(flat.leaves, flat.branches);
}

function clearLiveCssVar(ctx: ResizeCtx): void {
  ctx.canvas.style.removeProperty(ctx.liveCssVar);
  ctx.canvas.removeAttribute('data-live-resize-branch');
}

// ── Hook 实现 ───────────────────────────────────────────────────────

export function useTreeResize(): UseTreeResizeResult {
  const [resizingBranchId, setResizingBranchId] = useState<string | null>(null);

  const resizeCtxRef = useRef<ResizeCtx | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<PointerEvent | null>(null);

  // ── 启动 resize (Gated Resizing) ─────────────────────────────

  const startResize = useCallback(
    (branchId: string, branchRect: BranchRect, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const state = getCompositionRoot().tree.getState();
      const node = findNodeById(state.tree.root, branchId);
      if (!node || !isBranch(node)) return;

      const canvas = document.querySelector<HTMLElement>(
        '[data-tree-canvas="true"]'
      );
      if (!canvas) return;
      const canvasRect = canvas.getBoundingClientRect();
      const pixelRect = {
        left: canvasRect.left + branchRect.x * canvasRect.width,
        top: canvasRect.top + branchRect.y * canvasRect.height,
        width: branchRect.width * canvasRect.width,
        height: branchRect.height * canvasRect.height,
      };

      const captureEl = e.currentTarget as HTMLElement;
      try {
        captureEl.setPointerCapture(e.pointerId);
      } catch {
        /* ignore — 部分环境 / 非 primary 指针可能失败 */
      }

      // 1. 拓扑分析：精准锁定受本次分屏拖拽形变影响的叶子节点 ID 集合
      const affectedLeafIds = collectSubtreeLeafIds(state.tree.root, branchId);

      // 2. 细粒度窗格级挂起：仅挂起受影响叶子，放行后台推流窗格与全局浮层
      ResizeObserverManager.getInstance().suspendPanes(affectedLeafIds);

      const restoreIframes = disableIframePointerEvents();
      const liveCssVar = liveRatioVarName(branchId);
      const startRatio = clampSplitRatio(node.splitRatio);

      resizeCtxRef.current = {
        branchId,
        direction: node.direction,
        affectedLeafIds,
        pixelRect,
        startRatio,
        lastRatio: startRatio,
        didMove: false,
        pointerId: e.pointerId,
        captureEl,
        canvas,
        liveCssVar,
        restoreIframes,
      };

      // 3. 标记局部 Canvas 属性与受影响 Leaf 的 data-gated-resizing 属性
      canvas.setAttribute('data-live-resize-branch', branchId);
      canvas.style.setProperty(liveCssVar, String(startRatio));

      liveResizeDomMap = collectLiveResizeDomMap();
      for (const leafId of affectedLeafIds) {
        const leafEl =
          liveResizeDomMap.leaves.get(leafId) ??
          canvas.querySelector<HTMLElement>(
            `[data-leaf-id="${escapeCssIdent(leafId)}"]`
          );
        leafEl?.setAttribute('data-gated-resizing', 'true');
      }

      // 4. 绝不向 document.body 广播 tree-resizing 全局冻结类名，仅设置交互光标
      document.body.style.cursor =
        node.direction === 'horizontal' ? 'col-resize' : 'row-resize';
      setResizingBranchId(branchId);
    },
    []
  );

  // ── 计算 ratio（像素感知 min child + store 绝对上下限） ─────

  const ratioFromEvent = useCallback(
    (e: PointerEvent, ctx: ResizeCtx): number => {
      const parentPx = parentPxAlongAxis(ctx.pixelRect, ctx.direction);
      const raw =
        ctx.direction === 'horizontal'
          ? (e.clientX - ctx.pixelRect.left) / parentPx
          : (e.clientY - ctx.pixelRect.top) / parentPx;
      return clampSplitRatioForParent(raw, parentPx);
    },
    []
  );

  // ── 拖拽移动（rAF 节流；只写 CSS/DOM） ───────────────────────

  const applyMoveFrame = useCallback(() => {
    rafIdRef.current = null;
    const e = pendingPointerRef.current;
    pendingPointerRef.current = null;
    const ctx = resizeCtxRef.current;
    if (!e || !ctx) return;

    const ratio = ratioFromEvent(e, ctx);
    if (ratio === ctx.lastRatio && ctx.didMove) return;

    ctx.didMove = true;
    ctx.lastRatio = ratio;

    ctx.canvas.style.setProperty(ctx.liveCssVar, String(ratio));
    applyLiveLayout(ctx.branchId, ratio);
  }, [ratioFromEvent]);

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!resizeCtxRef.current) return;
      pendingPointerRef.current = e;
      if (rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(applyMoveFrame);
    },
    [applyMoveFrame]
  );

  // ── 结束 / 取消 ──────────────────────────────────────────────

  const cleanupGesture = useCallback((ctx: ResizeCtx) => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    pendingPointerRef.current = null;

    try {
      if (ctx.captureEl.hasPointerCapture?.(ctx.pointerId)) {
        ctx.captureEl.releasePointerCapture(ctx.pointerId);
      }
    } catch {
      /* ignore */
    }

    clearLiveCssVar(ctx);

    // 移除受影响 Leaf 上的 data-gated-resizing 局部属性
    for (const leafId of ctx.affectedLeafIds) {
      const leafEl =
        liveResizeDomMap?.leaves.get(leafId) ??
        ctx.canvas.querySelector<HTMLElement>(
          `[data-leaf-id="${escapeCssIdent(leafId)}"]`
        ) ??
        document.querySelector<HTMLElement>(
          `[data-leaf-id="${escapeCssIdent(leafId)}"]`
        );
      leafEl?.removeAttribute('data-gated-resizing');
    }

    // 解冻受影响窗格并启动 8ms 时间预算分片排空循环
    ResizeObserverManager.getInstance().resumePanes(ctx.affectedLeafIds);

    try {
      ctx.restoreIframes();
    } catch {
      /* ignore */
    }

    clearLiveResizeDomCache();

    document.body.style.cursor = '';
    resizeCtxRef.current = null;
    setResizingBranchId(null);
  }, []);

  const endResize = useCallback(() => {
    const ctx = resizeCtxRef.current;
    if (!ctx) return;

    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    const pendingMove = pendingPointerRef.current;
    pendingPointerRef.current = null;
    if (pendingMove) {
      ctx.lastRatio = ratioFromEvent(pendingMove, ctx);
      ctx.didMove = true;
    }

    const { branchId, lastRatio, didMove, startRatio } = ctx;

    if (didMove && lastRatio !== startRatio) {
      applyLiveLayout(branchId, lastRatio);
      ctx.canvas.style.setProperty(ctx.liveCssVar, String(lastRatio));
      const store = getCompositionRoot().tree.getState();
      store.pushHistory();
      store.resizeBranch(branchId, lastRatio, false);
    } else if (didMove) {
      restoreLayoutFromStore();
    }

    cleanupGesture(ctx);
  }, [cleanupGesture, ratioFromEvent]);

  const cancelResize = useCallback(() => {
    const ctx = resizeCtxRef.current;
    if (!ctx) return;
    restoreLayoutFromStore();
    cleanupGesture(ctx);
  }, [cleanupGesture]);

  // ── 全局事件监听与 200ms Windows 异常中断看门狗 ──────────────

  useEffect(() => {
    if (!resizingBranchId) return;

    const mgr = ResizeObserverManager.getInstance();
    const captureEl = resizeCtxRef.current?.captureEl;

    const handleInterrupt = () => {
      if (resizeCtxRef.current) {
        mgr.armWatchdog(WindowBlurWatchdog.DEFAULT_TIMEOUT_MS);
      }
    };

    const unsubWatchdog = mgr.onWatchdogRecover(() => {
      if (resizeCtxRef.current) {
        endResize();
      }
    });

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('blur', handleInterrupt);
    window.addEventListener('pointercancel', handleInterrupt);
    captureEl?.addEventListener('lostpointercapture', handleInterrupt);

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelResize();
      }
    };
    window.addEventListener('keydown', handleEscape);

    return () => {
      unsubWatchdog();
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', endResize);
      window.removeEventListener('blur', handleInterrupt);
      window.removeEventListener('pointercancel', handleInterrupt);
      captureEl?.removeEventListener('lostpointercapture', handleInterrupt);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [resizingBranchId, handlePointerMove, endResize, cancelResize]);

  // 组件卸载保底清理：防止拖拽中途卸载遗留挂起窗格
  useEffect(() => {
    return () => {
      if (resizeCtxRef.current) {
        cleanupGesture(resizeCtxRef.current);
      }
    };
  }, [cleanupGesture]);

  return useMemo(
    () => ({
      resizingBranchId,
      startResize,
      cancelResize,
    }),
    [resizingBranchId, startResize, cancelResize]
  );
}
