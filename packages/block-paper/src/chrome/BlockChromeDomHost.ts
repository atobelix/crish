/**
 * W3-F DOM 余量 · chrome 最小 DOM 宿主（把手可见性 / 多选框 / 落点线 / slash 宿主）。
 *
 * ## 角色
 * - **呈现投影**：`BlockChromeModel` / `SlashMenuModel` 快照 → 真实 DOM 属性与节点
 * - **禁止** DOM 当文档真相；**禁止** 本宿主旁路写盘 / 改树
 * - 写路径仍：StructureIntent → `submitIntent` → **`createCollabApplySink`** → RS apply
 *
 * ## 本波交付（可测 · jsdom）
 * - 把手可见性：`data-handle-visibility` 同步 model（hidden/hover/focus/multi）
 * - 多选框：`input[type=checkbox][data-bp-multi-check]` 勾选态 ↔ multiSelectedIds
 * - 落点线：`data-bp-drop-line` 节点按 `setDropTarget` 显隐与 side
 * - slash 宿主：`data-bp-slash-host` 按 SlashMenuModel.open 显隐
 *
 * ## 诚实边界（强制）
 * - **DOM 交付 ≠ EL-01**；**≠** A-BLK-02/04/05 产品 e2e 全关
 * - **≠** Notion chrome / 拖拽预览全链路 / 桌面 React 挂载
 * - collab Strict 子集（`chrome.w3f_apply.test.ts`）**不得**回退为 mock 默认
 *
 * 测：`chrome.w3f_dom.test.ts`
 */

import type { BlockId } from '@crish/block-paper-contract';
import type { BlockChromeModel, HandleVisibility } from './BlockChrome';
import type { SlashMenuModel } from './SlashMenuModel';

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

export type ChromeDomBlockSpec = {
  blockId: BlockId;
};

export type BlockChromeDomHostOptions = {
  /** 要挂 chrome 行的逻辑块列表（顺序 = DOM 顺序） */
  blocks: readonly ChromeDomBlockSpec[];
  /** 呈现源：把手 / 多选 / 折叠 */
  chrome: BlockChromeModel;
  /**
   * 可选 slash 模型：打开时露出 slash 浮层宿主（仅容器，不实现 catalog UI）。
   * 未注入时 slash 宿主恒 hidden。
   */
  slash?: SlashMenuModel;
  /**
   * 多选框变更回调（宿主 ↔ model 同步后通知）。
   * **不**自动 submit delete；调用方负责 Intent → collab sink。
   */
  onMultiSelectionChange?: (blockIds: readonly BlockId[]) => void;
};

// ---------------------------------------------------------------------------
// data-* 契约（测名与 e2e 可锚定）
// ---------------------------------------------------------------------------

export const BP_CHROME_ROOT = 'data-bp-chrome-root';
export const BP_BLOCK_ROW = 'data-bp-block-row';
export const BP_BLOCK_ID = 'data-block-id';
export const BP_HANDLE = 'data-bp-handle';
export const BP_HANDLE_VISIBILITY = 'data-handle-visibility';
export const BP_MULTI_CHECK = 'data-bp-multi-check';
export const BP_DROP_LINE = 'data-bp-drop-line';
export const BP_DROP_SIDE = 'data-drop-side';
export const BP_DROP_TARGET = 'data-drop-target';
export const BP_SLASH_HOST = 'data-bp-slash-host';
export const BP_SLASH_OPEN = 'data-slash-open';

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/**
 * 最小 chrome DOM 宿主：把 model 投影到 DOM，不持有文档权威。
 */
export class BlockChromeDomHost {
  private readonly root: HTMLElement;
  private readonly chrome: BlockChromeModel;
  private readonly slash: SlashMenuModel | undefined;
  private readonly onMultiSelectionChange:
    ((blockIds: readonly BlockId[]) => void) | undefined;
  private readonly rows = new Map<BlockId, HTMLElement>();
  private readonly handles = new Map<BlockId, HTMLElement>();
  private readonly checks = new Map<BlockId, HTMLInputElement>();
  private readonly dropLine: HTMLElement;
  private readonly slashHost: HTMLElement;
  private dropTarget: DropLineTarget | null = null;
  private destroyed = false;
  private readonly blockOrder: BlockId[];

  constructor(parent: HTMLElement, options: BlockChromeDomHostOptions) {
    this.chrome = options.chrome;
    this.slash = options.slash;
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

    // 落点线：单例指示器，sync 时挂到目标行 before/after 视觉位（属性契约）
    const dropLine = doc.createElement('div');
    dropLine.className = 'bp-drop-line';
    dropLine.setAttribute(BP_DROP_LINE, '1');
    dropLine.setAttribute(BP_DROP_SIDE, '');
    dropLine.setAttribute(BP_DROP_TARGET, '');
    dropLine.hidden = true;
    root.appendChild(dropLine);
    this.dropLine = dropLine;

    // slash 浮层宿主（仅容器；catalog 渲染后置）
    const slashHost = doc.createElement('div');
    slashHost.className = 'bp-slash-host';
    slashHost.setAttribute(BP_SLASH_HOST, '1');
    slashHost.setAttribute(BP_SLASH_OPEN, '0');
    slashHost.hidden = true;
    root.appendChild(slashHost);
    this.slashHost = slashHost;

    this.sync();
  }

  // -----------------------------------------------------------------------
  // 公共 API
  // -----------------------------------------------------------------------

  /** 从 model 重投影全部 chrome DOM（把手 / 多选 / slash / 落点线） */
  sync(): void {
    this.assertAlive();
    for (const id of this.blockOrder) {
      this.syncRow(id);
    }
    this.syncDropLine();
    this.syncSlashHost();
  }

  /**
   * 设置拖拽落点（纯呈现；**不**产 Move Intent）。
   * 真正重排须：`buildMoveBlocksIntent` → `submitIntent` → collab sink。
   */
  setDropTarget(
    blockId: BlockId | null,
    side: DropLineSide | null = 'before'
  ): void {
    this.assertAlive();
    if (!blockId || !side || !this.rows.has(blockId)) {
      this.dropTarget = null;
    } else {
      this.dropTarget = { blockId, side };
    }
    this.syncDropLine();
  }

  clearDropTarget(): void {
    this.setDropTarget(null, null);
  }

  getDropTarget(): DropLineTarget | null {
    return this.dropTarget ? { ...this.dropTarget } : null;
  }

  /** 落点线是否可见（DOM 契约） */
  isDropLineVisible(): boolean {
    return !this.dropLine.hidden;
  }

  getDropLineElement(): HTMLElement {
    return this.dropLine;
  }

  /** 读取 DOM 上把手可见性属性（测锚定） */
  getHandleVisibilityAttr(blockId: BlockId): HandleVisibility | null {
    const el = this.handles.get(blockId);
    if (!el) return null;
    const v = el.getAttribute(BP_HANDLE_VISIBILITY);
    if (v === 'hidden' || v === 'hover' || v === 'focus' || v === 'multi') {
      return v;
    }
    return null;
  }

  /** 多选框是否勾选（DOM 契约） */
  isMultiCheckboxChecked(blockId: BlockId): boolean {
    return this.checks.get(blockId)?.checked ?? false;
  }

  /** slash 宿主是否打开态（DOM 契约） */
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
    this.root.remove();
  }

  // -----------------------------------------------------------------------
  // 内部
  // -----------------------------------------------------------------------

  private onCheckChange(blockId: BlockId, check: HTMLInputElement): void {
    if (this.destroyed) return;
    const selected = new Set(this.chrome.getSnapshot().multiSelectedIds);
    if (check.checked) {
      selected.add(blockId);
    } else {
      selected.delete(blockId);
    }
    // 保序：沿 blockOrder
    const next = this.blockOrder.filter((id) => selected.has(id));
    this.chrome.setMultiSelected(next);
    this.sync();
    this.onMultiSelectionChange?.(next);
  }

  private syncRow(blockId: BlockId): void {
    const handle = this.handles.get(blockId);
    const check = this.checks.get(blockId);
    if (!handle || !check) return;

    const vis = this.chrome.getHandleVisibility(blockId);
    handle.setAttribute(BP_HANDLE_VISIBILITY, vis);
    // 可见性：hidden 时 aria/hidden；其余露出（产品 L0 按需）
    const showHandle = vis !== 'hidden';
    handle.hidden = !showHandle;
    handle.style.visibility = showHandle ? 'visible' : 'hidden';

    const multi = this.chrome.isMultiSelected(blockId);
    check.checked = multi;
    // 多选框：有多选集或本行 multi 时显示；纯 L0 无多选时仍可渲染但默认未勾选
    // 产品策略：始终挂载控件，靠 checked + 父级 CSS 控噪；此处不强制 hidden
  }

  private syncDropLine(): void {
    const t = this.dropTarget;
    if (!t) {
      this.dropLine.hidden = true;
      this.dropLine.setAttribute(BP_DROP_SIDE, '');
      this.dropLine.setAttribute(BP_DROP_TARGET, '');
      // 挂回 root 末尾，避免残留在某行
      if (this.dropLine.parentElement !== this.root) {
        this.root.appendChild(this.dropLine);
      }
      return;
    }

    const row = this.rows.get(t.blockId);
    if (!row) {
      this.dropLine.hidden = true;
      return;
    }

    this.dropLine.hidden = false;
    this.dropLine.setAttribute(BP_DROP_SIDE, t.side);
    this.dropLine.setAttribute(BP_DROP_TARGET, t.blockId);

    // 插到目标行 before/after，便于 DOM 序断言
    if (t.side === 'before') {
      row.parentElement?.insertBefore(this.dropLine, row);
    } else {
      row.parentElement?.insertBefore(this.dropLine, row.nextSibling);
    }
  }

  private syncSlashHost(): void {
    const open = this.slash?.isOpen() === true;
    this.slashHost.hidden = !open;
    this.slashHost.setAttribute(BP_SLASH_OPEN, open ? '1' : '0');
    if (open && this.slash) {
      const snap = this.slash.getSnapshot();
      if (snap.blockId) {
        this.slashHost.setAttribute(BP_BLOCK_ID, snap.blockId);
      }
    } else {
      this.slashHost.removeAttribute(BP_BLOCK_ID);
    }
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error('BlockChromeDomHost：已 destroy');
    }
  }
}

/** 类型守卫 */
export function isBlockChromeDomHost(v: unknown): v is BlockChromeDomHost {
  return v instanceof BlockChromeDomHost;
}
