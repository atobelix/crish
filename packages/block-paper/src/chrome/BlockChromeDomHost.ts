/**
 * W3-F DOM 余量 · chrome 最小 DOM 宿主（把手 / 多选 / 落点 / slash / 拖拽预览）。
 *
 * ## SD-48
 * - 宿主壳装配 / 行投影胶水：`chromeHostAssembly`
 * - slash / drag 细节仍在 `chromeSlashDom` / `chromeDragDom`
 *
 * ## 角色
 * - **呈现投影编排**：model → DOM
 * - **禁止** DOM 当文档真相 / 旁路写盘；写路径仍 Intent → collab sink
 *
 * ## slash 双浮层防护（SD-03）
 * - **`projectSlashCatalog` 默认 `false`**：`data-slash-catalog=react`，无 item 节点
 * - 产品 React `SlashMenuOverlay` 安全；契约测须显式 `true` 才投影 catalog
 *
 * ## 诚实边界
 * - **≠ EL-01**；**≠** A-BLK e2e 全关；collab Strict apply 测不得回退 mock
 * - **≠** 占 SD-03/08/40
 *
 * 测：`chrome.dom.test.ts` · `chrome.drag.test.ts`
 */

import type { BlockId } from '@crish/block-paper-contract';
import type { BlockChromeModel, HandleVisibility } from './BlockChrome';
import type { SlashMenuModel } from './SlashMenuModel';
import {
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
  applyMultiCheckChange,
  assembleChromeHostShell,
  projectChromeHostDom,
  readHandleVisibilityAttr,
  type ChromeDomBlockSpec,
  type ChromeHostShell,
} from './chromeHostAssembly';

// ---------------------------------------------------------------------------
// 类型 + 再导出（包入口兼容）
// ---------------------------------------------------------------------------

export type { ChromeDomBlockSpec };

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
} from './chromeDragDom';
export {
  BP_SLASH_HOST,
  BP_SLASH_OPEN,
  BP_SLASH_ITEM,
  BP_SLASH_GROUP,
  BP_SLASH_EMPTY,
} from './chromeSlashDom';
export {
  BP_CHROME_ROOT,
  BP_BLOCK_ROW,
  BP_BLOCK_ID,
  BP_HANDLE,
  BP_HANDLE_VISIBILITY,
  BP_MULTI_CHECK,
} from './chromeHostAssembly';

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/** 最小 chrome DOM 宿主：model 投影到 DOM，不持有文档权威。 */
export class BlockChromeDomHost {
  private readonly chrome: BlockChromeModel;
  private readonly slash: SlashMenuModel | undefined;
  /** 默认 false；仅契约测 / 无 React Overlay 时显式 true */
  private readonly projectSlashCatalog: boolean;
  private readonly onMultiSelectionChange:
    ((blockIds: readonly BlockId[]) => void) | undefined;
  private readonly shell: ChromeHostShell;
  private dropTarget: DropLineTarget | null = null;
  private dragState: DragPreviewState | null = null;
  private destroyed = false;

  constructor(parent: HTMLElement, options: BlockChromeDomHostOptions) {
    this.chrome = options.chrome;
    this.slash = options.slash;
    // SD-03：默认 false，防产品双浮层；契约测须显式 true
    this.projectSlashCatalog = options.projectSlashCatalog === true;
    this.onMultiSelectionChange = options.onMultiSelectionChange;
    this.shell = assembleChromeHostShell(parent, options.blocks, (id, check) =>
      this.onCheckChange(id, check)
    );
    this.sync();
  }

  /** 从 model 重投影全部 chrome DOM */
  sync(): void {
    this.assertAlive();
    projectChromeHostDom({
      shell: this.shell,
      chrome: this.chrome,
      slash: this.slash,
      projectSlashCatalog: this.projectSlashCatalog,
      dragState: this.dragState,
      dropTarget: this.dropTarget,
    });
  }

  /** 设置拖拽落点（纯呈现；**不**产 Move Intent） */
  setDropTarget(
    blockId: BlockId | null,
    side: DropLineSide | null = 'before'
  ): void {
    this.assertAlive();
    this.dropTarget = resolveDropTarget(blockId, side, (id) =>
      this.shell.rows.has(id)
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
    return !this.shell.dropLine.hidden;
  }

  getDropLineElement(): HTMLElement {
    return this.shell.dropLine;
  }

  /** 开始拖拽预览；未知源块返回 false */
  startDragPreview(sourceBlockId: BlockId, label?: string): boolean {
    this.assertAlive();
    if (!this.shell.rows.has(sourceBlockId)) return false;
    this.dragState =
      label === undefined ? { sourceBlockId } : { sourceBlockId, label };
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
    return this.shell.dragPreview;
  }

  isDragPreviewVisible(): boolean {
    return !this.shell.dragPreview.hidden;
  }

  /** 指针形状 mock（jsdom）：down/move/up → 预览 + 落点 */
  applyDragPointerShape(shape: DragPointerShape): void {
    this.assertAlive();
    const next = reduceDragPointerShape(
      { dragState: this.dragState, dropTarget: this.dropTarget },
      shape,
      (id) => this.shell.rows.has(id)
    );
    this.dragState = next.dragState;
    this.dropTarget = next.dropTarget;
    this.syncDragPreview();
    this.syncDropLine();
  }

  getHandleVisibilityAttr(blockId: BlockId): HandleVisibility | null {
    return readHandleVisibilityAttr(this.shell.handles.get(blockId));
  }

  isMultiCheckboxChecked(blockId: BlockId): boolean {
    return this.shell.checks.get(blockId)?.checked ?? false;
  }

  isSlashHostVisible(): boolean {
    return !this.shell.slashHost.hidden;
  }

  getSlashHostElement(): HTMLElement {
    return this.shell.slashHost;
  }

  getRootElement(): HTMLElement {
    return this.shell.root;
  }

  getRowElement(blockId: BlockId): HTMLElement | null {
    return this.shell.rows.get(blockId) ?? null;
  }

  getHandleElement(blockId: BlockId): HTMLElement | null {
    return this.shell.handles.get(blockId) ?? null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.shell.rows.clear();
    this.shell.handles.clear();
    this.shell.checks.clear();
    this.dropTarget = null;
    this.dragState = null;
    this.shell.root.remove();
  }

  private onCheckChange(blockId: BlockId, check: HTMLInputElement): void {
    if (this.destroyed) return;
    const next = applyMultiCheckChange({
      blockId,
      checked: check.checked,
      chrome: this.chrome,
      blockOrder: this.shell.blockOrder,
    });
    this.sync();
    this.onMultiSelectionChange?.(next);
  }

  private syncDragPreview(): void {
    syncDragPreviewDom({
      dragPreview: this.shell.dragPreview,
      dragState: this.dragState,
      blockOrder: this.shell.blockOrder,
      rows: this.shell.rows,
    });
  }

  private syncDropLine(): void {
    syncDropLineDom({
      dropLine: this.shell.dropLine,
      root: this.shell.root,
      dropTarget: this.dropTarget,
      rows: this.shell.rows,
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
