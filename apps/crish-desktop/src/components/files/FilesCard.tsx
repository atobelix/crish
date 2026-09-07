import { useToast } from '../../services/toast/ToastContext';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './FilesCard.module.css';
import { Button, Tooltip } from '../ui';
import { CornerLeftUp, RotateCw, Search, X } from 'lucide-react';
import {
  countPendingFileAnnotations,
  getWorkspacePath,
  openPathDefault,
  pathDirname,
  resolveWorkspacePath,
  takePendingOpenPath,
} from '../../api/workspaceFsApi';
import { logInternalError } from '../../api/userFacingErrors';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { useFileNavigation } from './hooks/useFileNavigation';
import { useFilePreview } from './hooks/useFilePreview';
import { FileBreadcrumb } from './FileBreadcrumb';
import { FileTreeView } from './FileTreeView';
import { FilePreview } from './FilePreview';
import { FileActions } from './FileActions';

interface FilesCardProps {
  initialPath?: string | null;
}

// 无名称图标按钮文案（同源约定）：aria-label 与 Tooltip content 同引用，禁止两处各写
const PARENT_DIR_LABEL = '上级目录';
const REFRESH_LABEL = '刷新';
const FILES_SPLIT_RATIO_KEY = 'crish:files-list-ratio';

export const FilesCard: React.FC<FilesCardProps> = React.memo(
  ({ initialPath }) => {
    const { showToast } = useToast();
    const preview = useFilePreview();
    const nav = useFileNavigation(() => preview.dirty);
    const filterInputRef = useRef<HTMLInputElement>(null);
    const bodySplitRef = useRef<HTMLDivElement>(null);
    const [isResizing, setIsResizing] = useState(false);
    const [listWidthRatio, setListWidthRatio] = useState<number>(() => {
      try {
        const saved = localStorage.getItem(FILES_SPLIT_RATIO_KEY);
        if (saved) {
          const val = parseFloat(saved);
          if (!isNaN(val) && val >= 15 && val <= 75) return val;
        }
      } catch {
        // fallback
      }
      return 35;
    });

    const handleSplitResizeStart = useCallback(
      (
        e:
          | React.PointerEvent<HTMLDivElement>
          | React.MouseEvent<HTMLDivElement>
      ) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const container = bodySplitRef.current;
        if (!container) return;

        const handleEl = e.currentTarget;
        if ('setPointerCapture' in handleEl && 'pointerId' in e) {
          try {
            handleEl.setPointerCapture((e as React.PointerEvent).pointerId);
          } catch {
            /* ignore */
          }
        }

        setIsResizing(true);
        const containerRect = container.getBoundingClientRect();

        const handleMove = (moveEv: MouseEvent | PointerEvent) => {
          const currentWidth = containerRect.width;
          if (currentWidth <= 0) return;
          const offsetX = moveEv.clientX - containerRect.left;
          const newRatio = Math.max(
            15,
            Math.min(75, (offsetX / currentWidth) * 100)
          );
          setListWidthRatio(newRatio);
        };

        const handleUp = (upEv: MouseEvent | PointerEvent) => {
          if ('releasePointerCapture' in handleEl && 'pointerId' in upEv) {
            try {
              if (
                handleEl.hasPointerCapture?.(
                  (upEv as PointerEvent).pointerId
                )
              ) {
                handleEl.releasePointerCapture(
                  (upEv as PointerEvent).pointerId
                );
              }
            } catch {
              /* ignore */
            }
          }
          window.removeEventListener('pointermove', handleMove);
          window.removeEventListener('pointerup', handleUp);
          window.removeEventListener('pointercancel', handleUp);
          window.removeEventListener('mousemove', handleMove);
          window.removeEventListener('mouseup', handleUp);
          setIsResizing(false);

          const currentWidth = containerRect.width;
          if (currentWidth > 0) {
            const offsetX = upEv.clientX - containerRect.left;
            const finalRatio = Math.max(
              15,
              Math.min(75, (offsetX / currentWidth) * 100)
            );
            setListWidthRatio(finalRatio);
            try {
              localStorage.setItem(FILES_SPLIT_RATIO_KEY, finalRatio.toFixed(2));
            } catch {
              // ignore
            }
          }
        };

        window.addEventListener('pointermove', handleMove);
        window.addEventListener('pointerup', handleUp);
        window.addEventListener('pointercancel', handleUp);
        window.addEventListener('mousemove', handleMove);
        window.addEventListener('mouseup', handleUp);
      },
      []
    );

    const handleOpenFile = useCallback(
      async (path: string) => {
        if (!(await nav.confirmNavigation())) return;
        const resolved = resolveWorkspacePath(path);
        const parent = pathDirname(resolved);
        if (parent) nav.setCwd(parent);
        await preview.openFile(path);
      },
      [nav, preview]
    );

    const handleRefresh = useCallback(
      async (dir?: string) => {
        if (!(await nav.confirmNavigation())) return;
        preview.resetPreview();
        preview.setView('browse');
        preview.setSelected(null);
        preview.clearActionHint();
        await nav.refresh(dir);
      },
      [nav, preview]
    );

    const handleGoUp = useCallback(async () => {
      if (!(await nav.confirmNavigation())) return;
      preview.setView('browse');
      preview.setSelected(null);
      preview.clearActionHint();
      nav.setError('');
      nav.goUp();
    }, [nav, preview]);

    const handleFileSelect = useCallback(
      (path: string, isDir: boolean) => {
        if (isDir) {
          void nav.toggleExpand(path, {
            stopPropagation: () => {},
          } as unknown as React.MouseEvent);
        } else {
          void handleOpenFile(path);
        }
      },
      [nav, handleOpenFile]
    );

    const handleFileDoubleClick = useCallback(
      (path: string, isDir: boolean) => {
        if (isDir) void handleRefresh(path);
        else void handleOpenFile(path);
      },
      [handleRefresh, handleOpenFile]
    );

    const handleCopyPath = useCallback(
      (mode: 'abs' | 'rel') => {
        preview.copyPath(preview.selected || nav.cwd, nav.root, mode);
        showToast(mode === 'abs' ? '绝对路径已复制' : '相对路径已复制');
      },
      [preview, nav, showToast]
    );

    const handleNavigate = useCallback(
      async (path: string) => {
        if (!(await nav.confirmNavigation())) return;
        preview.resetPreview();
        preview.clearActionHint();
        nav.setError('');
        void nav.refresh(path);
      },
      [nav, preview]
    );

    const handleRefreshDir = useCallback(
      async (path: string) => {
        if (!(await nav.confirmNavigation())) return;
        preview.resetPreview();
        void nav.refresh(path);
      },
      [nav, preview]
    );

    const handleOpenFromPreview = useCallback(() => {
      if (preview.selected) {
        void openPathDefault(preview.selected).catch((e) =>
          logInternalError('components/files/FilesCard/openDefault', e)
        );
      }
    }, [preview.selected]);

    useEffect(() => {
      const onProject = () => {
        const r = getWorkspacePath();
        nav.setCwd(r || '');
        preview.setView('browse');
        preview.setSelected(null);
        void nav.refresh(r || undefined);
      };
      window.addEventListener('crish-project-changed', onProject);
      return () =>
        window.removeEventListener('crish-project-changed', onProject);
    }, [nav, preview]);

    useEffect(() => {
      void nav.refresh().then(() => {
        const pending = takePendingOpenPath() || (initialPath ?? null);
        if (pending) void handleOpenFile(pending);
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载一次性：仅消费挂载时待打开路径，不随依赖变更重放
    }, []);

    useEffect(() => {
      const onOpen = (ev: Event) => {
        const path = (ev as CustomEvent<{ path?: string }>).detail?.path;
        if (!path) return;
        takePendingOpenPath();
        const resolved = resolveWorkspacePath(path);
        const parent = pathDirname(resolved);
        if (parent) {
          void nav.refresh(parent).finally(() => void handleOpenFile(resolved));
        } else {
          void handleOpenFile(resolved);
        }
      };
      window.addEventListener('crish-open-file', onOpen);
      return () => window.removeEventListener('crish-open-file', onOpen);
    }, [nav, handleOpenFile]);

    useEffect(() => {
      const onAnn = () =>
        preview.setPendingCount(countPendingFileAnnotations());
      window.addEventListener('crish-file-annotations-changed', onAnn);
      return () =>
        window.removeEventListener('crish-file-annotations-changed', onAnn);
    }, [preview]);

    useEffect(() => {
      return () => {
        if (preview.actionHintTimerRef.current)
          clearTimeout(preview.actionHintTimerRef.current);
      };
    }, [preview.actionHintTimerRef]);

    const handleRefreshBtn = useCallback(() => {
      preview.clearActionHint();
      if (preview.view === 'detail' && preview.selected)
        void handleOpenFile(preview.selected);
      else void handleRefresh();
    }, [preview, handleOpenFile, handleRefresh]);

    const noRoot = !nav.root;

    return (
      <AppErrorBoundary variant="compact" title="文件面板出错">
        {/* 确认对话框渲染点：useFileNavigation（未保存切换）+ useFilePreview（外部修改覆盖） */}
        {nav.confirmGateView}
        {preview.confirmGateView}
        <div className={`${styles.filesCard} chat-side-panel`} data-file-preview-host="files">
          <div className={`${styles.filesBar} side-panel-toolbar`} role="toolbar" aria-label="文件导航">
            <Tooltip content={PARENT_DIR_LABEL}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.filesNavBtn}
                aria-label={PARENT_DIR_LABEL}
                disabled={!nav.cwd || nav.cwd === nav.root}
                onClick={handleGoUp}
                icon={<CornerLeftUp size={14} />}
              />
            </Tooltip>
            <Tooltip content={REFRESH_LABEL}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.filesNavBtn}
                aria-label={REFRESH_LABEL}
                onClick={handleRefreshBtn}
                icon={<RotateCw size={14} />}
              />
            </Tooltip>

            {!noRoot ? (
              <FileBreadcrumb
                root={nav.root}
                cwd={nav.cwd}
                selected={preview.selected}
                view={preview.view}
                dirty={preview.dirty}
                onNavigate={handleNavigate}
                onOpenFile={handleOpenFile}
              />
            ) : null}

            {preview.view === 'browse' && (nav.filterMode || nav.filter) ? (
              <input
                ref={filterInputRef}
                className={styles.filesPathFilter}
                placeholder="筛选…"
                value={nav.filter}
                autoFocus
                onChange={(e) => nav.setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    nav.setFilter('');
                    nav.setFilterMode(false);
                  }
                }}
              />
            ) : null}

            {preview.view === 'browse' ? (
              <Tooltip
                content={
                  nav.filterMode || nav.filter ? '关闭筛选' : '筛选当前目录'
                }
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.filesNavBtn}
                  active={Boolean(nav.filterMode || nav.filter)}
                  aria-label={
                    nav.filterMode || nav.filter ? '关闭筛选' : '筛选当前目录'
                  }
                  onClick={() => {
                    if (nav.filterMode || nav.filter) {
                      nav.setFilter('');
                      nav.setFilterMode(false);
                    } else {
                      nav.setFilterMode(true);
                      requestAnimationFrame(() =>
                        filterInputRef.current?.focus()
                      );
                    }
                  }}
                  icon={
                    nav.filterMode || nav.filter ? (
                      <X size={14} />
                    ) : (
                      <Search size={14} />
                    )
                  }
                />
              </Tooltip>
            ) : null}

            {preview.pendingCount > 0 ? (
              <span
                className={styles.filesPendingBadge}
                aria-label="待发送批注"
              >
                {preview.pendingCount}
              </span>
            ) : null}

            {!noRoot ? (
              <FileActions
                selected={preview.selected}
                cwd={nav.cwd}
                root={nav.root}
                view={preview.view}
                canEdit={preview.canEdit}
                isMd={preview.isMd}
                mdMode={preview.mdMode}
                editing={preview.editing}
                dirty={preview.dirty}
                openDefaultLabel={preview.openDefaultLabel}
                fileOpeners={preview.fileOpeners}
                onEdit={() => {
                  preview.setEditing(true);
                  preview.setEditBuf(preview.content);
                  preview.setMdMode('source');
                  preview.clearActionHint();
                }}
                onSave={() => void preview.saveFile()}
                onCancel={() => {
                  preview.setEditing(false);
                  preview.setEditBuf(preview.content);
                  preview.setDirty(false);
                  preview.clearActionHint();
                }}
                onMdModeChange={(m) => preview.setMdMode(m)}
                onCopyPath={handleCopyPath}
              />
            ) : null}
          </div>

          {preview.actionHint ? (
            <div
              className={styles.filesActionHint}
              role="alert"
              aria-live="assertive"
            >
              <span className={styles.filesActionHintText}>
                {preview.actionHint}
              </span>
              <Tooltip content="关闭">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.filesActionHintDismiss}
                  aria-label="关闭提示"
                  onClick={() => preview.clearActionHint()}
                  icon={<X size={12} />}
                />
              </Tooltip>
            </div>
          ) : null}

          {noRoot ? (
            <div className={`${styles.filesEmpty} ${styles.filesEmptyCompact}`}>
              <div className={styles.filesEmptyTitle}>未选择项目</div>
              <div className={styles.filesEmptySub}>
                在侧栏选择工作区后即可浏览
              </div>
            </div>
          ) : (
            <div
              ref={bodySplitRef}
              className={`${styles.filesBody} ${styles.filesBodySplit}`}
              data-mode={preview.view}
              style={
                {
                  '--files-list-ratio': `${listWidthRatio}%`,
                } as React.CSSProperties
              }
            >
              <FileTreeView
                root={nav.root}
                cwd={nav.cwd}
                flatTree={nav.flatTree}
                selected={preview.selected}
                expanded={nav.expanded}
                loading={nav.loading}
                error={nav.error}
                filter={nav.filter}
                filterMode={nav.filterMode}
                gitStatusMap={nav.gitStatusMap}
                onSelect={handleFileSelect}
                onToggleExpand={(path, e) => void nav.toggleExpand(path, e)}
                onDoubleClick={handleFileDoubleClick}
                onFilterChange={(v) => nav.setFilter(v)}
                onFilterModeToggle={() => nav.setFilterMode(!nav.filterMode)}
                onErrorDismiss={() => nav.setError('')}
              />
              <div
                className={`${styles.filesSplitResizer} ${isResizing ? styles.isResizing : ''}`}
                onPointerDown={handleSplitResizeStart}
                onMouseDown={handleSplitResizeStart}
                role="separator"
                aria-orientation="vertical"
                aria-label="调整目录树与预览宽度"
              />
              <FilePreview
                file={{
                  selected: preview.selected,
                  kind: preview.kind,
                  isMd: preview.isMd,
                  canEdit: preview.canEdit,
                }}
                preview={{
                  view: preview.view,
                  content: preview.content,
                  editBuf: preview.editBuf,
                  editing: preview.editing,
                  dirty: preview.dirty,
                  error: nav.error,
                  detailLoading: preview.detailLoading,
                  truncated: preview.truncated,
                  lineBudget: preview.lineBudget,
                  loadingMore: preview.loadingMore,
                  mdMode: preview.mdMode,
                  assetUrl: preview.assetUrl,
                  canLoadMore: preview.canLoadMore,
                }}
                actions={{
                  onLoadMore: () => void preview.loadMoreLines(),
                  onEditBufChange: (v, d) => {
                    preview.setEditBuf(v);
                    preview.setDirty(d);
                  },
                  onError: (msg) => nav.setError(msg),
                  onOpenFile: handleOpenFromPreview,
                }}
              />
            </div>
          )}
        </div>
      </AppErrorBoundary>
    );
  }
);

export type { FilesCardProps };
