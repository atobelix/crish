import React, { useEffect, useRef, useState, useCallback } from 'react';
import menuStyles from '../ui/Menu/Menu.module.css';
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
import { Button, ConfirmDialog, Input, Menu, Tooltip } from '../ui';
import { useConfirmGate } from '../../hooks/useConfirmGate';
import { SafeTriangleTracker } from '../ui/internal/SafeTriangle';

/** 草稿态切项目：同步 draftFolder，不 mint 真会话 */
function syncDraftFolderOnProjectChange(folder: string): void {
  if (isPendingDraft(getSessionStoreState().activeSessionId)) {
    setDraftFolder(folder);
  }
}

function pickerItemClass(
  ...extra: Array<string | false | null | undefined>
): string {
  return [menuStyles.menuItem, styles.item, ...extra]
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
    .join(' ');
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
  const [confirmGate, renderConfirmGate] = useConfirmGate();

  const safeTrackerRef = useRef(new SafeTriangleTracker(300));
  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const cascadeRef = useRef<HTMLDivElement | null>(null);

  const refresh = () => setProjects(listProjects());

  useEffect(() => {
    if (!open) {
      setShowAddCascade(false);
      safeTrackerRef.current.reset();
      return;
    }
    refresh();
    setShowAddCascade(false);
    setQ('');
  }, [open]);

  const filtered = projects.filter(
    (p) =>
      !q.trim() ||
      p.name.toLowerCase().includes(q.toLowerCase()) ||
      p.path.toLowerCase().includes(q.toLowerCase())
  );

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setShowAddCascade(false);
      safeTrackerRef.current.reset();
      onClose?.();
    }
  };

  const handlePickFolder = async () => {
    setBusy(true);
    try {
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

  const pickProject = (id: string) => {
    openProject(id);
    syncDraftFolderOnProjectChange(id);
    onChanged?.();
    handleOpenChange(false);
  };

  const handleAddCascadeLeave = useCallback((e: React.MouseEvent) => {
    if (showAddCascade && cascadeRef.current) {
      const subRect = cascadeRef.current.getBoundingClientRect();
      safeTrackerRef.current.enter(
        { x: e.clientX, y: e.clientY },
        {
          left: subRect.left,
          top: subRect.top,
          right: subRect.right,
          bottom: subRect.bottom,
        },
        'right'
      );
    }
  }, [showAddCascade]);

  const handleOtherRowEnter = useCallback((e?: React.MouseEvent) => {
    if (showAddCascade && safeTrackerRef.current.isGraceActive() && e) {
      if (safeTrackerRef.current.check({ x: e.clientX, y: e.clientY })) {
        return;
      }
    }
    setShowAddCascade(false);
    safeTrackerRef.current.reset();
  }, [showAddCascade]);

  return (
    <>
      {renderConfirmGate(<ConfirmDialog />)}
      <Menu
        openState={{ open, onOpenChange: handleOpenChange }}
        trigger={children}
        position={{ side: 'bottom', align: 'center', sideOffset: 6 }}
        panel={{
          contentClassName: styles.pickerPanel,
          contentStyle: { overflow: 'visible' },
        }}
      >
        <div
          role="menu"
          aria-label="选择项目"
          onMouseEnter={onContentMouseEnter}
          onMouseLeave={onContentMouseLeave}
        >
          <div
            className={styles.searchWrapper}
            onMouseEnter={handleOtherRowEnter}
          >
            <Input
              variant="search"
              size="sm"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索项目"
              aria-label="搜索项目"
              autoFocus={open}
              prefixIcon={<Search size={13} />}
            />
          </div>

          <div
            className={styles.scrollArea}
            onMouseEnter={handleOtherRowEnter}
          >
            {filtered.map((p) => {
              const selected = p.id === activeId;
              return (
                <div key={p.id} className={styles.projectRow}>
                  <button
                    type="button"
                    role="menuitem"
                    aria-current={selected ? 'true' : undefined}
                    className={pickerItemClass(styles.itemWithTrail)}
                    onClick={() => pickProject(p.id)}
                  >
                    <span
                      className={`${menuStyles.menuItemIcon} ${styles.itemIcon}`}
                      aria-hidden="true"
                    >
                      <Folder size={14} />
                    </span>
                    <span className={menuStyles.menuItemLabel}>{p.name}</span>
                    {selected ? (
                      <Check size={13} className={styles.rowCheck} />
                    ) : null}
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

          <div className={menuStyles.separator} />

          <button
            type="button"
            role="menuitem"
            aria-current={!activeId ? 'true' : undefined}
            className={pickerItemClass(!activeId && styles.itemWithTrail)}
            onMouseEnter={handleOtherRowEnter}
            onClick={() => {
              setNoProject();
              syncDraftFolderOnProjectChange(GENERAL_FOLDER);
              onChanged?.();
              handleOpenChange(false);
            }}
          >
            <span
              className={`${menuStyles.menuItemIcon} ${styles.itemIcon}`}
              aria-hidden="true"
            >
              <Folder size={14} />
            </span>
            <span className={menuStyles.menuItemLabel}>通用项目</span>
            {!activeId ? <Check size={13} className={styles.rowCheck} /> : null}
          </button>

          <div
            className={styles.addCascadeWrapper}
            onMouseEnter={() => {
              setShowAddCascade(true);
              safeTrackerRef.current.reach();
            }}
            onMouseLeave={handleAddCascadeLeave}
          >
            <button
              ref={addBtnRef}
              type="button"
              role="menuitem"
              className={pickerItemClass()}
              aria-haspopup="menu"
              aria-expanded={showAddCascade}
              onClick={() => setShowAddCascade((prev) => !prev)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setShowAddCascade(true);
                  requestAnimationFrame(() => {
                    cascadeRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
                  });
                }
              }}
            >
              <span className={menuStyles.menuItemIcon} aria-hidden="true">
                <Plus size={14} />
              </span>
              <span className={menuStyles.menuItemLabel}>添加项目</span>
              <span className={menuStyles.menuItemHint} aria-hidden="true">
                <ChevronRight size={13} />
              </span>
            </button>

            {showAddCascade && (
              <div
                ref={cascadeRef}
                className={`${menuStyles.menuContent} ${styles.cascadeSubmenu}`}
                role="menu"
                aria-label="添加项目"
                onMouseEnter={() => safeTrackerRef.current.reach()}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft' || e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setShowAddCascade(false);
                    addBtnRef.current?.focus();
                  }
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className={pickerItemClass(
                    busy ? menuStyles.menuItemDisabled : undefined
                  )}
                  disabled={busy}
                  onClick={handlePickFolder}
                >
                  <span className={menuStyles.menuItemLabel}>
                    打开本地项目...
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={pickerItemClass(
                    busy ? menuStyles.menuItemDisabled : undefined
                  )}
                  disabled={busy}
                  onClick={handleCreateEmptyProject}
                >
                  <span className={menuStyles.menuItemLabel}>
                    新建空白项目...
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      </Menu>
    </>
  );
};
