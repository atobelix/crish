import React from 'react';
import styles from './FilesCard.module.css';
import { Button, Tooltip, Menu } from '../ui';

import { revealInOs } from '../../api/workspaceFsApi';
import {
  openPathDefault,
  openWithHostOpener,
  type HostOpener,
} from '../../api/hostOpenersApi';
import { logInternalError } from '../../api/userFacingErrors';
import type { ViewMode } from './hooks/useFilePreview';
import { AppIcon } from '../ui/icons/index';

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
    <AppIcon name="app-window" size={size}
      aria-hidden
      style={{ flexShrink: 0, color: 'var(--text-secondary)' }} />
  );
}

// 无名称图标按钮文案（同源约定）：aria-label 与 Tooltip content 同引用，禁止两处各写
const OPEN_WITH_LABEL = '选择打开方式';
const MORE_ACTIONS_LABEL = '更多操作';

export interface FileActionsProps {
  selected: string | null;
  root?: string;
  view: ViewMode;
  canEdit: boolean;
  isMd: boolean;
  mdMode: 'render' | 'source';
  editing: boolean;
  dirty: boolean;
  openDefaultLabel: string;
  fileOpeners: HostOpener[];
  isJson?: boolean;
  isFormatted?: boolean;
  onToggleFormatJson?: () => void;
  wordWrap?: boolean;
  onToggleWordWrap?: () => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onMdModeChange: (mode: 'render' | 'source') => void;
  onCopyPath: (mode: 'abs' | 'rel') => void;
}

export const FileActions = React.memo(function FileActions({
  selected,
  root,
  view,
  canEdit,
  isMd,
  mdMode,
  editing,
  dirty,
  openDefaultLabel,
  fileOpeners,
  isJson,
  isFormatted,
  onToggleFormatJson,
  wordWrap,
  onToggleWordWrap,
  onEdit,
  onSave,
  onCancel,
  onMdModeChange,
  onCopyPath,
}: FileActionsProps) {
  // 单轨收敛：仅凭 selected 与 root 推导目标路径，彻底切断对 cwd 的引用
  const targetPath = selected || root || null;

  const handleOpenDefault = () => {
    if (selected)
      void openPathDefault(selected).catch((e) =>
        logInternalError('components/files/FileActions/openDefault', e)
      );
  };
  const handleReveal = () => {
    if (targetPath)
      void revealInOs(targetPath).catch((e) =>
        logInternalError('components/files/FileActions/revealInOs', e)
      );
  };
  const handleOpenWith = (op: HostOpener) => {
    if (selected)
      void openWithHostOpener(op.id, selected).catch((e) =>
        logInternalError('components/files/FileActions/openWith', e)
      );
  };

  const systemFileManager = fileOpeners.find(
    (op) => op.id === 'system-file-manager'
  );
  const revealIcon = systemFileManager?.iconDataUrl ? (
    <img
      src={systemFileManager.iconDataUrl}
      width={14}
      height={14}
      alt=""
      style={{ flexShrink: 0, objectFit: 'contain' }}
    />
  ) : (
    <AppIcon name="folder-open" size={14} aria-hidden />
  );
  const defaultOpener = fileOpeners[0];
  const defaultOpenIcon = defaultOpener?.iconDataUrl ? (
    <img
      src={defaultOpener.iconDataUrl}
      width={14}
      height={14}
      alt=""
      style={{ flexShrink: 0, objectFit: 'contain' }}
    />
  ) : (
    <AppIcon name="app-window" size={14} aria-hidden />
  );

  return (
    <>
      {view !== 'browse' ? (
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
              icon={<AppIcon name="pencil" size={14} />}
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
                icon={<AppIcon name="save" size={14} />}
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
          {isJson && !editing && onToggleFormatJson ? (
            <Tooltip content={isFormatted ? '还原紧凑格式' : '格式化 JSON 排版'}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className={`${styles.filesSoftBtn} ${isFormatted ? styles.filesSoftBtnEmphasis : ''}`}
                aria-label={isFormatted ? '还原紧凑格式' : '格式化 JSON 排版'}
                aria-pressed={isFormatted}
                onClick={onToggleFormatJson}
                icon={<AppIcon name="braces" size={14} />}
              >
                {isFormatted ? '还原' : '格式化'}
              </Button>
            </Tooltip>
          ) : null}
          {!editing && onToggleWordWrap ? (
            <Tooltip content={wordWrap ? '关闭自动换行' : '开启自动换行'}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className={`${styles.filesSoftBtn} ${wordWrap ? styles.filesSoftBtnEmphasis : ''}`}
                aria-label={wordWrap ? '关闭自动换行' : '开启自动换行'}
                aria-pressed={wordWrap}
                onClick={onToggleWordWrap}
                icon={<AppIcon name="wrap-text" size={14} />}
              />
            </Tooltip>
          ) : null}
          {selected ? (
            <div className={styles.filesOpenCapsule}>
              <Tooltip content={`${openDefaultLabel}（系统默认）`}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.filesOpenMain}
                  onClick={handleOpenDefault}
                  icon={defaultOpenIcon}
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
                      icon={<AppIcon name="chevron-down" size={14} aria-hidden />}
                    />
                  </Tooltip>
                }
                options={[
                  {
                    id: 'copy-path',
                    label: '复制绝对路径',
                    icon: <AppIcon name="copy" size={14} aria-hidden />,
                    onClick: () => onCopyPath('abs'),
                  },
                  {
                    id: 'reveal-file',
                    label: '在资源管理器中显示',
                    icon: revealIcon,
                    onClick: handleReveal,
                  },
                  ...fileOpeners.map((op) => ({
                    id: op.id,
                    label: op.displayName,
                    icon: getOpenerIcon(op, 14),
                    onClick: () => handleOpenWith(op),
                  })),
                ]}
              />
            </div>
          ) : null}
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
                icon={<AppIcon name="more-horizontal" size={14} />}
              />
            </Tooltip>
          }
          options={[
            {
              id: 'copy-rel',
              label: '复制相对路径',
              icon: <AppIcon name="copy" size={14} aria-hidden />,
              onClick: () => onCopyPath('rel'),
            },
            {
              id: 'copy-abs',
              label: '复制绝对路径',
              icon: <AppIcon name="copy" size={14} aria-hidden />,
              onClick: () => onCopyPath('abs'),
            },
            {
              id: 'reveal-sys',
              label: '在资源管理器中显示',
              icon: revealIcon,
              onClick: handleReveal,
            },
          ]}
        />
      </div>
    </>
  );
});
