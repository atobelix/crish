/**
 * W3-F DOM 余量 · chrome 最小 DOM 宿主（把手 / 多选 / 落点 / slash / 拖拽预览）。
 *
 * ## 角色
 * - **呈现投影编排**：model → DOM；细节在 `chromeSlashDom` / `chromeDragDom`
 * - **禁止** DOM 当文档真相 / 旁路写盘；写路径仍 Intent → collab sink
 *
 * ## slash 双浮层防护（SD-03）
 * - **`projectSlashCatalog` 默认 `false`**：`data-slash-catalog=react`，无 item 节点
 * - 产品 React `SlashMenuOverlay` 安全；契约测须显式 `true` 才投影 catalog
 *
 * ## 诚实边界
 * - **≠ EL-01**；**≠** A-BLK e2e 全关；collab Strict apply 测不得回退 mock
 *
 * 测：`chrome.w3f_dom.test.ts` · `chrome.w3f_drag.test.ts`
 */

import type { BlockId } from '@crish/block-paper-contract';
import type { BlockChromeModel, HandleVisibility } from './BlockChrome';
import type { SlashMenuModel } from './SlashMenuModel';
import {
  BP_DRAG_PREVIEW,
  BP_DRAG_SOURCE,
  BP_DRAGGING,
  BP_DROP_LINE,
  BP_DROP_SIDE,
  BP_DROP_TARGET,
  createDragChromeIndicators,
  reduceDragPointerShape,
  resolveDropTarget,
  syncDragPreviewDom,
  syncDropLineDom,
  type DragPointerShape,
  type DragPreviewState,
  type DropLineSide,
  type DropLineTarget,
} from './chromeDragDom';
import {
  BP_SLASH_EMPTY,
  BP_SLASH_GROUP,
  BP_SLASH_HOST,
  BP_SLASH_ITEM,
  BP_SLASH_OPEN,
  createSlashHostElement,
  syncSlashHostDom,
} from './chromeSlashDom';

// ---------------------------------------------------------------------------
// 类型 + 再导出（包入口兼容）
// ---------------------------------------------------------------------------

export type ChromeDomBlockSpec = {
  blockId: BlockId;
  /** 可选 flavour（仅 `data-flavour` 呈现，非文档权威） */
  flavour?: string;
};

export type BlockChromeDomHostOptions = {
  blocks: readonly ChromeDomBlockSpec[];
  chrome: BlockChromeModel;
  slash?: SlashMenuModel;
  /**
   * 是否投影 catalog 子节点。**默认 false（SD-03）** 防双浮层；
   * jsdom 契约测显式 `true`。false 时 `data-slash-catalog=react` 且无 item。
   */
  projectSlashCatalog?: boolean;
  onMultiSelectionChange?: (blockIds: readonly BlockId[]) => void;
};

export type {
  DropLineSide,
  DropLineTarget,
  DragPreviewState,
  DragPointerShape,
};
export {
  BP_DROP_LINE,
  BP_DROP_SIDE,
  BP_DROP_TARGET,
  BP_DRAG_PREVIEW,
  BP_DRAG_SOURCE,
  BP_DRAGGING,
  BP_SLASH_HOST,
  BP_SLASH_OPEN,
  BP_SLASH_ITEM,
  BP_SLASH_GROUP,
  BP_SLASH_EMPTY,
};

export const BP_CHROME_ROOT = 'data-bp-chrome-root';
export const BP_BLOCK_ROW = 'data-bp-block-row';
export const BP_BLOCK_ID = 'data-block-id';
export const BP_HANDLE = 'data-bp-handle';
export const BP_HANDLE_VISIBILITY = 'data-handle-visibility';
export const BP_MULTI_CHECK = 'data-bp-multi-check';

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/** 最小 chrome DOM 宿主：model 投影到 DOM，不持有文档权威。 */
export class BlockChromeDomHost {
  private readonly root: HTMLElement;
  private readonly chrome: BlockChromeModel;
  private readonly slash: SlashMenuModel | undefined;
  /** 默认 false；仅契约测 / 无 React Overlay 时显式 true */
  private readonly projectSlashCatalog: boolean;
  private readonly onMultiSelectionChange:
    ((blockIds: readonly BlockId[]) => void) | undefined;
  private readonly rows = new Map<BlockId, HTMLElement>();
  private readonly handles = new Map<BlockId, HTMLElement>();
  private readonly checks = new Map<BlockId, HTMLInputElement>();
  private readonly dropLine: HTMLElement;
  private readonly slashHost: HTMLElement;
  private readonly dragPreview: HTMLElement;
  private dropTarget: DropLineTarget | null = null;
  private dragState: DragPreviewState | null = null;
  private destroyed = false;
  private readonly blockOrder: BlockId[];

  constructor(parent: HTMLElement, options: BlockChromeDomHostOptions) {
    this.chrome = options.chrome;
    this.slash = options.slash;
    // SD-03：默认 false，防产品双浮层；契约测须显式 true
    this.projectSlashCatalog = options.projectSlashCatalog === true;
    this.onMultiSelectionChange = options.onMultiSelectionChange;

    const doc = parent.ownerDocument;
    const root = doc.createElement('div');
    root.className = 'bp-chrome-root';
    root.setAttribute(BP_CHROME_ROOT, '1');
    parent.appendChild(root);
    this.root = root;

    this.blockOrder = [];
    for (const spec of options.blocks) {
      const id = spec.blockId;
      if (!id || this.rows.has(id)) continue;
      this.blockOrder.push(id);

      const row = doc.createElement('div');
      row.className = 'bp-block-row';
      row.setAttribute(BP_BLOCK_ROW, '1');
      row.setAttribute(BP_BLOCK_ID, id);
      row.setAttribute(BP_DRAGGING, '0');
      if (spec.flavour) row.setAttribute('data-flavour', spec.flavour);

      const handle = doc.createElement('button');
      handle.type = 'button';
      handle.className = 'bp-block-handle';
      handle.setAttribute(BP_HANDLE, '1');
      handle.setAttribute(BP_HANDLE_VISIBILITY, 'hidden');
      handle.setAttribute('aria-label', '块把手');
      handle.tabIndex = -1;

      const check = doc.createElement('input');
      check.type = 'checkbox';
      check.className = 'bp-multi-check';
      check.setAttribute(BP_MULTI_CHECK, '1');
      check.setAttribute(BP_BLOCK_ID, id);
      check.setAttribute('aria-label', '多选块');
      check.addEventListener('change', () => this.onCheckChange(id, check));

      row.appendChild(handle);
      row.appendChild(check);
      root.appendChild(row);
      this.rows.set(id, row);
      this.handles.set(id, handle);
      this.checks.set(id, check);
    }

    const indicators = createDragChromeIndicators(doc, root);
    this.dropLine = indicators.dropLine;
    this.dragPreview = indicators.dragPreview;
    this.slashHost = createSlashHostElement(doc, root);
    this.sync();
  }

  /** 从 model 重投影全部 chrome DOM */
  sync(): void {
    this.assertAlive();
    for (const id of this.blockOrder) this.syncRow(id);
    this.syncDropLine();
    this.syncDragPreview();
    this.syncSlashHost();
  }

  /** 设置拖拽落点（纯呈现；**不**产 Move Intent） */
  setDropTarget(
    blockId: BlockId | null,
    side: DropLineSide | null = 'before'
  ): void {
    this.assertAlive();
    this.dropTarget = resolveDropTarget(blockId, side, (id) =>
      this.rows.has(id)
    );
    this.syncDropLine();
  }

  clearDropTarget(): void {
    this.setDropTarget(null, null);
  }

  getDropTarget(): DropLineTarget | null {
    return this.dropTarget ? { ...this.dropTarget } : null;
  }

  isDropLineVisible(): boolean {
    return !this.dropLine.hidden;
  }

  getDropLineElement(): HTMLElement {
    return this.dropLine;
  }

  /** 开始拖拽预览；未知源块返回 false */
  startDragPreview(sourceBlockId: BlockId, label?: string): boolean {
    this.assertAlive();
    if (!this.rows.has(sourceBlockId)) return false;
    this.dragState = { sourceBlockId, label };
    this.syncDragPreview();
    return true;
  }

  clearDragPreview(): void {
    this.assertAlive();
    this.dragState = null;
    this.syncDragPreview();
  }

  /** 结束拖拽：清预览 + 落点；**不**自动 submit Move */
  endDrag(): void {
    this.assertAlive();
    this.dragState = null;
    this.dropTarget = null;
    this.syncDragPreview();
    this.syncDropLine();
  }

  isDragging(): boolean {
    return this.dragState !== null;
  }

  getDragPreviewState(): DragPreviewState | null {
    return this.dragState ? { ...this.dragState } : null;
  }

  getDragPreviewElement(): HTMLElement {
    return this.dragPreview;
  }

  isDragPreviewVisible(): boolean {
    return !this.dragPreview.hidden;
  }

  /** 指针形状 mock（jsdom）：down/move/up → 预览 + 落点 */
  applyDragPointerShape(shape: DragPointerShape): void {
    this.assertAlive();
    const next = reduceDragPointerShape(
      { dragState: this.dragState, dropTarget: this.dropTarget },
      shape,
      (id) => this.rows.has(id)
    );
    this.dragState = next.dragState;
    this.dropTarget = next.dropTarget;
    this.syncDragPreview();
    this.syncDropLine();
  }

  getHandleVisibilityAttr(blockId: BlockId): HandleVisibility | null {
    const el = this.handles.get(blockId);
    if (!el) return null;
    const v = el.getAttribute(BP_HANDLE_VISIBILITY);
    if (v === 'hidden' || v === 'hover' || v === 'focus' || v === 'multi') {
      return v;
    }
    return null;
  }

  isMultiCheckboxChecked(blockId: BlockId): boolean {
    return this.checks.get(blockId)?.checked ?? false;
  }

  isSlashHostVisible(): boolean {
    return !this.slashHost.hidden;
  }

  getSlashHostElement(): HTMLElement {
    return this.slashHost;
  }

  getRootElement(): HTMLElement {
    return this.root;
  }

  getRowElement(blockId: BlockId): HTMLElement | null {
    return this.rows.get(blockId) ?? null;
  }

  getHandleElement(blockId: BlockId): HTMLElement | null {
    return this.handles.get(blockId) ?? null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rows.clear();
    this.handles.clear();
    this.checks.clear();
    this.dropTarget = null;
    this.dragState = null;
    this.root.remove();
  }

  // -----------------------------------------------------------------------
  // 内部
  // -----------------------------------------------------------------------

  private onCheckChange(blockId: BlockId, check: HTMLInputElement): void {
    if (this.destroyed) return;
    const selected = new Set(this.chrome.getSnapshot().multiSelectedIds);
    if (check.checked) selected.add(blockId);
    else selected.delete(blockId);
    const next = this.blockOrder.filter((id) => selected.has(id));
    this.chrome.setMultiSelected(next);
    this.sync();
    this.onMultiSelectionChange?.(next);
  }

  private syncRow(blockId: BlockId): void {
    const handle = this.handles.get(blockId);
    const check = this.checks.get(blockId);
    const row = this.rows.get(blockId);
    if (!handle || !check || !row) return;

    const vis = this.chrome.getHandleVisibility(blockId);
    handle.setAttribute(BP_HANDLE_VISIBILITY, vis);
    const showHandle = vis !== 'hidden';
    handle.hidden = !showHandle;
    handle.style.visibility = showHandle ? 'visible' : 'hidden';
    check.checked = this.chrome.isMultiSelected(blockId);

    const dragging =
      this.dragState !== null && this.dragState.sourceBlockId === blockId;
    row.setAttribute(BP_DRAGGING, dragging ? '1' : '0');
  }

  private syncDragPreview(): void {
    syncDragPreviewDom({
      dragPreview: this.dragPreview,
      dragState: this.dragState,
      blockOrder: this.blockOrder,
      rows: this.rows,
    });
  }

  private syncDropLine(): void {
    syncDropLineDom({
      dropLine: this.dropLine,
      root: this.root,
      dropTarget: this.dropTarget,
      rows: this.rows,
    });
  }

  private syncSlashHost(): void {
    syncSlashHostDom({
      slashHost: this.slashHost,
      projectSlashCatalog: this.projectSlashCatalog,
      slash: this.slash,
    });
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error('BlockChromeDomHost：已 destroy');
    }
  }
}

export function isBlockChromeDomHost(v: unknown): v is BlockChromeDomHost {
  return v instanceof BlockChromeDomHost;
}
