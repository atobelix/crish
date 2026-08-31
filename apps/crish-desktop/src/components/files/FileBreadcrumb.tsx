import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import styles from './FilesCard.module.css';
import { Button, Tooltip } from '../ui';
import {
  ChevronRight,
  CornerLeftUp,
  File,
  FileCode2,
  FileText,
  Folder,
  Image,
  Search,
  Table,
} from 'lucide-react';
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

function joinLocal(base: string, name: string): string {
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

function BcFileIcon({ name }: { name: string }) {
  const k = detectFileKind(name);
  const color = fileExtColor(name);
  const sz = 14;
  if (k === 'image') return <Image size={sz} style={{ color }} aria-hidden />;
  if (k === 'pdf') return <FileText size={sz} style={{ color }} aria-hidden />;
  if (k === 'table') return <Table size={sz} style={{ color }} aria-hidden />;
  if (
    /\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|css|html|json|md|yml|yaml)$/i.test(
      name
    )
  )
    return <FileCode2 size={sz} style={{ color }} aria-hidden />;
  return <File size={sz} style={{ color }} aria-hidden />;
}

interface BreadcrumbItem {
  label: string;
  path: string;
  isFile?: boolean;
}

interface FlyoutState {
  /** 触发弹层的面包屑节点路径（锚点，决定挂载在哪个 segment 上） */
  anchorPath: string;
  /** 当前浮层正在浏览的物理目录路径（支持下钻和回退） */
  currentPath: string;
  /** 当前正在浏览的目录显示名称 */
  currentLabel: string;
  /** 下钻历史路径栈（用于返回上一级） */
  navHistory: string[];
  /** 当前目录下的文件/文件夹列表 */
  entries: FsDirEntry[];
  /** 加载中状态 */
  loading: boolean;
  /** 过滤关键词 */
  filter: string;
}

interface FileBreadcrumbProps {
  root: string;
  cwd: string;
  selected: string | null;
  view: ViewMode;
  onNavigate: (path: string) => void;
  onRefresh: (path: string) => void;
  onOpenFile: (path: string) => void;
}

export const FileBreadcrumb = React.memo(function FileBreadcrumb({
  root,
  cwd,
  selected,
  view,
  onNavigate,
  onRefresh: _onRefresh,
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

  const breadcrumbs: BreadcrumbItem[] = useMemo(() => {
    if (!root) return [];
    const dir =
      view === 'detail' && selected
        ? pathDirname(selected) || root
        : cwd || root;
    const rel = pathRelativeToRoot(dir, root);
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
  }, [cwd, root, rootLabel, selected, view]);

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
        currentPath: dirPath,
        currentLabel: label,
        navHistory: [],
        entries: [],
        loading: true,
        filter: '',
      });
      try {
        const list = await loadDir(dirPath);
        setBcFlyout((prev) =>
          prev && prev.anchorPath === dirPath && prev.currentPath === dirPath
            ? { ...prev, entries: list, loading: false }
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

  const handleDrillDown = useCallback(
    async (dirPath: string, dirName: string) => {
      if (!bcFlyout) return;
      const nextHistory = [...bcFlyout.navHistory, bcFlyout.currentPath];
      setBcFlyout((prev) =>
        prev
          ? {
              ...prev,
              currentPath: dirPath,
              currentLabel: dirName,
              navHistory: nextHistory,
              entries: [],
              loading: true,
              filter: '',
            }
          : null
      );
      try {
        const list = await loadDir(dirPath);
        setBcFlyout((prev) =>
          prev && prev.currentPath === dirPath
            ? { ...prev, entries: list, loading: false }
            : prev
        );
        requestAnimationFrame(() => bcFilterRef.current?.focus());
      } catch {
        setBcFlyout((prev) =>
          prev ? { ...prev, entries: [], loading: false } : null
        );
      }
    },
    [bcFlyout, loadDir]
  );

  const handleNavBack = useCallback(async () => {
    if (!bcFlyout || bcFlyout.navHistory.length === 0) return;
    const prevPath = bcFlyout.navHistory[bcFlyout.navHistory.length - 1];
    if (!prevPath) return;
    const targetPath = prevPath;
    const nextHistory = bcFlyout.navHistory.slice(0, -1);
    const prevLabel =
      targetPath.split(/[\\/]/).filter(Boolean).pop() || rootLabel;
    setBcFlyout((prev) =>
      prev
        ? {
            ...prev,
            currentPath: targetPath,
            currentLabel: prevLabel,
            navHistory: nextHistory,
            entries: [],
            loading: true,
            filter: '',
          }
        : null
    );
    try {
      const list = await loadDir(targetPath);
      setBcFlyout((prev) =>
        prev && prev.currentPath === targetPath
          ? { ...prev, entries: list, loading: false }
          : prev
      );
      requestAnimationFrame(() => bcFilterRef.current?.focus());
    } catch {
      setBcFlyout((prev) =>
        prev ? { ...prev, entries: [], loading: false } : null
      );
    }
  }, [bcFlyout, loadDir, rootLabel]);

  useEffect(() => {
    if (!bcFlyout) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (crumbsRef.current?.contains(t)) return;
      setBcFlyout(null);
      requestAnimationFrame(() => bcTriggerRef.current?.focus());
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

  const bcFlyoutFiltered = useMemo(() => {
    if (!bcFlyout) return [];
    const q = bcFlyout.filter.trim().toLowerCase();
    let list = bcFlyout.entries;
    if (q) list = list.filter((e) => e.name.toLowerCase().includes(q));
    return [...list].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const aNoise = a.name.startsWith('.') || a.name.startsWith('--');
      const bNoise = b.name.startsWith('.') || b.name.startsWith('--');
      if (aNoise !== bNoise) return aNoise ? 1 : -1;
      return a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });
  }, [bcFlyout]);

  if (!root) return null;

  return (
    <div
      className={styles.filesCrumbs}
      ref={crumbsRef}
      aria-label="工作区相对路径"
    >
      {breadcrumbs.length === 0 ? (
        <span
          className={`${styles.filesBcChip} ${styles.filesBcChipMuted || 'files-bc-chip--muted'}`}
        >
          {rootLabel}
        </span>
      ) : (
        breadcrumbs.map((b, i) => {
          const isLast = i === breadcrumbs.length - 1;
          const canNav = !b.isFile;
          // 关键修复：依靠稳定的 anchorPath 匹配，下钻时弹层绝不意外卸载瞬灭
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
                        requestAnimationFrame(() =>
                          bcTriggerRef.current?.focus()
                        );
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
                      aria-label={`${bcFlyout.currentLabel} 目录`}
                    >
                      {bcFlyout.navHistory.length > 0 ? (
                        <div className={styles.filesBcNavHeader}>
                          <button
                            type="button"
                            className={styles.filesBcNavBackBtn}
                            onClick={() => void handleNavBack()}
                            aria-label="返回上一级"
                          >
                            <CornerLeftUp size={12} aria-hidden />
                            <span>返回</span>
                          </button>
                          <Tooltip content={bcFlyout.currentPath}>
                            <span className={styles.filesBcNavCurrentPath}>
                              {pathRelativeToRoot(bcFlyout.currentPath, root) ||
                                rootLabel}
                            </span>
                          </Tooltip>
                        </div>
                      ) : null}
                      <div className={styles.filesBcFlyoutSearch}>
                        <Search size={14} aria-hidden />
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
                              requestAnimationFrame(() =>
                                bcTriggerRef.current?.focus()
                              );
                            }
                          }}
                        />
                      </div>
                      <div className={styles.filesBcFlyoutList}>
                        {bcFlyout.loading ? (
                          <div className={styles.filesBcFlyoutEmpty}>
                            加载中…
                          </div>
                        ) : bcFlyoutFiltered.length === 0 ? (
                          <div className={styles.filesBcFlyoutEmpty}>
                            {bcFlyout.filter.trim() ? '无匹配' : '空目录'}
                          </div>
                        ) : (
                          bcFlyoutFiltered.map((ent) => (
                            <button
                              key={ent.path}
                              type="button"
                              role="option"
                              className={`${styles.filesBcFlyoutItem} ${selected === ent.path ? styles.isActive : ''}`}
                              onClick={() => {
                                if (ent.isDir) {
                                  // 下钻导航：进入子目录，保持浮层展开
                                  void handleDrillDown(ent.path, ent.name);
                                } else {
                                  // 打开文件：关闭浮层
                                  setBcFlyout(null);
                                  requestAnimationFrame(() =>
                                    bcTriggerRef.current?.focus()
                                  );
                                  void onOpenFile(ent.path);
                                }
                              }}
                            >
                              {ent.isDir ? (
                                <>
                                  <ChevronRight
                                    size={13}
                                    className={styles.filesBcFlyoutChev}
                                    aria-hidden
                                  />
                                  <Folder size={14} aria-hidden />
                                </>
                              ) : (
                                <>
                                  <span
                                    className={`${styles.filesBcFlyoutChev} ${styles.isLeaf}`}
                                  />
                                  <BcFileIcon name={ent.name} />
                                </>
                              )}
                              <span className={styles.filesBcFlyoutName}>
                                {ent.name}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className={styles.filesBcFlyoutGoto}
                        onClick={() => {
                          const target = bcFlyout.currentPath;
                          setBcFlyout(null);
                          requestAnimationFrame(() =>
                            bcTriggerRef.current?.focus()
                          );
                          onNavigate(target);
                        }}
                      >
                        打开此目录
                      </Button>
                    </div>
                  ) : null}
                </span>
              ) : (
                <span
                  className={`${styles.filesBcChip} ${isLast ? styles.filesBcChipFile : ''}`}
                >
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
