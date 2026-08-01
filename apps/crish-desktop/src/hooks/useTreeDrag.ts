/**
 * 二叉树拖拽控制器 — 统一管理 leaf / tab 拖拽生命周期。
 *
 * 职责：
 * 1. 监听全局 pointer 事件（pointermove / pointerup / pointercancel / escape）
 * 2. 在拖拽过程中调用 detectDropZone 计算落点，更新 activeDropZone
 * 3. 在 drop 时调用 store.commitDrop() 提交结构变更
 * 4. 维护拖拽 ghost 跟随指针的位置（供 BinaryTreeWorkspace 内联 ghost 渲染）
 *
 * 手势机制（阈值 / phase 状态机 / pointerId 隔离 / ghost 跟随 / 监听注册 /
 * body class）统一收敛到 `usePointerDragBase`（PE-06 T06.8 组 3），
 * 本 hook 只保留 drop 语义差异层：leaf rect 缓存 + drop zone 检测 + store 提交。
 *
 * 设计要点：
 * - 拖拽源由 startDragLeaf / startDragTab 显式启动，避免误触
 * - leaf rects 在 enterActive 时一次性缓存：拖拽过程中 tree 不变，
 *   DOM rect 不会变化，无需每帧重新查询 DOM
 * - ghost 位置更新经 ref + 直接 DOM style（跳过 React），仅拖拽起止触发 re-render
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  useLayoutTreeStore,
  type TreeDragSource,
  isSameDomain,
  isLeaf,
  findNodeById,
} from '../store/layout-tree';
import {
  detectDropZone,
  findLeafAtPointer,
  rectFromDOM,
  isZoneSame,
  isUnitScopedDropAllowed,
  type DropZone,
  type Rect,
} from '../store/layout-tree';
import {
  usePointerDragBase,
  DROP_DETECT_INTERVAL_MS,
} from './usePointerDragBase';

// ── Hook 签名 ───────────────────────────────────────────────────────

export interface UseTreeDragResult {
  /** 当前是否处于拖拽中 */
  isDragging: boolean;
  /** 拖拽源（拖拽中时非 null） */
  draggedSource: TreeDragSource | null;
  /**
   * Ghost 元素回调 ref — 由消费者挂在 ghost DOM 节点上。
   * 元素挂载时自动应用当前位置（避免首帧闪现在 0,0）。
   */
  setGhostRef: (el: HTMLDivElement | null) => void;
  /** 当前 drop zone（拖拽预览） */
  activeDropZone: DropZone | null;
  /** 启动 leaf 拖拽（pointerdown 时调用） */
  startDragLeaf: (
    leafId: string,
    panelId: string,
    e: React.PointerEvent
  ) => void;
  /** 启动 tab 拖拽（pointerdown 时调用） */
  startDragTab: (
    leafId: string,
    tabId: string,
    panelId: string,
    e: React.PointerEvent
  ) => void;
  /** 取消拖拽 */
  cancelDrag: () => void;
}

// ── Hook 实现 ───────────────────────────────────────────────────────

export function useTreeDrag(): UseTreeDragResult {
  const setDraggedSource = useLayoutTreeStore((s) => s.setDraggedSource);
  const setActiveDropZone = useLayoutTreeStore((s) => s.setActiveDropZone);
  const commitDrop = useLayoutTreeStore((s) => s.commitDrop);
  const cancelDragStore = useLayoutTreeStore((s) => s.cancelDrag);

  const lastDropDetectRef = useRef(0);
  /**
   * leaf rect 缓存：在 enterActive 时一次性收集。
   * 拖拽过程中 tree 不会变更（commitDrop 仅在 pointerUp 时调用），
   * 故 DOM rect 保持稳定，无需每帧重新查询。
   * 缓存在 handlePointerUp/Cancel 时清空。
   *
   * viewport 变化（window resize）例外：leaf 屏幕坐标随 canvas 尺寸变化，
   * 拖拽期间若窗口 resize，缓存失效。由专门的 resize effect 重新收集。
   */
  const cachedLeafRectsRef = useRef<
    Array<{
      id: string;
      panelId: string;
      tabCount: number;
      /** leaf.sessionId（tool = ownerSessionId；chat = 绑定会话） */
      sessionId?: string;
      rect: Rect;
    }>
  >([]);

  /**
   * 上次检测到的 drop zone（语义缓存，避免无效 store 更新）。
   *
   * pointermove 每 16ms 触发一次 detectDropZone，返回新对象引用。
   * 若直接调用 setActiveDropZone，即使 zone 语义不变也会触发 store set
   * → 订阅组件（DropZoneOverlay）re-render + DOM getBoundingClientRect。
   * 用 lastZoneRef 做浅相等短路，仅在 zone 真正变化时才推 store。
   */
  const lastZoneRef = useRef<DropZone | null>(null);

  // ── 收集所有 leaf 的 rect（仅 enterActive 时调用一次） ────────

  const collectLeafRects = useCallback((): Array<{
    id: string;
    panelId: string;
    tabCount: number;
    sessionId?: string;
    rect: Rect;
  }> => {
    const container = document.querySelector(
      '[data-tree-canvas="true"]'
    ) as HTMLElement | null;
    if (!container) return [];
    const leafEls = container.querySelectorAll<HTMLElement>('[data-leaf-id]');
    const result: Array<{
      id: string;
      panelId: string;
      tabCount: number;
      sessionId?: string;
      rect: Rect;
    }> = [];
    leafEls.forEach((el) => {
      const id = el.dataset.leafId;
      const panelId = el.dataset.panelId || 'chat';
      const tabCount = parseInt(el.dataset.tabCount || '1', 10);
      const sessionId = el.dataset.sessionId || undefined;
      if (!id) return;
      const rect = rectFromDOM(el.getBoundingClientRect());
      result.push({
        id,
        panelId,
        tabCount,
        ...(sessionId ? { sessionId } : {}),
        rect,
      });
    });
    return result;
  }, []);

  // ── DropZone 更新（带浅相等短路） ────────────────────────────
  //
  // 包装 setActiveDropZone：仅当 zone 语义变化（type + targetLeafId）
  // 才推 store。避免 pointermove 期间因 confidence 浮动或新对象引用
  // 触发无效 store set → 订阅组件 re-render。
  const updateZone = useCallback(
    (zone: DropZone | null) => {
      if (isZoneSame(lastZoneRef.current, zone)) return;
      lastZoneRef.current = zone;
      setActiveDropZone(zone);
    },
    [setActiveDropZone]
  );

  // ── 手势基座（阈值 / phase / pointerId 隔离 / ghost / 监听） ──

  const base = usePointerDragBase<TreeDragSource>({
    bodyClass: 'tree-dragging',
    onDragStart: (source) => {
      // 一次性缓存 leaf rects — 拖拽期间 tree 不变，rect 稳定
      cachedLeafRectsRef.current = collectLeafRects();
      // 重置 zone 缓存：新手势的首次检测必触发 store 更新
      lastZoneRef.current = null;
      // 重置节流时间戳：确保 pending → active 过渡后的首帧 drop zone 检测
      // 不被上一手势遗留的时间戳短路（快速连击场景）
      lastDropDetectRef.current = 0;
      setDraggedSource(source);
    },
    onDragMove: (source, clientX, clientY) => {
      // 时间节流：drop zone 检测
      const now = performance.now();
      if (now - lastDropDetectRef.current < DROP_DETECT_INTERVAL_MS) return;
      lastDropDetectRef.current = now;

      // 使用缓存的 leaf rects，避免每帧 DOM 查询
      const leafRects = cachedLeafRectsRef.current;
      const hit = findLeafAtPointer({ x: clientX, y: clientY }, leafRects);
      if (!hit) {
        updateZone(null);
        return;
      }
      // 1. 跨域防护（Chat vs Tool 隔离）
      if (!isSameDomain(source.panelId, hit.panelId)) {
        updateZone(null);
        return;
      }
      // 1b. Conversation Unit 作用域：tool 不得跨 session 落点
      //     源 owner 从当前 tree 查（拖拽期间 tree 不变）
      {
        const tree = useLayoutTreeStore.getState().tree;
        const srcNode = findNodeById(tree.root, source.leafId);
        const srcOwner =
          srcNode && isLeaf(srcNode) ? srcNode.sessionId : undefined;
        if (
          !isUnitScopedDropAllowed(
            source.panelId,
            srcOwner,
            hit.panelId,
            hit.sessionId
          )
        ) {
          updateZone(null);
          return;
        }
      }
      // 2. 不允许 drop 到自身（leaf 拖拽时）
      if (source.type === 'leaf' && hit.id === source.leafId) {
        updateZone(null);
        return;
      }
      // 3. tab 拖拽时：若同 leaf 且仅有 1 个 tab，无法在自身内切分，强制 merge-tab
      let zone = detectDropZone(
        { x: clientX, y: clientY },
        hit.rect,
        hit.id
      );
      if (
        source.type === 'tab' &&
        hit.id === source.leafId &&
        hit.tabCount <= 1
      ) {
        if (zone.type !== 'merge-tab') {
          zone = { type: 'merge-tab', targetLeafId: hit.id, confidence: 1 };
        }
      }
      updateZone(zone);
    },
    onDrop: () => {
      // commitDrop 已在 store 内清空 draggedSource + activeDropZone，
      // 此处无需再调用 setDraggedSource(null) — 否则触发冗余 store 更新。
      commitDrop();
    },
    onCancel: () => {
      // cancelDragStore 已在 store 内清空 draggedSource + activeDropZone。
      cancelDragStore();
    },
    onGestureEnd: () => {
      cachedLeafRectsRef.current = [];
      lastZoneRef.current = null;
    },
  });

  // ── 拖拽启动 ──────────────────────────────────────────────────

  const startDragLeaf = useCallback(
    (leafId: string, panelId: string, e: React.PointerEvent) => {
      const source: TreeDragSource = {
        type: 'leaf',
        leafId,
        tabId: leafId,
        panelId,
      };
      base.start(source, e);
    },
    [base]
  );

  const startDragTab = useCallback(
    (leafId: string, tabId: string, panelId: string, e: React.PointerEvent) => {
      const source: TreeDragSource = {
        type: 'tab',
        leafId,
        tabId,
        panelId,
      };
      base.start(source, e);
    },
    [base]
  );

  // viewport resize 重收集 leaf rects（拖拽期间才需要）。
  //
  // 系统性约束：cachedLeafRectsRef 在 enterActive 时一次性收集，假设拖拽期间
  // tree 不变 → DOM rect 稳定。但窗口 resize 会改变 canvas 像素尺寸 → leaf
  // 屏幕坐标漂移 → 缓存失效。若不重收集，drop zone 检测会用过时坐标，
  // 拖拽体验在窗口缩放时错位。
  useEffect(() => {
    if (!base.isDragging) return;
    const handleResize = () => {
      cachedLeafRectsRef.current = collectLeafRects();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [base.isDragging, collectLeafRects]);

  // 从 store 同步 activeDropZone（避免本地与 store 状态分叉）
  const activeDropZone = useLayoutTreeStore((s) => s.activeDropZone);
  const draggedSource = useLayoutTreeStore((s) => s.draggedSource);

  return {
    isDragging: base.isDragging,
    draggedSource,
    setGhostRef: base.setGhostRef,
    activeDropZone,
    startDragLeaf,
    startDragTab,
    cancelDrag: base.cancel,
  };
}
