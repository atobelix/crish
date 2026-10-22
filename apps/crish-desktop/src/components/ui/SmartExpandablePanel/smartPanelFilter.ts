import type { MenuGroup, MenuItem } from './types';

/**
 * 按搜索词过滤面板条目（label / sublabel / searchKeywords，大小写不敏感）。
 * 分组只保留命中的子项，整组无命中则剔除；空查询原样返回。
 */
export function filterSmartPanelItems(
  items: Array<MenuItem | MenuGroup>,
  query: string
): Array<MenuItem | MenuGroup> {
  const q = query.trim().toLowerCase();
  if (!q) return items;

  const matchNode = (item: MenuItem): boolean => {
    const target = `${item.label || ''} ${item.sublabel || ''} ${
      item.searchKeywords || ''
    }`.toLowerCase();
    return target.includes(q);
  };

  return items
    .map((entry) => {
      if ('items' in entry && Array.isArray((entry as MenuGroup).items)) {
        const matched = (entry as MenuGroup).items.filter(matchNode);
        return matched.length > 0 ? { ...entry, items: matched } : null;
      }
      return matchNode(entry as MenuItem) ? entry : null;
    })
    .filter(Boolean) as Array<MenuItem | MenuGroup>;
}
