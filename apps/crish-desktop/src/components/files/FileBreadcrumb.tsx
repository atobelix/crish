import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import styles from './FilesCard.module.css';
import { Tooltip } from '../ui';

import {
  detectFileKind,
  listDirectory,
  pathDirname,
  pathRelativeToRoot,
  resolveWorkspacePath,
  type FsDirEntry,
} from '../../api/workspaceFsApi';
import { fileExtColor } from '../../api/codeHighlight';
import type { ViewMode } from './hooks/useFilePreview';
import { AppIcon } from '../ui/icons/index';

function joinLocal(base: string, name: string): string {
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

function sortEntries(entries: FsDirEntry[]): FsDirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const aNoise = a.name.startsWith('.') || a.name.startsWith('--');
    const bNoise = b.name.startsWith('.') || b.name.startsWith('--');
    if (aNoise !== bNoise) return aNoise ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function BcFileIcon({ name }: { name: string }) {
  const k = detectFileKind(name);
  const color = fileExtColor(name);
  const sz = 14;
  if (k === 'image') return <AppIcon name="image" size={sz} style={{ color }} aria-hidden />;
  if (k === 'pdf') return <AppIcon name="file-text" size={sz} style={{ color }} aria-hidden />;
  if (k === 'table') return <AppIcon name="table" size={sz} style={{ color }} aria-hidden />;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|css|html|json|md|yml|yaml)$/i.test(name)) {
    return <AppIcon name="file-code" size={sz} style={{ color }} aria-hidden />;
  }
  return <AppIcon name="file" size={sz} style={{ color }} aria-hidden />;
}

interface BreadcrumbItem {
  label: string;
  path: string;
  isFile?: boolean;
}

interface FlyoutState {
  anchorPath: string;
  anchorLabel: string;
  dirCache: Record<string, FsDirEntry[]>;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  loading: boolean;
  filter: string;
}

export interface FileBreadcrumbProps {
  root: string;
  selected: string | null;
  view: ViewMode;
  dirty?: boolean;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
}

export const FileBreadcrumb = React.memo(function FileBreadcrumb({
  root,
  selected,
  view,
  dirty,
  onNavigate,
  onOpenFile,
}: FileBreadcrumbProps) {
  const [bcFlyout, setBcFlyout] = useState<FlyoutState | null>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const bcFilterRef = useRef<HTMLInputElement>(null);
  const bcTriggerRef = useRef<HTMLButtonElement>(null);

  const rootLabel = useMemo(() => {
    if (!root) return '项目';
    return root.split(/[\\/]/).filter(Boolean).pop() || '项目';
  }, [root]);

  // 单轨面包屑推导：无 cwd，依据当前选中的 selected 或 root 进行层级推导
  const breadcrumbs: BreadcrumbItem[] = useMemo(() => {
    if (!root) return [];
    const targetDir = selected ? (view === 'detail' ? pathDirname(selected) : selected) : root;
    const rel = pathRelativeToRoot(targetDir || root, root);
    const items: BreadcrumbItem[] = [{ label: rootLabel, path: root }];
    if (rel && rel !== '.') {
      let acc = root;
      for (const part of rel.replace(/\\/g, '/').split('/').filter(Boolean)) {
        acc = joinLocal(acc, part);
        items.push({ label: part, path: acc });
      }
    }
    if (view === 'detail' && selected) {
      items.push({
        label: selected.split(/[\\/]/).pop() || '',
        path: selected,
        isFile: true,
      });
    }
    return items;
  }, [root, rootLabel, selected, view]);

  const loadDir = useCallback(
    async (path: string) => listDirectory(resolveWorkspacePath(path)),
    []
  );

  const openBcFlyout = useCallback(
    async (dirPath: string, label: string) => {
      if (bcFlyout?.anchorPath === dirPath) {
        setBcFlyout(null);
        requestAnimationFrame(() => bcTriggerRef.current?.focus());
        return;
      }
      setBcFlyout({
        anchorPath: dirPath,
        anchorLabel: label,
        dirCache: {},
        expandedPaths: new Set<string>(),
        loadingPaths: new Set<string>(),
        loading: true,
        filter: '',
      });
      try {
        const list = await loadDir(dirPath);
        setBcFlyout((prev) =>
          prev && prev.anchorPath === dirPath
            ? { ...prev, dirCache: { [dirPath]: list }, loading: false }
            : prev
        );
        requestAnimationFrame(() => bcFilterRef.current?.focus());
      } catch {
        setBcFlyout(null);
        requestAnimationFrame(() => bcTriggerRef.current?.focus());
      }
    },
    [bcFlyout?.anchorPath, loadDir]
  );

  const toggleExpand = useCallback(
    async (dirPath: string) => {
      if (!bcFlyout) return;

      if (bcFlyout.expandedPaths.has(dirPath)) {
        setBcFlyout((prev) => {
          if (!prev) return null;
          const nextExpanded = new Set(prev.expandedPaths);
          nextExpanded.delete(dirPath);
          return { ...prev, expandedPaths: nextExpanded };
        });
        return;
      }

      if (bcFlyout.dirCache[dirPath]) {
        setBcFlyout((prev) => {
          if (!prev) return null;
          const nextExpanded = new Set(prev.expandedPaths);
          nextExpanded.add(dirPath);
          return { ...prev, expandedPaths: nextExpanded };
        });
        return;
      }

      setBcFlyout((prev) => {
        if (!prev) return null;
        const nextLoading = new Set(prev.loadingPaths);
        nextLoading.add(dirPath);
        const nextExpanded = new Set(prev.expandedPaths);
        nextExpanded.add(dirPath);
        return { ...prev, loadingPaths: nextLoading, expandedPaths: nextExpanded };
      });

      try {
        const list = await loadDir(dirPath);
        setBcFlyout((prev) => {
          if (!prev) return null;
          const nextLoading = new Set(prev.loadingPaths);
          nextLoading.delete(dirPath);
          return {
            ...prev,
            loadingPaths: nextLoading,
            dirCache: { ...prev.dirCache, [dirPath]: list },
          };
        });
      } catch {
        setBcFlyout((prev) => {
          if (!prev) return null;
          const nextLoading = new Set(prev.loadingPaths);
          nextLoading.delete(dirPath);
          const nextExpanded = new Set(prev.expandedPaths);
          nextExpanded.delete(dirPath);
          return { ...prev, loadingPaths: nextLoading, expandedPaths: nextExpanded };
        });
      }
    },
    [bcFlyout, loadDir]
  );

  const handleDirectOpenCurrentDir = useCallback(() => {
    if (!bcFlyout) return;
    const target = bcFlyout.anchorPath;
    setBcFlyout(null);
    requestAnimationFrame(() => bcTriggerRef.current?.focus());
    onNavigate(target);
  }, [bcFlyout, onNavigate]);

  const handleDoubleClickFolder = useCallback(
    (folderPath: string) => {
      setBcFlyout(null);
      requestAnimationFrame(() => bcTriggerRef.current?.focus());
      onNavigate(folderPath);
    },
    [onNavigate]
  );

  const handleOpenFile = useCallback(
    (filePath: string) => {
      setBcFlyout(null);
      requestAnimationFrame(() => bcTriggerRef.current?.focus());
      onOpenFile(filePath);
    },
    [onOpenFile]
  );

  useEffect(() => {
    if (!bcFlyout) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (crumbsRef.current?.contains(t)) return;
      setBcFlyout(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setBcFlyout(null);
        requestAnimationFrame(() => bcTriggerRef.current?.focus());
      }
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [bcFlyout]);

  const filteredEntries = useMemo(() => {
    if (!bcFlyout) return [];
    const q = bcFlyout.filter.trim().toLowerCase();
    if (!q) return [];
    const results: FsDirEntry[] = [];
    const visited = new Set<string>();

    const traverse = (dirPath: string) => {
      if (visited.has(dirPath)) return;
      visited.add(dirPath);
      const entries = bcFlyout.dirCache[dirPath] || [];
      for (const ent of entries) {
        if (ent.name.toLowerCase().includes(q)) results.push(ent);
        if (ent.isDir && bcFlyout.dirCache[ent.path]) traverse(ent.path);
      }
    };

    traverse(bcFlyout.anchorPath);
    return sortEntries(results);
  }, [bcFlyout]);

  const renderTreeNodes = (dirPath: string, depth: number) => {
    if (!bcFlyout) return null;
    const entries = bcFlyout.dirCache[dirPath];
    if (!entries) return null;

    return sortEntries(entries).map((ent) => {
      const isExpanded = bcFlyout.expandedPaths.has(ent.path);
      const isLoading = bcFlyout.loadingPaths.has(ent.path);
      const children = bcFlyout.dirCache[ent.path];

      return (
        <React.Fragment key={ent.path}>
          <button
            type="button"
            role="option"
            className={`${styles.filesBcFlyoutItem} ${selected === ent.path ? styles.isActive : ''}`}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            onClick={() => (ent.isDir ? void toggleExpand(ent.path) : handleOpenFile(ent.path))}
            onDoubleClick={() => ent.isDir && handleDoubleClickFolder(ent.path)}
          >
            {ent.isDir ? (
              <>
                <AppIcon name="chevron-right" size={13}
                  className={`${styles.filesBcFlyoutChev} ${isExpanded ? styles.isExpanded : ''}`}
                  aria-hidden />
                <AppIcon name="folder" size={14} aria-hidden />
              </>
            ) : (
              <>
                <span className={`${styles.filesBcFlyoutChev} ${styles.isLeaf}`} />
                <BcFileIcon name={ent.name} />
              </>
            )}
            <span className={styles.filesBcFlyoutName}>{ent.name}</span>
          </button>
          {ent.isDir && isExpanded ? (
            isLoading ? (
              <div
                className={styles.filesBcFlyoutEmpty}
                style={{ paddingLeft: `${8 + (depth + 1) * 14}px`, textAlign: 'left', paddingBlock: '4px' }}
              >
                加载中…
              </div>
            ) : children && children.length === 0 ? (
              <div
                className={styles.filesBcFlyoutEmpty}
                style={{ paddingLeft: `${8 + (depth + 1) * 14}px`, textAlign: 'left', paddingBlock: '4px' }}
              >
                空目录
              </div>
            ) : children ? (
              renderTreeNodes(ent.path, depth + 1)
            ) : null
          ) : null}
        </React.Fragment>
      );
    });
  };

  if (!root) return null;

  return (
    <div className={styles.filesCrumbs} ref={crumbsRef} aria-label="工作区相对路径">
      {breadcrumbs.length === 0 ? (
        <span className={`${styles.filesBcChip} ${styles.filesBcChipMuted}`}>{rootLabel}</span>
      ) : (
        breadcrumbs.map((b, i) => {
          const isLast = i === breadcrumbs.length - 1;
          const canNav = !b.isFile;
          const flyOpen = bcFlyout?.anchorPath === b.path;
          return (
            <React.Fragment key={`${b.path}-${i}`}>
              {i > 0 ? <span className={styles.filesBcSep}>/</span> : null}
              {canNav ? (
                <span className={styles.filesBcSeg}>
                  <Tooltip
                    content={
                      i === 0
                        ? `项目根目录 (${rootLabel}) · 点击列出内容`
                        : `${b.path} · 点击列出该层`
                    }
                  >
                    <button
                      type="button"
                      className={`${styles.filesBcChip} ${flyOpen ? styles.isOpen : ''}`}
                      aria-haspopup="listbox"
                      aria-expanded={flyOpen}
                      onClick={(e) => {
                        bcTriggerRef.current = e.currentTarget;
                        void openBcFlyout(b.path, b.label);
                      }}
                      onDoubleClick={() => {
                        setBcFlyout(null);
                        requestAnimationFrame(() => bcTriggerRef.current?.focus());
                        onNavigate(b.path);
                      }}
                    >
                      {b.label}
                    </button>
                  </Tooltip>
                  {flyOpen && bcFlyout ? (
                    <div
                      className={styles.filesBcFlyout}
                      role="listbox"
                      aria-label={`${bcFlyout.anchorLabel} 目录`}
                    >
                      <div className={styles.filesBcFlyoutSearch}>
                        <AppIcon name="search" size={13} aria-hidden />
                        <input
                          ref={bcFilterRef}
                          type="search"
                          placeholder="筛选文件…"
                          value={bcFlyout.filter}
                          onChange={(e) =>
                            setBcFlyout((prev) =>
                              prev ? { ...prev, filter: e.target.value } : prev
                            )
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              setBcFlyout(null);
                              requestAnimationFrame(() => bcTriggerRef.current?.focus());
                            } else if (e.key === 'Enter') {
                              e.preventDefault();
                              handleDirectOpenCurrentDir();
                            }
                          }}
                        />
                        <Tooltip
                          content={`在文件树中打开此目录 (${bcFlyout.anchorLabel}) (Enter)`}
                        >
                          <button
                            type="button"
                            className={styles.filesBcDirectOpenBtn}
                            aria-label="在文件树中打开此目录"
                            onClick={handleDirectOpenCurrentDir}
                          >
                            <AppIcon name="folder-open" size={14} aria-hidden />
                          </button>
                        </Tooltip>
                      </div>
                      <div className={styles.filesBcFlyoutList}>
                        {bcFlyout.loading ? (
                          <div className={styles.filesBcFlyoutEmpty}>加载中…</div>
                        ) : bcFlyout.filter.trim() ? (
                          filteredEntries.length === 0 ? (
                            <div className={styles.filesBcFlyoutEmpty}>无匹配</div>
                          ) : (
                            filteredEntries.map((ent) => (
                              <button
                                key={ent.path}
                                type="button"
                                role="option"
                                className={`${styles.filesBcFlyoutItem} ${selected === ent.path ? styles.isActive : ''}`}
                                onClick={() =>
                                  ent.isDir ? void toggleExpand(ent.path) : handleOpenFile(ent.path)
                                }
                                onDoubleClick={() => ent.isDir && handleDoubleClickFolder(ent.path)}
                              >
                                {ent.isDir ? (
                                  <AppIcon name="folder" size={14} aria-hidden />
                                ) : (
                                  <BcFileIcon name={ent.name} />
                                )}
                                <span className={styles.filesBcFlyoutName}>{ent.name}</span>
                              </button>
                            ))
                          )
                        ) : !bcFlyout.dirCache[bcFlyout.anchorPath] ||
                          bcFlyout.dirCache[bcFlyout.anchorPath]?.length === 0 ? (
                          <div className={styles.filesBcFlyoutEmpty}>空目录</div>
                        ) : (
                          renderTreeNodes(bcFlyout.anchorPath, 0)
                        )}
                      </div>
                    </div>
                  ) : null}
                </span>
              ) : (
                <span
                  className={`${styles.filesBcChip} ${isLast ? styles.filesBcChipFile : ''}`}
                >
                  {dirty && b.isFile ? (
                    <span className={styles.filesDirtyDot} aria-label="未保存">
                      ●
                    </span>
                  ) : null}
                  {b.label}
                </span>
              )}
            </React.Fragment>
          );
        })
      )}
    </div>
  );
});



