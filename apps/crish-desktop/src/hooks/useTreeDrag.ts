/**
 * 二叉树拖拽控制器 — 统一管理 leaf / tab 拖拽生命周期。
 *
 * 职责：
 * 1. 监听全局 pointer 事件（pointermove / pointerup / pointercancel / escape）
 * 2. 在拖拽过程中调用 detectDropZone 计算落点，更新 activeDropZone
 * 3. 在 drop 时调用 store.commitDrop() 提交结构变更
 * 4. 维护拖拽 ghost 跟随指针的位置（供 BinaryTreeWorkspace 内联 ghost 渲染）
 *
 * 设计要点：
 * - 拖拽源由 startDragLeaf / startDragTab 显式启动，避免误触
 * - 拖拽阈值（DRAG_THRESHOLD_PX）用于区分点击与拖拽
 * - 拖拽过程中 pointer 事件挂在 window 上，避免被 leaf 元素拦截
 * - drop zone 检测使用时间节流（DROP_DETECT_INTERVAL_MS），避免高频更新
 * - leaf rects 在 enterActive 时一次性缓存：拖拽过程中 tree 不变，
 *   DOM rect 不会变化，无需每帧重新查询 DOM
 *
 * Ghost 位置更新（系统性优化）：
 * 旧实现用 React state (ghostPosition) 存位置，每帧 setGhostPosition 触发
 * re-render — 拖拽 60fps 下每秒 60 次 React reconciliation。
 * 现改用 ref + 直接 DOM style 更新：
 * - ghostPosRef 存逻辑位置（不触发 re-render）
 * - ghostRef 指向 ghost DOM 元素（由 BinaryTreeWorkspace 通过 setGhostRef 挂载）
 * - applyGhostPos 直接写 el.style.transform，跳过 React
 * - isDragging 仍为 state（仅拖拽起止时切换，2 次 re-render/手势）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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

// ── 常量 ────────────────────────────────────────────────────────────

/** 拖拽触发阈值（px）：移动超过此距离才认定为拖拽，避免误触 */
const DRAG_THRESHOLD_PX = 5;
/** 拖拽 ghost 偏移：让 ghost 略低于指针，避免遮挡指针 */
const GHOST_OFFSET_X = 16;
const GHOST_OFFSET_Y = 16;
/** drop zone 检测节流间隔（ms） */
const DROP_DETECT_INTERVAL_MS = 16; // ~1 frame

// ── 拖拽状态机 ──────────────────────────────────────────────────────

type DragPhase = 'idle' | 'pending' | 'active' | 'committed' | 'cancelled';

interface PendingDrag {
  /** 拖拽源（leaf 或 tab） */
  source: TreeDragSource;
  /** pointerdown 时的指针位置 */
  startX: number;
  startY: number;
  /** 触发拖拽的 pointer id（多指隔离，见 ActiveDrag.pointerId 注释） */
  pointerId: number;
}

interface ActiveDrag {
  source: TreeDragSource;
  /** 当前指针位置 */
  currentX: number;
  currentY: number;
  /**
   * 触发拖拽的 pointer id（系统性约束）。
   *
   * 桌面端触屏 / Trackpad 多指场景下，第二根手指的 pointerdown 会被
   * startDragLeaf 守卫（phaseRef !== 'idle'）拒绝，但其 pointermove 事件
   * 仍会到达 window 监听器。若不按 pointerId 过滤，第二指的移动会被
   * 误认为第一指的延续，导致 ghost 跳跃、drop zone 错位。
   *
   * 拖拽期间仅处理与启动时相同 pointerId 的事件，其它 pointer 一律忽略。
   */
  pointerId: number;
}

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
  // 拖拽阶段（ref 避免频繁 re-render）
  const phaseRef = useRef<DragPhase>('idle');
  const pendingRef = useRef<PendingDrag | null>(null);
  const activeRef = useRef<ActiveDrag | null>(null);
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

  // ── Ghost 位置：ref + 直接 DOM 更新（非 React state） ────────
  //
  // ghostPosRef 存逻辑位置，ghostRef 指向 DOM 元素。
  // applyGhostPos 把 posRef 写入 el.style.transform，跳过 React。
  // 拖拽期间 pointermove 仅触发 DOM 写入，不触发 re-render。
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const ghostPosRef = useRef<{ x: number; y: number } | null>(null);

  const applyGhostPos = useCallback(() => {
    const el = ghostRef.current;
    const pos = ghostPosRef.current;
    if (el && pos) {
      // translate 定位 + rotate 视觉倾斜（原 CSS 中的 rotate(1.5deg)）
      el.style.transform = `translate(${pos.x}px, ${pos.y}px) rotate(1.5deg)`;
    }
  }, []);

  // React 状态（仅用于触发 re-render — 拖拽起止时各 1 次）
  const [isDragging, setIsDragging] = useState(false);

  // store actions（稳定引用，无需 useEffect 依赖）
  const setDraggedSource = useLayoutTreeStore((s) => s.setDraggedSource);
  const setActiveDropZone = useLayoutTreeStore((s) => s.setActiveDropZone);
  const commitDrop = useLayoutTreeStore((s) => s.commitDrop);
  const cancelDragStore = useLayoutTreeStore((s) => s.cancelDrag);

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

  // ── 拖拽启动 ──────────────────────────────────────────────────

  const startDragLeaf = useCallback(
    (leafId: string, panelId: string, e: React.PointerEvent) => {
      if (e.button !== 0) return; // 仅左键
      // 已在拖拽中：忽略（含多指场景 — 第二指的 pointerdown 直接拒绝）
      if (phaseRef.current !== 'idle') return;

      const source: TreeDragSource = {
        type: 'leaf',
        leafId,
        tabId: leafId,
        panelId,
      };
      pendingRef.current = {
        source,
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
      };
      phaseRef.current = 'pending';
    },
    []
  );

  const startDragTab = useCallback(
    (leafId: string, tabId: string, panelId: string, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if (phaseRef.current !== 'idle') return;

      const source: TreeDragSource = {
        type: 'tab',
        leafId,
        tabId,
        panelId,
      };
      pendingRef.current = {
        source,
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
      };
      phaseRef.current = 'pending';
    },
    []
  );

  // ── 进入 active 阶段 ─────────────────────────────────────────

  const enterActive = useCallback(
    (clientX: number, clientY: number) => {
      const pending = pendingRef.current;
      if (!pending) return;
      const active: ActiveDrag = {
        source: pending.source,
        currentX: clientX,
        currentY: clientY,
        pointerId: pending.pointerId,
      };
      activeRef.current = active;
      pendingRef.current = null;
      phaseRef.current = 'active';
      // 一次性缓存 leaf rects — 拖拽期间 tree 不变，rect 稳定
      cachedLeafRectsRef.current = collectLeafRects();
      // 重置 zone 缓存：新手势的首次检测必触发 store 更新
      lastZoneRef.current = null;
      // 重置节流时间戳：确保 pending → active 过渡后的首帧 drop zone 检测
      // 不被上一手势遗留的时间戳短路（快速连击场景）
      lastDropDetectRef.current = 0;
      // 设置 ghost 逻辑位置 — DOM 元素由 setGhostRef 回调在挂载时应用
      ghostPosRef.current = {
        x: clientX + GHOST_OFFSET_X,
        y: clientY + GHOST_OFFSET_Y,
      };
      setIsDragging(true);
      setDraggedSource(active.source);
    },
    [collectLeafRects, setDraggedSource]
  );

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

  // ── 拖拽移动 ─────────────────────────────────────────────────

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const phase = phaseRef.current;
      if (phase === 'idle' || phase === 'committed' || phase === 'cancelled')
        return;

      // 多指隔离：仅处理与启动时相同 pointerId 的事件。
      // pending 阶段读 pendingRef.pointerId，active 阶段读 activeRef.pointerId。
      if (phase === 'pending') {
        const pending = pendingRef.current;
        if (!pending) return;
        if (e.pointerId !== pending.pointerId) return;

        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        enterActive(e.clientX, e.clientY);
        // 不 return — 落到 active 分支，让首帧立即检测 drop zone，
        // 避免超过阈值后的第一帧（~16ms）无反馈。
        // enterActive 已设置 activeRef.current + 重置 lastDropDetectRef=0，
        // 故下方节流不会跳过本次检测。
      } else {
        // active 阶段：检查 pointerId 一致
        const active = activeRef.current;
        if (!active) return;
        if (e.pointerId !== active.pointerId) return;
      }

      // active → 更新 ghost 位置 + 检测 drop zone
      const active = activeRef.current;
      if (!active) return;
      active.currentX = e.clientX;
      active.currentY = e.clientY;
      // 直接 DOM 更新 ghost 位置，跳过 React re-render
      ghostPosRef.current = {
        x: e.clientX + GHOST_OFFSET_X,
        y: e.clientY + GHOST_OFFSET_Y,
      };
      applyGhostPos();

      // 时间节流：drop zone 检测
      const now = performance.now();
      if (now - lastDropDetectRef.current < DROP_DETECT_INTERVAL_MS) return;
      lastDropDetectRef.current = now;

      // 使用缓存的 leaf rects，避免每帧 DOM 查询
      const leafRects = cachedLeafRectsRef.current;
      const hit = findLeafAtPointer({ x: e.clientX, y: e.clientY }, leafRects);
      if (!hit) {
        updateZone(null);
        return;
      }
      // 1. 跨域防护（Chat vs Tool 隔离）
      if (!isSameDomain(active.source.panelId, hit.panelId)) {
        updateZone(null);
        return;
      }
      // 1b. Conversation Unit 作用域：tool 不得跨 session 落点
      //     源 owner 从当前 tree 查（拖拽期间 tree 不变）
      {
        const tree = useLayoutTreeStore.getState().tree;
        const srcNode = findNodeById(tree.root, active.source.leafId);
        const srcOwner =
          srcNode && isLeaf(srcNode) ? srcNode.sessionId : undefined;
        if (
          !isUnitScopedDropAllowed(
            active.source.panelId,
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
      if (active.source.type === 'leaf' && hit.id === active.source.leafId) {
        updateZone(null);
        return;
      }
      // 3. tab 拖拽时：若同 leaf 且仅有 1 个 tab，无法在自身内切分，强制 merge-tab
      let zone = detectDropZone(
        { x: e.clientX, y: e.clientY },
        hit.rect,
        hit.id
      );
      if (
        active.source.type === 'tab' &&
        hit.id === active.source.leafId &&
        hit.tabCount <= 1
      ) {
        if (zone.type !== 'merge-tab') {
          zone = { type: 'merge-tab', targetLeafId: hit.id, confidence: 1 };
        }
      }
      updateZone(zone);
    },
    [enterActive, applyGhostPos, updateZone]
  );

  // ── 拖拽结束 ─────────────────────────────────────────────────

  const handlePointerUp = useCallback(
    (e: PointerEvent) => {
      const phase = phaseRef.current;
      if (phase === 'idle') return;

      // 多指隔离：仅处理启动拖拽的 pointer 的 up 事件。
      // 其它 pointer 的 up 不应结束拖拽（如双指场景中第二指抬起）。
      const expectedPointerId =
        pendingRef.current?.pointerId ?? activeRef.current?.pointerId;
      if (expectedPointerId !== undefined && e.pointerId !== expectedPointerId)
        return;

      // pending：未超过阈值，按 click 处理（不算拖拽）
      if (phase === 'pending') {
        pendingRef.current = null;
        phaseRef.current = 'idle';
        return;
      }

      // active：提交 drop
      if (phase === 'active') {
        phaseRef.current = 'committed';
        // commitDrop 已在 store 内清空 draggedSource + activeDropZone，
        // 此处无需再调用 setDraggedSource(null) — 否则触发冗余 store 更新。
        commitDrop();
      }

      // 清理本地状态（store 状态已由 commitDrop / cancelDrag 处理）
      activeRef.current = null;
      pendingRef.current = null;
      cachedLeafRectsRef.current = [];
      ghostPosRef.current = null;
      lastZoneRef.current = null;
      phaseRef.current = 'idle';
      setIsDragging(false);
    },
    [commitDrop]
  );

  // ── 拖拽取消（pointercancel / escape） ───────────────────────

  const handlePointerCancel = useCallback(() => {
    if (phaseRef.current === 'idle') return;
    phaseRef.current = 'cancelled';
    // cancelDragStore 已在 store 内清空 draggedSource + activeDropZone，
    // 此处无需再调用 setDraggedSource(null) — 否则触发冗余 store 更新。
    cancelDragStore();
    activeRef.current = null;
    pendingRef.current = null;
    cachedLeafRectsRef.current = [];
    ghostPosRef.current = null;
    lastZoneRef.current = null;
    phaseRef.current = 'idle';
    setIsDragging(false);
  }, [cancelDragStore]);

  const cancelDrag = useCallback(() => {
    handlePointerCancel();
  }, [handlePointerCancel]);

  // ── Ghost 元素回调 ref ───────────────────────────────────────
  //
  // 消费者把 setGhostRef 挂在 ghost DOM 节点上。
  // 元素挂载时（drag 开始 → isDragging=true → ghost 渲染），
  // 回调被调用，立即应用 ghostPosRef 中的位置，避免首帧闪现在 (0,0)。
  // 元素卸载时回调以 null 调用，清理引用。
  const setGhostRef = useCallback(
    (el: HTMLDivElement | null) => {
      ghostRef.current = el;
      if (el && ghostPosRef.current) {
        applyGhostPos();
      }
    },
    [applyGhostPos]
  );

  // ── 全局事件监听（常驻挂载，handler 内按 phase 守卫） ─────────
  //
  // 设计理由：原先尝试"仅在 pending/active 时挂载"，但 phaseRef.current
  // 的变更不会触发重渲染，导致 startDragLeaf 后 isPendingOrActive 仍为
  // false、effect 不重新挂载 listener，拖拽永远无法进入 active 阶段。
  // 改为常驻挂载 + handler 内 phaseRef 守卫，彻底消除时序依赖。
  //
  // 关注点拆分（系统性优化）：
  // 旧实现把"事件订阅"与"body class"混在同一 effect，依赖 [isDragging, ...handlers]。
  // isDragging 在每次手势起止各切换一次 → 触发 cleanup + 重新订阅事件，
  // 但 handlers 是 useCallback 稳定引用，重新订阅是无效开销。
  // 现拆为三个独立 effect：
  // 1. 事件订阅：依赖 handlers（理论上从不重挂载，因为 handlers 稳定）
  // 2. body class：依赖 isDragging（仅 class 切换，不动事件监听）
  // 3. viewport resize：依赖 isDragging（拖拽期间重收集 leaf rects）

  useEffect(() => {
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handlePointerCancel();
      }
    };
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [handlePointerMove, handlePointerUp, handlePointerCancel]);

  // body.tree-dragging 由 isDragging 状态驱动：
  // - enterActive 调用 setIsDragging(true) → 重渲染 → effect 添加 class
  // - handlePointerUp/Cancel 调用 setIsDragging(false) → 重渲染 → effect 移除 class
  // pending 阶段不添加 class（尚未超过阈值，不算真正拖拽）。
  useEffect(() => {
    if (isDragging) {
      document.body.classList.add('tree-dragging');
    } else {
      document.body.classList.remove('tree-dragging');
    }
    return () => document.body.classList.remove('tree-dragging');
  }, [isDragging]);

  // viewport resize 重收集 leaf rects（拖拽期间才需要）。
  //
  // 系统性约束：cachedLeafRectsRef 在 enterActive 时一次性收集，假设拖拽期间
  // tree 不变 → DOM rect 稳定。但窗口 resize 会改变 canvas 像素尺寸 → leaf
  // 屏幕坐标漂移 → 缓存失效。若不重收集，drop zone 检测会用过时坐标，
  // 拖拽体验在窗口缩放时错位。
  useEffect(() => {
    if (!isDragging) return;
    const handleResize = () => {
      cachedLeafRectsRef.current = collectLeafRects();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isDragging, collectLeafRects]);

  // 从 store 同步 activeDropZone（避免本地与 store 状态分叉）
  const activeDropZone = useLayoutTreeStore((s) => s.activeDropZone);
  const draggedSource = useLayoutTreeStore((s) => s.draggedSource);

  return {
    isDragging,
    draggedSource,
    setGhostRef,
    activeDropZone,
    startDragLeaf,
    startDragTab,
    cancelDrag,
  };
}
