import type { FsDirEntry } from '../../api/workspaceFsApi';

export type TreeNode = FsDirEntry & { depth: number };

/**
 * 展平并按搜索关键词过滤文件树节点
 */
export function filterTreeNodes(
  entries: FsDirEntry[],
  expanded: Record<string, FsDirEntry[] | undefined>,
  filter: string
): TreeNode[] {
  const q = filter.trim().toLowerCase();
  const out: TreeNode[] = [];

  const walk = (list: FsDirEntry[], depth: number) => {
    for (const e of list) {
      out.push({ ...e, depth });
      const childEntries = expanded[e.path];
      if (e.isDir && childEntries && Array.isArray(childEntries)) {
        walk(childEntries, depth + 1);
      }
    }
  };

  walk(entries, 0);

  if (!q) return out;
  return out.filter((n) => n.name.toLowerCase().includes(q));
}

/**
 * 过滤并排序面包屑下拉菜单中的目录条目（文件夹在前，字母排序）
 */
export function filterBcFlyoutEntries(
  entries: FsDirEntry[],
  filter: string
): FsDirEntry[] {
  const q = filter.trim().toLowerCase();
  let list = entries;
  if (q) {
    list = list.filter((e) => e.name.toLowerCase().includes(q));
  }
  return [...list].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}
