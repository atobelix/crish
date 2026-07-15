import React, { useEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  addProjectFromPath,
  getActiveProjectId,
  listProjects,
  openProject,
  removeProject,
  setNoProject,
  type ProjectEntry,
} from '../api/projectStore';

type Props = {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
};

type View = 'list' | 'add';

async function pickFolderNative(): Promise<string | null> {
  try {
    const mod: any = await (Function('return import("@tauri-apps/plugin-dialog")')() as Promise<any>).catch(
      () => null,
    );
    if (mod?.open) {
      const selected = await mod.open({ directory: true, multiple: false });
      if (typeof selected === 'string' && selected) return selected;
    }
  } catch {
    /* browser */
  }
  return null;
}

/**
 * Polished project menu (ChatGPT-style structure, Crish chrome).
 * - Search + recent projects
 * - Add via folder picker or careful path form (no window.prompt)
 * - Work without project
 */
export const ProjectPickerMenu: React.FC<Props> = ({ open, onClose, onChanged }) => {
  const [q, setQ] = useState('');
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [view, setView] = useState<View>('list');
  const [pathDraft, setPathDraft] = useState('');
  const [pathError, setPathError] = useState('');
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeId = getActiveProjectId();

  const refresh = () => setProjects(listProjects());

  useEffect(() => {
    if (!open) return;
    refresh();
    setView('list');
    setQ('');
    setPathDraft('');
    setPathError('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (view === 'add') setView('list');
        else onClose();
      }
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, view]);

  if (!open) return null;

  const filtered = projects.filter(
    (p) =>
      !q.trim() ||
      p.name.toLowerCase().includes(q.toLowerCase()) ||
      p.path.toLowerCase().includes(q.toLowerCase()),
  );

  const commitPath = (path: string) => {
    const cleaned = path.trim().replace(/\\/g, '/');
    if (!cleaned) {
      setPathError('请输入文件夹路径');
      return;
    }
    // Light validation — real FS check is engine-side
    if (!/^[a-zA-Z]:\/|^\//.test(cleaned) && !cleaned.includes('/')) {
      setPathError('路径看起来不完整，请包含盘符或 /');
      return;
    }
    addProjectFromPath(cleaned);
    onChanged?.();
    onClose();
  };

  return (
    <div ref={rootRef} className="pp-menu" role="listbox" aria-label="选择项目" onClick={(e) => e.stopPropagation()}>
      {view === 'list' ? (
        <>
          {projects.length > 3 && (
            <div className="pp-search">
              <Lucide.Search size={16} strokeWidth={1.75} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索"
                autoFocus
              />
            </div>
          )}

          <div className="pp-scroll">
            {filtered.map((p) => {
              const selected = p.id === activeId;
              return (
                <div key={p.id} className={`pp-row ${selected ? 'is-selected' : ''}`}>
                  <button
                    type="button"
                    className="pp-row-main"
                    onClick={() => {
                      openProject(p.id);
                      onChanged?.();
                      onClose();
                    }}
                  >
                    <Lucide.Folder size={16} className="pp-row-icon" />
                    <span className="pp-row-text">
                      <span className="pp-row-title">{p.name}</span>
                      <span className="pp-row-path" title={p.path}>
                        {p.path}
                      </span>
                    </span>
                    {selected && <Lucide.Check size={16} className="pp-check" />}
                  </button>
                  <button
                    type="button"
                    className="pp-row-more"
                    title="移除"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeProject(p.id);
                      refresh();
                      onChanged?.();
                    }}
                  >
                    <Lucide.X size={14} />
                  </button>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="pp-empty">
                {projects.length === 0 ? '暂无项目' : '无匹配'}
              </div>
            )}
          </div>

          <div className="pp-footer">
            <button
              type="button"
              className="pp-footer-item"
              disabled={busy}
              onClick={async () => {
                // 优先本机文件夹选择；失败则内嵌路径输入（不另开「页面感」视图）
                setBusy(true);
                setPathError('');
                try {
                  const path = await pickFolderNative();
                  if (path) {
                    addProjectFromPath(path);
                    onChanged?.();
                    onClose();
                    return;
                  }
                  setView('add');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Lucide.Plus size={16} />
              <span>添加项目</span>
            </button>
            <button
              type="button"
              className="pp-footer-item"
              onClick={() => {
                setNoProject();
                onChanged?.();
                onClose();
              }}
            >
              <Lucide.MessageSquare size={16} />
              <span>不在项目中</span>
            </button>
          </div>
        </>
      ) : (
        <div className="pp-add">
          <div className="pp-add-header">
            <button type="button" className="pp-back" onClick={() => setView('list')} title="返回">
              <Lucide.ArrowLeft size={16} />
            </button>
            <span className="pp-add-title">输入路径</span>
          </div>

          <button
            type="button"
            className="pp-add-card"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setPathError('');
              try {
                const path = await pickFolderNative();
                if (path) {
                  addProjectFromPath(path);
                  onChanged?.();
                  onClose();
                } else {
                  setPathError('请在下方填写文件夹路径');
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="pp-add-card-icon">
              <Lucide.FolderInput size={16} />
            </div>
            <div className="pp-add-card-copy">
              <div className="pp-add-card-title">选择文件夹</div>
              <div className="pp-add-card-desc">浏览本地目录并加入项目列表</div>
            </div>
          </button>

          <div className="pp-add-divider">
            <span>或输入路径</span>
          </div>

          <div className="pp-add-form">
            <input
              className="pp-path-input"
              placeholder="例如 C:/Software/conex"
              value={pathDraft}
              onChange={(e) => {
                setPathDraft(e.target.value);
                setPathError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitPath(pathDraft);
              }}
            />
            {pathError && <div className="pp-path-error">{pathError}</div>}
            <div className="pp-add-actions">
              <button type="button" className="pp-btn-ghost" onClick={() => setView('list')}>
                取消
              </button>
              <button type="button" className="pp-btn-primary" onClick={() => commitPath(pathDraft)}>
                添加并打开
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
