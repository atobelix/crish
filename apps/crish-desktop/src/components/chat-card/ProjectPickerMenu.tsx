import React, { useMemo, useState, useCallback } from 'react';

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
import { isPendingDraft } from '../../store/storeAccess';
import { Button, ConfirmDialog, Tooltip } from '../ui';
import { useConfirmGate } from '../../hooks/useConfirmGate';
import {
  SmartExpandablePanel,
  type MenuItem,
  type SmartPanelProps,
} from '../ui/SmartExpandablePanel';
import styles from './ProjectPickerMenu.module.css';
import { AppIcon } from '../ui/icons/index';
import { useScopedSessionId } from '../../contexts/LeafScopeContext';
import { setDraftProjectFolder } from '../../store/sessionDraftActions';

export interface ProjectPickerMenuProps {
  sessionId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** @deprecated 优先使用 onOpenChange(false)。@see onOpenChange */
  onClose?: () => void;
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
  onClose,
  onChanged,
  children,
  onContentMouseEnter,
  onContentMouseLeave,
  position = { side: 'bottom', align: 'center', sideOffset: 6 },
  triggerMode,
  avoidCollisions,
  onCloseAutoFocus,
}) => {
  const scopedSessionId = useScopedSessionId(sessionIdProp);
  const [projectListVersion, setProjectListVersion] = useState(0);
  const [busy, setBusy] = useState(false);
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

  const handlePickFolder = async () => {
    setBusy(true);
    try {
      const path = await openDirectoryDialogSafe('选择现有项目文件夹');
      if (path) {
        addProjectFromPath(path);
        onChanged?.();
        refresh();
        onOpenChange(false);
      }
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
        refresh();
        onOpenChange(false);
      }
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

  const pickProject = useCallback(
    (id: string) => {
      openProject(id);
      syncDraftFolderOnProjectChange(id);
      onChanged?.();
      onOpenChange(false);
    },
    [onChanged, onOpenChange, syncDraftFolderOnProjectChange]
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
            <Tooltip content="从列表移除项目">
              <Button
                type="button"
                variant="ghost"
                className={styles.rowDeleteBtn}
                aria-label={`从列表移除项目 ${p.name}`}
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
      label: '通用项目',
      icon: <AppIcon name="folder" size={14} />,
      selected: isGeneralSelected,
      onSelect: () => {
        setNoProject();
        syncDraftFolderOnProjectChange(GENERAL_FOLDER);
        onChanged?.();
        onOpenChange(false);
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
        label: '添加项目',
        icon: <AppIcon name="plus" size={14} />,
        children: [
          {
            id: 'action:open-local',
            label: '打开本地项目...',
            icon: <AppIcon name="folder-open" size={14} />,
            disabled: busy,
            onSelect: handlePickFolder,
          },
          {
            id: 'action:create-empty',
            label: '新建空白项目...',
            icon: <AppIcon name="folder-plus" size={14} />,
            disabled: busy,
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
  ]);

  return (
    <>
      {renderConfirmGate(<ConfirmDialog />)}
      <SmartExpandablePanel
        open={open}
        onOpenChange={onOpenChange}
        onClose={onClose}
        trigger={children}
        items={menuItems}
        enableSearch={true}
        searchPlaceholder="搜索项目"
        position={position}
        triggerMode={triggerMode}
        avoidCollisions={avoidCollisions}
        onCloseAutoFocus={onCloseAutoFocus}
        className={styles.pickerPanel}
        onMouseEnter={onContentMouseEnter}
        onMouseLeave={onContentMouseLeave}
      />
    </>
  );
};
