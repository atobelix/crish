/**
 * useTopBarDrag 纯规划层：会话落点决策 + 画布 leaf 收集/命中。
 * 保证 1 session ↔ 0..1 chat leaf；从 useTopBarDrag.ts 抽出，可单测。
 */
import {
  findLeafAtPointer,
  findNodeById,
  findChatLeafBySessionId,
  findUnitRootId,
  isChatDomain,
  rectFromDOM,
  type DropZone,
} from '../../store/storeAccess';
import { findParent } from '../../store/storeAccess';
import type { DropDirection, LayoutNode } from '../../store/types';
import { TOP_BAR_GHOST_CLASS } from './topBarDragConst';
import type { LeafRectItem } from './topBarDragTypes';

/** 延迟加载，避免与 adapterShape 在 HMR 时形成循环依赖导致缺导出崩溃 */
export function reprojectAllSessionDocksSafe(): void {
  void import('../../store/storeAccess')
    .then((m) => {
      if (typeof m.reprojectAllSessionDocks === 'function') {
        m.reprojectAllSessionDocks();
      }
    })
    .catch(() => {
      /* ignore */
    });
}

/** 收集画布 leaf rects（拖拽开始时一次性快照） */
export function collectLeafRects(): LeafRectItem[] {
  const container = document.querySelector(
    '[data-tree-canvas="true"]'
  ) as HTMLElement | null;
  if (!container) return [];
  const leafEls = container.querySelectorAll<HTMLElement>('[data-leaf-id]');
  const result: LeafRectItem[] = [];
  leafEls.forEach((el) => {
    const id = el.dataset.leafId;
    const panelId = el.dataset.panelId || 'chat';
    const tabCount = parseInt(el.dataset.tabCount || '1', 10);
    if (!id) return;
    result.push({
      id,
      panelId,
      tabCount,
      rect: rectFromDOM(el.getBoundingClientRect()),
    });
  });
  return result;
}

/** 找到指针下方的会话标签元素（忽略 ghost / overlay 等 pointer-events 干扰） */
export function findSessionTabAt(pointer: {
  x: number;
  y: number;
}): HTMLElement | null {
  // 临时隐藏 ghost 避免命中测试干扰
  const ghosts = document.querySelectorAll<HTMLElement>(
    `.${TOP_BAR_GHOST_CLASS}`
  );
  ghosts.forEach((g) => (g.style.pointerEvents = 'none'));

  // elementsFromPoint：即便有半透明层覆盖，也能找到 session tab
  const stack =
    typeof document.elementsFromPoint === 'function'
      ? (document.elementsFromPoint(pointer.x, pointer.y) as Element[])
      : ([document.elementFromPoint(pointer.x, pointer.y)].filter(
          Boolean
        ) as Element[]);

  ghosts.forEach((g) => (g.style.pointerEvents = ''));

  for (const node of stack) {
    if (!(node instanceof HTMLElement)) continue;
    // 跳过 ghost / drop overlay
    if (
      node.classList.contains(TOP_BAR_GHOST_CLASS) ||
      node.closest(`.${TOP_BAR_GHOST_CLASS}`)
    ) {
      continue;
    }
    const tab = node.closest<HTMLElement>('[data-topbar-session-id]');
    if (tab) return tab;
  }
  return null;
}

/** 找到指针下方的第一个 chat leaf */
export function findChatLeafAt(
  pointer: { x: number; y: number },
  leafRects: LeafRectItem[]
): LeafRectItem | null {
  const chatRects = leafRects.filter((l) => isChatDomain(l.panelId));
  return findLeafAtPointer(pointer, chatRects);
}

/** split zone → DropDirection */
function splitZoneToDirection(
  zoneType: DropZone['type']
): DropDirection | null {
  switch (zoneType) {
    case 'split-left':
      return 'left';
    case 'split-right':
      return 'right';
    case 'split-top':
      return 'top';
    case 'split-bottom':
      return 'bottom';
    default:
      return null;
  }
}

/**
 * 源 leaf 是否已在目标 leaf 的指定侧（直接兄弟 + 方向匹配）。
 * 已在正确侧时再 drop 只应 focus，避免无意义 move。
 */
function isAlreadyAdjacentOnSide(
  root: LayoutNode,
  sourceLeafId: string,
  targetLeafId: string,
  direction: DropDirection
): boolean {
  const parentInfo = findParent(root, targetLeafId);
  if (!parentInfo) return false;
  const { parent, index } = parentInfo;
  const sibling = parent.children[index === 0 ? 1 : 0];
  if (sibling.id !== sourceLeafId) return false;

  if (direction === 'left') {
    return (
      parent.direction === 'horizontal' &&
      parent.children[0].id === sourceLeafId
    );
  }
  if (direction === 'right') {
    return (
      parent.direction === 'horizontal' &&
      parent.children[1].id === sourceLeafId
    );
  }
  if (direction === 'top') {
    return (
      parent.direction === 'vertical' && parent.children[0].id === sourceLeafId
    );
  }
  if (direction === 'bottom') {
    return (
      parent.direction === 'vertical' && parent.children[1].id === sourceLeafId
    );
  }
  return false;
}

/**
 * 会话标签拖到画布 split 区的决策计划。
 *
 * - 已有 chat leaf → activate 或 move（绝不 clone）
 * - 尚无 leaf → create（split + 绑定一次）
 */
export type SessionCanvasDropPlan =
  | { action: 'activate'; leafId: string }
  | {
      action: 'move';
      sourceLeafId: string;
      targetLeafId: string;
      direction: DropDirection;
    }
  | {
      action: 'create';
      targetLeafId: string;
      direction: DropDirection;
      /** 目标 leaf 无 session 时，是否需要先绑 shell active */
      targetNeedsShellBind: boolean;
    }
  | { action: 'none' };

/**
 * 会话落点锚点 = Conversation Unit root（H(chat|tools) 或 chat-only），
 * 禁止锚到 unit 内部的 chat leaf（会把 tools 拆成全局孤儿列）。
 */
function resolveSessionUnitAnchorId(
  root: LayoutNode,
  chatLeafId: string,
  sessionId?: string | null
): string {
  const sid = (sessionId || '').trim();
  if (sid) {
    const unitId = findUnitRootId(root, sid);
    if (unitId) return unitId;
  }
  const leaf = findNodeById(root, chatLeafId);
  if (
    leaf &&
    leaf.type === 'leaf' &&
    isChatDomain(leaf.panelId) &&
    leaf.sessionId
  ) {
    const unitId = findUnitRootId(root, leaf.sessionId);
    if (unitId) return unitId;
  }
  return chatLeafId;
}

export function planSessionCanvasDrop(
  root: LayoutNode,
  sourceSessionId: string,
  zone: DropZone
): SessionCanvasDropPlan {
  const direction = splitZoneToDirection(zone.type);
  if (!direction) return { action: 'none' };

  const targetLeafId = zone.targetLeafId;
  const targetNode = findNodeById(root, targetLeafId);
  if (
    !targetNode ||
    targetNode.type !== 'leaf' ||
    !isChatDomain(targetNode.panelId)
  ) {
    return { action: 'none' };
  }

  // 锚到目标 unit root（含其右坞 tools），而不是 unit 内 chat leaf
  const targetAnchorId = resolveSessionUnitAnchorId(
    root,
    targetLeafId,
    targetNode.sessionId
  );

  const existing = findChatLeafBySessionId(root, sourceSessionId);
  if (existing) {
    const sourceAnchorId = resolveSessionUnitAnchorId(
      root,
      existing.id,
      sourceSessionId
    );
    // 落点即自身 / 目标已是该 session / 已在指定侧 → 仅激活
    if (
      existing.id === targetLeafId ||
      sourceAnchorId === targetAnchorId ||
      targetNode.sessionId === sourceSessionId ||
      isAlreadyAdjacentOnSide(root, sourceAnchorId, targetAnchorId, direction)
    ) {
      return { action: 'activate', leafId: existing.id };
    }
    // 已有 unit 在别处 → 整 unit（chat+tools）移到目标 unit 旁
    return {
      action: 'move',
      sourceLeafId: sourceAnchorId,
      targetLeafId: targetAnchorId,
      direction,
    };
  }

  // 尚无 leaf：在目标 unit 旁创建 chat（一次性）
  return {
    action: 'create',
    targetLeafId: targetAnchorId,
    direction,
    targetNeedsShellBind: !targetNode.sessionId,
  };
}
