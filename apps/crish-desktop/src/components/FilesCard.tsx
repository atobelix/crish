/**
 * 右侧文件管理器：浏览工作区 + 详情预览 / 编辑 / 评论。
 * 定位：按需打开的详细入口，不是运行时日志垃圾桶。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import { getWorkspacePath } from '../api/projectStore';
import {
  addFileComment,
  detectFileKind,
  listDirectory,
  listFileComments,
  parseCsvPreview,
  pathBasename,
  pathDirname,
  pathRelativeToRoot,
  readTextFile,
  removeFileComment,
  revealInOs,
  takePendingOpenPath,
  toAssetUrl,
  writeTextFile,
  type FileComment,
  type FsDirEntry,
} from '../api/workspaceFsApi';

interface FilesCardProps {
  onShowToast: (message: string) => void;
  initialPath?: string | null;
}

type ViewMode = 'browse' | 'detail';

export const FilesCard: React.FC<FilesCardProps> = ({ onShowToast, initialPath }) => {
  const [root, setRoot] = useState(() => getWorkspacePath());
  const [cwd, setCwd] = useState(root || '');
  const [entries, setEntries] = useState<FsDirEntry[]>([]);
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
  const [comments, setComments] = useState<FileComment[]>([]);
  const [commentDraft, setCommentDraft] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(true);

  const kind = selected ? detectFileKind(pathBasename(selected)) : 'binary';

  const refresh = useCallback(async (dir?: string) => {
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
      const list = await listDirectory(path);
      setEntries(list);
      setCwd(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  const openFile = useCallback(
    async (filePath: string) => {
      // 消费挂起的打开请求，避免下次挂载重复打开
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
      setComments(listFileComments(filePath));
      // 定位到文件所在目录，便于返回后仍在附近
      const parent = pathDirname(filePath);
      if (parent) setCwd(parent);
      const k = detectFileKind(pathBasename(filePath));
      try {
        if (k === 'image' || k === 'pdf') {
          const url = await toAssetUrl(filePath);
          setAssetUrl(url);
          if (!url) {
            setError('无法生成预览 URL（需桌面壳 convertFileSrc）');
          }
        } else if (k === 'text' || k === 'table') {
          const res = await readTextFile(filePath, k === 'table' ? 500 : 5000);
          setContent(res.content);
          setEditBuf(res.content);
          setTruncated(res.truncated);
        } else {
          setContent('');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setDetailLoading(false);
      }
    },
    [],
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
      // 面板刚挂载：消费打开请求（事件可能早于挂载发出）
      const pending = takePendingOpenPath() || initialPath;
      if (pending) void openFile(pending);
    });
    // 仅挂载
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

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, filter]);

  const enterDir = (path: string) => {
    setView('browse');
    setSelected(null);
    void refresh(path);
  };

  const goUp = () => {
    if (!cwd || (root && cwd === root)) return;
    const parent = pathDirname(cwd);
    if (parent && parent !== cwd) enterDir(parent);
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

  const copyPath = async (p: string) => {
    try {
      await navigator.clipboard.writeText(p);
      onShowToast('路径已复制');
    } catch {
      onShowToast(p);
    }
  };

  const breadcrumbs = useMemo(() => {
    if (!root || !cwd) return [] as { label: string; path: string }[];
    const rel = pathRelativeToRoot(cwd, root);
    if (rel === '.' || !rel) return [{ label: pathBasename(root) || '项目', path: root }];
    const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
    const items: { label: string; path: string }[] = [
      { label: pathBasename(root) || '项目', path: root },
    ];
    let acc = root;
    for (const part of parts) {
      acc = joinLocal(acc, part);
      items.push({ label: part, path: acc });
    }
    return items;
  }, [cwd, root]);

  const relSelected = selected && root ? pathRelativeToRoot(selected, root) : selected;

  return (
    <div className="files-card">
      <div className="files-card-header">
        <div className="files-card-title-row">
          <Lucide.FolderTree size={14} />
          <span className="files-card-title">文件</span>
          {view === 'detail' ? (
            <button type="button" className="files-link-btn" onClick={() => setView('browse')}>
              <Lucide.ArrowLeft size={12} />
              返回列表
            </button>
          ) : null}
        </div>
        {!root ? (
          <div className="files-no-root">未打开项目 — 请在侧栏选择项目后再浏览文件</div>
        ) : (
          <div className="files-path-bar">
            <button
              type="button"
              className="files-icon-btn"
              title="上级"
              onClick={goUp}
              disabled={!cwd || cwd === root}
            >
              <Lucide.CornerLeftUp size={13} />
            </button>
            <button type="button" className="files-icon-btn" title="刷新" onClick={() => void refresh()}>
              <Lucide.RefreshCw size={12} />
            </button>
            <div className="files-breadcrumbs" title={cwd}>
              {breadcrumbs.map((b, i) => (
                <React.Fragment key={b.path}>
                  {i > 0 ? <span className="files-bc-sep">/</span> : null}
                  <button
                    type="button"
                    className="files-bc-item"
                    onClick={() => enterDir(b.path)}
                  >
                    {b.label}
                  </button>
                </React.Fragment>
              ))}
            </div>
          </div>
        )}
      </div>

      {view === 'browse' ? (
        <>
          <div className="files-filter-row">
            <Lucide.Search size={12} className="files-filter-ico" />
            <input
              className="files-filter-input"
              placeholder="筛选文件名…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="files-list">
            {loading ? (
              <div className="files-empty">加载中…</div>
            ) : error && !entries.length ? (
              <div className="files-empty files-empty--err">{error}</div>
            ) : filtered.length === 0 ? (
              <div className="files-empty">空目录或无匹配项</div>
            ) : (
              filtered.map((e) => (
                <button
                  key={e.path}
                  type="button"
                  className={`files-row ${selected === e.path ? 'is-selected' : ''}`}
                  onClick={() => {
                    if (e.isDir) enterDir(e.path);
                    else void openFile(e.path);
                  }}
                >
                  {e.isDir ? (
                    <Lucide.Folder size={14} className="files-row-ico dir" />
                  ) : (
                    <FileIcon name={e.name} />
                  )}
                  <span className="files-row-name">{e.name}</span>
                  {!e.isDir && e.size != null ? (
                    <span className="files-row-meta">{formatSize(e.size)}</span>
                  ) : e.isDir ? (
                    <Lucide.ChevronRight size={12} className="files-row-chevron" />
                  ) : null}
                </button>
              ))
            )}
          </div>
          <div className="files-footer-hint">
            点击文件可预览 / 编辑 / 评论 · 图片 · 表格 · PDF
          </div>
        </>
      ) : (
        <div className="files-detail">
          <div className="files-detail-toolbar">
            <div className="files-detail-name-wrap">
              <span className="files-detail-name" title={selected || ''}>
                {selected ? pathBasename(selected) : ''}
              </span>
              {relSelected ? (
                <span className="files-detail-rel" title={selected || ''}>
                  {relSelected}
                </span>
              ) : null}
            </div>
            <div className="files-detail-actions">
              {(kind === 'text' || kind === 'table') && (
                <>
                  {!editing ? (
                    <button
                      type="button"
                      className="files-chip-btn"
                      onClick={() => {
                        setEditing(true);
                        setEditBuf(content);
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
                    onClick={() => void copyPath(selected)}
                  >
                    <Lucide.Copy size={12} />
                  </button>
                  <button
                    type="button"
                    className="files-icon-btn"
                    title="在资源管理器中显示"
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
          </div>

          <div className="files-detail-body">
            {detailLoading ? (
              <div className="files-empty">读取中…</div>
            ) : error && kind !== 'image' && kind !== 'pdf' && !content ? (
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
                      <tr key={i} className={i === 0 ? 'is-header' : undefined}>
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
                <pre className="files-text-pre">
                  {content || '（空文件）'}
                  {truncated ? '\n\n…（已截断，仅预览前部）' : ''}
                </pre>
              )
            ) : kind === 'image' || kind === 'pdf' ? (
              <div className="files-empty files-empty--err">
                {error || '无法预览'}
                <div className="files-empty-sub">{selected}</div>
              </div>
            ) : (
              <div className="files-empty">
                二进制或不支持预览的类型
                <div className="files-empty-sub">{selected}</div>
                <button
                  type="button"
                  className="files-chip-btn"
                  style={{ marginTop: 10 }}
                  onClick={() => {
                    if (selected) {
                      void revealInOs(selected).catch((e) =>
                        onShowToast(e instanceof Error ? e.message : '打开失败'),
                      );
                    }
                  }}
                >
                  用系统应用打开
                </button>
              </div>
            )}
          </div>

          <div className="files-comments">
            <button
              type="button"
              className="files-comments-title"
              onClick={() => setCommentsOpen((v) => !v)}
            >
              <Lucide.MessageSquare size={12} />
              评论
              <span className="files-comments-count">{comments.length}</span>
              <Lucide.ChevronRight
                size={12}
                className={`files-comments-chev ${commentsOpen ? 'open' : ''}`}
              />
            </button>
            {commentsOpen ? (
              <>
                <div className="files-comment-form">
                  <input
                    value={commentDraft}
                    onChange={(e) => setCommentDraft(e.target.value)}
                    placeholder="添加评论（本地保存）…"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && commentDraft.trim() && selected) {
                        addFileComment(selected, commentDraft);
                        setComments(listFileComments(selected));
                        setCommentDraft('');
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="files-chip-btn primary"
                    disabled={!commentDraft.trim()}
                    onClick={() => {
                      if (!selected || !commentDraft.trim()) return;
                      addFileComment(selected, commentDraft);
                      setComments(listFileComments(selected));
                      setCommentDraft('');
                    }}
                  >
                    添加
                  </button>
                </div>
                <div className="files-comment-list">
                  {comments.length === 0 ? (
                    <div className="files-empty" style={{ padding: 8 }}>
                      暂无评论
                    </div>
                  ) : (
                    comments.map((c) => (
                      <div key={c.id} className="files-comment-item">
                        <div className="files-comment-text">{c.text}</div>
                        <div className="files-comment-meta">
                          <span>{new Date(c.createdAt).toLocaleString()}</span>
                          <button
                            type="button"
                            className="files-link-btn"
                            onClick={() => {
                              if (!selected) return;
                              removeFileComment(selected, c.id);
                              setComments(listFileComments(selected));
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};

function FileIcon({ name }: { name: string }) {
  const k = detectFileKind(name);
  if (k === 'image') return <Lucide.Image size={14} className="files-row-ico" />;
  if (k === 'pdf') return <Lucide.FileText size={14} className="files-row-ico" />;
  if (k === 'table') return <Lucide.Table size={14} className="files-row-ico" />;
  if (/\.(ts|tsx|js|jsx|mjs)$/i.test(name)) {
    return <Lucide.FileCode size={14} className="files-row-ico" />;
  }
  if (/\.md$/i.test(name)) return <Lucide.FileType size={14} className="files-row-ico" />;
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
