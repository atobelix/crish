import React, { useState } from 'react';
import styles from './FilesCard.module.css';
import { Button, Tooltip, Menu } from '../ui';
import {
  AppWindow,
  ChevronDown,
  ChevronsUpDown,
  Copy,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Save,
} from 'lucide-react';
import { revealInOs } from '../../api/workspaceFsApi';
import {
  openPathDefault,
  openWithHostOpener,
  type HostOpener,
} from '../../api/hostOpenersApi';
import { logInternalError } from '../../api/userFacingErrors';
import type { ViewMode } from './hooks/useFilePreview';

function getOpenerIcon(op: HostOpener, size = 14) {
  if (op.iconDataUrl)
    return (
      <img
        src={op.iconDataUrl}
        width={size}
        height={size}
        alt=""
        style={{ flexShrink: 0, objectFit: 'contain' }}
      />
    );
  return (
    <AppWindow
      size={size}
      aria-hidden
      style={{ flexShrink: 0, color: 'var(--text-secondary)' }}
    />
  );
}

// 无名称图标按钮文案（同源约定）：aria-label 与 Tooltip content 同引用，禁止两处各写
const OPEN_WITH_LABEL = '选择打开方式';
const MORE_ACTIONS_LABEL = '更多操作';

interface FileActionsProps {
  selected: string | null;
  view: ViewMode;
  canEdit: boolean;
  isMd: boolean;
  mdMode: 'render' | 'source';
  editing: boolean;
  dirty: boolean;
  openDefaultLabel: string;
  fileOpeners: HostOpener[];
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onMdModeChange: (mode: 'render' | 'source') => void;
  onCopyPath: (mode: 'abs' | 'rel') => void;
}

export const FileActions = React.memo(function FileActions({
  selected,
  view,
  canEdit,
  isMd,
  mdMode,
  editing,
  dirty,
  openDefaultLabel,
  fileOpeners,
  onEdit,
  onSave,
  onCancel,
  onMdModeChange,
  onCopyPath,
}: FileActionsProps) {
  const [openMenuMore, setOpenMenuMore] = useState(false);

  const handleOpenDefault = () => {
    if (selected)
      void openPathDefault(selected).catch((e) =>
        logInternalError('components/files/FileActions/openDefault', e)
      );
  };
  const handleReveal = () => {
    if (selected)
      void revealInOs(selected).catch((e) =>
        logInternalError('components/files/FileActions/revealInOs', e)
      );
  };
  const handleOpenWith = (op: HostOpener) => {
    if (selected)
      void openWithHostOpener(op.id, selected).catch((e) =>
        logInternalError('components/files/FileActions/openWith', e)
      );
  };

  return (
    <>
      {view !== 'browse' ? (
        <div className={styles.filesContextBar}>
          <span className={styles.filesContextName}>
            {dirty ? (
              <span className={styles.filesDirtyDot} aria-label="未保存">
                ·
              </span>
            ) : null}
            {selected?.split(/[\\/]/).pop() || ''}
          </span>
          <div className={styles.filesContextActions}>
            {isMd ? (
              <div
                className={styles.filesSeg}
                role="group"
                aria-label="Markdown 显示"
                data-md-source-toggle="files-leaf-only"
              >
                <Tooltip content="渲染预览">
                  <button
                    type="button"
                    className={`${styles.filesSegBtn} ${mdMode === 'render' ? styles.isOn : ''}`}
                    aria-pressed={mdMode === 'render'}
                    onClick={() => onMdModeChange('render')}
                  >
                    渲染
                  </button>
                </Tooltip>
                <Tooltip content="源码">
                  <button
                    type="button"
                    className={`${styles.filesSegBtn} ${mdMode === 'source' ? styles.isOn : ''}`}
                    aria-pressed={mdMode === 'source'}
                    onClick={() => onMdModeChange('source')}
                  >
                    源码
                  </button>
                </Tooltip>
              </div>
            ) : null}
            {canEdit && !editing ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className={styles.filesSoftBtn}
                onClick={onEdit}
                icon={<Pencil size={13} />}
              >
                编辑
              </Button>
            ) : null}
            {editing ? (
              <>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  className={`${styles.filesSoftBtn} ${styles.filesSoftBtnEmphasis}`}
                  disabled={!dirty}
                  onClick={onSave}
                  icon={<Save size={13} />}
                >
                  保存
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className={styles.filesSoftBtn}
                  onClick={onCancel}
                >
                  取消
                </Button>
              </>
            ) : null}
            {selected ? (
              <div className={styles.filesOpenCapsule}>
                <Tooltip content={`${openDefaultLabel}（系统默认）`}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className={styles.filesOpenMain}
                    onClick={handleOpenDefault}
                    icon={<AppWindow size={13} aria-hidden />}
                  >
                    {openDefaultLabel}
                  </Button>
                </Tooltip>
                <Menu
                  position={{ align: 'end', side: 'bottom', sideOffset: 4 }}
                  trigger={
                    <Tooltip content={OPEN_WITH_LABEL}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={styles.filesOpenChev}
                        aria-label={OPEN_WITH_LABEL}
                        icon={<ChevronDown size={14} aria-hidden />}
                      />
                    </Tooltip>
                  }
                  options={[
                    {
                      id: 'copy-path',
                      label: '复制路径',
                      icon: <Copy size={14} aria-hidden />,
                      onClick: () => onCopyPath('abs'),
                    },
                    {
                      id: 'reveal-file',
                      label: '在文件管理器中显示',
                      icon: <FolderOpen size={14} aria-hidden />,
                      onClick: handleReveal,
                    },
                    ...fileOpeners
                      .slice(0, openMenuMore ? fileOpeners.length : 6)
                      .map((op) => ({
                        id: op.id,
                        label: op.displayName,
                        icon: getOpenerIcon(op, 14),
                        onClick: () => handleOpenWith(op),
                      })),
                    ...(fileOpeners.length > 6
                      ? [
                          {
                            id: '__toggle_more_openers__',
                            label: openMenuMore
                              ? '收起'
                              : `更多应用（${fileOpeners.length - 6}）`,
                            icon: <ChevronsUpDown size={14} aria-hidden />,
                            onClick: () => setOpenMenuMore((v) => !v),
                          },
                        ]
                      : []),
                  ]}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className={styles.filesMoreWrap}>
        <Menu
          position={{ align: 'end', side: 'bottom', sideOffset: 4 }}
          trigger={
            <Tooltip content={MORE_ACTIONS_LABEL}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.filesNavBtn}
                aria-label={MORE_ACTIONS_LABEL}
                icon={<MoreHorizontal size={14} />}
              />
            </Tooltip>
          }
          options={[
            {
              id: 'copy-rel',
              label: '复制相对路径',
              onClick: () => onCopyPath('rel'),
            },
            {
              id: 'copy-abs',
              label: '复制绝对路径',
              onClick: () => onCopyPath('abs'),
            },
            {
              id: 'reveal-sys',
              label: '在资源管理器中显示',
              onClick: handleReveal,
            },
            ...(view === 'detail' && canEdit && !editing
              ? [
                  {
                    id: 'edit-file',
                    label: '编辑文件',
                    onClick: onEdit,
                  },
                ]
              : []),
          ]}
        />
      </div>
    </>
  );
});
