import React, { useCallback, useEffect, useRef } from 'react';
import styles from './FilesCard.module.css';
import { Tooltip } from '../Tooltip';
import { CornerLeftUp, RotateCw, Search, X } from 'lucide-react';
import { countPendingFileAnnotations, getWorkspacePath, openPathDefault, pathDirname, resolveWorkspacePath, takePendingOpenPath } from '../../api/workspaceFsApi';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { useFileNavigation } from './hooks/useFileNavigation';
import { useFilePreview } from './hooks/useFilePreview';
import { FileBreadcrumb } from './FileBreadcrumb';
import { FileTree } from './FileTree';
import { FilePreview } from './FilePreview';
import { FileActions } from './FileActions';

interface FilesCardProps {
  onShowToast?: (message: string) => void;
  initialPath?: string | null;
}

export const FilesCard: React.FC<FilesCardProps> = React.memo(({ initialPath }) => {
  const preview = useFilePreview();
  const nav = useFileNavigation(() => preview.dirty);
  const filterInputRef = useRef<HTMLInputElement>(null);

  const handleOpenFile = useCallback(async (path: string) => {
    if (!(await nav.confirmNavigation())) return;
    const resolved = resolveWorkspacePath(path);
    const parent = pathDirname(resolved);
    if (parent) nav.setCwd(parent);
    await preview.openFile(path);
  }, [nav, preview]);

  const handleRefresh = useCallback(async (dir?: string) => {
    if (!(await nav.confirmNavigation())) return;
    preview.resetPreview();
    preview.setView('browse');
    preview.setSelected(null);
    preview.clearActionHint();
    await nav.refresh(dir);
  }, [nav, preview]);

  const handleGoUp = useCallback(async () => {
    if (!(await nav.confirmNavigation())) return;
    preview.setView('browse');
    preview.setSelected(null);
    preview.clearActionHint();
    nav.setError('');
    nav.goUp();
  }, [nav, preview]);

  const handleFileSelect = useCallback((path: string, isDir: boolean) => {
    if (isDir) {
      void nav.toggleExpand(path, { stopPropagation: () => {} } as unknown as React.MouseEvent);
    } else {
      void handleOpenFile(path);
    }
  }, [nav, handleOpenFile]);

  const handleFileDoubleClick = useCallback((path: string, isDir: boolean) => {
    if (isDir) void handleRefresh(path);
    else void handleOpenFile(path);
  }, [handleRefresh, handleOpenFile]);

  const handleCopyPath = useCallback((mode: 'abs' | 'rel') => {
    preview.copyPath(preview.selected || nav.cwd, nav.root, mode);
  }, [preview, nav]);

  const handleNavigate = useCallback(async (path: string) => {
    if (!(await nav.confirmNavigation())) return;
    preview.resetPreview();
    preview.clearActionHint();
    nav.setError('');
    void nav.refresh(path);
  }, [nav, preview]);

  const handleRefreshDir = useCallback(async (path: string) => {
    if (!(await nav.confirmNavigation())) return;
    preview.resetPreview();
    void nav.refresh(path);
  }, [nav, preview]);

  const handleOpenFromPreview = useCallback(() => {
    if (preview.selected) {
      void openPathDefault(preview.selected).catch(() => {});
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
    return () => window.removeEventListener('crish-project-changed', onProject);
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
    const onAnn = () => preview.setPendingCount(countPendingFileAnnotations());
    window.addEventListener('crish-file-annotations-changed', onAnn);
    return () => window.removeEventListener('crish-file-annotations-changed', onAnn);
  }, [preview]);

  useEffect(() => {
    return () => {
      if (preview.actionHintTimerRef.current) clearTimeout(preview.actionHintTimerRef.current);
    };
  }, [preview.actionHintTimerRef]);

  const handleRefreshBtn = useCallback(() => {
    preview.clearActionHint();
    if (preview.view === 'detail' && preview.selected) void handleOpenFile(preview.selected);
    else void handleRefresh();
  }, [preview, handleOpenFile, handleRefresh]);

  const noRoot = !nav.root;

  return (
    <AppErrorBoundary variant="compact" title="文件面板出错">
      <div className={styles.filesCard}>
        <div className={styles.filesBar} role="toolbar" aria-label="文件导航">
          <Tooltip content="上级目录">
            <button type="button" className={styles.filesNavBtn} disabled={!nav.cwd || nav.cwd === nav.root} onClick={handleGoUp}>
              <CornerLeftUp size={15} />
            </button>
          </Tooltip>
          <Tooltip content="刷新">
            <button type="button" className={styles.filesNavBtn} onClick={handleRefreshBtn}>
              <RotateCw size={15} />
            </button>
          </Tooltip>

          {!noRoot ? (
            <FileBreadcrumb
              root={nav.root}
              cwd={nav.cwd}
              selected={preview.selected}
              view={preview.view}
              onNavigate={handleNavigate}
              onRefresh={handleRefreshDir}
              onOpenFile={handleOpenFile}
            />
          ) : null}

          {preview.view === 'browse' && (nav.filterMode || nav.filter) ? (
            <input ref={filterInputRef} className={styles.filesPathFilter} placeholder="筛选…" value={nav.filter}
              autoFocus onChange={(e) => nav.setFilter(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { nav.setFilter(''); nav.setFilterMode(false); } }}
            />
          ) : null}

          {preview.view === 'browse' ? (
            <Tooltip content={nav.filterMode || nav.filter ? '关闭筛选' : '筛选当前目录'}>
              <button type="button" className={`${styles.filesNavBtn} ${nav.filterMode || nav.filter ? styles.isOn : ''}`}
                onClick={() => {
                  if (nav.filterMode || nav.filter) { nav.setFilter(''); nav.setFilterMode(false); }
                  else { nav.setFilterMode(true); requestAnimationFrame(() => filterInputRef.current?.focus()); }
                }}>
                {nav.filterMode || nav.filter ? <X size={14} /> : <Search size={14} />}
              </button>
            </Tooltip>
          ) : null}

          {preview.pendingCount > 0 ? (
            <span className={styles.filesPendingBadge} aria-label="待发送批注">{preview.pendingCount}</span>
          ) : null}

          {!noRoot ? (
            <FileActions
              selected={preview.selected}
              view={preview.view}
              canEdit={preview.canEdit}
              isMd={preview.isMd}
              mdMode={preview.mdMode}
              editing={preview.editing}
              dirty={preview.dirty}
              openDefaultLabel={preview.openDefaultLabel}
              fileOpeners={preview.fileOpeners}
              onEdit={() => { preview.setEditing(true); preview.setEditBuf(preview.content); preview.setMdMode('source'); preview.clearActionHint(); }}
              onSave={() => void preview.saveFile()}
              onCancel={() => { preview.setEditing(false); preview.setEditBuf(preview.content); preview.setDirty(false); preview.clearActionHint(); }}
              onMdModeChange={(m) => preview.setMdMode(m)}
              onCopyPath={handleCopyPath}
            />
          ) : null}
        </div>

        {preview.actionHint ? (
          <div className={styles.filesActionHint} role="alert" aria-live="assertive">
            <span className={styles.filesActionHintText}>{preview.actionHint}</span>
            <Tooltip content="关闭">
              <button type="button" className={styles.filesActionHintDismiss} aria-label="关闭提示" onClick={() => preview.clearActionHint()}>
                <X size={12} />
              </button>
            </Tooltip>
          </div>
        ) : null}

        {noRoot ? (
          <div className={`${styles.filesEmpty} ${styles.filesEmptyCompact}`}>
            <div className={styles.filesEmptyTitle}>未选择项目</div>
            <div className={styles.filesEmptySub}>在侧栏选择工作区后即可浏览</div>
          </div>
        ) : (
          <div className={`${styles.filesBody} ${styles.filesBodySplit}`}>
            <FileTree
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
            <FilePreview
              selected={preview.selected}
              view={preview.view}
              kind={preview.kind}
              content={preview.content}
              editBuf={preview.editBuf}
              editing={preview.editing}
              dirty={preview.dirty}
              error={nav.error}
              detailLoading={preview.detailLoading}
              truncated={preview.truncated}
              lineBudget={preview.lineBudget}
              loadingMore={preview.loadingMore}
              mdMode={preview.mdMode}
              assetUrl={preview.assetUrl}
              isMd={preview.isMd}
              canLoadMore={preview.canLoadMore}
              canEdit={preview.canEdit}
              onLoadMore={() => void preview.loadMoreLines()}
              onEditBufChange={(v, d) => { preview.setEditBuf(v); preview.setDirty(d); }}
              onError={(msg) => nav.setError(msg)}
              onOpenFile={handleOpenFromPreview}
            />
          </div>
        )}
      </div>
    </AppErrorBoundary>
  );
});

export type { FilesCardProps };
