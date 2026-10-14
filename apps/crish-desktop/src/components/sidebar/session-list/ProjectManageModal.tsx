import React, { useCallback, useEffect, useState } from 'react';
import {
  addProjectFromPaths,
  openProject,
  projectFolderLabel,
  removeProject,
  updateProject,
  type ProjectEntry,
} from '../../../api/projectStore';
import { openDirectoriesDialogSafe } from '../../../api/openDirectoryDialog';
import { navigateToNewDraft } from '../../../store/storeAccess';
import { Button, Dialog, Input, Tooltip } from '../../ui';
import { AppIcon } from '../../ui/icons/index';
import styles from './ProjectManageModal.module.css';

export interface ProjectManageModalProps {
  mode: 'create' | 'manage';
  open: boolean;
  onClose: () => void;
  project?: ProjectEntry;
  onProjectSaved?: (entry: ProjectEntry) => void;
  onProjectRemoved?: (projectId: string) => void;
  onOpenProject?: (projectId: string) => void;
}

export const ProjectManageModal: React.FC<ProjectManageModalProps> = ({
  mode,
  open,
  onClose,
  project,
  onProjectSaved,
  onProjectRemoved,
  onOpenProject,
}) => {
  const [folderPaths, setFolderPaths] = useState<string[]>([]);
  const [projectName, setProjectName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (mode === 'manage' && project) {
      const initialPaths =
        project.paths && project.paths.length > 0
          ? [...project.paths]
          : project.path
            ? [project.path]
            : [];
      setFolderPaths(initialPaths);
      setProjectName(project.name || '');
      setNameTouched(true);
    } else {
      setFolderPaths([]);
      setProjectName('');
      setNameTouched(false);
    }
    setCopied(false);
  }, [open, mode, project]);

  const handlePickFolders = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const picked = await openDirectoriesDialogSafe(
        mode === 'create' ? '选择项目文件夹（支持多选）' : '添加文件夹到项目'
      );
      if (picked.length > 0) {
        setFolderPaths((prev) => {
          const next = [...prev];
          for (const p of picked) {
            if (!next.includes(p)) next.push(p);
          }
          if ((!nameTouched || !projectName.trim()) && next[0]) {
            setProjectName(projectFolderLabel(next[0]));
          }
          return next;
        });
      }
    } finally {
      setBusy(false);
    }
  }, [busy, mode, nameTouched, projectName]);

  const handleRemovePath = useCallback(
    (index: number) => {
      setFolderPaths((prev) => {
        const next = prev.filter((_, i) => i !== index);
        if (!nameTouched && next[0]) {
          setProjectName(projectFolderLabel(next[0]));
        } else if (!nameTouched && next.length === 0) {
          setProjectName('');
        }
        return next;
      });
    },
    [nameTouched]
  );

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      if (folderPaths.length === 0) return;
      const primaryPath = folderPaths[0]!;
      const resolvedName =
        projectName.trim() || projectFolderLabel(primaryPath);

      if (mode === 'create') {
        const entry = addProjectFromPaths(folderPaths, resolvedName);
        onOpenProject?.(entry.id);
        onProjectSaved?.(entry);
        onClose();
        return;
      }

      if (project) {
        const updated = updateProject(project.id, {
          name: resolvedName,
          path: primaryPath,
          paths: folderPaths,
        });
        if (updated) {
          onProjectSaved?.(updated);
        }
        onClose();
      }
    },
    [
      folderPaths,
      projectName,
      mode,
      project,
      onOpenProject,
      onProjectSaved,
      onClose,
    ]
  );

  const handleCopyPath = useCallback(async () => {
    const targetPath = (folderPaths[0] || project?.path || '').trim();
    if (!targetPath) return;
    try {
      await navigator.clipboard?.writeText(targetPath);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore clipboard error */
    }
  }, [folderPaths, project]);

  const isDirty =
    mode === 'create'
      ? folderPaths.length > 0
      : Boolean(
          project &&
          (folderPaths.length !== (project.paths?.length ?? 1) ||
            folderPaths[0] !== project.path ||
            (projectName.trim() || projectFolderLabel(folderPaths[0] || '')) !==
              project.name)
        );

  const footer = (
    <div className={styles.modalFooter}>
      <Button type="button" variant="ghost" size="sm" onClick={onClose}>
        取消
      </Button>
      <Button
        type="button"
        variant="primary"
        size="sm"
        disabled={mode === 'create' ? folderPaths.length === 0 : !isDirty}
        onClick={handleSubmit}
      >
        {mode === 'create' ? '新建项目' : '保存修改'}
      </Button>
    </div>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={mode === 'create' ? '新建项目' : '项目管理'}
      classNames={{ panel: styles.modalPanel, body: styles.modalBody }}
      footer={footer}
    >
      <div className={styles.formGroup}>
        <label className={styles.fieldLabel}>项目文件夹</label>
        {folderPaths.length === 0 ? (
          <Button
            bare
            type="button"
            className={styles.folderPickerDropzone}
            onClick={() => void handlePickFolders()}
          >
            <AppIcon
              name="folder-plus"
              size={20}
              className={styles.dropzoneIcon}
              aria-hidden
            />
            <span className={styles.dropzoneText}>点击选择项目文件夹</span>
            <span className={styles.dropzoneSubtext}>
              支持单选或多选本地文件夹
            </span>
          </Button>
        ) : (
          <>
            <div className={styles.folderListCard}>
              {folderPaths.map((p, idx) => (
                <div key={p} className={styles.folderItem}>
                  <AppIcon
                    name="folder"
                    size={14}
                    className={styles.folderItemIcon}
                    aria-hidden
                  />
                  <div className={styles.folderItemMeta}>
                    <span className={styles.folderItemName}>
                      {projectFolderLabel(p)}
                    </span>
                    <Tooltip content={p}>
                      <span className={styles.folderItemPath}>{p}</span>
                    </Tooltip>
                  </div>
                  <Tooltip content="移除此文件夹">
                    <Button
                      bare
                      type="button"
                      className={styles.folderRemoveBtn}
                      aria-label={`移除文件夹 ${p}`}
                      onClick={() => handleRemovePath(idx)}
                    >
                      <AppIcon name="x" size={12} aria-hidden />
                    </Button>
                  </Tooltip>
                </div>
              ))}
            </div>
            <Button
              bare
              type="button"
              className={styles.addMoreBtn}
              onClick={() => void handlePickFolders()}
            >
              <AppIcon name="plus" size={12} aria-hidden />
              <span>添加更多文件夹</span>
            </Button>
          </>
        )}
      </div>

      <div className={styles.formGroup} style={{ marginTop: 8 }}>
        <label className={styles.fieldLabel}>项目名称</label>
        <Input
          type="text"
          size="md"
          className={styles.nameInput}
          aria-label="项目名称"
          placeholder="输入项目名称（默认按首个文件夹命名）"
          value={projectName}
          onChange={(e) => {
            setNameTouched(true);
            setProjectName(e.target.value);
          }}
        />
      </div>

      {mode === 'manage' && project ? (
        <>
          <div className={styles.actionDivider} role="separator" />
          <div className={styles.actionList}>
            <Button
              bare
              type="button"
              className={styles.actionItem}
              onClick={() => {
                onOpenProject?.(project.id);
                navigateToNewDraft(project.id);
                onClose();
              }}
            >
              <AppIcon name="file-plus" size={14} aria-hidden />
              <span>在本项目新建对话</span>
            </Button>

            <Button
              bare
              type="button"
              className={styles.actionItem}
              onClick={() => {
                openProject(project.id);
                onOpenProject?.(project.id);
                onClose();
              }}
            >
              <AppIcon name="folder-open" size={14} aria-hidden />
              <span>设为当前工作区</span>
            </Button>

            <Button
              bare
              type="button"
              className={styles.actionItem}
              onClick={() => void handleCopyPath()}
            >
              <AppIcon name={copied ? 'check' : 'copy'} size={14} aria-hidden />
              <span>{copied ? '已复制路径' : '复制文件夹路径'}</span>
            </Button>

            <Button
              bare
              type="button"
              className={`${styles.actionItem} ${styles.actionItemDanger}`}
              onClick={() => {
                removeProject(project.id);
                onProjectRemoved?.(project.id);
                onClose();
              }}
            >
              <AppIcon name="trash" size={14} aria-hidden />
              <span>从列表移除项目</span>
            </Button>
          </div>
        </>
      ) : null}
    </Dialog>
  );
};
