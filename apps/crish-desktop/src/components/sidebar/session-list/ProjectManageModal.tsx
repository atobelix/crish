import React, { useCallback, useEffect, useState } from 'react';
import {
  projectFolderLabel,
  type ProjectEntry,
} from '../../../api/projectStore';
import {
  addProjectFromRecentPaths,
  openAuthorizedProject,
  removeAuthorizedProject,
  selectWorkspaceFolders,
  updateAuthorizedProjectPaths,
  WorkspaceAccessError,
} from '../../../api/workspaceAccessApi';
import { navigateToNewDraft } from '../../../store/storeAccess';
import { Button, Dialog, Input, Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { toast } from '../../../services/toast';
import styles from './ProjectManageModal.module.css';
import { useI18n } from '../../../i18n';

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
  const { t } = useI18n();
  const [folderPaths, setFolderPaths] = useState<string[]>([]);
  const [projectName, setProjectName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

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
    setError('');
  }, [open, mode, project]);

  const handlePickFolders = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const picked = await selectWorkspaceFolders(false);
      if (picked && picked.length > 0) {
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
    } catch (selectionError) {
      setError(
        selectionError instanceof WorkspaceAccessError
          ? selectionError.message
          : t('workspace.project.pickerUnavailable')
      );
    } finally {
      setBusy(false);
    }
  }, [busy, nameTouched, projectName, t]);

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
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (busy || folderPaths.length === 0) return;
      setError('');
      const primaryPath = folderPaths[0]!;
      const resolvedName =
        projectName.trim() || projectFolderLabel(primaryPath);

      if (mode === 'create') {
        setBusy(true);
        try {
          const entry = await addProjectFromRecentPaths(
            folderPaths,
            resolvedName
          );
          onOpenProject?.(entry.id);
          onProjectSaved?.(entry);
          onClose();
        } catch {
          setError(t('workspace.project.saveFailed'));
        } finally {
          setBusy(false);
        }
        return;
      }

      if (project) {
        setBusy(true);
        try {
          const updated = await updateAuthorizedProjectPaths(
            project.id,
            folderPaths,
            resolvedName
          );
          if (updated) {
            onProjectSaved?.(updated);
          }
          onClose();
        } catch (authorizationError) {
          setError(
            authorizationError instanceof WorkspaceAccessError
              ? authorizationError.message
              : t('workspace.project.saveFailed')
          );
        } finally {
          setBusy(false);
        }
      }
    },
    [
      folderPaths,
      projectName,
      busy,
      mode,
      project,
      onOpenProject,
      onProjectSaved,
      onClose,
      t,
    ]
  );

  const handleCreateChatInProject = useCallback(async () => {
    if (!project) return;
    try {
      const opened = await openAuthorizedProject(project.id);
      if (!opened) return;
      onOpenProject?.(project.id);
      navigateToNewDraft(project.id);
      onClose();
    } catch (openError) {
      toast.error(
        openError instanceof WorkspaceAccessError
          ? openError.message
          : t('workspace.project.notAuthorized')
      );
    }
  }, [project, onOpenProject, onClose, t]);

  const handleSetCurrentWorkspace = useCallback(async () => {
    if (!project) return;
    try {
      const opened = await openAuthorizedProject(project.id);
      if (!opened) return;
      onOpenProject?.(project.id);
      onClose();
    } catch (openError) {
      toast.error(
        openError instanceof WorkspaceAccessError
          ? openError.message
          : t('workspace.project.notAuthorized')
      );
    }
  }, [project, onOpenProject, onClose, t]);

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

  const handleRemoveProject = useCallback(async () => {
    if (!project || busy) return;
    setError('');
    setBusy(true);
    try {
      await removeAuthorizedProject(project.id);
      onProjectRemoved?.(project.id);
      onClose();
    } catch (removeError) {
      setError(
        removeError instanceof WorkspaceAccessError
          ? removeError.message
          : t('workspace.project.removeFailed')
      );
    } finally {
      setBusy(false);
    }
  }, [busy, onClose, onProjectRemoved, project, t]);

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
        {t('common.cancel')}
      </Button>
      <Button
        type="button"
        variant="primary"
        size="sm"
        disabled={
          busy || (mode === 'create' ? folderPaths.length === 0 : !isDirty)
        }
        onClick={() => void handleSubmit()}
      >
        {mode === 'create'
          ? t('workspace.project.create')
          : t('workspace.project.saveChanges')}
      </Button>
    </div>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        mode === 'create'
          ? t('workspace.project.create')
          : t('workspace.project.manage')
      }
      classNames={{ panel: styles.modalPanel, body: styles.modalBody }}
      footer={footer}
    >
      <div className={styles.formGroup}>
        <label className={styles.fieldLabel}>
          {t('workspace.project.folder')}
        </label>
        {folderPaths.length === 0 ? (
          <Button
            bare
            type="button"
            disabled={busy}
            className={styles.folderPickerDropzone}
            onClick={() => void handlePickFolders()}
          >
            <div className={styles.dropzoneIconWrapper}>
              <AppIcon
                name="folder-plus"
                size={20}
                className={styles.dropzoneIcon}
                aria-hidden
              />
            </div>
            <span className={styles.dropzoneText}>
              {t('workspace.project.chooseFolder')}
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
                  <Tooltip content={t('workspace.project.removeFolder')}>
                    <Button
                      bare
                      type="button"
                      className={styles.folderRemoveBtn}
                      aria-label={t('workspace.project.removeFolderAria', {
                        path: p,
                      })}
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
              disabled={busy}
              className={styles.addMoreBtn}
              onClick={() => void handlePickFolders()}
            >
              <AppIcon name="plus" size={12} aria-hidden />
              <span>{t('workspace.project.addMoreFolders')}</span>
            </Button>
          </>
        )}
      </div>

      <div className={styles.formGroup}>
        <label className={styles.fieldLabel}>
          {t('workspace.project.name')}
        </label>
        <Input
          type="text"
          size="md"
          className={styles.nameInput}
          aria-label={t('workspace.project.name')}
          placeholder={t('workspace.project.name')}
          value={projectName}
          onChange={(e) => {
            setNameTouched(true);
            setProjectName(e.target.value);
          }}
        />
      </div>

      {error ? (
        <div className={styles.errorMessage} role="alert">
          {error}
        </div>
      ) : null}

      {mode === 'manage' && project ? (
        <>
          <div className={styles.actionDivider} role="separator" />
          <div className={styles.actionList}>
            <Button
              bare
              type="button"
              className={styles.actionItem}
              onClick={() => void handleCreateChatInProject()}
            >
              <AppIcon name="file-plus" size={14} aria-hidden />
              <span>{t('workspace.project.createConversation')}</span>
            </Button>

            <Button
              bare
              type="button"
              className={styles.actionItem}
              onClick={() => void handleSetCurrentWorkspace()}
            >
              <AppIcon name="folder-open" size={14} aria-hidden />
              <span>{t('workspace.project.setCurrentWorkspace')}</span>
            </Button>

            <Button
              bare
              type="button"
              className={styles.actionItem}
              onClick={() => void handleCopyPath()}
            >
              <AppIcon name={copied ? 'check' : 'copy'} size={14} aria-hidden />
              <span>
                {copied
                  ? t('workspace.project.pathCopied')
                  : t('workspace.project.copyFolderPath')}
              </span>
            </Button>

            <Button
              bare
              type="button"
              className={`${styles.actionItem} ${styles.actionItemDanger}`}
              disabled={busy}
              onClick={() => void handleRemoveProject()}
            >
              <AppIcon name="trash" size={14} aria-hidden />
              <span>{t('workspace.project.removeFromList')}</span>
            </Button>
          </div>
        </>
      ) : null}
    </Dialog>
  );
};
