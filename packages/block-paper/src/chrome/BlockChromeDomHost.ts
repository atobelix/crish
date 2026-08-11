/**
 * W3-F DOM 余量 · chrome 最小 DOM 宿主（把手可见性 / 多选框 / 落点线 / slash 宿主 / 拖拽预览）。
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
 * - slash 宿主：`data-bp-slash-host` 按 SlashMenuModel.open 显隐 + **catalog 最小投影**
 *   （group / item / empty；`data-active` 对齐 activeIndex；**不**提交 Intent）
 * - **拖拽预览子集**：`data-bp-drag-preview` + 源行 `data-dragging`；指针形状 mock 可驱动落点
 *
 * ## 视觉皮（≠ 本文件职责）
 * - 类名：`bp-chrome-root` / `bp-block-row` / `bp-block-handle` / `bp-drop-line` /
 *   `bp-slash-host` / `bp-slash-item` / `bp-slash-group-label` / `bp-drag-preview`
 * - 产品 CSS：`@crish/block-paper/chrome.css`（token 化落点线 / slash / 把手热区）
 * - **DOM 契约测不依赖像素色**；**视觉皮 ≠ EL-01**；**≠** A-BLK-02 slash 产品 e2e 全关
 *
 * ## 诚实边界（强制）
 * - **DOM 交付 ≠ EL-01**；**≠** A-BLK-02/04/05 产品 e2e 全关
 * - **≠** Notion chrome / 桌面 React 挂载 / 拖拽产品 e2e 全关
 * - collab Strict 子集（`chrome.w3f_apply.test.ts`）**不得**回退为 mock 默认
 *
 * 测：`chrome.w3f_dom.test.ts` · `chrome.w3f_drag.test.ts`
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
  /**
   * 可选 flavour 提示（仅呈现 `data-flavour`；**不**当文档权威）。
   * chrome.css 可对 code/quote 等做轻量区分。
   */
  flavour?: string;
};

/**
 * 拖拽预览状态（纯呈现；**不**产 Move Intent）。
 * 真正重排须：`buildMoveBlocksIntent` → `submitIntent` → collab sink。
 */
export type DragPreviewState = {
  sourceBlockId: BlockId;
  /** 可选预览标签（如块摘要） */
  label?: string;
};

/**
 * 指针事件形状（jsdom 无布局命中时由测/适配层注入 overBlockId）。
 * 宿主只做呈现投影，**不**绑定真实 PointerEvent 监听器（产品挂载后置）。
 */
export type DragPointerShape = {
  phase: 'down' | 'move' | 'up' | 'cancel';
  /** down：拖拽源块（通常为把手所属行） */
  sourceBlockId?: BlockId;
  /** move：当前悬停目标块（null = 离开列表） */
  overBlockId?: BlockId | null;
  /** move：落点边（默认 before） */
  side?: DropLineSide | null;
  /** 可选预览标签 */
  label?: string;
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
/** slash catalog 项（可见皮 DOM 契约） */
export const BP_SLASH_ITEM = 'data-bp-slash-item';
/** slash 分组标签 */
export const BP_SLASH_GROUP = 'data-bp-slash-group';
/** slash 无结果空态 */
export const BP_SLASH_EMPTY = 'data-bp-slash-empty';
/** 拖拽预览指示器（ghost 节点） */
export const BP_DRAG_PREVIEW = 'data-bp-drag-preview';
/** 预览 / 源行上的源块 id */
export const BP_DRAG_SOURCE = 'data-drag-source';
/** 源行正在被拖拽 */
export const BP_DRAGGING = 'data-dragging';

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
  private readonly dragPreview: HTMLElement;
  private dropTarget: DropLineTarget | null = null;
  private dragState: DragPreviewState | null = null;
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
      row.setAttribute(BP_DRAGGING, '0');
      if (spec.flavour) {
        row.setAttribute('data-flavour', spec.flavour);
      }

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

    // 拖拽预览 ghost（单例；active 时 data-drag-source 锚定源块）
    const dragPreview = doc.createElement('div');
    dragPreview.className = 'bp-drag-preview';
    dragPreview.setAttribute(BP_DRAG_PREVIEW, '1');
    dragPreview.setAttribute(BP_DRAG_SOURCE, '');
    dragPreview.setAttribute('aria-hidden', 'true');
    dragPreview.hidden = true;
    root.appendChild(dragPreview);
    this.dragPreview = dragPreview;

    // slash 浮层宿主（open 时投影 group/item catalog；关时清空）
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

  /** 从 model 重投影全部 chrome DOM（把手 / 多选 / slash / 落点线 / 拖拽预览） */
  sync(): void {
    this.assertAlive();
    for (const id of this.blockOrder) {
      this.syncRow(id);
    }
    this.syncDropLine();
    this.syncDragPreview();
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

  // -----------------------------------------------------------------------
  // 拖拽预览子集（W3-F DOM · 可测契约）
  // -----------------------------------------------------------------------

  /**
   * 开始拖拽预览（源块把手按下后的呈现态）。
   * @returns false 若 blockId 不在列表
   */
  startDragPreview(sourceBlockId: BlockId, label?: string): boolean {
    this.assertAlive();
    if (!this.rows.has(sourceBlockId)) {
      return false;
    }
    this.dragState = { sourceBlockId, label };
    this.syncDragPreview();
    return true;
  }

  /** 清除拖拽预览（保留落点线，除非调用 endDrag） */
  clearDragPreview(): void {
    this.assertAlive();
    this.dragState = null;
    this.syncDragPreview();
  }

  /**
   * 结束拖拽会话：清预览 + 清落点线。
   * **不**自动 submit Move Intent——调用方在 up 后自行决定是否 wire。
   */
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

  /** 拖拽预览是否可见（DOM 契约） */
  isDragPreviewVisible(): boolean {
    return !this.dragPreview.hidden;
  }

  /**
   * 应用指针形状 mock（jsdom 可测入口）。
   * - down：startDragPreview
   * - move：setDropTarget（需已在 dragging）
   * - up / cancel：endDrag
   */
  applyDragPointerShape(shape: DragPointerShape): void {
    this.assertAlive();
    switch (shape.phase) {
      case 'down': {
        const src = shape.sourceBlockId;
        if (src) {
          this.startDragPreview(src, shape.label);
        }
        break;
      }
      case 'move': {
        if (!this.dragState) return;
        const over = shape.overBlockId;
        if (over === null || over === undefined) {
          this.clearDropTarget();
        } else if (over === this.dragState.sourceBlockId) {
          // 悬停自身：隐藏落点（禁止无意义自落）
          this.clearDropTarget();
        } else {
          const side = shape.side ?? 'before';
          this.setDropTarget(over, side);
        }
        break;
      }
      case 'up':
      case 'cancel': {
        this.endDrag();
        break;
      }
      default:
        break;
    }
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
    this.dragState = null;
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
    const row = this.rows.get(blockId);
    if (!handle || !check || !row) return;

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

    // 拖拽源行标记
    const dragging =
      this.dragState !== null && this.dragState.sourceBlockId === blockId;
    row.setAttribute(BP_DRAGGING, dragging ? '1' : '0');
  }

  private syncDragPreview(): void {
    const s = this.dragState;
    if (!s || !this.rows.has(s.sourceBlockId)) {
      this.dragPreview.hidden = true;
      this.dragPreview.setAttribute(BP_DRAG_SOURCE, '');
      this.dragPreview.textContent = '';
      // 同步各行 data-dragging
      for (const id of this.blockOrder) {
        this.rows.get(id)?.setAttribute(BP_DRAGGING, '0');
      }
      return;
    }

    this.dragPreview.hidden = false;
    this.dragPreview.setAttribute(BP_DRAG_SOURCE, s.sourceBlockId);
    this.dragPreview.textContent = s.label ?? s.sourceBlockId;
    for (const id of this.blockOrder) {
      this.rows
        .get(id)
        ?.setAttribute(BP_DRAGGING, id === s.sourceBlockId ? '1' : '0');
    }
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

    if (!open || !this.slash) {
      this.slashHost.removeAttribute(BP_BLOCK_ID);
      this.slashHost.removeAttribute('data-slash-query');
      this.slashHost.removeAttribute('aria-activedescendant');
      this.slashHost.replaceChildren();
      return;
    }

    const snap = this.slash.getSnapshot();
    if (snap.blockId) {
      this.slashHost.setAttribute(BP_BLOCK_ID, snap.blockId);
    } else {
      this.slashHost.removeAttribute(BP_BLOCK_ID);
    }
    this.slashHost.setAttribute('data-slash-query', snap.query);
    this.slashHost.setAttribute('role', 'listbox');
    this.slashHost.setAttribute('aria-label', '斜杠命令');

    // catalog 最小投影：group 标签 + item 行（纯呈现；点击不产 Intent）
    this.renderSlashCatalog(snap.items, snap.activeIndex);
  }

  /**
   * 将 SlashMenuModel 过滤后的 items 投影为 group/item DOM。
   * - 按 `group` 字段分段；无 group 归入空标签段（不渲染 label）
   * - `data-active` / `aria-selected` 对齐 activeIndex（键盘高亮皮）
   * - 空 items → 空态节点（过滤无结果）
   */
  private renderSlashCatalog(
    items: readonly {
      id: string;
      title: string;
      description?: string;
      group?: string;
    }[],
    activeIndex: number
  ): void {
    const doc = this.slashHost.ownerDocument;
    this.slashHost.replaceChildren();

    if (items.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'bp-slash-empty';
      empty.setAttribute(BP_SLASH_EMPTY, '1');
      empty.setAttribute('role', 'status');
      empty.textContent = '无匹配项';
      this.slashHost.appendChild(empty);
      this.slashHost.removeAttribute('aria-activedescendant');
      return;
    }

    // 保序分组：相邻同 group 合并；不重排 catalog 顺序
    type Item = (typeof items)[number];
    type Seg = { group: string | undefined; items: Item[] };
    const segs: Seg[] = [];
    for (const it of items) {
      const g = it.group;
      const last = segs[segs.length - 1];
      if (last && last.group === g) {
        last.items.push(it);
      } else {
        segs.push({ group: g, items: [it] });
      }
    }

    let flatIndex = 0;
    let activeDomId: string | null = null;

    for (const seg of segs) {
      if (seg.group) {
        const label = doc.createElement('div');
        label.className = 'bp-slash-group-label';
        label.setAttribute(BP_SLASH_GROUP, seg.group);
        label.setAttribute('role', 'presentation');
        label.textContent = seg.group;
        this.slashHost.appendChild(label);
      }

      for (const it of seg.items) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'bp-slash-item';
        btn.setAttribute(BP_SLASH_ITEM, '1');
        btn.setAttribute('data-item-id', it.id);
        btn.setAttribute('role', 'option');
        btn.id = `bp-slash-opt-${it.id}`;
        btn.tabIndex = -1;

        const isActive = flatIndex === activeIndex;
        btn.setAttribute('data-active', isActive ? '1' : '0');
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        if (isActive) {
          activeDomId = btn.id;
        }

        // 图标占位（字母首字；产品可后置真实 icon）
        const icon = doc.createElement('span');
        icon.className = 'bp-slash-item-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = (it.title.trim().charAt(0) || '?').toUpperCase();

        const body = doc.createElement('span');
        body.className = 'bp-slash-item-body';

        const title = doc.createElement('span');
        title.className = 'bp-slash-item-title';
        title.textContent = it.title;

        body.appendChild(title);
        if (it.description) {
          const desc = doc.createElement('span');
          desc.className = 'bp-slash-item-desc';
          desc.textContent = it.description;
          body.appendChild(desc);
        }

        btn.appendChild(icon);
        btn.appendChild(body);
        this.slashHost.appendChild(btn);
        flatIndex += 1;
      }
    }

    if (activeDomId) {
      this.slashHost.setAttribute('aria-activedescendant', activeDomId);
    } else {
      this.slashHost.removeAttribute('aria-activedescendant');
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
