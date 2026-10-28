import React, { useMemo, useState, useCallback, useRef } from 'react';

import {
  GENERAL_FOLDER,
  getActiveProjectId,
  listProjects,
  type ProjectEntry,
} from '../../api/projectStore';
import {
  activateDefaultWorkspace,
  openAuthorizedProject,
  pickAndAddWorkspaceProject,
  removeAuthorizedProject,
  WorkspaceAccessError,
} from '../../api/workspaceAccessApi';
import { isPendingDraft } from '../../store/storeAccess';
import { Button, ConfirmDialog, Tooltip } from '@/components/ui';
import { useConfirmGate } from '../../hooks/useConfirmGate';
import {
  SmartExpandablePanel,
  type MenuItem,
  type SmartPanelProps,
} from '@/components/ui';
import styles from './ProjectPickerMenu.module.css';
import { AppIcon } from '@/components/ui/icons';
import { useScopedSessionId } from '../../contexts/LeafScopeContext';
import { ProjectManageModal } from '../sidebar/session-list/ProjectManageModal';
import { setDraftProjectFolder } from '../../store/storeAccess';
import { toast } from '../../services/toast';
import { useI18n } from '../../i18n';

export interface ProjectPickerMenuProps {
  sessionId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
  /** 真实触发器（项目名按钮），用于锚定 Popover */
  children: React.ReactNode;
  onContentMouseEnter?: () => void;
  onContentMouseLeave?: () => void;
  /** 以下透传 SmartExpandablePanel；未传沿用默认（居中、hover+click、可翻转） */
  position?: SmartPanelProps['position'];
  triggerMode?: SmartPanelProps['triggerMode'];
  avoidCollisions?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
}

export const ProjectPickerMenu: React.FC<ProjectPickerMenuProps> = ({
  sessionId: sessionIdProp,
  open,
  onOpenChange,
  onChanged,
  children,
  onContentMouseEnter,
  onContentMouseLeave,
  position = { side: 'bottom', align: 'center', sideOffset: 6 },
  triggerMode,
  avoidCollisions,
  onCloseAutoFocus,
}) => {
  const { t } = useI18n();
  const scopedSessionId = useScopedSessionId(sessionIdProp);
  const [projectListVersion, setProjectListVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [createPopoverOpen, setCreatePopoverOpen] = useState(false);
  const createAnchorRef = useRef<HTMLElement | null>(null);
  const activeId = getActiveProjectId();
  const [confirmGate, renderConfirmGate] = useConfirmGate();

  const syncDraftFolderOnProjectChange = useCallback(
    (folder: string) => {
      if (isPendingDraft(scopedSessionId)) {
        setDraftProjectFolder(folder, scopedSessionId || undefined);
      }
    },
    [scopedSessionId]
  );

  const refresh = useCallback(() => {
    setProjectListVersion((v) => v + 1);
  }, []);

  const projects = useMemo(() => {
    void projectListVersion;
    return listProjects();
  }, [projectListVersion, open]);

  const handlePickFolder = useCallback(async () => {
    setBusy(true);
    try {
      const entry = await pickAndAddWorkspaceProject();
      if (entry) {
        syncDraftFolderOnProjectChange(entry.id);
        onChanged?.();
        refresh();
        onOpenChange(false);
      }
    } catch (error) {
      toast.error(
        error instanceof WorkspaceAccessError
          ? error.message
          : t('workspace.project.pickerUnavailable')
      );
    } finally {
      setBusy(false);
    }
  }, [onChanged, onOpenChange, refresh, syncDraftFolderOnProjectChange, t]);

  const handleCreateEmptyProject = useCallback(() => {
    if (typeof document !== 'undefined') {
      createAnchorRef.current = document.querySelector<HTMLElement>(
        '[data-composer-project-picker]'
      );
    }
    onOpenChange(false);
    window.requestAnimationFrame(() => {
      setCreatePopoverOpen(true);
    });
  }, [onOpenChange]);

  const handleRemoveProject = async (p: ProjectEntry) => {
    const ok = await confirmGate({
      title: t('workspace.project.removeTitle'),
      description: t('workspace.project.confirmRemoveDescription', {
        name: p.name,
      }),
      confirmLabel: t('workspace.project.removeTitle'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await removeAuthorizedProject(p.id);
      refresh();
      onChanged?.();
    } catch (error) {
      toast.error(
        error instanceof WorkspaceAccessError
          ? error.message
          : t('workspace.project.removeFailed')
      );
    } finally {
      setBusy(false);
    }
  };

  const pickProject = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const project = await openAuthorizedProject(id);
        if (!project) return;
        syncDraftFolderOnProjectChange(id);
        onChanged?.();
        onOpenChange(false);
      } catch (error) {
        toast.error(
          error instanceof WorkspaceAccessError
            ? error.message
            : t('workspace.project.notAuthorized')
        );
      } finally {
        setBusy(false);
      }
    },
    [onChanged, onOpenChange, syncDraftFolderOnProjectChange, t]
  );

  // 纯数据驱动 Schema 构造
  const menuItems = useMemo<MenuItem[]>(() => {
    const projectItems: MenuItem[] = projects.map((p) => {
      const isSelected = p.id === activeId;
      return {
        id: `proj:${p.id}`,
        type: 'selectable',
        label: p.name,
        sublabel: p.path,
        icon: <AppIcon name="folder" size={14} />,
        selected: isSelected,
        searchKeywords: `${p.name} ${p.path}`,
        onSelect: () => pickProject(p.id),
        trailingAction:
          p.id !== GENERAL_FOLDER ? (
            <Tooltip content={t('workspace.project.removeFromList')}>
              <Button
                type="button"
                variant="danger"
                className={styles.rowDeleteBtn}
                aria-label={t('workspace.project.removeAria', {
                  name: p.name,
                })}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleRemoveProject(p);
                }}
              >
                <AppIcon name="trash" size={12} />
              </Button>
            </Tooltip>
          ) : undefined,
      };
    });

    const isGeneralSelected = !activeId || activeId === GENERAL_FOLDER;
    const generalItem: MenuItem = {
      id: 'proj:general',
      type: 'selectable',
      label: t('workspace.project.general'),
      icon: <AppIcon name="folder" size={14} />,
      selected: isGeneralSelected,
      disabled: busy,
      onSelect: () => {
        setBusy(true);
        void activateDefaultWorkspace()
          .then(() => {
            syncDraftFolderOnProjectChange(GENERAL_FOLDER);
            onChanged?.();
            onOpenChange(false);
          })
          .catch((error: unknown) => {
            toast.error(
              error instanceof WorkspaceAccessError
                ? error.message
                : t('workspace.switchToDefaultFailed')
            );
          })
          .finally(() => setBusy(false));
      },
    };

    return [
      ...projectItems,
      generalItem,
      {
        id: 'sep-actions',
        type: 'divider',
      },
      {
        id: 'action:add-project',
        type: 'submenu',
        label: t('workspace.project.add'),
        icon: <AppIcon name="plus" size={14} />,
        children: [
          {
            id: 'action:open-local',
            label: t('workspace.project.openLocal'),
            icon: <AppIcon name="folder-open" size={14} />,
            disabled: busy,
            closeOnSelect: false,
            onSelect: () => void handlePickFolder(),
          },
          {
            id: 'action:create-empty',
            label: t('workspace.project.createBlank'),
            icon: <AppIcon name="folder-plus" size={14} />,
            disabled: busy,
            closeOnSelect: false,
            onSelect: handleCreateEmptyProject,
          },
        ],
      },
    ];
  }, [
    projects,
    activeId,
    busy,
    pickProject,
    onChanged,
    onOpenChange,
    syncDraftFolderOnProjectChange,
    handlePickFolder,
    handleCreateEmptyProject,
    t,
  ]);

  return (
    <>
      {renderConfirmGate(<ConfirmDialog />)}
      <SmartExpandablePanel
        open={open}
        onOpenChange={onOpenChange}
        trigger={children}
        items={menuItems}
        enableSearch={true}
        searchPlaceholder={t('workspace.project.search')}
        position={position}
        triggerMode={triggerMode}
        avoidCollisions={avoidCollisions}
        onCloseAutoFocus={onCloseAutoFocus}
        className={styles.pickerPanel}
        onMouseEnter={onContentMouseEnter}
        onMouseLeave={onContentMouseLeave}
      />
      <ProjectManageModal
        mode="create"
        open={createPopoverOpen}
        onClose={() => setCreatePopoverOpen(false)}
        onProjectSaved={(entry) => {
          syncDraftFolderOnProjectChange(entry.id);
          onChanged?.();
          refresh();
        }}
      />
    </>
  );
};
