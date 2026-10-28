import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { getWorkspacePath } from '../api/projectStore';
import {
  assertWorkspacePath,
  listDirectory,
  resolveWorkspacePath,
  toCanonicalFsPath,
  getAncestorDirPaths,
  type FsDirEntry,
} from '../api/workspaceFsApi';
import { fetchGitStatus, type GitStatusFile } from '../api/gitApi';
import { ConfirmDialog } from '@/components/ui';
import { useConfirmGate } from './useConfirmGate';
import {
  DEFAULT_FILE_TREE_ROW_HEIGHT,
  FILE_TREE_COLLATOR,
  MAX_FILE_TREE_DOM_NODES,
  PrefixFileTreeIndex,
  getVisibleSlice,
  type FileTreeNode,
  type VisibleFileTreeSlice,
} from '../utils/prefixFileTreeIndex';

export type TreeNode = FsDirEntry & { depth: number };

const MAX_DEPTH = 32;
const sortedEntryCache = new WeakMap<readonly FsDirEntry[], FsDirEntry[]>();

/**
 * 使用全局单例 FILE_TREE_COLLATOR 排序同级条目，并通过 WeakMap 缓存同引用数组
 */
export function sortFsDirEntries(list: readonly FsDirEntry[]): FsDirEntry[] {
  const cached = sortedEntryCache.get(list);
  if (cached) return cached;
  const sorted = [...list].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const aNoise = a.name.startsWith('.') || a.name.startsWith('--');
    const bNoise = b.name.startsWith('.') || b.name.startsWith('--');
    if (aNoise !== bNoise) return aNoise ? 1 : -1;
    return FILE_TREE_COLLATOR.compare(a.name, b.name);
  });
  sortedEntryCache.set(list, sorted);
  return sorted;
}

function buildSubtreeNodes(
  list: readonly FsDirEntry[],
  depth: number,
  expanded: Record<string, FsDirEntry[]>,
  visitedPaths: Set<string>,
  out: TreeNode[]
): void {
  if (depth > MAX_DEPTH) return;
  const sorted = sortFsDirEntries(list);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    out.push({ ...e, depth });
    const canonicalPath = toCanonicalFsPath(e.path);
    const childList = e.isDir ? expanded[canonicalPath] : undefined;
    if (childList && !visitedPaths.has(canonicalPath)) {
      visitedPaths.add(canonicalPath);
      buildSubtreeNodes(childList, depth + 1, expanded, visitedPaths, out);
      visitedPaths.delete(canonicalPath);
    }
  }
}

export function useFileNavigation(getIsDirty?: () => boolean) {
  const [root, setRoot] = useState(() => getWorkspacePath());
  const [entries, setEntries] = useState<FsDirEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, FsDirEntry[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [filterMode, setFilterMode] = useState(false);
  const [gitStatusMap, setGitStatusMap] = useState<Record<string, string>>({});

  const getIsDirtyRef = useRef(getIsDirty);
  getIsDirtyRef.current = getIsDirty;

  const prefixIndexRef = useRef<PrefixFileTreeIndex>(
    new PrefixFileTreeIndex({ defaultExpanded: false })
  );
  const prevEntriesRef = useRef<FsDirEntry[] | null>(null);
  const prevExpandedRef = useRef<Record<string, FsDirEntry[]>>({});
  const prevUnfilteredFlatRef = useRef<TreeNode[]>([]);

  const [confirmGate, renderConfirmGate] = useConfirmGate();

  const loadDir = useCallback(
    async (path: string) => listDirectory(resolveWorkspacePath(path)),
    []
  );

  const refresh = useCallback(async (): Promise<void> => {
    const r = getWorkspacePath();
    setRoot(r);
    const rootPath = resolveWorkspacePath(r || '');
    if (!rootPath) {
      setError('请先选择项目工作区');
      setEntries([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const rawEntries = await loadDir(rootPath);
      const nextEntries = rawEntries.map((it) => ({
        ...it,
        path: toCanonicalFsPath(it.path),
      }));
      prefixIndexRef.current.removePrefix('');
      prefixIndexRef.current.upsertPaths(
        nextEntries.map((it) => (it.isDir ? `${it.path}/` : it.path))
      );
      setEntries(nextEntries);
      setExpanded({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [loadDir]);

  const toggleExpand = useCallback(
    async (dirPath: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      const canonicalDirPath = toCanonicalFsPath(dirPath);
      if (!canonicalDirPath) return;

      if (expanded[canonicalDirPath]) {
        prefixIndexRef.current.toggleFolder(canonicalDirPath, false);
        setExpanded((prev) => {
          const next = { ...prev };
          delete next[canonicalDirPath];
          return next;
        });
        return;
      }

      try {
        const list = await loadDir(canonicalDirPath);
        const canonicalList = list.map((it) => ({
          ...it,
          path: toCanonicalFsPath(it.path),
        }));
        prefixIndexRef.current.upsertPaths([
          `${canonicalDirPath}/`,
          ...canonicalList.map((it) => (it.isDir ? `${it.path}/` : it.path)),
        ]);
        prefixIndexRef.current.toggleFolder(canonicalDirPath, true);
        setExpanded((prev) => ({ ...prev, [canonicalDirPath]: canonicalList }));
        setError('');
      } catch (err) {
        setError(err instanceof Error ? err.message : '展开目录失败');
      }
    },
    [expanded, loadDir]
  );

  const revealPath = useCallback(
    async (filePath: string): Promise<boolean> => {
      const r = getWorkspacePath();
      if (r) setRoot(r);
      const effectiveRoot = r || root;
      if (!effectiveRoot || !filePath?.trim()) return false;

      let resolvedTarget: string;
      try {
        resolvedTarget = assertWorkspacePath(filePath);
      } catch (err) {
        setError(err instanceof Error ? err.message : '文件不在当前工作区内');
        return false;
      }

      const normTarget = toCanonicalFsPath(resolvedTarget);
      const normRoot = toCanonicalFsPath(effectiveRoot);
      const targetLower = normTarget.toLowerCase();
      const rootLower = normRoot.toLowerCase();
      const rootPrefix = rootLower.endsWith('/') ? rootLower : `${rootLower}/`;

      if (!targetLower.startsWith(rootPrefix) && targetLower !== rootLower) {
        setError('文件不在当前工作区内');
        return false;
      }

      const ancestors = getAncestorDirPaths(normTarget, normRoot);

      if (entries.length === 0) {
        try {
          const rootEntries = await loadDir(normRoot);
          setEntries(
            rootEntries.map((e) => ({ ...e, path: toCanonicalFsPath(e.path) }))
          );
        } catch (e) {
          setError(e instanceof Error ? e.message : '读取项目根目录失败');
          return false;
        }
      }

      if (ancestors.length === 0) return true;

      const toLoad = ancestors.filter((dir) => !expanded[dir]);
      if (toLoad.length > 0) {
        const results: Record<string, FsDirEntry[]> = {};
        const failureReasons: string[] = [];

        const settledResults = await Promise.allSettled(
          toLoad.map(async (dir) => {
            const list = await loadDir(dir);
            return {
              dir,
              items: list.map((it) => ({
                ...it,
                path: toCanonicalFsPath(it.path),
              })),
            };
          })
        );

        for (const res of settledResults) {
          if (res.status === 'fulfilled') {
            results[res.value.dir] = res.value.items;
          } else {
            failureReasons.push(
              res.reason instanceof Error
                ? res.reason.message
                : String(res.reason)
            );
          }
        }

        if (Object.keys(results).length > 0) {
          setExpanded((prev) => ({ ...prev, ...results }));
        }

        if (failureReasons.length > 0) {
          setError(`部分祖先目录无法展开: ${failureReasons.join('; ')}`);
          if (Object.keys(results).length === 0) return false;
        }
      }

      return true;
    },
    [root, entries.length, expanded, loadDir]
  );

  // 单点展开 O(depth + K) 局部 splice 注入 / 单点折叠 O(M) 连续深度区间截除
  const flatTree: TreeNode[] = useMemo(() => {
    const prevEntries = prevEntriesRef.current;
    const prevExpanded = prevExpandedRef.current;
    const prevFlat = prevUnfilteredFlatRef.current;
    let unfiltered: TreeNode[] | null = null;

    if (prevEntries === entries && prevFlat.length > 0) {
      const prevKeys = Object.keys(prevExpanded);
      const nextKeys = Object.keys(expanded);
      if (Math.abs(nextKeys.length - prevKeys.length) === 1) {
        const isCollapse = nextKeys.length < prevKeys.length;
        const changedDir = isCollapse
          ? prevKeys.find((k) => !(k in expanded))
          : nextKeys.find((k) => !(k in prevExpanded));

        if (changedDir) {
          const targetIdx = prevFlat.findIndex(
            (n) => toCanonicalFsPath(n.path) === changedDir
          );
          if (targetIdx >= 0) {
            const targetDepth = prevFlat[targetIdx]!.depth;
            let endIdx = targetIdx + 1;
            while (
              endIdx < prevFlat.length &&
              prevFlat[endIdx]!.depth > targetDepth
            ) {
              endIdx++;
            }
            const oldCount = endIdx - (targetIdx + 1);
            const nextFlat = prevFlat.slice();
            if (isCollapse) {
              if (oldCount > 0) nextFlat.splice(targetIdx + 1, oldCount);
              unfiltered = nextFlat;
            } else {
              const subtree: TreeNode[] = [];
              buildSubtreeNodes(
                expanded[changedDir] ?? [],
                targetDepth + 1,
                expanded,
                new Set<string>([changedDir]),
                subtree
              );
              nextFlat.splice(targetIdx + 1, oldCount, ...subtree);
              unfiltered = nextFlat;
            }
          }
        }
      }
    }

    if (!unfiltered) {
      unfiltered = [];
      buildSubtreeNodes(entries, 0, expanded, new Set<string>(), unfiltered);
    }

    prevEntriesRef.current = entries;
    prevExpandedRef.current = expanded;
    prevUnfilteredFlatRef.current = unfiltered;

    const q = filter.trim().toLowerCase();
    return q
      ? unfiltered.filter((n) => n.name.toLowerCase().includes(q))
      : unfiltered;
  }, [entries, expanded, filter]);

  const getVisibleTreeSlice = useCallback(
    (
      scrollTop: number,
      viewportHeight: number,
      rowHeight = DEFAULT_FILE_TREE_ROW_HEIGHT,
      maxDomNodes = MAX_FILE_TREE_DOM_NODES
    ): VisibleFileTreeSlice => {
      const nodes: FileTreeNode[] = flatTree.map((n) => {
        const kind = n.isDir ? 'directory' : 'file';
        const cPath = toCanonicalFsPath(n.path);
        return {
          path: cPath,
          name: n.name,
          kind,
          type: kind,
          depth: n.depth,
          expanded: Boolean(n.isDir && expanded[cPath]),
          hasChildren: Boolean(n.isDir),
        };
      });
      return getVisibleSlice(
        nodes,
        scrollTop,
        viewportHeight,
        rowHeight,
        maxDomNodes
      );
    },
    [flatTree, expanded]
  );

  useEffect(() => {
    const buildMap = (files: GitStatusFile[]) => {
      const m: Record<string, string> = {};
      for (const f of files) m[f.path] = f.status;
      setGitStatusMap(m);
    };
    const onGitUpdate = (ev: Event) => {
      const data = (ev as CustomEvent<GitStatusFile[]>).detail;
      if (data) buildMap(data);
    };
    const fromWindow = window.__crish_git_status as GitStatusFile[] | undefined;
    if (fromWindow) buildMap(fromWindow);
    window.addEventListener('crish-git-status-changed', onGitUpdate);
    void fetchGitStatus().then((r) => {
      if (r.found && r.files) buildMap(r.files);
    });
    return () =>
      window.removeEventListener('crish-git-status-changed', onGitUpdate);
  }, []);

  const isDirty = useCallback(() => getIsDirtyRef.current?.() ?? false, []);

  const confirmNavigation = useCallback(async (): Promise<boolean> => {
    if (isDirty()) {
      return confirmGate({
        title: '未保存的修改',
        description: '当前文件未保存，切换将丢失修改，是否继续？',
        confirmLabel: '继续切换',
      });
    }
    return true;
  }, [isDirty, confirmGate]);

  return {
    root,
    entries,
    expanded,
    loading,
    error,
    filter,
    filterMode,
    gitStatusMap,
    loadDir,
    refresh,
    toggleExpand,
    revealPath,
    setFilter,
    setFilterMode,
    setError,
    setExpanded,
    setEntries,
    setLoading,
    flatTree,
    getVisibleSlice: getVisibleTreeSlice,
    prefixIndex: prefixIndexRef.current,
    isDirty,
    confirmNavigation,
    confirmGate,
    renderConfirmGate,
    confirmGateView: renderConfirmGate(createElement(ConfirmDialog)),
  };
}
