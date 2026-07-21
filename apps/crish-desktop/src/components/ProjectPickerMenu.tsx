import React, { useEffect, useRef, useState } from 'react';
import styles from './ProjectPickerMenu.module.css';
import {
  addProjectFromPath,
  GENERAL_FOLDER,
  getActiveProjectId,
  listProjects,
  openProject,
  removeProject,
  setNoProject,
  type ProjectEntry,
} from '../api/projectStore';
import { getSessionStoreState, setDraftFolder } from '../api/storeAccess';
import { isPendingDraft } from '../store/draftSession';
import { Tooltip } from './Tooltip';
import { Check, ChevronRight, Folder, Plus, Search, X } from 'lucide-react';

/** 草稿态切项目：同步 draftFolder，不 mint 真会话 */
function syncDraftFolderOnProjectChange(folder: string): void {
  if (isPendingDraft(getSessionStoreState().activeSessionId)) {
    setDraftFolder(folder);
  }
}

type Props = {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
};

/**
 * Native platform directory picker utilizing Tauri dialogs.
 */
async function pickFolderNative(title?: string): Promise<string | null> {
  try {
    const mod = (await (
      Function('return import("@tauri-apps/plugin-dialog")')() as Promise<{
        open?: (
          opts: Record<string, unknown>
        ) => Promise<string | string[] | null>;
      }>
    ).catch(() => null)) as {
      open?: (
        opts: Record<string, unknown>
      ) => Promise<string | string[] | null>;
    } | null;
    if (mod?.open) {
      const selected = await mod.open({
        directory: true,
        multiple: false,
        title: title || '选择文件夹',
      });
      if (typeof selected === 'string' && selected) return selected;
    }
  } catch {
    /* browser fallback */
  }
  return null;
}

export const ProjectPickerMenu: React.FC<Props> = ({
  open,
  onClose,
  onChanged,
}) => {
  const [q, setQ] = useState('');
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [showAddCascade, setShowAddCascade] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeId = getActiveProjectId();

  const refresh = () => setProjects(listProjects());

  useEffect(() => {
    if (!open) return;
    refresh();
    setShowAddCascade(false);
    setQ('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showAddCascade) setShowAddCascade(false);
        else onClose();
      }
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, showAddCascade]);

  if (!open) return null;

  // Filter projects by search query
  const filtered = projects.filter(
    (p) =>
      !q.trim() ||
      p.name.toLowerCase().includes(q.toLowerCase()) ||
      p.path.toLowerCase().includes(q.toLowerCase())
  );

  const handlePickFolder = async () => {
    setBusy(true);
    try {
      const path = await pickFolderNative('选择现有项目文件夹');
      if (path) {
        addProjectFromPath(path);
        onChanged?.();
        onClose();
      }
    } catch {
      // quiet fail
    } finally {
      setBusy(false);
    }
  };

  const handleCreateEmptyProject = async () => {
    setBusy(true);
    try {
      const path = await pickFolderNative('选择或创建空白文件夹');
      if (path) {
        addProjectFromPath(path);
        onChanged?.();
        onClose();
      }
    } catch {
      // quiet fail
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className="sort-filter-menu open"
      style={{
        position: 'absolute',
        top: 'calc(100% + 6px)',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 'var(--z-dropdown)',
        width: '230px',
        overflow: 'visible',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header Search Box */}
      <div
        className={styles.searchWrapper}
        onMouseEnter={() => setShowAddCascade(false)}
      >
        <div className={styles.searchBox}>
          <Search size={13} style={{ flexShrink: 0, opacity: 0.6 }} />
          <input
            className={styles.searchInput}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索项目"
            autoFocus
          />
        </div>
      </div>

      {/* Projects List Scroll Area */}
      <div
        className={styles.scrollArea}
        onMouseEnter={() => setShowAddCascade(false)}
      >
        {filtered.map((p) => {
          const selected = p.id === activeId;
          return (
            <div key={p.id} className={styles.projectRow}>
              <button
                type="button"
                className={`sort-filter-option ${selected ? 'is-on' : ''}`}
                style={{ paddingRight: '28px' }}
                onClick={() => {
                  openProject(p.id);
                  syncDraftFolderOnProjectChange(p.id);
                  onChanged?.();
                  onClose();
                }}
              >
                <Folder
                  size={14}
                  style={{ marginRight: '6px', flexShrink: 0, opacity: 0.7 }}
                />
                <span
                  style={{
                    textOverflow: 'ellipsis',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}
                  title={p.path}
                >
                  {p.name}
                </span>
                {selected && <Check size={14} className={styles.rowCheck} />}
              </button>

              {/* Delete hover-only button */}
              <Tooltip content="从列表中移除">
                <button
                  type="button"
                  className={styles.rowDeleteBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeProject(p.id);
                    refresh();
                    onChanged?.();
                  }}
                >
                  <X size={12} />
                </button>
              </Tooltip>
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div
            style={{
              padding: '16px 12px',
              textAlign: 'center',
              fontSize: 'var(--font-size-xs)',
              color: 'var(--text-tertiary)',
            }}
          >
            {projects.length === 0 ? '暂无项目' : '无匹配项目'}
          </div>
        )}
      </div>

      {/* Divider */}
      <div
        style={{
          height: '1px',
          background: 'var(--border-subtle)',
          margin: '4px 2px',
        }}
      />

      {/* Footer Option: New/Add Project */}
      <div
        style={{ position: 'relative', width: '100%' }}
        onMouseEnter={() => setShowAddCascade(true)}
      >
        <button
          type="button"
          className="sort-filter-option"
          disabled={busy}
          style={{
            background: showAddCascade
              ? 'color-mix(in srgb, var(--text-primary) 6%, transparent)'
              : undefined,
          }}
          onClick={() => setShowAddCascade(!showAddCascade)}
        >
          <Plus
            size={14}
            style={{ marginRight: '6px', flexShrink: 0, opacity: 0.7 }}
          />
          <span style={{ flex: 1 }}>新建项目</span>
          <ChevronRight
            size={14}
            style={{ marginLeft: 'auto', flexShrink: 0, opacity: 0.5 }}
          />
        </button>

        {/* Standardized Cascade Flyout Sub-menu positioned relative to the parent button wrapper */}
        {showAddCascade && (
          <div
            className="sort-filter-flyout"
            style={{
              position: 'absolute',
              top: '-4px' /* Perfectly aligns the top of the flyout with the top of the parent button row */,
              left: 'calc(100% + 4px)',
              width: '160px',
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
              padding: '4px',
              boxSizing: 'border-box',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ position: 'relative', width: '100%' }}>
              <button
                type="button"
                className="sort-filter-option"
                onClick={handleCreateEmptyProject}
              >
                <Plus
                  size={14}
                  style={{ marginRight: '6px', flexShrink: 0, opacity: 0.7 }}
                />
                <span>新建空白项目</span>
              </button>
            </div>
            <div style={{ position: 'relative', width: '100%' }}>
              <button
                type="button"
                className="sort-filter-option"
                onClick={handlePickFolder}
              >
                <Folder
                  size={14}
                  style={{ marginRight: '6px', flexShrink: 0, opacity: 0.7 }}
                />
                <span>使用现有文件夹</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer Option: Not In Project Working */}
      <div
        style={{ position: 'relative', width: '100%' }}
        onMouseEnter={() => setShowAddCascade(false)}
      >
        <button
          type="button"
          className="sort-filter-option"
          style={{ display: 'flex', alignItems: 'center' }}
          onClick={() => {
            setNoProject();
            syncDraftFolderOnProjectChange(GENERAL_FOLDER);
            onChanged?.();
            onClose();
          }}
        >
          <X
            size={14}
            style={{
              marginRight: '6px',
              flexShrink: 0,
              opacity: 0.7,
              display: 'block',
            }}
          />
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: '14px',
              lineHeight: '14px',
            }}
          >
            不在项目中工作
          </span>
        </button>
      </div>
    </div>
  );
};
