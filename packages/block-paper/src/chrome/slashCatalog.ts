/**
 * Slash 默认目录 + 过滤（SD-55 · catalog）。
 *
 * 假数据；不接线真实 flavour 注册表。
 * 产品树 catalog 投影仍由 DomHost `projectSlashCatalog === true` 才开；
 * **本模不改任何默认 true**。
 *
 * **≠ EL-01**；**≠** 占 SD-13 Overlay / SD-48 DomHost；**≠** 默开 catalog。
 */

import type { SlashContribution } from '@crish/block-paper-contract';
import type { SlashMenuItemView } from './SlashMenuModel.types';

// ---------------------------------------------------------------------------
// 默认目录（假数据；不接线真实 flavour 注册表）
// ---------------------------------------------------------------------------

export const DEFAULT_SLASH_CATALOG: readonly SlashContribution[] = [
  { id: 'paragraph', title: '正文', description: '普通段落', group: '基础' },
  { id: 'heading-1', title: '标题 1', description: '一级标题', group: '基础' },
  { id: 'heading-2', title: '标题 2', description: '二级标题', group: '基础' },
  { id: 'bullet', title: '无序列表', description: '项目符号', group: '列表' },
  { id: 'numbered', title: '有序列表', description: '编号列表', group: '列表' },
  { id: 'code', title: '代码块', description: '等宽代码', group: '高级' },
  { id: 'quote', title: '引用', description: '引用块', group: '高级' },
  { id: 'divider', title: '分割线', description: '水平线', group: '高级' },
];

// ---------------------------------------------------------------------------
// 过滤
// ---------------------------------------------------------------------------

function toView(item: SlashContribution): SlashMenuItemView {
  const view: SlashMenuItemView = {
    id: item.id,
    title: item.title,
  };
  if (item.description !== undefined) {
    view.description = item.description;
  }
  if (item.group !== undefined) {
    view.group = item.group;
  }
  return view;
}

/**
 * 按 query 过滤目录（标题 / id / description 子串，大小写不敏感）。
 * 空 query → 全部。
 */
export function filterSlashCatalog(
  catalog: readonly SlashContribution[],
  query: string
): SlashMenuItemView[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return catalog.map(toView);
  }
  return catalog
    .filter((item) => {
      const hay = [
        item.id,
        item.title,
        item.description ?? '',
        item.group ?? '',
      ]
        .join('\n')
        .toLowerCase();
      return hay.includes(q);
    })
    .map(toView);
}
