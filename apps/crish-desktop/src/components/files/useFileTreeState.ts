import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getWorkspacePath } from '../../api/projectStore';
import {
  listDirectory,
  pathDirname,
  resolveWorkspacePath,
  type FsDirEntry,
} from '../../api/workspaceFsApi';
import { fetchGitStatus, type GitStatusFile } from '../../api/gitApi';
import { filterTreeNodes, type TreeNode } from './FileSearchFilter';

export type { TreeNode };

export function useFileTreeState(getIsDirty?: () => boolean) {
  const [root, setRoot] = useState(() => getWorkspacePath());
  const [cwd, setCwd] = useState(root || '');
  const [entries, setEntries] = useState<FsDirEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, FsDirEntry[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [filterMode, setFilterMode] = useState(false);
  const [gitStatusMap, setGitStatusMap] = useState<Record<string, string>>({});
  const getIsDirtyRef = useRef(getIsDirty);
  getIsDirtyRef.current = getIsDirty;

  const loadDir = useCallback(async (path: string) => listDirectory(resolveWorkspacePath(path)), []);

  const refresh = useCallback(
    async (dir?: string) => {
      const r = getWorkspacePath();
      setRoot(r);
      const path = resolveWorkspacePath(dir || cwd || r || '');
      if (!path) {
        setError('请先选择项目工作区');
        setEntries([]);
        return;
      }
      setLoading(true);
      setError('');
      try {
        setEntries(await loadDir(path));
        setCwd(path);
        setExpanded({});
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [cwd, loadDir]
  );

  const toggleExpand = useCallback(
    async (dirPath: string, e?: React.MouseEvent) => {
      if (e) e.stopPropagation();
      if (expanded[dirPath]) {
        setExpanded((prev) => {
          const next = { ...prev };
          delete next[dirPath];
          return next;
        });
        return;
      }
      try {
        const list = await loadDir(dirPath);
        setExpanded((prev) => ({ ...prev, [dirPath]: list }));
        setError('');
      } catch (err) {
        setError(err instanceof Error ? err.message : '展开失败');
      }
    },
    [expanded, loadDir]
  );

  const goUp = useCallback(() => {
    if (!cwd || (root && cwd === root)) return;
    const parent = pathDirname(cwd);
    if (parent && parent !== cwd) {
      void refresh(parent);
    }
  }, [cwd, root, refresh]);

  const flatTree: TreeNode[] = useMemo(() => {
    return filterTreeNodes(entries, expanded, filter);
  }, [entries, expanded, filter]);

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
    return () => window.removeEventListener('crish-git-status-changed', onGitUpdate);
  }, []);

  const isDirty = useCallback(() => getIsDirtyRef.current?.() ?? false, []);

  const confirmNavigation = useCallback(async (): Promise<boolean> => {
    if (isDirty()) {
      return window.confirm('当前文件未保存，切换将丢失修改，是否继续？');
    }
    return true;
  }, [isDirty]);

  return {
    root,
    cwd,
    entries,
    expanded,
    selected,
    loading,
    error,
    filter,
    filterMode,
    gitStatusMap,
    flatTree,
    loadDir,
    refresh,
    toggleExpand,
    goUp,
    setSelected,
    setFilter,
    setFilterMode,
    setError,
    setCwd,
    setExpanded,
    setEntries,
    setLoading,
    isDirty,
    confirmNavigation,
  };
}
