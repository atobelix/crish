/**
 * W3-F DOM · slash catalog 投影（纯呈现）
 *
 * ## 角色
 * - 把 `SlashMenuModel` 过滤后的 items 投影为 group / item / empty DOM
 * - **仅** jsdom 契约测 / 无 React Overlay 的宿主显式启用（`projectSlashCatalog: true`）
 * - 产品树挂 React `SlashMenuOverlay` 时 **不得** 走本路径（防双浮层）
 *
 * ## 诚实边界
 * - **≠ EL-01**；**≠** A-BLK-02 slash 产品 e2e 全关
 * - 点击不产 Intent；Intent 由 React Overlay / selectAndSubmit 负责
 *
 * 由 `BlockChromeDomHost.syncSlashHost` 编排调用。
 */

import { groupSlashCatalogItems } from './slashSelectAndSubmit';
import type { SlashMenuModel } from './SlashMenuModel';

// ---------------------------------------------------------------------------
// data-* 契约（slash）
// ---------------------------------------------------------------------------

export const BP_SLASH_HOST = 'data-bp-slash-host';
export const BP_SLASH_OPEN = 'data-slash-open';
/** slash catalog 项（可见皮 DOM 契约） */
export const BP_SLASH_ITEM = 'data-bp-slash-item';
/** slash 分组标签 */
export const BP_SLASH_GROUP = 'data-bp-slash-group';
/** slash 无结果空态 */
export const BP_SLASH_EMPTY = 'data-bp-slash-empty';

/** React 浮层接管时宿主标记（无 catalog 子节点） */
export const SLASH_CATALOG_REACT = 'react';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type SlashCatalogItem = {
  id: string;
  title: string;
  description?: string;
  group?: string;
};

// ---------------------------------------------------------------------------
// React 模式：让位 Overlay，清空 item 节点
// ---------------------------------------------------------------------------

/**
 * React `SlashMenuOverlay` 接管 catalog 时：
 * DomHost slash 宿主恒 hidden，标记 `data-slash-catalog=react`，无 item 子节点。
 */
export function applySlashHostReactCatalogMode(slashHost: HTMLElement): void {
  slashHost.hidden = true;
  slashHost.setAttribute(BP_SLASH_OPEN, '0');
  slashHost.setAttribute('data-slash-catalog', SLASH_CATALOG_REACT);
  slashHost.removeAttribute('data-block-id');
  slashHost.removeAttribute('data-slash-query');
  slashHost.removeAttribute('aria-activedescendant');
  slashHost.replaceChildren();
}

// ---------------------------------------------------------------------------
// Dom catalog 模式：投影 group/item/empty
// ---------------------------------------------------------------------------

/**
 * 将 SlashMenuModel 过滤后的 items 投影为 group/item DOM。
 * - 按 `group` 字段分段；无 group 归入空标签段（不渲染 label）
 * - `data-active` / `aria-selected` 对齐 activeIndex（键盘高亮皮）
 * - 空 items → 空态节点（过滤无结果）
 */
export function renderSlashCatalog(
  slashHost: HTMLElement,
  items: readonly SlashCatalogItem[],
  activeIndex: number
): void {
  const doc = slashHost.ownerDocument;
  slashHost.replaceChildren();

  if (items.length === 0) {
    const empty = doc.createElement('div');
    empty.className = 'bp-slash-empty';
    empty.setAttribute(BP_SLASH_EMPTY, '1');
    empty.setAttribute('role', 'status');
    empty.textContent = '无匹配项';
    slashHost.appendChild(empty);
    slashHost.removeAttribute('aria-activedescendant');
    return;
  }

  // 保序分组：与 React 浮层共用 groupSlashCatalogItems
  const segs = groupSlashCatalogItems(items);

  let flatIndex = 0;
  let activeDomId: string | null = null;

  for (const seg of segs) {
    if (seg.group) {
      const label = doc.createElement('div');
      label.className = 'bp-slash-group-label';
      label.setAttribute(BP_SLASH_GROUP, seg.group);
      label.setAttribute('role', 'presentation');
      label.textContent = seg.group;
      slashHost.appendChild(label);
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
      slashHost.appendChild(btn);
      flatIndex += 1;
    }
  }

  if (activeDomId) {
    slashHost.setAttribute('aria-activedescendant', activeDomId);
  } else {
    slashHost.removeAttribute('aria-activedescendant');
  }
}

/**
 * DomHost slash 宿主完整 sync。
 * - `projectSlashCatalog=false`（默认）：React 模式让位，无 item 节点
 * - `projectSlashCatalog=true`：投影 catalog（契约测显式开启）
 */
export function syncSlashHostDom(args: {
  slashHost: HTMLElement;
  projectSlashCatalog: boolean;
  slash: SlashMenuModel | undefined;
}): void {
  const { slashHost, projectSlashCatalog, slash } = args;

  if (!projectSlashCatalog) {
    applySlashHostReactCatalogMode(slashHost);
    return;
  }

  const open = slash?.isOpen() === true;
  slashHost.hidden = !open;
  slashHost.setAttribute(BP_SLASH_OPEN, open ? '1' : '0');
  slashHost.removeAttribute('data-slash-catalog');

  if (!open || !slash) {
    slashHost.removeAttribute('data-block-id');
    slashHost.removeAttribute('data-slash-query');
    slashHost.removeAttribute('aria-activedescendant');
    slashHost.replaceChildren();
    return;
  }

  const snap = slash.getSnapshot();
  if (snap.blockId) {
    slashHost.setAttribute('data-block-id', snap.blockId);
  } else {
    slashHost.removeAttribute('data-block-id');
  }
  slashHost.setAttribute('data-slash-query', snap.query);
  slashHost.setAttribute('role', 'listbox');
  slashHost.setAttribute('aria-label', '斜杠命令');

  renderSlashCatalog(slashHost, snap.items, snap.activeIndex);
}

/** 创建 slash 宿主空壳并挂到 root */
export function createSlashHostElement(
  doc: Document,
  root: HTMLElement
): HTMLElement {
  const slashHost = doc.createElement('div');
  slashHost.className = 'bp-slash-host';
  slashHost.setAttribute(BP_SLASH_HOST, '1');
  slashHost.setAttribute(BP_SLASH_OPEN, '0');
  slashHost.hidden = true;
  root.appendChild(slashHost);
  return slashHost;
}
