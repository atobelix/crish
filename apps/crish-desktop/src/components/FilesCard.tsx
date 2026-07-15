/**
 * 右侧文件管理器
 * 布局对齐预览浏览器：
 *  - 第 1 行：标签（由 CardPanel 负责）
 *  - 第 2 行：稳定导航 + 路径/筛选一体（地址栏形态）
 *  - 第 3 行：仅详情态，放随文件变化的操作；低频放「更多」
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { getWorkspacePath } from '../api/projectStore';
import {
  addPendingFileAnnotation,
  countPendingFileAnnotations,
  detectFileKind,
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

interface FilesCardProps {
  onShowToast: (message: string) => void;
  initialPath?: string | null;
}

type ViewMode = 'browse' | 'detail';
type TreeNode = FsDirEntry & { depth: number };

export const FilesCard: React.FC<FilesCardProps> = ({ onShowToast, initialPath }) => {
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
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selText, setSelText] = useState('');
  const [commentDraft, setCommentDraft] = useState('');
  const [pendingCount, setPendingCount] = useState(() => countPendingFileAnnotations());
  const [moreOpen, setMoreOpen] = useState(false);
  const [filterMode, setFilterMode] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLPreElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

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
    setSelText('');
    setCommentDraft('');
    setMoreOpen(false);
    const parent = pathDirname(resolved);
    if (parent) setCwd(parent);
    const k = detectFileKind(pathBasename(resolved));
    try {
      if (k === 'image' || k === 'pdf') {
        const url = await toAssetUrl(resolved);
        setAssetUrl(url);
        if (!url) setError('无法生成预览（需桌面壳）');
      } else if (k === 'text' || k === 'table') {
        const res = await readTextFile(resolved, k === 'table' ? 500 : 5000);
        setContent(res.content);
        setEditBuf(res.content);
        setTruncated(res.truncated);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  }, []);

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
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '展开失败');
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
      void refresh(parent);
    }
  };

  const saveFile = async () => {
    if (!selected || !editing) return;
    try {
      await writeTextFile(selected, editBuf);
      setContent(editBuf);
      setDirty(false);
      setEditing(false);
      onShowToast('已保存');
    } catch (e) {
      onShowToast(e instanceof Error ? e.message : '保存失败');
    }
  };

  const onTextSelect = () => {
    // 延迟一帧，确保 selection 已稳定
    requestAnimationFrame(() => {
      const sel = window.getSelection()?.toString().trim() || '';
      if (sel.length > 0) setSelText(sel.slice(0, 2000));
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
    onShowToast('批注将随下一条消息发给模型');
  };

  const breadcrumbs = useMemo(() => {
    if (!root || !cwd) return [] as { label: string; path: string }[];
    const rel = pathRelativeToRoot(cwd, root);
    const items: { label: string; path: string }[] = [
      { label: pathBasename(root) || '项目', path: root },
    ];
    if (rel && rel !== '.') {
      let acc = root;
      for (const part of rel.replace(/\\/g, '/').split('/').filter(Boolean)) {
        acc = joinLocal(acc, part);
        items.push({ label: part, path: acc });
      }
    }
    return items;
  }, [cwd, root]);

  const copyPath = () => {
    const p = selected || cwd;
    if (!p) return;
    void navigator.clipboard.writeText(p).then(
      () => onShowToast('路径已复制'),
      () => onShowToast(p),
    );
  };

  if (!root) {
    return (
      <div className="files-card">
        <div className="files-empty">
          <div className="files-empty-title">未选择项目</div>
          <div className="files-empty-sub">请先在侧栏选择项目工作区</div>
        </div>
      </div>
    );
  }

  const canEdit = kind === 'text' || kind === 'table';

  return (
    <div className="files-card">
      {/* 第 2 行：稳定导航 + 地址栏（与浏览器一致） */}
      <div className="files-bar">
        <button
          type="button"
          className="files-nav-btn"
          title={view === 'detail' ? '返回列表' : '上级'}
          disabled={view === 'browse' && (!cwd || cwd === root)}
          onClick={() => {
            if (view === 'detail') {
              setView('browse');
              setSelText('');
              setEditing(false);
            } else goUp();
          }}
        >
          <Lucide.ArrowLeft size={16} />
        </button>
        <button
          type="button"
          className="files-nav-btn"
          title="刷新"
          onClick={() => {
            if (view === 'detail' && selected) void openFile(selected);
            else void refresh();
          }}
        >
          <Lucide.RotateCw size={16} />
        </button>

        <div className="files-path-form">
          {view === 'browse' ? (
            filterMode || filter ? (
              <>
                <Lucide.Search size={16} className="files-path-ico" />
                <input
                  ref={filterInputRef}
                  className="files-path-input"
                  placeholder="筛选文件…"
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
                <button
                  type="button"
                  className="files-nav-btn files-nav-btn--sm"
                  title="关闭筛选"
                  onClick={() => {
                    setFilter('');
                    setFilterMode(false);
                  }}
                >
                  <Lucide.X size={14} />
                </button>
              </>
            ) : (
              <>
                <Lucide.Folder size={16} className="files-path-ico" />
                <div className="files-path-crumbs files-path-crumbs--grow" title={cwd}>
                  {breadcrumbs.map((b, i) => (
                    <React.Fragment key={b.path}>
                      {i > 0 ? <span className="files-bc-sep">/</span> : null}
                      <button
                        type="button"
                        className="files-bc-chip"
                        onClick={() => {
                          setView('browse');
                          void refresh(b.path);
                        }}
                      >
                        {b.label}
                      </button>
                    </React.Fragment>
                  ))}
                </div>
                <button
                  type="button"
                  className="files-nav-btn files-nav-btn--sm"
                  title="筛选"
                  onClick={() => {
                    setFilterMode(true);
                    requestAnimationFrame(() => filterInputRef.current?.focus());
                  }}
                >
                  <Lucide.Search size={14} />
                </button>
              </>
            )
          ) : (
            <>
              <Lucide.File size={16} className="files-path-ico" />
              <div className="files-path-crumbs files-path-crumbs--grow" title={selected || ''}>
                {selected ? pathRelativeToRoot(selected, root) : ''}
              </div>
            </>
          )}
        </div>

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
            onClick={() => setMoreOpen((v) => !v)}
          >
            <Lucide.MoreHorizontal size={16} />
          </button>
          {moreOpen ? (
            <div className="files-more-menu">
              <button
                type="button"
                className="files-more-item"
                onClick={() => {
                  copyPath();
                  setMoreOpen(false);
                }}
              >
                复制路径
              </button>
              <button
                type="button"
                className="files-more-item"
                onClick={() => {
                  const p = selected || cwd;
                  if (p) {
                    void revealInOs(p).catch((e) =>
                      onShowToast(e instanceof Error ? e.message : '打开失败'),
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

      {/* 第 3 行：仅详情态，随文件变化的操作 */}
      {view === 'detail' && selected ? (
        <div className="files-context-bar">
          <span className="files-context-name" title={selected}>
            {pathBasename(selected)}
          </span>
          <div className="files-context-actions">
            {canEdit && !editing ? (
              <button
                type="button"
                className="files-soft-btn"
                onClick={() => {
                  setEditing(true);
                  setEditBuf(content);
                  setSelText('');
                }}
              >
                <Lucide.Pencil size={14} />
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
                  <Lucide.Save size={14} />
                  保存
                </button>
                <button
                  type="button"
                  className="files-soft-btn"
                  onClick={() => {
                    setEditing(false);
                    setEditBuf(content);
                    setDirty(false);
                  }}
                >
                  取消
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="files-body">
        {view === 'browse' ? (
          <div className="files-list">
            {loading ? (
              <div className="files-empty">加载中…</div>
            ) : error && !entries.length ? (
              <div className="files-empty files-empty--err">
                <div className="files-empty-title">无法读取目录</div>
                <div className="files-empty-sub">{error}</div>
              </div>
            ) : flatTree.length === 0 ? (
              <div className="files-empty">
                {filter.trim() ? '无匹配项' : '空目录'}
              </div>
            ) : (
              flatTree.map((e) => (
                <div
                  key={e.path}
                  className={`files-row ${selected === e.path ? 'is-selected' : ''}`}
                  style={{ paddingLeft: 8 + e.depth * 14 }}
                  onClick={() => {
                    if (e.isDir) {
                      void (async () => {
                        if (!expanded[e.path]) {
                          try {
                            const list = await loadDir(e.path);
                            setExpanded((prev) => ({ ...prev, [e.path]: list }));
                          } catch {
                            /* ignore */
                          }
                        }
                      })();
                    } else void openFile(e.path);
                  }}
                  onDoubleClick={() => {
                    if (e.isDir) void refresh(e.path);
                    else void openFile(e.path);
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
                        <Lucide.ChevronDown size={14} />
                      ) : (
                        <Lucide.ChevronRight size={14} />
                      )
                    ) : null}
                  </button>
                  {e.isDir ? (
                    <Lucide.Folder size={16} className="files-row-ico dir" />
                  ) : (
                    <FileIcon name={e.name} />
                  )}
                  <span className="files-row-name">{e.name}</span>
                  {!e.isDir && e.size != null ? (
                    <span className="files-row-meta">{formatSize(e.size)}</span>
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="files-detail">
            <div className="files-detail-body">
              {detailLoading ? (
                <div className="files-empty">读取中…</div>
              ) : error && !content && !assetUrl ? (
                <div className="files-empty files-empty--err">
                  <div className="files-empty-title">无法预览</div>
                  <div className="files-empty-sub">{error}</div>
                </div>
              ) : kind === 'image' && assetUrl ? (
                <div className="files-preview-media">
                  <img src={assetUrl} alt={pathBasename(selected || '')} />
                </div>
              ) : kind === 'pdf' && assetUrl ? (
                <iframe title="pdf" className="files-preview-pdf" src={assetUrl} />
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
                  {truncated ? <div className="files-trunc">已截断</div> : null}
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
                ) : (
                  <pre
                    ref={textRef}
                    className="files-text-pre"
                    onMouseUp={onTextSelect}
                    onKeyUp={onTextSelect}
                  >
                    {content || '（空文件）'}
                    {truncated ? '\n\n…（已截断）' : ''}
                  </pre>
                )
              ) : (
                <div className="files-empty">
                  不支持预览
                  <div className="files-empty-sub">{selected}</div>
                </div>
              )}
            </div>

            {selText && !editing ? (
              <div className="files-sel-bar" role="region" aria-label="选区批注">
                <div className="files-sel-preview" title={selText}>
                  {selText.length > 120 ? `${selText.slice(0, 120)}…` : selText}
                </div>
                <div className="files-sel-form">
                  <input
                    value={commentDraft}
                    onChange={(e) => setCommentDraft(e.target.value)}
                    placeholder="对选区写批注…"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitSelectionComment();
                      if (e.key === 'Escape') {
                        setSelText('');
                        setCommentDraft('');
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="files-soft-btn files-soft-btn--emphasis"
                    disabled={!commentDraft.trim()}
                    onClick={submitSelectionComment}
                  >
                    批注
                  </button>
                  <button
                    type="button"
                    className="files-soft-btn"
                    onClick={() => {
                      setSelText('');
                      setCommentDraft('');
                    }}
                  >
                    取消
                  </button>
                </div>
                <div className="files-sel-hint">随下一条消息发给模型 · Esc 取消</div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};

function FileIcon({ name }: { name: string }) {
  const k = detectFileKind(name);
  if (k === 'image') return <Lucide.Image size={16} className="files-row-ico" />;
  if (k === 'pdf') return <Lucide.FileText size={16} className="files-row-ico" />;
  if (k === 'table') return <Lucide.Table size={16} className="files-row-ico" />;
  if (/\.(ts|tsx|js|jsx|mjs|rs|py|go)$/i.test(name)) {
    return <Lucide.FileCode size={16} className="files-row-ico" />;
  }
  return <Lucide.File size={16} className="files-row-ico" />;
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
