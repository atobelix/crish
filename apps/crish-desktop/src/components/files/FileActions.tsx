import React, { useEffect, useRef, useState } from 'react';
import styles from './FilesCard.module.css';
import { Button, Tooltip } from '../ui';
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

function useMenu(
  menuRef: React.RefObject<HTMLElement | null>,
  triggerRef: React.RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (v: boolean) => void
) {
  const prevRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [open, setOpen]);
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        ?.focus();
    });
  }, [open, menuRef]);
  useEffect(() => {
    if (prevRef.current && !open)
      requestAnimationFrame(() => triggerRef.current?.focus());
    prevRef.current = open;
  }, [open, triggerRef]);
}

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
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const [openMenuMore, setOpenMenuMore] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const openMenuRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const openMenuTriggerRef = useRef<HTMLButtonElement>(null);

  useMenu(moreRef, moreTriggerRef, moreOpen, setMoreOpen);
  useMenu(openMenuRef, openMenuTriggerRef, openMenuOpen, setOpenMenuOpen);

  useEffect(() => {
    if (!moreOpen && !openMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (moreOpen && moreRef.current && !moreRef.current.contains(t))
        setMoreOpen(false);
      if (
        openMenuOpen &&
        openMenuRef.current &&
        !openMenuRef.current.contains(t)
      )
        setOpenMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [moreOpen, openMenuOpen]);

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
              <div className={styles.filesOpenCapsule} ref={openMenuRef}>
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
                <Tooltip content={OPEN_WITH_LABEL}>
                  <Button
                    ref={openMenuTriggerRef}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.filesOpenChev}
                    aria-label={OPEN_WITH_LABEL}
                    aria-haspopup="menu"
                    aria-expanded={openMenuOpen}
                    onClick={() => {
                      setOpenMenuOpen((v) => !v);
                      setOpenMenuMore(false);
                      setMoreOpen(false);
                    }}
                    icon={<ChevronDown size={14} aria-hidden />}
                  />
                </Tooltip>
                {openMenuOpen ? (
                  <div
                    className={`${styles.filesOpenMenu} files-open-menu`}
                    role="menu"
                  >
                    <button
                      type="button"
                      className={`${styles.filesOpenItem} files-open-item`}
                      role="menuitem"
                      onClick={() => {
                        onCopyPath('abs');
                        setOpenMenuOpen(false);
                      }}
                    >
                      <Copy size={14} aria-hidden />
                      复制路径
                    </button>
                    <button
                      type="button"
                      className={`${styles.filesOpenItem} files-open-item`}
                      role="menuitem"
                      onClick={() => {
                        handleReveal();
                        setOpenMenuOpen(false);
                      }}
                    >
                      <FolderOpen size={14} aria-hidden />
                      在文件管理器中显示
                    </button>
                    {fileOpeners.length > 0 ? (
                      <div className={styles.filesOpenSep} role="separator" />
                    ) : null}
                    {(openMenuMore ? fileOpeners : fileOpeners.slice(0, 6)).map(
                      (op) => (
                        <button
                          key={op.id}
                          type="button"
                          className={`${styles.filesOpenItem} files-open-item`}
                          role="menuitem"
                          onClick={() => {
                            handleOpenWith(op);
                            setOpenMenuOpen(false);
                          }}
                        >
                          {getOpenerIcon(op, 14)}
                          {op.displayName}
                        </button>
                      )
                    )}
                    {fileOpeners.length > 6 ? (
                      <button
                        type="button"
                        className={`${styles.filesOpenItem} files-open-item ${styles.filesOpenItemMore}`}
                        role="menuitem"
                        onClick={() => setOpenMenuMore((v) => !v)}
                      >
                        <ChevronsUpDown size={14} aria-hidden />
                        {openMenuMore
                          ? '收起'
                          : `更多应用（${fileOpeners.length - 6}）`}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className={styles.filesMoreWrap} ref={moreRef}>
        <Tooltip content={MORE_ACTIONS_LABEL}>
          <Button
            ref={moreTriggerRef}
            type="button"
            variant="ghost"
            size="sm"
            className={styles.filesNavBtn}
            aria-label={MORE_ACTIONS_LABEL}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => {
              setMoreOpen((v) => !v);
              setOpenMenuOpen(false);
            }}
            icon={<MoreHorizontal size={15} />}
          />
        </Tooltip>
        {moreOpen ? (
          <div
            className={`${styles.filesMoreMenu} files-more-menu`}
            role="menu"
          >
            <button
              type="button"
              className={`${styles.filesMoreItem} files-more-item`}
              role="menuitem"
              onClick={() => {
                onCopyPath('rel');
                setMoreOpen(false);
              }}
            >
              复制相对路径
            </button>
            <button
              type="button"
              className={`${styles.filesMoreItem} files-more-item`}
              role="menuitem"
              onClick={() => {
                onCopyPath('abs');
                setMoreOpen(false);
              }}
            >
              复制绝对路径
            </button>
            <button
              type="button"
              className={styles.filesMoreItem}
              role="menuitem"
              onClick={() => {
                handleReveal();
                setMoreOpen(false);
              }}
            >
              在资源管理器中显示
            </button>
            {view === 'detail' && canEdit && !editing ? (
              <button
                type="button"
                className={styles.filesMoreItem}
                role="menuitem"
                onClick={() => {
                  onEdit();
                  setMoreOpen(false);
                }}
              >
                编辑文件
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
});
