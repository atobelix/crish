/**
 * W3-F DOM · 拖拽预览 / 落点线投影（纯呈现）
 *
 * ## 角色
 * - ghost 预览节点 + 源行 `data-dragging` + 落点线 side/target
 * - **不**产 Move Intent；真正重排须 buildMoveBlocksIntent → submitIntent → collab sink
 *
 * ## 诚实边界
 * - **≠ EL-01**；**≠** A-BLK-04 拖拽产品 e2e 全关
 * - 指针形状 mock 由 DomHost 编排；本模块只做 DOM 属性同步
 *
 * 由 `BlockChromeDomHost` 编排调用。
 */

import type { BlockId } from '@crish/block-paper-contract';

// ---------------------------------------------------------------------------
// data-* 契约（落点 / 拖拽）
// ---------------------------------------------------------------------------

export const BP_DROP_LINE = 'data-bp-drop-line';
export const BP_DROP_SIDE = 'data-drop-side';
export const BP_DROP_TARGET = 'data-drop-target';
/** 拖拽预览指示器（ghost 节点） */
export const BP_DRAG_PREVIEW = 'data-bp-drag-preview';
/** 预览 / 源行上的源块 id */
export const BP_DRAG_SOURCE = 'data-drag-source';
/** 源行正在被拖拽 */
export const BP_DRAGGING = 'data-dragging';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 落点线相对目标块的边 */
export type DropLineSide = 'before' | 'after';

/** 落点目标（null = 无落点 / 隐藏） */
export type DropLineTarget = {
  blockId: BlockId;
  side: DropLineSide;
};

/**
 * 拖拽预览状态（纯呈现；**不**产 Move Intent）。
 * 真正重排须：`buildMoveBlocksIntent` → `submitIntent` → collab sink。
 */
export type DragPreviewState = {
  sourceBlockId: BlockId;
  /** 可选预览标签（如块摘要） */
  label?: string | undefined;
};

/**
 * 指针事件形状（jsdom 无布局命中时由测/适配层注入 overBlockId）。
 * 宿主只做呈现投影，**不**绑定真实 PointerEvent 监听器（产品挂载后置）。
 */
export type DragPointerShape = {
  phase: 'down' | 'move' | 'up' | 'cancel';
  /** down：拖拽源块（通常为把手所属行） */
  sourceBlockId?: BlockId | undefined;
  /** move：当前悬停目标块（null = 离开列表） */
  overBlockId?: BlockId | null | undefined;
  /** move：落点边（默认 before） */
  side?: DropLineSide | null | undefined;
  /** 可选预览标签 */
  label?: string | undefined;
};

// ---------------------------------------------------------------------------
// 投影
// ---------------------------------------------------------------------------

/**
 * 同步拖拽 ghost + 各行 `data-dragging`。
 */
export function syncDragPreviewDom(args: {
  dragPreview: HTMLElement;
  dragState: DragPreviewState | null;
  blockOrder: readonly BlockId[];
  rows: ReadonlyMap<BlockId, HTMLElement>;
}): void {
  const { dragPreview, dragState, blockOrder, rows } = args;
  const s = dragState;

  if (!s || !rows.has(s.sourceBlockId)) {
    dragPreview.hidden = true;
    dragPreview.setAttribute(BP_DRAG_SOURCE, '');
    dragPreview.textContent = '';
    for (const id of blockOrder) {
      rows.get(id)?.setAttribute(BP_DRAGGING, '0');
    }
    return;
  }

  dragPreview.hidden = false;
  dragPreview.setAttribute(BP_DRAG_SOURCE, s.sourceBlockId);
  dragPreview.textContent = s.label ?? s.sourceBlockId;
  for (const id of blockOrder) {
    rows.get(id)?.setAttribute(BP_DRAGGING, id === s.sourceBlockId ? '1' : '0');
  }
}

/**
 * 同步落点线显隐 / side / target，并插到目标行 before/after。
 */
export function syncDropLineDom(args: {
  dropLine: HTMLElement;
  root: HTMLElement;
  dropTarget: DropLineTarget | null;
  rows: ReadonlyMap<BlockId, HTMLElement>;
}): void {
  const { dropLine, root, dropTarget, rows } = args;
  const t = dropTarget;

  if (!t) {
    dropLine.hidden = true;
    dropLine.setAttribute(BP_DROP_SIDE, '');
    dropLine.setAttribute(BP_DROP_TARGET, '');
    if (dropLine.parentElement !== root) {
      root.appendChild(dropLine);
    }
    return;
  }

  const row = rows.get(t.blockId);
  if (!row) {
    dropLine.hidden = true;
    return;
  }

  dropLine.hidden = false;
  dropLine.setAttribute(BP_DROP_SIDE, t.side);
  dropLine.setAttribute(BP_DROP_TARGET, t.blockId);

  if (t.side === 'before') {
    row.parentElement?.insertBefore(dropLine, row);
  } else {
    row.parentElement?.insertBefore(dropLine, row.nextSibling);
  }
}

// ---------------------------------------------------------------------------
// 节点工厂 + 指针形状状态机
// ---------------------------------------------------------------------------

/** 创建落点线 + 拖拽 ghost 单例节点并挂到 root */
export function createDragChromeIndicators(
  doc: Document,
  root: HTMLElement
): { dropLine: HTMLElement; dragPreview: HTMLElement } {
  const dropLine = doc.createElement('div');
  dropLine.className = 'bp-drop-line';
  dropLine.setAttribute(BP_DROP_LINE, '1');
  dropLine.setAttribute(BP_DROP_SIDE, '');
  dropLine.setAttribute(BP_DROP_TARGET, '');
  dropLine.hidden = true;
  root.appendChild(dropLine);

  const dragPreview = doc.createElement('div');
  dragPreview.className = 'bp-drag-preview';
  dragPreview.setAttribute(BP_DRAG_PREVIEW, '1');
  dragPreview.setAttribute(BP_DRAG_SOURCE, '');
  dragPreview.setAttribute('aria-hidden', 'true');
  dragPreview.hidden = true;
  root.appendChild(dragPreview);

  return { dropLine, dragPreview };
}

/** 解析 setDropTarget 输入 → 有效落点或 null */
export function resolveDropTarget(
  blockId: BlockId | null,
  side: DropLineSide | null,
  hasBlock: (id: BlockId) => boolean
): DropLineTarget | null {
  if (!blockId || !side || !hasBlock(blockId)) return null;
  return { blockId, side };
}

export type DragSession = {
  dragState: DragPreviewState | null;
  dropTarget: DropLineTarget | null;
};

/**
 * 指针形状 mock → 下一拖拽会话态（纯函数；不写 DOM）。
 * DomHost 应用后自行 sync 投影。
 */
export function reduceDragPointerShape(
  session: DragSession,
  shape: DragPointerShape,
  hasBlock: (id: BlockId) => boolean
): DragSession {
  switch (shape.phase) {
    case 'down': {
      const src = shape.sourceBlockId;
      if (!src || !hasBlock(src)) return session;
      const dragState: DragPreviewState = { sourceBlockId: src };
      if (shape.label !== undefined) {
        dragState.label = shape.label;
      }
      return {
        dragState,
        dropTarget: session.dropTarget,
      };
    }
    case 'move': {
      if (!session.dragState) return session;
      const over = shape.overBlockId;
      if (
        over === null ||
        over === undefined ||
        over === session.dragState.sourceBlockId
      ) {
        return { dragState: session.dragState, dropTarget: null };
      }
      return {
        dragState: session.dragState,
        dropTarget: resolveDropTarget(over, shape.side ?? 'before', hasBlock),
      };
    }
    case 'up':
    case 'cancel':
      return { dragState: null, dropTarget: null };
    default:
      return session;
  }
}
