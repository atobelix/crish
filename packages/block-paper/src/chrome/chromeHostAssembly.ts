/**
 * SD-48 · W3-F DOM 宿主壳装配（root / 行 / 把手 / 多选 + slash/drag 挂点）
 *
 * ## 角色
 * - 一次性装配 chrome 壳；行投影（把手可见性 / 多选框 / dragging）
 * - slash catalog 细节仍在 `chromeSlashDom`；拖拽 ghost/落点线仍在 `chromeDragDom`
 * - 本模只做宿主编排胶水，不持有文档权威
 *
 * ## 诚实边界
 * - **≠ EL-01**；**≠** 占 SD-03/08/40
 * - `projectSlashCatalog` 默认仍由 DomHost 钉死 `false`（本模不改默认）
 *
 * 由 `BlockChromeDomHost` 编排调用。
 */

import type { BlockId } from '@crish/block-paper-contract';
import type { BlockChromeModel, HandleVisibility } from './BlockChrome';
import type { SlashMenuModel } from './SlashMenuModel';
import {
  BP_DRAGGING,
  createDragChromeIndicators,
  syncDragPreviewDom,
  syncDropLineDom,
  type DragPreviewState,
  type DropLineTarget,
} from './chromeDragDom';
import { createSlashHostElement, syncSlashHostDom } from './chromeSlashDom';

// ---------------------------------------------------------------------------
// data-* 契约（宿主壳 / 行 / 把手 / 多选）
// ---------------------------------------------------------------------------

export const BP_CHROME_ROOT = 'data-bp-chrome-root';
export const BP_BLOCK_ROW = 'data-bp-block-row';
export const BP_BLOCK_ID = 'data-block-id';
export const BP_HANDLE = 'data-bp-handle';
export const BP_HANDLE_VISIBILITY = 'data-handle-visibility';
export const BP_MULTI_CHECK = 'data-bp-multi-check';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type ChromeDomBlockSpec = {
  blockId: BlockId;
  /** 可选 flavour（仅 `data-flavour` 呈现，非文档权威） */
  flavour?: string;
};

/** 装配后的 chrome 壳（行图 + slash/drag 单例挂点） */
export type ChromeHostShell = {
  root: HTMLElement;
  blockOrder: BlockId[];
  rows: Map<BlockId, HTMLElement>;
  handles: Map<BlockId, HTMLElement>;
  checks: Map<BlockId, HTMLInputElement>;
  dropLine: HTMLElement;
  dragPreview: HTMLElement;
  slashHost: HTMLElement;
};

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

/** 创建 root + 块行 + 落点线/ghost + slash 宿主空壳 */
export function assembleChromeHostShell(
  parent: HTMLElement,
  blocks: readonly ChromeDomBlockSpec[],
  onCheckChange: (blockId: BlockId, check: HTMLInputElement) => void
): ChromeHostShell {
  const doc = parent.ownerDocument;
  const root = doc.createElement('div');
  root.className = 'bp-chrome-root';
  root.setAttribute(BP_CHROME_ROOT, '1');
  parent.appendChild(root);

  const rows = new Map<BlockId, HTMLElement>();
  const handles = new Map<BlockId, HTMLElement>();
  const checks = new Map<BlockId, HTMLInputElement>();
  const blockOrder: BlockId[] = [];

  for (const spec of blocks) {
    const id = spec.blockId;
    if (!id || rows.has(id)) continue;
    blockOrder.push(id);
    const mounted = createChromeBlockRow(doc, spec, onCheckChange);
    root.appendChild(mounted.row);
    rows.set(id, mounted.row);
    handles.set(id, mounted.handle);
    checks.set(id, mounted.check);
  }

  const { dropLine, dragPreview } = createDragChromeIndicators(doc, root);
  const slashHost = createSlashHostElement(doc, root);
  return {
    root,
    blockOrder,
    rows,
    handles,
    checks,
    dropLine,
    dragPreview,
    slashHost,
  };
}

function createChromeBlockRow(
  doc: Document,
  spec: ChromeDomBlockSpec,
  onCheckChange: (blockId: BlockId, check: HTMLInputElement) => void
): { row: HTMLElement; handle: HTMLElement; check: HTMLInputElement } {
  const id = spec.blockId;
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
  check.addEventListener('change', () => onCheckChange(id, check));

  row.appendChild(handle);
  row.appendChild(check);
  return { row, handle, check };
}

// ---------------------------------------------------------------------------
// 行投影 / 全量编排 / 多选回写
// ---------------------------------------------------------------------------

/** 单行：把手可见性 + 多选框 + dragging 属性 */
export function syncChromeRowDom(args: {
  blockId: BlockId;
  chrome: BlockChromeModel;
  dragState: DragPreviewState | null;
  handles: ReadonlyMap<BlockId, HTMLElement>;
  checks: ReadonlyMap<BlockId, HTMLInputElement>;
  rows: ReadonlyMap<BlockId, HTMLElement>;
}): void {
  const handle = args.handles.get(args.blockId);
  const check = args.checks.get(args.blockId);
  const row = args.rows.get(args.blockId);
  if (!handle || !check || !row) return;

  const vis = args.chrome.getHandleVisibility(args.blockId);
  handle.setAttribute(BP_HANDLE_VISIBILITY, vis);
  const showHandle = vis !== 'hidden';
  handle.hidden = !showHandle;
  handle.style.visibility = showHandle ? 'visible' : 'hidden';
  check.checked = args.chrome.isMultiSelected(args.blockId);

  const dragging =
    args.dragState !== null && args.dragState.sourceBlockId === args.blockId;
  row.setAttribute(BP_DRAGGING, dragging ? '1' : '0');
}

/** 全量投影：行 + 落点线 + ghost + slash 宿主 */
export function projectChromeHostDom(args: {
  shell: ChromeHostShell;
  chrome: BlockChromeModel;
  slash: SlashMenuModel | undefined;
  projectSlashCatalog: boolean;
  dragState: DragPreviewState | null;
  dropTarget: DropLineTarget | null;
}): void {
  const { shell } = args;
  for (const id of shell.blockOrder) {
    syncChromeRowDom({
      blockId: id,
      chrome: args.chrome,
      dragState: args.dragState,
      handles: shell.handles,
      checks: shell.checks,
      rows: shell.rows,
    });
  }
  syncDropLineDom({
    dropLine: shell.dropLine,
    root: shell.root,
    dropTarget: args.dropTarget,
    rows: shell.rows,
  });
  syncDragPreviewDom({
    dragPreview: shell.dragPreview,
    dragState: args.dragState,
    blockOrder: shell.blockOrder,
    rows: shell.rows,
  });
  syncSlashHostDom({
    slashHost: shell.slashHost,
    projectSlashCatalog: args.projectSlashCatalog,
    slash: args.slash,
  });
}

export function readHandleVisibilityAttr(
  el: HTMLElement | undefined
): HandleVisibility | null {
  if (!el) return null;
  const v = el.getAttribute(BP_HANDLE_VISIBILITY);
  if (v === 'hidden' || v === 'hover' || v === 'focus' || v === 'multi') {
    return v;
  }
  return null;
}

/** 勾选回写 model：保 blockOrder 序；返回下一多选列表 */
export function applyMultiCheckChange(args: {
  blockId: BlockId;
  checked: boolean;
  chrome: BlockChromeModel;
  blockOrder: readonly BlockId[];
}): BlockId[] {
  const selected = new Set(args.chrome.getSnapshot().multiSelectedIds);
  if (args.checked) selected.add(args.blockId);
  else selected.delete(args.blockId);
  const next = args.blockOrder.filter((id) => selected.has(id));
  args.chrome.setMultiSelected(next);
  return next;
}
