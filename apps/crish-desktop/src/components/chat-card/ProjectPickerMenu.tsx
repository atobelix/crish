import React, { useEffect, useState } from 'react';
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
} from '../../api/projectStore';
import { openDirectoryDialogSafe } from '../../api/openDirectoryDialog';
import { getSessionStoreState, setDraftFolder } from '../../api/storeAccess';
import { isPendingDraft } from '../../store/storeAccess';
import {
  Check,
  ChevronRight,
  Folder,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { Button, ConfirmDialog, Menu, Tooltip } from '../ui';
import { useConfirmGate } from '../../hooks/useConfirmGate';

/** 草稿态切项目：同步 draftFolder，不 mint 真会话 */
function syncDraftFolderOnProjectChange(folder: string): void {
  if (isPendingDraft(getSessionStoreState().activeSessionId)) {
    setDraftFolder(folder);
  }
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** @deprecated 优先使用 onOpenChange(false)。@see onOpenChange */
  onClose?: () => void;
  onChanged?: () => void;
  /** 真实触发器（项目名按钮），用于锚定 Popover */
  children: React.ReactNode;
  onContentMouseEnter?: () => void;
  onContentMouseLeave?: () => void;
};

export const ProjectPickerMenu: React.FC<Props> = ({
  open,
  onOpenChange,
  onClose,
  onChanged,
  children,
  onContentMouseEnter,
  onContentMouseLeave,
}) => {
  const [q, setQ] = useState('');
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [showAddCascade, setShowAddCascade] = useState(false);
  const [busy, setBusy] = useState(false);
  const activeId = getActiveProjectId();
  // window.confirm → ConfirmDialog Promise 桥（批次 4.1，04-detail §2.1.1）
  const [confirmGate, renderConfirmGate] = useConfirmGate();

  const refresh = () => setProjects(listProjects());

  useEffect(() => {
    if (!open) return;
    refresh();
    setShowAddCascade(false);
    setQ('');
  }, [open]);

  // Filter projects by search query
  const filtered = projects.filter(
    (p) =>
      !q.trim() ||
      p.name.toLowerCase().includes(q.toLowerCase()) ||
      p.path.toLowerCase().includes(q.toLowerCase())
  );

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) onClose?.();
  };

  const handlePickFolder = async () => {
    setBusy(true);
    try {
      // 选择现有项目文件夹
      const path = await openDirectoryDialogSafe('选择现有项目文件夹');
      if (path) {
        addProjectFromPath(path);
        onChanged?.();
        handleOpenChange(false);
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
      // 选择或创建空白文件夹作为新项目
      const path = await openDirectoryDialogSafe('选择或创建空白文件夹');
      if (path) {
        addProjectFromPath(path);
        onChanged?.();
        handleOpenChange(false);
      }
    } catch {
      // quiet fail
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveProject = async (p: ProjectEntry) => {
    const ok = await confirmGate({
      title: '移除项目',
      description: `确定从列表移除项目「${p.name}」？`,
      confirmLabel: '移除项目',
    });
    if (!ok) return;
    removeProject(p.id);
    refresh();
    onChanged?.();
  };

  return (
    <>
      {/* 移除项目确认（Promise 桥渲染点） */}
      {renderConfirmGate(<ConfirmDialog />)}
      <Menu
        open={open}
        onOpenChange={handleOpenChange}
        trigger={children}
        side="bottom"
        align="center"
        sideOffset={6}
        contentClassName="sort-filter-menu open no-drag"
        contentStyle={{ width: '230px', overflow: 'visible' }}
      >
        <div
          onMouseEnter={onContentMouseEnter}
          onMouseLeave={onContentMouseLeave}
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
                autoFocus={open}
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
                      handleOpenChange(false);
                    }}
                  >
                    <Folder
                      size={14}
                      style={{
                        marginRight: '6px',
                        flexShrink: 0,
                        opacity: 0.7,
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {p.name}
                    </span>
                    {selected && (
                      <Check
                        size={13}
                        className={styles.rowCheck}
                        style={{
                          position: 'absolute',
                          right: '8px',
                          color: 'var(--text-primary)',
                        }}
                      />
                    )}
                  </button>
                  {p.id !== GENERAL_FOLDER && (
                    <Tooltip content="从列表移除项目">
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        className={styles.rowDeleteBtn}
                        aria-label={`从列表移除项目 ${p.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRemoveProject(p);
                        }}
                        icon={<Trash2 size={12} />}
                      />
                    </Tooltip>
                  )}
                </div>
              );
            })}
          </div>

          <div className={styles.divider} />

          {/* General Folder Option */}
          <button
            type="button"
            className={`sort-filter-option ${!activeId ? 'is-on' : ''}`}
            onMouseEnter={() => setShowAddCascade(false)}
            onClick={() => {
              setNoProject();
              syncDraftFolderOnProjectChange(GENERAL_FOLDER);
              onChanged?.();
              handleOpenChange(false);
            }}
          >
            <Folder
              size={14}
              style={{ marginRight: '6px', flexShrink: 0, opacity: 0.7 }}
            />
            <span style={{ flex: 1 }}>通用项目</span>
            {!activeId && <Check size={13} />}
          </button>

          {/* Add Project Cascade — 子菜单向右浮出，不扁平化进主列表 */}
          <div
            className={styles.addCascadeWrapper}
            onMouseEnter={() => setShowAddCascade(true)}
            onMouseLeave={() => setShowAddCascade(false)}
          >
            <button
              type="button"
              className={`sort-filter-option ${styles.addBtn}`}
              aria-haspopup="menu"
              aria-expanded={showAddCascade}
            >
              <Plus size={14} style={{ marginRight: '6px', flexShrink: 0 }} />
              <span style={{ flex: 1 }}>添加项目</span>
              <ChevronRight size={13} style={{ opacity: 0.5 }} />
            </button>

            {showAddCascade && (
              <div
                className={styles.cascadeSubmenu}
                role="menu"
                aria-label="添加项目"
              >
                <button
                  type="button"
                  className="sort-filter-option"
                  role="menuitem"
                  disabled={busy}
                  onClick={handlePickFolder}
                >
                  打开本地项目...
                </button>
                <button
                  type="button"
                  className="sort-filter-option"
                  role="menuitem"
                  disabled={busy}
                  onClick={handleCreateEmptyProject}
                >
                  新建空白项目...
                </button>
              </div>
            )}
          </div>
        </div>
      </Menu>
    </>
  );
};
