/**
 * 二叉树 resize 控制器 — 处理 branch 分割线的拖拽调整。
 *
 * 与列/组 resize 不同，二叉树的 resize 针对单个 branch：
 * 拖动 sash 时，根据指针位移计算新的 splitRatio。
 *
 * 要点：
 * 1. sash 挂在 branch 的两个 child 之间，方向由 branch.direction 决定
 * 2. horizontal branch：sash 沿 X 轴移动，调整左右 child 宽度比
 * 3. vertical branch：sash 沿 Y 轴移动，调整上下 child 高度比
 * 4. 拖拽期间只写 CSS / DOM（`--live-ratio-{branchId}` + 叶子/sash 几何），
 *    不调用 store.resizeBranch，避免全树 re-render
 * 5. pointerup 时 pushHistory + 一次性 resizeBranch(commit=false)；
 *    单击无位移不入历史；Escape 取消不写 store
 * 6. setPointerCapture + disableIframePointerEvents，指针离开窗口仍可干净结束
 *
 * branchRect 来源（系统性修复）：
 * 旧实现查询 `[data-branch-id]` DOM 元素作为 container rect — 但该元素是
 * 6px 宽的 sash 本身，而非 branch 容器，导致 ratio 计算完全错误。
 * 现由 TreeResizeSash 传入 flattenTree 计算的 branch.rect（0-1 占比），
 * 启动时一次性换算为像素坐标（canvas DOM rect × branch.rect），
 * 拖拽期间不再查询 DOM 量测 container。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCompositionRoot } from '../app/compositionRoot';
import { findNodeById, isBranch } from '../store/layout-tree';
import {
  flattenTree,
  resizeBranch as resizeBranchTree,
} from '../store/layout-tree/operations';
import { clampSplitRatio } from '../store/layout-tree/types';
import { disableIframePointerEvents } from '../utils/dragOverlay';
import {
  clampSplitRatioForParent,
  parentPxAlongAxis,
} from './treeResizeClamp';

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

// ── 纯 DOM 实时布局（不写 store） ────────────────────────────────────

function liveRatioVarName(branchId: string): string {
  // CSS 自定义属性名：id 仅含 [a-z0-9-] 时安全；否则做简单转义
  const safe = branchId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `--live-ratio-${safe}`;
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
  if (!liveResizeDomMap) {
    liveResizeDomMap = collectLiveResizeDomMap();
  }
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
      // 缓存未命中时回退查询并补入 map（极少数 id 晚挂载）
      el =
        document.querySelector<HTMLElement>(
          `[data-leaf-id="${CSS.escape(leaf.leafId)}"]`
        ) ?? undefined;
      if (el) map.leaves.set(leaf.leafId, el);
    }
    if (!el) continue;
    const { rect } = leaf;
    // 两侧 leaf 同步写几何，保证 chat|tool 分屏时右侧面板跟手
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
          `[data-branch-id="${CSS.escape(branch.branchId)}"]`
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

/** 按给定 ratio 本地重算 flatten 结果，写入 leaf / sash 的 inline style */
function applyLiveLayout(branchId: string, ratio: number): void {
  const state = getCompositionRoot().tree.getState();
  const liveTree = resizeBranchTree(state.tree, branchId, ratio);
  const flat = flattenTree(liveTree.root, {
    collapsedDomain: state.toolColumnCollapsed ? 'tool' : undefined,
  });
  paintFlatLayout(flat.leaves, flat.branches);
}

/** 用当前 store 树几何覆盖 DOM（取消手势时恢复，无 React re-render） */
function restoreLayoutFromStore(): void {
  const state = getCompositionRoot().tree.getState();
  const flat = flattenTree(state.tree.root, {
    collapsedDomain: state.toolColumnCollapsed ? 'tool' : undefined,
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

  // 拖拽上下文（ref 避免频繁 re-render）
  const resizeCtxRef = useRef<ResizeCtx | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<PointerEvent | null>(null);

  // 动作引用稳定；勿在 render 路径订阅 tree / past（避免 sash 父级无谓 re-render）
  // endResize 内用 getState() 取最新 action，deps 不必绑 store selector

  // ── 启动 resize ──────────────────────────────────────────────

  const startResize = useCallback(
    (branchId: string, branchRect: BranchRect, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      // 从 compositionRoot.tree 读取 branch 信息（命令式；不订阅）
      const state = getCompositionRoot().tree.getState();
      const node = findNodeById(state.tree.root, branchId);
      if (!node || !isBranch(node)) return;

      // 将 branch.rect（0-1 占比）转换为屏幕像素坐标
      // 需要查询 canvas DOM 一次（启动时，非拖拽中）
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

      const restoreIframes = disableIframePointerEvents();
      const liveCssVar = liveRatioVarName(branchId);
      const startRatio = clampSplitRatio(node.splitRatio);

      resizeCtxRef.current = {
        branchId,
        direction: node.direction,
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

      canvas.setAttribute('data-live-resize-branch', branchId);
      canvas.style.setProperty(liveCssVar, String(startRatio));

      // S4.3：手势开始预热 leaf/sash DOM map，pointermove 热路径只查 Map
      liveResizeDomMap = collectLiveResizeDomMap();

      setResizingBranchId(branchId);
      document.body.classList.add('tree-resizing');
      document.body.style.cursor =
        node.direction === 'horizontal' ? 'col-resize' : 'row-resize';
    },
    []
  );

  // ── 计算 ratio（像素感知 min child + store 绝对上下限） ─────

  const ratioFromEvent = useCallback((e: PointerEvent, ctx: ResizeCtx): number => {
    const parentPx = parentPxAlongAxis(ctx.pixelRect, ctx.direction);
    const raw =
      ctx.direction === 'horizontal'
        ? (e.clientX - ctx.pixelRect.left) / parentPx
        : (e.clientY - ctx.pixelRect.top) / parentPx;
    return clampSplitRatioForParent(raw, parentPx);
  }, []);

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

    // 1) canvas CSS 变量 — 布局可读取；当前由 hook 直接刷 DOM 消费
    ctx.canvas.style.setProperty(ctx.liveCssVar, String(ratio));
    // 2) 叶子 + sash 几何（不写 store）— 两侧 leaf 同帧更新
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
    try {
      ctx.restoreIframes();
    } catch {
      /* ignore */
    }

    // S4.3：手势结束丢弃 DOM map，下一轮 resize 重新扫描
    clearLiveResizeDomCache();

    document.body.classList.remove('tree-resizing');
    document.body.style.cursor = '';
    resizeCtxRef.current = null;
    setResizingBranchId(null);
  }, []);

  const endResize = useCallback(() => {
    const ctx = resizeCtxRef.current;
    if (!ctx) return;

    // 吞掉尚未绘制的 pointermove（rAF 可能尚未跑）
    // 只用 move 事件更新 ratio — 不用 pointerup 坐标，避免单击 sash
    // 时因 6px 热区中心偏移把 startRatio 误当成变化并 commit。
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

    // 提交：有 move 且 ratio 相对起点有变化时写一次 store
    // 历史在 commit 前推入（store 仍是 pre-resize）
    if (didMove && lastRatio !== startRatio) {
      // 确保最终帧已刷到 DOM（pending move 可能跳过了 rAF）
      applyLiveLayout(branchId, lastRatio);
      ctx.canvas.style.setProperty(ctx.liveCssVar, String(lastRatio));
      const store = getCompositionRoot().tree.getState();
      store.pushHistory();
      store.resizeBranch(branchId, lastRatio, false);
      // store 更新后 React 会用新 rect 刷 style；DOM 已是 final ratio，无闪烁
    } else if (didMove) {
      // 移回起点：恢复 store 几何（store 未改，需手动还原 live DOM）
      restoreLayoutFromStore();
    }
    // 单击无移动：无历史、无 store 写

    cleanupGesture(ctx);
  }, [cleanupGesture, ratioFromEvent]);

  const cancelResize = useCallback(() => {
    const ctx = resizeCtxRef.current;
    if (!ctx) return;
    // 取消：不写 store，把 live DOM 还原为 store 几何
    restoreLayoutFromStore();
    cleanupGesture(ctx);
  }, [cleanupGesture]);

  // ── 全局事件监听（仅在 resize 中挂载） ───────────────────────

  useEffect(() => {
    if (!resizingBranchId) return;

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelResize();
      }
    };
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', endResize);
      window.removeEventListener('pointercancel', endResize);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [resizingBranchId, handlePointerMove, endResize, cancelResize]);

  // 稳定返回对象：避免父级把 controller 当 prop 时默认 React.memo 每次失效
  // （TreeResizeSash 已改为收 startResize + isResizing，此处仍保持 API 稳定）
  return useMemo(
    () => ({
      resizingBranchId,
      startResize,
      cancelResize,
    }),
    [resizingBranchId, startResize, cancelResize]
  );
}
