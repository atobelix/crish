import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getWorkspacePath } from '../../../api/projectStore';
import {
  listDirectory,
  pathDirname,
  resolveWorkspacePath,
  type FsDirEntry,
} from '../../../api/workspaceFsApi';
import { fetchGitStatus, type GitStatusFile } from '../../../api/gitApi';
import { ConfirmDialog } from '../../ui';
import { useConfirmGate } from '../../../hooks/useConfirmGate';

export type TreeNode = FsDirEntry & { depth: number };

export function useFileNavigation(getIsDirty?: () => boolean) {
  const [root, setRoot] = useState(() => getWorkspacePath());
  const [cwd, setCwd] = useState(root || '');
  const [entries, setEntries] = useState<FsDirEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, FsDirEntry[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [filterMode, setFilterMode] = useState(false);
  const [gitStatusMap, setGitStatusMap] = useState<Record<string, string>>({});
  const getIsDirtyRef = useRef(getIsDirty);
  getIsDirtyRef.current = getIsDirty;
  // window.confirm → ConfirmDialog Promise 桥（批次 4.1，04-detail §2.1.1）；
  // hook 不直接渲染，渲染物经返回值交给宿主（FilesCard）挂载
  const [confirmGate, renderConfirmGate] = useConfirmGate();

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
    [cwd, loadDir],
  );

  const toggleExpand = useCallback(
    async (dirPath: string, e: React.MouseEvent) => {
      e.stopPropagation();
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
    [expanded, loadDir],
  );

  const goUp = useCallback(() => {
    if (!cwd || (root && cwd === root)) return;
    const parent = pathDirname(cwd);
    if (parent && parent !== cwd) {
      void refresh(parent);
    }
  }, [cwd, root, refresh]);

  const flatTree: TreeNode[] = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const out: TreeNode[] = [];
    const walk = (list: FsDirEntry[], depth: number) => {
      // 智能自然排序：1. 文件夹优先；2. 业务目录优先于 . 或 -- 前缀的内部噪音目录；3. 拼写自然排序
      const sorted = [...list].sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        const aNoise = a.name.startsWith('.') || a.name.startsWith('--');
        const bNoise = b.name.startsWith('.') || b.name.startsWith('--');
        if (aNoise !== bNoise) return aNoise ? 1 : -1;
        return a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      });
      for (const e of sorted) {
        out.push({ ...e, depth });
        if (e.isDir && expanded[e.path]) walk(expanded[e.path] ?? [], depth + 1);
      }
    };
    walk(entries, 0);
    if (!q) return out;
    return out.filter((n) => n.name.toLowerCase().includes(q));
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
      return confirmGate({
        title: '未保存的修改',
        description: '当前文件未保存，切换将丢失修改，是否继续？',
        confirmLabel: '继续切换',
      });
    }
    return true;
  }, [isDirty, confirmGate]);

  return {
    root, cwd, entries, expanded, loading, error, filter, filterMode, gitStatusMap,
    loadDir, refresh, toggleExpand, goUp,
    setFilter, setFilterMode, setError, setCwd, setExpanded, setEntries, setLoading, flatTree,
    isDirty, confirmNavigation,
    confirmGateView: renderConfirmGate(createElement(ConfirmDialog)),
  };
}
