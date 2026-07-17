/**
 * 右侧文件管理器
 *  - 顶栏：导航图标 + 面包屑（非地址栏输入框）+ 筛选/更多
 *  - 详情：图片/PDF/表格/文本；Markdown 可渲染/源码；长文件分段加载
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { getWorkspacePath } from '../api/projectStore';
import {
  addPendingFileAnnotation,
  countPendingFileAnnotations,
  detectFileKind,
  FILE_PREVIEW_CHUNK_LINES,
  FILE_PREVIEW_MAX_LINES,
  isMarkdownFilename,
  nextFilePreviewLineBudget,
  listDirectory,
  parseCsvPreview,
  pathBasename,
  pathDirname,
  pathRelativeToRoot,
  readTextFile,
  resolveWorkspacePath,
  revealInOs,
  takePendingOpenPath,
  toAssetUrl,
  writeTextFile,
  type FsDirEntry,
} from '../api/workspaceFsApi';
import {
  listOpenOptionsForFile,
  openPathDefault,
  openWithHostOpener,
  type HostOpener,
} from '../api/hostOpenersApi';
import { fileExtColor, highlightCode, langFromFilename } from '../api/codeHighlight';
import { parseMarkdownToHtml } from '../api/markdownRender';

interface FilesCardProps {
  /** @deprecated 文件操作错误改行内；保留 prop 兼容 CardPanel */
  onShowToast?: (message: string) => void;
  initialPath?: string | null;
}

type ViewMode = 'browse' | 'detail';
type TreeNode = FsDirEntry & { depth: number };

export const FilesCard: React.FC<FilesCardProps> = ({ initialPath }) => {
  const [root, setRoot] = useState(() => getWorkspacePath());
  const [cwd, setCwd] = useState(root || '');
  const [entries, setEntries] = useState<FsDirEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, FsDirEntry[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('browse');
  const [content, setContent] = useState('');
  const [editBuf, setEditBuf] = useState('');
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [truncated, setTruncated] = useState(false);
  /** 当前已加载的行上限（分段预览） */
  const [lineBudget, setLineBudget] = useState(FILE_PREVIEW_CHUNK_LINES);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Markdown：渲染预览 / 源码 */
  const [mdMode, setMdMode] = useState<'render' | 'source'>('render');
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selText, setSelText] = useState('');
  const [commentDraft, setCommentDraft] = useState('');
  const [selAnchor, setSelAnchor] = useState<{ top: number; left: number } | null>(null);
  const [pendingCount, setPendingCount] = useState(() => countPendingFileAnnotations());
  const [moreOpen, setMoreOpen] = useState(false);
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const [openMenuMore, setOpenMenuMore] = useState(false);
  const [fileOpeners, setFileOpeners] = useState<HostOpener[]>([]);
  const [openDefaultLabel, setOpenDefaultLabel] = useState('打开');
  const [filterMode, setFilterMode] = useState(false);
  /** 面包屑某段展开的目录下拉（Kimi 式：点层级列出该目录） */
  const [bcFlyout, setBcFlyout] = useState<{
    path: string;
    label: string;
    entries: FsDirEntry[];
    loading: boolean;
    filter: string;
  } | null>(null);
  /** 保存/复制/资源管理器：行内短提示，不 toast（仅失败） */
  const [actionHint, setActionHint] = useState<string | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const openMenuRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLPreElement>(null);
  const previewPaneRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const bcFilterRef = useRef<HTMLInputElement>(null);
  const actionHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 行内操作错误：短时自消，成功路径永不写提示 */
  const showActionError = useCallback((msg: string) => {
    setActionHint(msg);
    if (actionHintTimerRef.current) clearTimeout(actionHintTimerRef.current);
    actionHintTimerRef.current = setTimeout(() => {
      setActionHint(null);
      actionHintTimerRef.current = null;
    }, 4800);
  }, []);

  const clearActionHint = useCallback(() => {
    if (actionHintTimerRef.current) {
      clearTimeout(actionHintTimerRef.current);
      actionHintTimerRef.current = null;
    }
    setActionHint(null);
  }, []);

  const kind = selected ? detectFileKind(pathBasename(selected)) : 'binary';

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

  const openFile = useCallback(async (filePath: string) => {
    takePendingOpenPath();
    const resolved = resolveWorkspacePath(filePath);
    setSelected(resolved);
    setView('detail');
    setEditing(false);
    setDirty(false);
    setDetailLoading(true);
    setContent('');
    setEditBuf('');
    setAssetUrl(null);
    setError('');
    clearActionHint();
    setSelText('');
    setCommentDraft('');
    setMoreOpen(false);
    setOpenMenuOpen(false);
    setOpenMenuMore(false);
    setTruncated(false);
    // 扫描本机打开方式（快捷方式 / 已安装应用，非硬编码名单）
    void listOpenOptionsForFile(resolved)
      .then((opts) => {
        setFileOpeners(opts.openers);
        setOpenDefaultLabel(opts.defaultLabel || '打开');
      })
      .catch(() => {
        setFileOpeners([]);
        setOpenDefaultLabel('打开');
      });
    const initialBudget =
      detectFileKind(pathBasename(resolved)) === 'table'
        ? 200
        : FILE_PREVIEW_CHUNK_LINES;
    setLineBudget(initialBudget);
    setMdMode('render');
    setLoadingMore(false);
    const parent = pathDirname(resolved);
    if (parent) setCwd(parent);
    const base = pathBasename(resolved);
    const k = detectFileKind(base);
    try {
      if (k === 'image' || k === 'pdf') {
        const url = await toAssetUrl(resolved);
        setAssetUrl(url);
        if (!url) setError('无法生成预览（需桌面壳 · 资源协议）');
      } else if (k === 'text' || k === 'table') {
        const res = await readTextFile(resolved, initialBudget);
        setContent(res.content);
        setEditBuf(res.content);
        setTruncated(res.truncated);
        setLineBudget(initialBudget);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  }, [clearActionHint]);

  /** 长文件再加载一段（提高 maxLines 重读，避免一次挂满 DOM） */
  const loadMoreLines = useCallback(async () => {
    if (!selected || loadingMore || editing) return;
    const next = nextFilePreviewLineBudget(lineBudget);
    if (next == null || next <= lineBudget) return;
    setLoadingMore(true);
    try {
      const res = await readTextFile(selected, next);
      setContent(res.content);
      if (!dirty) setEditBuf(res.content);
      setTruncated(res.truncated);
      setLineBudget(next);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }, [dirty, editing, lineBudget, loadingMore, selected]);

  /** 接近底部自动续载长文件 */
  const onPreviewScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!truncated || loadingMore || editing) return;
      if (lineBudget >= FILE_PREVIEW_MAX_LINES) return;
      const el = e.currentTarget;
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (gap < 120) void loadMoreLines();
    },
    [editing, lineBudget, loadMoreLines, loadingMore, truncated],
  );

  useEffect(() => {
    const onProject = () => {
      const r = getWorkspacePath();
      setRoot(r);
      setView('browse');
      setSelected(null);
      void refresh(r || undefined);
    };
    window.addEventListener('crish-project-changed', onProject);
    return () => window.removeEventListener('crish-project-changed', onProject);
  }, [refresh]);

  useEffect(() => {
    void refresh(root || undefined).then(() => {
      const pending = takePendingOpenPath() || initialPath;
      if (pending) void openFile(pending);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onOpen = (ev: Event) => {
      const path = (ev as CustomEvent<{ path?: string }>).detail?.path;
      if (!path) return;
      const resolved = resolveWorkspacePath(path);
      // 从对话打开时：先定位到父目录列表，再进入详情
      const parent = pathDirname(resolved);
      if (parent) {
        void refresh(parent).finally(() => {
          void openFile(resolved);
        });
      } else {
        void openFile(resolved);
      }
    };
    window.addEventListener('crish-open-file', onOpen);
    return () => window.removeEventListener('crish-open-file', onOpen);
  }, [openFile, refresh]);

  useEffect(() => {
    const onAnn = () => setPendingCount(countPendingFileAnnotations());
    window.addEventListener('crish-file-annotations-changed', onAnn);
    return () => window.removeEventListener('crish-file-annotations-changed', onAnn);
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [moreOpen]);

  useEffect(
    () => () => {
      if (actionHintTimerRef.current) clearTimeout(actionHintTimerRef.current);
    },
    [],
  );

  const toggleExpand = async (dirPath: string, e: React.MouseEvent) => {
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
      // 行内错误，避免与 diff/打开文件联动时 toast 刷屏
      setError(err instanceof Error ? err.message : '展开失败');
    }
  };

  const flatTree: TreeNode[] = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const out: TreeNode[] = [];
    const walk = (list: FsDirEntry[], depth: number) => {
      for (const e of list) {
        out.push({ ...e, depth });
        if (e.isDir && expanded[e.path]) walk(expanded[e.path], depth + 1);
      }
    };
    walk(entries, 0);
    if (!q) return out;
    return out.filter((n) => n.name.toLowerCase().includes(q));
  }, [entries, expanded, filter]);

  const goUp = () => {
    if (!cwd || (root && cwd === root)) return;
    const parent = pathDirname(cwd);
    if (parent && parent !== cwd) {
      setView('browse');
      setSelected(null);
      clearActionHint();
      setError('');
      void refresh(parent);
    }
  };

  const saveFile = async () => {
    if (!selected || !editing) return;
    clearActionHint();
    try {
      await writeTextFile(selected, editBuf);
      setContent(editBuf);
      setDirty(false);
      setEditing(false);
      setError('');
      // 成功静默：退出编辑 + dirty 消失即为反馈，不 toast
    } catch (e) {
      // 行内错误，避免保存连点 toast 刷屏
      showActionError(e instanceof Error ? e.message : '保存失败');
    }
  };

  const onTextSelect = () => {
    // 延迟一帧，确保 selection 已稳定；批注条锚定到选区可视位置
    requestAnimationFrame(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() || '';
      if (!text.length) {
        setSelText('');
        setSelAnchor(null);
        return;
      }
      setSelText(text.slice(0, 2000));
      try {
        if (!selection || selection.rangeCount === 0) {
          setSelAnchor(null);
          return;
        }
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const pane = previewPaneRef.current;
        if (!pane || !rect || (rect.width === 0 && rect.height === 0)) {
          setSelAnchor(null);
          return;
        }
        const paneRect = pane.getBoundingClientRect();
        // 相对预览窗定位，贴近选区下方
        const top = Math.min(
          Math.max(rect.bottom - paneRect.top + pane.scrollTop + 6, 8),
          Math.max(pane.scrollHeight - 120, 8),
        );
        const left = Math.min(
          Math.max(rect.left - paneRect.left + pane.scrollLeft, 8),
          Math.max(pane.clientWidth - 280, 8),
        );
        setSelAnchor({ top, left });
      } catch {
        setSelAnchor(null);
      }
    });
  };

  const submitSelectionComment = () => {
    if (!selected || !selText.trim() || !commentDraft.trim()) return;
    addPendingFileAnnotation({
      path: selected,
      selectedText: selText.trim(),
      text: commentDraft.trim(),
    });
    setPendingCount(countPendingFileAnnotations());
    setCommentDraft('');
    setSelText('');
    setSelAnchor(null);
    // 仅靠 pending badge 反馈，不 toast（与 diff 联动路径一致）
  };

  /** 地址栏面包屑：浏览用 cwd；详情用文件父路径 + 文件名 */
  const breadcrumbs = useMemo(() => {
    if (!root) return [] as { label: string; path: string; isFile?: boolean }[];
    const dir =
      view === 'detail' && selected
        ? pathDirname(selected) || root
        : cwd || root;
    const rel = pathRelativeToRoot(dir, root);
    const items: { label: string; path: string; isFile?: boolean }[] = [
      { label: '项目', path: root },
    ];
    if (rel && rel !== '.') {
      let acc = root;
      for (const part of rel.replace(/\\/g, '/').split('/').filter(Boolean)) {
        acc = joinLocal(acc, part);
        items.push({ label: part, path: acc });
      }
    }
    if (view === 'detail' && selected) {
      items.push({
        label: pathBasename(selected),
        path: selected,
        isFile: true,
      });
    }
    return items;
  }, [cwd, root, selected, view]);

  const copyPath = (mode: 'abs' | 'rel' = 'rel') => {
    const p = selected || cwd;
    if (!p || !root) return;
    const text =
      mode === 'rel' ? pathRelativeToRoot(p, root) || pathBasename(p) : p;
    // 成功静默（剪贴板本身即反馈）；失败行内，不 toast
    void navigator.clipboard.writeText(text).then(
      () => clearActionHint(),
      () => showActionError('复制失败'),
    );
  };

  /** 点面包屑目录段：弹出该层目录列表（可筛选/进入） */
  const openBcFlyout = useCallback(
    async (dirPath: string, label: string) => {
      if (bcFlyout?.path === dirPath) {
        setBcFlyout(null);
        return;
      }
      setBcFlyout({ path: dirPath, label, entries: [], loading: true, filter: '' });
      try {
        const list = await loadDir(dirPath);
        setBcFlyout((prev) =>
          prev && prev.path === dirPath
            ? { ...prev, entries: list, loading: false }
            : prev,
        );
        requestAnimationFrame(() => bcFilterRef.current?.focus());
      } catch (e) {
        setBcFlyout(null);
        showActionError(e instanceof Error ? e.message : '无法读取目录');
      }
    },
    [bcFlyout?.path, loadDir, showActionError],
  );

  useEffect(() => {
    if (!bcFlyout) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (crumbsRef.current?.contains(t)) return;
      setBcFlyout(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBcFlyout(null);
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
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }, [bcFlyout]);

  if (!root) {
    return (
      <div className="files-card">
        <div className="files-empty files-empty--compact">
          <div className="files-empty-title">未选择项目</div>
          <div className="files-empty-sub">在侧栏选择工作区后即可浏览</div>
        </div>
      </div>
    );
  }

  const canEdit = kind === 'text' || kind === 'table';
  const isMd = Boolean(
    view === 'detail' &&
      selected &&
      isMarkdownFilename(pathBasename(selected)) &&
      !editing,
  );
  const canLoadMore =
    truncated &&
    lineBudget < FILE_PREVIEW_MAX_LINES &&
    (kind === 'text' || kind === 'table') &&
    !editing;

  return (
    <div className="files-card">
      {/* 顶栏：导航 + 面包屑（非输入框 chrome） */}
      <div className="files-bar" role="toolbar" aria-label="文件导航">
        <button
          type="button"
          className="files-nav-btn"
          title="上级目录"
          disabled={!cwd || cwd === root}
          onClick={() => goUp()}
        >
          <Lucide.CornerLeftUp size={15} />
        </button>
        <button
          type="button"
          className="files-nav-btn"
          title="刷新"
          onClick={() => {
            clearActionHint();
            if (view === 'detail' && selected) void openFile(selected);
            else void refresh();
          }}
        >
          <Lucide.RotateCw size={15} />
        </button>

        <div
          className="files-crumbs"
          ref={crumbsRef}
          title={
            selected || cwd ? `绝对路径：${selected || cwd}` : '项目根目录'
          }
          aria-label="工作区相对路径"
        >
          {breadcrumbs.length === 0 ? (
            <span className="files-bc-chip files-bc-chip--muted">项目</span>
          ) : (
            breadcrumbs.map((b, i) => {
              const isLast = i === breadcrumbs.length - 1;
              const canNav = !b.isFile;
              const flyOpen = bcFlyout?.path === b.path;
              return (
                <React.Fragment key={`${b.path}-${i}`}>
                  {i > 0 ? <span className="files-bc-sep">/</span> : null}
                  {canNav ? (
                    <span className="files-bc-seg">
                      <button
                        type="button"
                        className={`files-bc-chip ${i === 0 ? 'files-bc-chip--root' : ''}${flyOpen ? ' is-open' : ''}`}
                        title={i === 0 ? '项目根目录 · 点击列出内容' : `${b.path} · 点击列出该层`}
                        aria-haspopup="listbox"
                        aria-expanded={flyOpen}
                        onClick={() => void openBcFlyout(b.path, b.label)}
                        onDoubleClick={() => {
                          // 双击：直接进入该目录（树刷新）
                          setBcFlyout(null);
                          setSelected(null);
                          setEditing(false);
                          clearActionHint();
                          setError('');
                          void refresh(b.path);
                        }}
                      >
                        {b.label}
                      </button>
                      {flyOpen && bcFlyout ? (
                        <div
                          className="files-bc-flyout"
                          role="listbox"
                          aria-label={`${b.label} 目录`}
                        >
                          <div className="files-bc-flyout-search">
                            <Lucide.Search size={14} aria-hidden />
                            <input
                              ref={bcFilterRef}
                              type="search"
                              placeholder="筛选文件…"
                              value={bcFlyout.filter}
                              onChange={(e) =>
                                setBcFlyout((prev) =>
                                  prev ? { ...prev, filter: e.target.value } : prev,
                                )
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') setBcFlyout(null);
                              }}
                            />
                          </div>
                          <div className="files-bc-flyout-list">
                            {bcFlyout.loading ? (
                              <div className="files-bc-flyout-empty">加载中…</div>
                            ) : bcFlyoutFiltered.length === 0 ? (
                              <div className="files-bc-flyout-empty">
                                {bcFlyout.filter.trim() ? '无匹配' : '空目录'}
                              </div>
                            ) : (
                              bcFlyoutFiltered.map((ent) => (
                                <button
                                  key={ent.path}
                                  type="button"
                                  role="option"
                                  className={`files-bc-flyout-item${
                                    selected === ent.path ? ' is-active' : ''
                                  }`}
                                  onClick={() => {
                                    if (ent.isDir) {
                                      void openBcFlyout(ent.path, ent.name);
                                      void refresh(ent.path);
                                    } else {
                                      setBcFlyout(null);
                                      void openFile(ent.path);
                                    }
                                  }}
                                >
                                  {ent.isDir ? (
                                    <>
                                      <Lucide.ChevronRight
                                        size={13}
                                        className="files-bc-flyout-chev"
                                        aria-hidden
                                      />
                                      <Lucide.Folder size={14} aria-hidden />
                                    </>
                                  ) : (
                                    <>
                                      <span className="files-bc-flyout-chev is-leaf" />
                                      <FileIcon name={ent.name} />
                                    </>
                                  )}
                                  <span className="files-bc-flyout-name">{ent.name}</span>
                                </button>
                              ))
                            )}
                          </div>
                          <button
                            type="button"
                            className="files-bc-flyout-goto"
                            onClick={() => {
                              setBcFlyout(null);
                              setSelected(null);
                              setEditing(false);
                              clearActionHint();
                              void refresh(bcFlyout.path);
                            }}
                          >
                            打开此目录
                          </button>
                        </div>
                      ) : null}
                    </span>
                  ) : (
                    <span
                      className={`files-bc-chip ${isLast ? 'files-bc-chip--file' : ''}`}
                      title={b.path}
                    >
                      {b.label}
                    </span>
                  )}
                </React.Fragment>
              );
            })
          )}
        </div>

        {view === 'browse' && (filterMode || filter) ? (
          <input
            ref={filterInputRef}
            className="files-path-filter"
            placeholder="筛选…"
            value={filter}
            autoFocus
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setFilter('');
                setFilterMode(false);
              }
            }}
          />
        ) : null}
        {view === 'browse' ? (
          <button
            type="button"
            className={`files-nav-btn ${filterMode || filter ? 'is-on' : ''}`}
            title={filterMode || filter ? '关闭筛选' : '筛选当前目录'}
            onClick={() => {
              if (filterMode || filter) {
                setFilter('');
                setFilterMode(false);
              } else {
                setFilterMode(true);
                requestAnimationFrame(() => filterInputRef.current?.focus());
              }
            }}
          >
            {filterMode || filter ? <Lucide.X size={14} /> : <Lucide.Search size={14} />}
          </button>
        ) : null}

        {pendingCount > 0 ? (
          <span className="files-pending-badge" title="待发送批注">
            {pendingCount}
          </span>
        ) : null}

        <div className="files-more-wrap" ref={moreRef}>
          <button
            type="button"
            className="files-nav-btn"
            title="更多"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          >
            <Lucide.MoreHorizontal size={15} />
          </button>
          {moreOpen ? (
            <div className="files-more-menu" role="menu">
              <button
                type="button"
                className="files-more-item"
                role="menuitem"
                onClick={() => {
                  copyPath('rel');
                  setMoreOpen(false);
                }}
              >
                复制相对路径
              </button>
              <button
                type="button"
                className="files-more-item"
                role="menuitem"
                onClick={() => {
                  copyPath('abs');
                  setMoreOpen(false);
                }}
              >
                复制绝对路径
              </button>
              <button
                type="button"
                className="files-more-item"
                role="menuitem"
                onClick={() => {
                  const p = selected || cwd;
                  if (p) {
                    void revealInOs(p)
                      .then(() => clearActionHint())
                      .catch((e) =>
                        showActionError(e instanceof Error ? e.message : '打开失败'),
                      );
                  }
                  setMoreOpen(false);
                }}
              >
                在资源管理器中显示
              </button>
              {view === 'detail' && canEdit && !editing ? (
                <button
                  type="button"
                  className="files-more-item"
                  onClick={() => {
                    setEditing(true);
                    setEditBuf(content);
                    setSelText('');
                    setMoreOpen(false);
                  }}
                >
                  编辑文件
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* 选中文件后：名称 + 打开胶囊 + 编辑等 */}
      {selected ? (
        <div className="files-context-bar">
          <span className="files-context-name" title={selected}>
            {dirty ? (
              <span className="files-dirty-dot" title="未保存" aria-label="未保存">
                ·
              </span>
            ) : null}
            {pathBasename(selected)}
          </span>
          <div className="files-context-actions">
            {isMd ? (
              <div className="files-seg" role="group" aria-label="Markdown 显示">
                <button
                  type="button"
                  className={`files-seg-btn ${mdMode === 'render' ? 'is-on' : ''}`}
                  aria-pressed={mdMode === 'render'}
                  title="渲染预览"
                  onClick={() => setMdMode('render')}
                >
                  渲染
                </button>
                <button
                  type="button"
                  className={`files-seg-btn ${mdMode === 'source' ? 'is-on' : ''}`}
                  aria-pressed={mdMode === 'source'}
                  title="源码"
                  onClick={() => setMdMode('source')}
                >
                  源码
                </button>
              </div>
            ) : null}
            {canEdit && !editing ? (
              <button
                type="button"
                className="files-soft-btn"
                onClick={() => {
                  setEditing(true);
                  setEditBuf(content);
                  setSelText('');
                  setMdMode('source');
                  clearActionHint();
                }}
              >
                <Lucide.Pencil size={13} />
                编辑
              </button>
            ) : null}
            {editing ? (
              <>
                <button
                  type="button"
                  className="files-soft-btn files-soft-btn--emphasis"
                  disabled={!dirty}
                  onClick={() => void saveFile()}
                >
                  <Lucide.Save size={13} />
                  保存
                </button>
                <button
                  type="button"
                  className="files-soft-btn"
                  onClick={() => {
                    setEditing(false);
                    setEditBuf(content);
                    setDirty(false);
                    clearActionHint();
                  }}
                >
                  取消
                </button>
              </>
            ) : null}
            {selected ? (
              <div className="files-open-capsule" ref={openMenuRef}>
                <button
                  type="button"
                  className="files-open-main"
                  title={`${openDefaultLabel}（系统默认）`}
                  onClick={() => {
                    void openPathDefault(selected)
                      .then(() => clearActionHint())
                      .catch((e) =>
                        showActionError(e instanceof Error ? e.message : '打开失败'),
                      );
                  }}
                >
                  <Lucide.ExternalLink size={13} aria-hidden />
                  {openDefaultLabel}
                </button>
                <button
                  type="button"
                  className="files-open-chev"
                  title="选择打开方式"
                  aria-haspopup="menu"
                  aria-expanded={openMenuOpen}
                  onClick={() => {
                    setOpenMenuOpen((v) => !v);
                    setOpenMenuMore(false);
                  }}
                >
                  <Lucide.ChevronDown size={14} aria-hidden />
                </button>
                {openMenuOpen ? (
                  <div className="files-open-menu" role="menu">
                    <button
                      type="button"
                      className="files-open-item"
                      role="menuitem"
                      onClick={() => {
                        copyPath('abs');
                        setOpenMenuOpen(false);
                      }}
                    >
                      <Lucide.Copy size={14} aria-hidden />
                      复制路径
                    </button>
                    <button
                      type="button"
                      className="files-open-item"
                      role="menuitem"
                      onClick={() => {
                        void revealInOs(selected)
                          .then(() => clearActionHint())
                          .catch((e) =>
                            showActionError(e instanceof Error ? e.message : '打开失败'),
                          );
                        setOpenMenuOpen(false);
                      }}
                    >
                      <Lucide.FolderOpen size={14} aria-hidden />
                      在文件管理器中显示
                    </button>
                    {fileOpeners.length > 0 ? (
                      <div className="files-open-sep" role="separator" />
                    ) : null}
                    {(openMenuMore ? fileOpeners : fileOpeners.slice(0, 6)).map((op) => (
                      <button
                        key={op.id}
                        type="button"
                        className="files-open-item"
                        role="menuitem"
                        title={op.path || op.displayName}
                        onClick={() => {
                          void openWithHostOpener(op.id, selected)
                            .then(() => clearActionHint())
                            .catch((e) =>
                              showActionError(e instanceof Error ? e.message : '打开失败'),
                            );
                          setOpenMenuOpen(false);
                        }}
                      >
                        <span className="files-open-app-ico" aria-hidden>
                          {(op.displayName || '?').slice(0, 1)}
                        </span>
                        {op.displayName}
                      </button>
                    ))}
                    {fileOpeners.length > 6 ? (
                      <button
                        type="button"
                        className="files-open-item files-open-item--more"
                        role="menuitem"
                        onClick={() => setOpenMenuMore((v) => !v)}
                      >
                        <Lucide.ChevronsUpDown size={14} aria-hidden />
                        {openMenuMore ? '收起' : `更多应用（${fileOpeners.length - 6}）`}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 操作级错误条（保存/复制/OS 打开）：仅失败，不 toast */}
      {actionHint ? (
        <div className="files-action-hint" role="alert" aria-live="assertive">
          <span className="files-action-hint-text">{actionHint}</span>
          <button
            type="button"
            className="files-action-hint-dismiss"
            title="关闭"
            aria-label="关闭提示"
            onClick={() => clearActionHint()}
          >
            <Lucide.X size={12} />
          </button>
        </div>
      ) : null}

      <div className="files-body files-body--split">
        {/* 左：文件树（始终可见） */}
        <div className="files-list files-list--pane">
          {loading ? (
            <div className="files-empty files-empty--compact">加载中…</div>
          ) : error && !entries.length ? (
            <div className="files-empty files-empty--compact files-empty--err" role="alert">
              <div className="files-empty-title">无法读取目录</div>
              <div className="files-empty-sub">{error}</div>
            </div>
          ) : flatTree.length === 0 ? (
            <div className="files-empty files-empty--compact">
              {filter.trim() ? '无匹配项' : '空目录'}
            </div>
          ) : (
            <>
              {error ? (
                <div className="files-inline-err" role="alert" aria-live="polite">
                  <span className="files-inline-err-text">{error}</span>
                  <button
                    type="button"
                    className="files-inline-err-dismiss"
                    title="关闭"
                    aria-label="关闭错误"
                    onClick={() => setError('')}
                  >
                    <Lucide.X size={11} />
                  </button>
                </div>
              ) : null}
              {flatTree.map((e) => (
                <div
                  key={e.path}
                  className={`files-row ${selected === e.path ? 'is-selected' : ''}`}
                  style={{ paddingLeft: 4 + e.depth * 10 }}
                  onClick={() => {
                    if (e.isDir) {
                      void (async () => {
                        if (!expanded[e.path]) {
                          try {
                            const list = await loadDir(e.path);
                            setExpanded((prev) => ({ ...prev, [e.path]: list }));
                            setError('');
                          } catch (err) {
                            setError(err instanceof Error ? err.message : '展开失败');
                          }
                        } else {
                          setExpanded((prev) => {
                            const next = { ...prev };
                            delete next[e.path];
                            return next;
                          });
                        }
                      })();
                    } else void openFile(e.path);
                  }}
                  onDoubleClick={() => {
                    if (e.isDir) void refresh(e.path);
                    else {
                      void openFile(e.path);
                      void openPathDefault(e.path).catch(() => undefined);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter') {
                      if (e.isDir) void refresh(e.path);
                      else void openFile(e.path);
                    }
                  }}
                >
                  <button
                    type="button"
                    className={`files-row-twist ${e.isDir ? '' : 'is-leaf'}`}
                    onClick={(ev) => (e.isDir ? void toggleExpand(e.path, ev) : undefined)}
                    tabIndex={-1}
                  >
                    {e.isDir ? (
                      expanded[e.path] ? (
                        <Lucide.ChevronDown size={13} />
                      ) : (
                        <Lucide.ChevronRight size={13} />
                      )
                    ) : null}
                  </button>
                  {e.isDir ? (
                    <Lucide.Folder size={14} className="files-row-ico dir" />
                  ) : (
                    <FileIcon name={e.name} />
                  )}
                  <span className="files-row-name" title={e.name}>
                    {e.name}
                  </span>
                  {!e.isDir && e.size != null ? (
                    <span className="files-row-meta">{formatSize(e.size)}</span>
                  ) : null}
                </div>
              ))}
            </>
          )}
        </div>
        {/* 右：预览（点选文件后显示） */}
        <div className="files-detail files-detail--pane">
          {!selected ? (
            <div className="files-empty files-empty--compact">
              <div className="files-empty-title">预览</div>
              <div className="files-empty-sub">在左侧选择文件</div>
            </div>
          ) : null}
          {selected && error && (content || assetUrl) ? (
            <div className="files-inline-err files-inline-err--detail" role="alert" aria-live="polite">
              <span className="files-inline-err-text">{error}</span>
              <button
                type="button"
                className="files-inline-err-dismiss"
                title="关闭"
                aria-label="关闭错误"
                onClick={() => setError('')}
              >
                <Lucide.X size={11} />
              </button>
            </div>
          ) : null}
          {selected ? (
            <div
              className="files-detail-body"
              ref={previewPaneRef}
              onScroll={onPreviewScroll}
            >
              {detailLoading ? (
                <div className="files-empty files-empty--compact">读取中…</div>
              ) : error && !content && !assetUrl ? (
                <div className="files-empty files-empty--compact files-empty--err" role="alert">
                  <div className="files-empty-title">无法预览</div>
                  <div className="files-empty-sub">{error}</div>
                </div>
              ) : kind === 'image' && assetUrl ? (
                <div className="files-preview-media">
                  <img
                    src={assetUrl}
                    alt={pathBasename(selected || '')}
                    onError={() =>
                      setError('图片无法显示（请确认桌面壳资源协议已启用）')
                    }
                  />
                </div>
              ) : kind === 'pdf' && assetUrl ? (
                <iframe
                  title="pdf"
                  className="files-preview-pdf"
                  src={assetUrl}
                />
              ) : kind === 'table' && !editing ? (
                <div className="files-table-wrap">
                  <table className="files-table">
                    <tbody>
                      {parseCsvPreview(content).map((row, i) => (
                        <tr key={i}>
                          {row.map((cell, j) =>
                            i === 0 ? <th key={j}>{cell}</th> : <td key={j}>{cell}</td>,
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {canLoadMore ? (
                    <button
                      type="button"
                      className="files-load-more"
                      disabled={loadingMore}
                      onClick={() => void loadMoreLines()}
                    >
                      {loadingMore ? '加载中…' : '继续加载更多行'}
                    </button>
                  ) : truncated ? (
                    <div className="files-trunc">已达预览上限</div>
                  ) : null}
                </div>
              ) : kind === 'text' || kind === 'table' ? (
                editing ? (
                  <textarea
                    className="files-editor"
                    value={editBuf}
                    onChange={(e) => {
                      setEditBuf(e.target.value);
                      setDirty(e.target.value !== content);
                    }}
                    spellCheck={false}
                  />
                ) : isMd && mdMode === 'render' ? (
                  <div className="files-md-wrap">
                    <div
                      className="files-md-body md-rendered msg-assistant-text"
                      dangerouslySetInnerHTML={{
                        __html: parseMarkdownToHtml(content || '（空文件）'),
                      }}
                    />
                    {canLoadMore ? (
                      <button
                        type="button"
                        className="files-load-more"
                        disabled={loadingMore}
                        onClick={() => void loadMoreLines()}
                      >
                        {loadingMore ? '加载中…' : '继续加载更多'}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <pre
                      ref={textRef}
                      className="files-text-pre hljs"
                      onMouseUp={onTextSelect}
                      onKeyUp={onTextSelect}
                      dangerouslySetInnerHTML={{
                        __html:
                          highlightCode(
                            content || '（空文件）',
                            langFromFilename(selected || ''),
                          ) || '',
                      }}
                    />
                    {canLoadMore ? (
                      <button
                        type="button"
                        className="files-load-more"
                        disabled={loadingMore}
                        onClick={() => void loadMoreLines()}
                      >
                        {loadingMore
                          ? '加载中…'
                          : `继续加载（已 ${lineBudget} 行）`}
                      </button>
                    ) : truncated ? (
                      <div className="files-trunc">已达预览上限</div>
                    ) : null}
                  </>
                )
              ) : (
                <div className="files-empty files-empty--compact">
                  不支持内嵌预览
                  <div className="files-empty-sub" title={selected || undefined}>
                    {selected ? pathBasename(selected) : ''}
                  </div>
                  <button
                    type="button"
                    className="files-soft-btn"
                    style={{ marginTop: 10 }}
                    onClick={() => {
                      void openPathDefault(selected!).catch((e) =>
                        showActionError(
                          e instanceof Error ? e.message : '打开失败',
                        ),
                      );
                    }}
                  >
                    <Lucide.ExternalLink size={13} />
                    用默认应用打开
                  </button>
                </div>
              )}
            </div>
          ) : null}

          {selected && selText && !editing ? (
            <div
              className={`files-sel-bar ${selAnchor ? 'is-anchored' : ''}`}
              role="region"
              aria-label="选区批注"
              style={
                selAnchor
                  ? { top: selAnchor.top, left: selAnchor.left }
                  : undefined
              }
            >
              <div className="files-sel-preview" title={selText}>
                {selText.length > 80 ? `${selText.slice(0, 80)}…` : selText}
              </div>
              <div className="files-sel-form">
                <input
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                  placeholder="批注…"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitSelectionComment();
                    if (e.key === 'Escape') {
                      setSelText('');
                      setCommentDraft('');
                      setSelAnchor(null);
                    }
                  }}
                />
                <button
                  type="button"
                  className="files-soft-btn files-soft-btn--emphasis"
                  disabled={!commentDraft.trim()}
                  onClick={submitSelectionComment}
                >
                  添加
                </button>
                <button
                  type="button"
                  className="files-soft-btn"
                  onClick={() => {
                    setSelText('');
                    setCommentDraft('');
                    setSelAnchor(null);
                  }}
                >
                  取消
                </button>
              </div>
              <div className="files-sel-hint">随下一条消息发送 · Esc</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

function FileIcon({ name }: { name: string }) {
  const k = detectFileKind(name);
  const color = fileExtColor(name);
  const sw = 1.7;
  const sz = 14;
  if (k === 'image') return <Lucide.Image size={sz} className="files-row-ico" style={{ color }} strokeWidth={sw} />;
  if (k === 'pdf') return <Lucide.FileText size={sz} className="files-row-ico" style={{ color }} strokeWidth={sw} />;
  if (k === 'table') return <Lucide.Table size={sz} className="files-row-ico" style={{ color }} strokeWidth={sw} />;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|css|html|json|md|yml|yaml)$/i.test(name)) {
    return <Lucide.FileCode2 size={sz} className="files-row-ico" style={{ color }} strokeWidth={sw} />;
  }
  return <Lucide.File size={sz} className="files-row-ico" style={{ color }} strokeWidth={sw} />;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

function joinLocal(base: string, name: string): string {
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}
