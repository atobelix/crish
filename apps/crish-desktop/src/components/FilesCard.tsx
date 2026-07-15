/**
 * 右侧文件管理器：中性色、两行工具栏、树形浏览、选区评论喂入下轮输入。
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
  const textRef = useRef<HTMLPreElement>(null);

  const kind = selected ? detectFileKind(pathBasename(selected)) : 'binary';

  const loadDir = useCallback(async (path: string): Promise<FsDirEntry[]> => {
    return listDirectory(path);
  }, []);

  const refresh = useCallback(
    async (dir?: string) => {
      const r = getWorkspacePath();
      setRoot(r);
      const path = dir || cwd || r;
      if (!path) {
        setError('请先选择项目工作区');
        setEntries([]);
        return;
      }
      setLoading(true);
      setError('');
      try {
        const list = await loadDir(path);
        setEntries(list);
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
    setSelected(filePath);
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
    const parent = pathDirname(filePath);
    if (parent) setCwd(parent);
    const k = detectFileKind(pathBasename(filePath));
    try {
      if (k === 'image' || k === 'pdf') {
        const url = await toAssetUrl(filePath);
        setAssetUrl(url);
        if (!url) setError('无法生成预览（需桌面壳）');
      } else if (k === 'text' || k === 'table') {
        const res = await readTextFile(filePath, k === 'table' ? 500 : 5000);
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
      if (path) void openFile(path);
    };
    window.addEventListener('crish-open-file', onOpen);
    return () => window.removeEventListener('crish-open-file', onOpen);
  }, [openFile]);

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
        if (q && !e.name.toLowerCase().includes(q) && !e.isDir) continue;
        if (q && e.isDir && !e.name.toLowerCase().includes(q) && !expanded[e.path]) {
          // 仍显示匹配子树的父级：若展开后有匹配则保留
        }
        out.push({ ...e, depth });
        if (e.isDir && expanded[e.path]) {
          walk(expanded[e.path], depth + 1);
        }
      }
    };
    walk(entries, 0);
    if (q) {
      return out.filter((n) => n.name.toLowerCase().includes(q) || (n.isDir && expanded[n.path]));
    }
    return out;
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
    const sel = window.getSelection()?.toString().trim() || '';
    if (sel.length > 0) {
      setSelText(sel.slice(0, 2000));
    }
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
    onShowToast('批注已加入，将随下一条消息发给模型');
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

  if (!root) {
    return (
      <div className="files-card">
        <div className="files-no-root">请先在侧栏选择项目，再浏览文件</div>
      </div>
    );
  }

  return (
    <div className="files-card">
      {/* 行 1：路径与导航 */}
      <div className="files-toolbar">
        <div className="files-toolbar-actions">
          {view === 'detail' ? (
            <button
              type="button"
              className="files-icon-btn"
              title="返回列表"
              onClick={() => {
                setView('browse');
                setSelText('');
              }}
            >
              <Lucide.ArrowLeft size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="files-icon-btn"
              title="上级"
              onClick={goUp}
              disabled={!cwd || cwd === root}
            >
              <Lucide.CornerLeftUp size={13} />
            </button>
          )}
          <button
            type="button"
            className="files-icon-btn"
            title="刷新"
            onClick={() => void refresh()}
          >
            <Lucide.RefreshCw size={12} />
          </button>
        </div>
        <div className="files-breadcrumbs" title={cwd}>
          {breadcrumbs.map((b, i) => (
            <React.Fragment key={b.path}>
              {i > 0 ? <span className="files-bc-sep">/</span> : null}
              <button
                type="button"
                className={`files-bc-item ${i === breadcrumbs.length - 1 ? 'is-current' : ''}`}
                onClick={() => {
                  setView('browse');
                  setSelected(null);
                  void refresh(b.path);
                }}
              >
                {b.label}
              </button>
            </React.Fragment>
          ))}
        </div>
        {pendingCount > 0 ? (
          <span className="files-pending-badge" title="待发送给模型的批注">
            批注 {pendingCount}
          </span>
        ) : null}
      </div>

      {/* 行 2：筛选 或 详情操作 */}
      {view === 'browse' ? (
        <div className="files-subbar">
          <div className="files-filter-wrap">
            <Lucide.Search size={12} className="files-filter-ico" />
            <input
              className="files-filter-input"
              placeholder="筛选…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        </div>
      ) : (
        <div className="files-subbar">
          <span className="files-subbar-name" title={selected || ''}>
            {selected ? pathBasename(selected) : ''}
          </span>
          {(kind === 'text' || kind === 'table') && (
            <>
              {!editing ? (
                <button
                  type="button"
                  className="files-chip-btn"
                  onClick={() => {
                    setEditing(true);
                    setEditBuf(content);
                    setSelText('');
                  }}
                >
                  <Lucide.Pencil size={11} /> 编辑
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="files-chip-btn primary"
                    onClick={() => void saveFile()}
                    disabled={!dirty}
                  >
                    <Lucide.Save size={11} /> 保存
                  </button>
                  <button
                    type="button"
                    className="files-chip-btn"
                    onClick={() => {
                      setEditing(false);
                      setEditBuf(content);
                      setDirty(false);
                    }}
                  >
                    取消
                  </button>
                </>
              )}
            </>
          )}
          {selected ? (
            <>
              <button
                type="button"
                className="files-icon-btn"
                title="复制路径"
                onClick={() => {
                  void navigator.clipboard.writeText(selected).then(
                    () => onShowToast('路径已复制'),
                    () => onShowToast(selected),
                  );
                }}
              >
                <Lucide.Copy size={12} />
              </button>
              <button
                type="button"
                className="files-icon-btn"
                title="资源管理器"
                onClick={() => {
                  void revealInOs(selected).catch((e) =>
                    onShowToast(e instanceof Error ? e.message : '打开失败'),
                  );
                }}
              >
                <Lucide.FolderOpen size={12} />
              </button>
            </>
          ) : null}
        </div>
      )}

      <div className="files-body">
        {view === 'browse' ? (
          <div className="files-list">
            {loading ? (
              <div className="files-empty">加载中…</div>
            ) : error && !entries.length ? (
              <div className="files-empty files-empty--err">{error}</div>
            ) : flatTree.length === 0 ? (
              <div className="files-empty">空目录或无匹配项</div>
            ) : (
              flatTree.map((e) => (
                <div
                  key={e.path}
                  className={`files-row ${selected === e.path ? 'is-selected' : ''}`}
                  style={{ paddingLeft: 6 + e.depth * 14 }}
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
                        setCwd(e.path);
                      })();
                    } else {
                      void openFile(e.path);
                    }
                  }}
                  onDoubleClick={() => {
                    if (e.isDir) {
                      setView('browse');
                      void refresh(e.path);
                    } else void openFile(e.path);
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
                        <Lucide.ChevronDown size={12} />
                      ) : (
                        <Lucide.ChevronRight size={12} />
                      )
                    ) : null}
                  </button>
                  {e.isDir ? (
                    <Lucide.Folder size={14} className="files-row-ico dir" />
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
                <div className="files-empty files-empty--err">{error}</div>
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
                  {truncated ? <div className="files-trunc">已截断预览</div> : null}
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
                  不支持预览的类型
                  <div className="files-empty-sub">{selected}</div>
                </div>
              )}
            </div>

            {/* 仅选中文本时显示评论入口 */}
            {selText && !editing ? (
              <div className="files-sel-bar">
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
                    className="files-chip-btn primary"
                    disabled={!commentDraft.trim()}
                    onClick={submitSelectionComment}
                  >
                    批注
                  </button>
                  <button
                    type="button"
                    className="files-link-btn"
                    onClick={() => {
                      setSelText('');
                      setCommentDraft('');
                    }}
                  >
                    取消
                  </button>
                </div>
                <div className="files-sel-hint">批注会随下一条用户消息发给模型</div>
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
  if (k === 'image') return <Lucide.Image size={14} className="files-row-ico" />;
  if (k === 'pdf') return <Lucide.FileText size={14} className="files-row-ico" />;
  if (k === 'table') return <Lucide.Table size={14} className="files-row-ico" />;
  if (/\.(ts|tsx|js|jsx|mjs|rs|py|go)$/i.test(name)) {
    return <Lucide.FileCode size={14} className="files-row-ico" />;
  }
  return <Lucide.File size={14} className="files-row-ico" />;
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
