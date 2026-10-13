/**
 * 重型工具视图性能优化核心原语（W3-3 & W3-4）：
 * 1. DiffChunkCachePool：L1 视口核心工作集锁定 + L2 64 行分块 LRU 缓存池
 * 2. PrefixFileTreeIndex：万级文件树纯前缀路径 O(depth) 局部增量索引与 <= 60 恒定窗口切片
 */

export const CHUNK_SIZE = 64;
export const DIFF_CHUNK_SIZE = CHUNK_SIZE;
export const DEFAULT_MAX_CHUNKS = 64;
export const DEFAULT_OVERSCAN_LINES = 64;
export const DEFAULT_FILE_TREE_ROW_HEIGHT = 28;
export const MAX_FILE_TREE_DOM_NODES = 60;

export const FILE_TREE_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

/**
 * 大文件 Diff 视图双级分块缓存池：
 * - L1 视口核心工作集锁定（pinnedChunkIndices）：视口及缓冲区覆盖的分块绝对免疫 LRU 驱逐
 * - L2 有界 64 行分块 LRU 缓存池：容量满时仅从非 L1 的冷分块中按 LRU 顺序淘汰最旧分块
 */
export class DiffChunkCachePool<TLineToken = string> {
  static readonly CHUNK_SIZE = CHUNK_SIZE;
  readonly chunkSize = CHUNK_SIZE;
  readonly maxChunks: number;
  readonly pinnedChunkIndices: Set<number> = new Set<number>();
  private readonly chunks = new Map<number, readonly TLineToken[]>();

  constructor(opts: number | { maxChunks?: number } = DEFAULT_MAX_CHUNKS) {
    const raw =
      typeof opts === 'number' ? opts : (opts?.maxChunks ?? DEFAULT_MAX_CHUNKS);
    this.maxChunks =
      Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_CHUNKS;
  }

  get size(): number {
    return this.chunks.size;
  }

  hasChunk(chunkIndex: number): boolean {
    return (
      Number.isFinite(chunkIndex) &&
      chunkIndex >= 0 &&
      this.chunks.has(Math.floor(chunkIndex))
    );
  }

  lockViewportRange(
    startLine: number,
    endLine: number,
    overscanLines = DEFAULT_OVERSCAN_LINES
  ): ReadonlySet<number> {
    this.pinnedChunkIndices.clear();
    if (
      !Number.isFinite(startLine) ||
      !Number.isFinite(endLine) ||
      endLine < 0
    ) {
      this.evictColdChunks();
      return this.pinnedChunkIndices;
    }
    const pad = Number.isFinite(overscanLines)
      ? Math.max(0, Math.floor(overscanLines))
      : 64;
    const low = Math.max(0, Math.floor(Math.min(startLine, endLine)) - pad);
    const high = Math.max(0, Math.floor(Math.max(startLine, endLine)) + pad);
    const firstChunk = Math.floor(low / CHUNK_SIZE);
    const lastChunk = Math.floor(high / CHUNK_SIZE);

    for (let idx = firstChunk; idx <= lastChunk; idx++) {
      this.pinnedChunkIndices.add(idx);
      const cached = this.chunks.get(idx);
      if (cached !== undefined) {
        this.chunks.delete(idx);
        this.chunks.set(idx, cached);
      }
    }
    this.evictColdChunks();
    return this.pinnedChunkIndices;
  }

  putChunk(chunkIndex: number, lines: readonly TLineToken[]): void {
    if (!Number.isFinite(chunkIndex) || chunkIndex < 0) return;
    const idx = Math.floor(chunkIndex);
    if (this.chunks.has(idx)) this.chunks.delete(idx);
    this.chunks.set(idx, lines.slice(0, CHUNK_SIZE));
    this.evictColdChunks(idx);
  }

  getLine(lineNumber: number): TLineToken | undefined {
    if (!Number.isFinite(lineNumber) || lineNumber < 0) return undefined;
    const line = Math.floor(lineNumber);
    const idx = Math.floor(line / CHUNK_SIZE);
    const chunk = this.chunks.get(idx);
    if (!chunk) return undefined;
    this.chunks.delete(idx);
    this.chunks.set(idx, chunk);
    return chunk[line % CHUNK_SIZE];
  }

  getMissingChunksInRange(startLine: number, endLine: number): number[] {
    if (
      !Number.isFinite(startLine) ||
      !Number.isFinite(endLine) ||
      endLine < startLine ||
      endLine < 0
    ) {
      return [];
    }
    const first = Math.floor(Math.max(0, Math.floor(startLine)) / CHUNK_SIZE);
    const last = Math.floor(Math.max(0, Math.floor(endLine)) / CHUNK_SIZE);
    const missing: number[] = [];
    for (let c = first; c <= last; c++) {
      if (!this.chunks.has(c)) missing.push(c);
    }
    return missing;
  }

  private evictColdChunks(protectedIdx?: number): void {
    if (this.chunks.size <= this.maxChunks) return;
    for (const key of this.chunks.keys()) {
      if (this.chunks.size <= this.maxChunks) break;
      if (!this.pinnedChunkIndices.has(key) && key !== protectedIdx) {
        this.chunks.delete(key);
      }
    }
  }
}

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
 * 万级文件树纯前缀路径增量索引：
 * - 通过路径前缀 O(depth) 局部插入/删除/展开/折叠目录，无需全树递归重建
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

    for (const raw of paths) {
      const { path, isDir } = normPath(raw);
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
          const type = kind;
          this.nodesByPath.set(cur, {
            path: cur,
            name,
            kind,
            type,
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
      if (pNode)
        pNode.hasChildren = (this.childrenByParent.get(p)?.length ?? 0) > 0;
    }

    if (wasEmpty || dirtyParents.has('')) {
      this.flatTree = this.buildSubtree('', 0);
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
    const prefix = `${path}/`;
    const startIdx = this.flatTree.findIndex(
      (n) => n.path === path || n.path.startsWith(prefix)
    );
    if (startIdx >= 0) {
      while (startIdx + removed < this.flatTree.length) {
        const item = this.flatTree[startIdx + removed];
        if (item && (item.path === path || item.path.startsWith(prefix)))
          removed++;
        else break;
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
    const h =
      Number.isFinite(rowHeight) && rowHeight > 0
        ? rowHeight
        : DEFAULT_FILE_TREE_ROW_HEIGHT;
    const cap =
      Number.isFinite(maxDomNodes) && maxDomNodes > 0
        ? Math.min(MAX_FILE_TREE_DOM_NODES, Math.floor(maxDomNodes))
        : MAX_FILE_TREE_DOM_NODES;

    const totalCount = this.flatTree.length;
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

    const items = this.flatTree.slice(startIndex, endIndex);
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

  private syncFlatDir(dir: string): void {
    const idx = this.flatTree.findIndex((n) => n.path === dir);
    if (idx < 0) return;
    const target = this.flatTree[idx];
    if (!target) return;
    const isExp = this.expandedFolders.has(dir);
    const hasChildren = (this.childrenByParent.get(dir)?.length ?? 0) > 0;
    const prefix = `${dir}/`;
    let oldCount = 0;
    while (idx + 1 + oldCount < this.flatTree.length) {
      const item = this.flatTree[idx + 1 + oldCount];
      if (item && item.path.startsWith(prefix)) oldCount++;
      else break;
    }
    const slice = isExp ? this.buildSubtree(dir, target.depth + 1) : [];
    this.flatTree[idx] = { ...target, expanded: isExp, hasChildren };
    this.flatTree.splice(idx + 1, oldCount, ...slice);
  }

  private sortChildren(parentPath: string): void {
    const list = this.childrenByParent.get(parentPath);
    if (!list || list.length <= 1) return;
    list.sort((a, b) => {
      const na = this.nodesByPath.get(a)!;
      const nb = this.nodesByPath.get(b)!;
      if (na.kind !== nb.kind) return na.kind === 'directory' ? -1 : 1;
      return FILE_TREE_COLLATOR.compare(na.name, nb.name);
    });
  }

  private buildSubtree(parentPath: string, depth: number): FileTreeNode[] {
    const out: FileTreeNode[] = [];
    const children = this.childrenByParent.get(parentPath);
    if (!children) return out;
    for (const childPath of children) {
      const node = this.nodesByPath.get(childPath);
      if (!node) continue;
      const grand = this.childrenByParent.get(childPath);
      const hasChildren =
        node.kind === 'directory' && Boolean(grand && grand.length > 0);
      const isExp =
        node.kind === 'directory' && this.expandedFolders.has(childPath);
      out.push({ ...node, depth, expanded: isExp, hasChildren });
      if (isExp && hasChildren)
        out.push(...this.buildSubtree(childPath, depth + 1));
    }
    return out;
  }
}
