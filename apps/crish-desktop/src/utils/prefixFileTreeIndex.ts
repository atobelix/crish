/**
 * 万级文件树纯前缀路径局部变异索引（Stage 07 核心原语）：
 * - 单例 Intl.Collator (FILE_TREE_COLLATOR) 预编译同级字典序，消除运行时比较器分配与 GC 抖动
 * - 单点展开 O(depth + K) 局部 splice 注入，单点折叠 O(M) 连续前缀区间截除，彻底废除全树递归 walk
 * - 虚拟切片 getVisibleSlice 刚性限制挂载 DOM 节点数恒定 <= 60
 */

export const DEFAULT_FILE_TREE_ROW_HEIGHT = 28;
export const MAX_FILE_TREE_DOM_NODES = 60;

export const FILE_TREE_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export interface FileTreeNode {
  path: string;
  name: string;
  kind: 'directory' | 'file';
  type: 'directory' | 'file';
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
}

export type VisibleFileTreeSlice = ReadonlyArray<FileTreeNode> & {
  readonly items: readonly FileTreeNode[];
  readonly startIndex: number;
  readonly endIndex: number;
  readonly offsetTop: number;
  readonly totalHeight: number;
  readonly totalCount: number;
};

function normPath(raw: string): { path: string; isDir: boolean } {
  const s = String(raw ?? '')
    .replace(/\\/g, '/')
    .trim();
  return {
    path: s.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/'),
    isDir: s.endsWith('/'),
  };
}

/**
 * 窗口化可见节点切片纯函数：刚性保证返回 DOM 渲染节点数恒定 <= 60
 */
export function getVisibleSlice(
  flatTree: readonly FileTreeNode[],
  scrollTop: number,
  viewportHeight: number,
  rowHeight = DEFAULT_FILE_TREE_ROW_HEIGHT,
  maxDomNodes = MAX_FILE_TREE_DOM_NODES
): VisibleFileTreeSlice {
  const h =
    Number.isFinite(rowHeight) && rowHeight > 0
      ? rowHeight
      : DEFAULT_FILE_TREE_ROW_HEIGHT;
  const cap =
    Number.isFinite(maxDomNodes) && maxDomNodes > 0
      ? Math.min(MAX_FILE_TREE_DOM_NODES, Math.floor(maxDomNodes))
      : MAX_FILE_TREE_DOM_NODES;

  const totalCount = flatTree.length;
  let startIndex = 0;
  let endIndex = 0;
  if (totalCount > 0) {
    const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
    const viewH =
      Number.isFinite(viewportHeight) && viewportHeight > 0
        ? viewportHeight
        : h;
    const firstRow = Math.min(totalCount - 1, Math.floor(top / h));
    const visRows = Math.max(1, Math.ceil(viewH / h));
    const overscan =
      visRows >= cap ? 0 : Math.min(10, Math.floor((cap - visRows) / 2));
    startIndex =
      visRows >= cap
        ? Math.min(firstRow, Math.max(0, totalCount - cap))
        : Math.max(0, firstRow - overscan);
    endIndex = Math.min(
      totalCount,
      startIndex + cap,
      firstRow + visRows + overscan
    );
  }

  const items = flatTree.slice(startIndex, endIndex);
  const offsetTop = startIndex * h;
  const totalHeight = totalCount * h;
  return Object.assign(items, {
    items,
    startIndex,
    endIndex,
    offsetTop,
    totalHeight,
    totalCount,
  });
}

/**
 * 万级文件树纯前缀路径增量索引：
 * - 通过路径前缀 O(depth + K) 局部插入/删除/展开/折叠目录，无需全树递归重建
 * - 提供窗口化可见节点切片 getVisibleSlice，确保返回 DOM 渲染项数量严格 <= 60
 */
export class PrefixFileTreeIndex {
  readonly nodesByPath = new Map<string, FileTreeNode>();
  readonly childrenByParent = new Map<string, string[]>();
  readonly expandedFolders = new Set<string>();
  private readonly defaultExpanded: boolean;
  private flatTree: FileTreeNode[] = [];

  constructor(options: { defaultExpanded?: boolean } = {}) {
    this.defaultExpanded = options.defaultExpanded ?? true;
  }

  get visibleCount(): number {
    return this.flatTree.length;
  }

  getFlatNodes(): readonly FileTreeNode[] {
    return this.flatTree;
  }

  upsertPaths(paths: readonly string[]): number {
    if (!paths || paths.length === 0) return this.flatTree.length;
    const wasEmpty = this.flatTree.length === 0;
    const dirtyParents = new Set<string>();

    for (let pIdx = 0; pIdx < paths.length; pIdx++) {
      const { path, isDir } = normPath(paths[pIdx]!);
      if (!path) continue;
      const parts = path.split('/');
      let cur = '';
      for (let i = 0; i < parts.length; i++) {
        const name = parts[i];
        if (!name) continue;
        const parentPath = cur;
        cur = parentPath ? `${parentPath}/${name}` : name;
        const kind: 'directory' | 'file' =
          i < parts.length - 1 || isDir ? 'directory' : 'file';
        const existing = this.nodesByPath.get(cur);

        if (!existing) {
          const expanded = kind === 'directory' && this.defaultExpanded;
          if (expanded) this.expandedFolders.add(cur);
          this.nodesByPath.set(cur, {
            path: cur,
            name,
            kind,
            type: kind,
            depth: i,
            expanded,
            hasChildren: false,
          });
          const list = this.childrenByParent.get(parentPath);
          if (list) list.push(cur);
          else this.childrenByParent.set(parentPath, [cur]);
          dirtyParents.add(parentPath);
        } else if (kind === 'directory' && existing.kind === 'file') {
          existing.kind = existing.type = 'directory';
          if (this.defaultExpanded) {
            existing.expanded = true;
            this.expandedFolders.add(cur);
          }
          dirtyParents.add(parentPath);
        }
      }
    }

    if (dirtyParents.size === 0) return this.flatTree.length;
    for (const p of dirtyParents) {
      this.sortChildren(p);
      const pNode = p ? this.nodesByPath.get(p) : undefined;
      if (pNode) {
        pNode.hasChildren = (this.childrenByParent.get(p)?.length ?? 0) > 0;
      }
    }

    if (wasEmpty || dirtyParents.has('')) {
      const nextFlat: FileTreeNode[] = [];
      this.buildSubtreeInto('', 0, nextFlat);
      this.flatTree = nextFlat;
      return this.flatTree.length;
    }

    for (const dir of dirtyParents) {
      let anc = dir;
      let hasDirtyAnc = false;
      while (anc.includes('/')) {
        anc = anc.slice(0, anc.lastIndexOf('/'));
        if (dirtyParents.has(anc)) {
          hasDirtyAnc = true;
          break;
        }
      }
      if (!hasDirtyAnc) this.syncFlatDir(dir);
    }
    return this.flatTree.length;
  }

  removePrefix(prefixPath: string): number {
    const { path } = normPath(prefixPath);
    if (!path) {
      this.nodesByPath.clear();
      this.childrenByParent.clear();
      this.expandedFolders.clear();
      return this.flatTree.splice(0).length;
    }

    const parent = path.includes('/')
      ? path.slice(0, path.lastIndexOf('/'))
      : '';
    const siblings = this.childrenByParent.get(parent);
    if (siblings) {
      const sIdx = siblings.indexOf(path);
      if (sIdx >= 0) siblings.splice(sIdx, 1);
      const pNode = parent ? this.nodesByPath.get(parent) : undefined;
      if (pNode) pNode.hasChildren = siblings.length > 0;
    }

    let removed = 0;
    const startIdx = this.findFlatIndex(path);
    if (startIdx >= 0) {
      const targetDepth = this.flatTree[startIdx]!.depth;
      const flat = this.flatTree;
      const len = flat.length;
      removed = 1;
      while (
        startIdx + removed < len &&
        flat[startIdx + removed]!.depth > targetDepth
      ) {
        removed++;
      }
      this.flatTree.splice(startIdx, removed);
    }

    const stack = [path];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const kids = this.childrenByParent.get(cur);
      if (kids) {
        stack.push(...kids);
        this.childrenByParent.delete(cur);
      }
      this.nodesByPath.delete(cur);
      this.expandedFolders.delete(cur);
    }
    return removed;
  }

  toggleFolder(folderPath: string, forceExpanded?: boolean): boolean {
    const { path } = normPath(folderPath);
    const node = this.nodesByPath.get(path);
    if (!node || node.kind !== 'directory') return false;

    const curExp = this.expandedFolders.has(path);
    const nextExp = forceExpanded !== undefined ? forceExpanded : !curExp;
    if (nextExp === curExp) return nextExp;

    node.expanded = nextExp;
    if (nextExp) this.expandedFolders.add(path);
    else this.expandedFolders.delete(path);
    this.syncFlatDir(path);
    return nextExp;
  }

  getVisibleSlice(
    scrollTop: number,
    viewportHeight: number,
    rowHeight = DEFAULT_FILE_TREE_ROW_HEIGHT,
    maxDomNodes = MAX_FILE_TREE_DOM_NODES
  ): VisibleFileTreeSlice {
    return getVisibleSlice(
      this.flatTree,
      scrollTop,
      viewportHeight,
      rowHeight,
      maxDomNodes
    );
  }

  private areAncestorsExpanded(dir: string): boolean {
    let slashIdx = dir.indexOf('/');
    while (slashIdx !== -1) {
      const anc = dir.slice(0, slashIdx);
      if (!this.expandedFolders.has(anc)) return false;
      slashIdx = dir.indexOf('/', slashIdx + 1);
    }
    return true;
  }

  private findFlatIndex(targetPath: string): number {
    const flat = this.flatTree;
    const len = flat.length;
    for (let i = 0; i < len; i++) {
      if (flat[i]!.path === targetPath) return i;
    }
    return -1;
  }

  private syncFlatDir(dir: string): void {
    if (!this.areAncestorsExpanded(dir)) return;
    const idx = this.findFlatIndex(dir);
    if (idx < 0) return;
    const target = this.flatTree[idx];
    if (!target) return;

    const isExp = this.expandedFolders.has(dir);
    const hasChildren = (this.childrenByParent.get(dir)?.length ?? 0) > 0;
    const targetDepth = target.depth;
    const flat = this.flatTree;
    const len = flat.length;

    let endIdx = idx + 1;
    while (endIdx < len && flat[endIdx]!.depth > targetDepth) {
      endIdx++;
    }
    const oldCount = endIdx - (idx + 1);

    target.expanded = isExp;
    target.hasChildren = hasChildren;

    if (!isExp) {
      if (oldCount > 0) {
        flat.splice(idx + 1, oldCount);
      }
      return;
    }

    const slice: FileTreeNode[] = [];
    this.buildSubtreeInto(dir, targetDepth + 1, slice);
    if (slice.length <= 16384) {
      flat.splice(idx + 1, oldCount, ...slice);
    } else {
      const head = flat.slice(0, idx + 1);
      const tail = flat.slice(idx + 1 + oldCount);
      this.flatTree = head.concat(slice, tail);
    }
  }

  private sortChildren(parentPath: string): void {
    const list = this.childrenByParent.get(parentPath);
    if (!list || list.length <= 1) return;
    list.sort((a, b) => {
      const na = this.nodesByPath.get(a)!;
      const nb = this.nodesByPath.get(b)!;
      if (na.kind !== nb.kind) return na.kind === 'directory' ? -1 : 1;
      const aNoise = na.name.startsWith('.') || na.name.startsWith('--');
      const bNoise = nb.name.startsWith('.') || nb.name.startsWith('--');
      if (aNoise !== bNoise) return aNoise ? 1 : -1;
      return FILE_TREE_COLLATOR.compare(na.name, nb.name);
    });
  }

  private buildSubtreeInto(
    parentPath: string,
    depth: number,
    out: FileTreeNode[]
  ): void {
    const children = this.childrenByParent.get(parentPath);
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const childPath = children[i]!;
      const node = this.nodesByPath.get(childPath);
      if (!node) continue;
      const grand = this.childrenByParent.get(childPath);
      const hasChildren =
        node.kind === 'directory' && Boolean(grand && grand.length > 0);
      const isExp =
        node.kind === 'directory' && this.expandedFolders.has(childPath);
      node.depth = depth;
      node.expanded = isExp;
      node.hasChildren = hasChildren;
      out.push(node);
      if (isExp && hasChildren) {
        this.buildSubtreeInto(childPath, depth + 1, out);
      }
    }
  }
}
