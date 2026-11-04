import { useToast } from '../../services/toast/ToastContext';
import { t } from '../../i18n';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import styles from './FilesCard.module.css';
import { Button, Tooltip, Input } from '@/components/ui';

import {
  countPendingFileAnnotations,
  openPathDefault,
  resolveReadableFilePath,
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
import { AppIcon } from '@/components/ui/icons';
import { preferencesClient } from '../../api/preferences';
import { useFileListRatio } from './hooks/useFileListRatio';
import { useSplitResize } from '../ui/SplitResizer';
import { ElasticSplitHandle } from '../ui/SplitResizer';
import {
  shouldConsumeScopedEvent,
  useLeafScope,
  useScopedSessionId,
} from '../../contexts/LeafScopeContext';

export interface FilesCardProps {
  initialPath?: string | null;
  sessionId?: string | null;
  leafId?: string | null;
}

const REFRESH_LABEL = '刷新';

/** 文件列表分栏比例域（百分数），与 useFileListRatio 的归一化口径一致 */
export const FILES_LIST_RATIO_MIN = 15;
export const FILES_LIST_RATIO_MAX = 75;

/**
 * 统一 hook 的 px 域宽界：文件域全部钳制由 clampFilesListRatio 承担，
 * hook 侧 min/max 仅需不截断任何真实指针行程（与 R3 同例）。
 */
const SPLIT_HOOK_WIDE_BOUND = 100_000;

/** 分栏比例钳制单一真源（百分数域 [15, 75]） */
export function clampFilesListRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return FILES_LIST_RATIO_MIN;
  return Math.min(FILES_LIST_RATIO_MAX, Math.max(FILES_LIST_RATIO_MIN, ratio));
}

/**
 * 指针增量（px）→ 钳制后新比例：以手势开始时实测的容器宽度换算，
 * 容器不可测（宽为 0）时保持起始比例（导出供单元测试直接断言）。
 */
export function filesListRatioFromDelta(
  startRatio: number,
  deltaPx: number,
  containerWidth: number
): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return clampFilesListRatio(startRatio);
  }
  return clampFilesListRatio(startRatio + (deltaPx / containerWidth) * 100);
}

/** 一次分栏拖拽会话的文件域账本（手势本体在统一 hook 内） */
interface FilesSplitDragSession {
  /** 手势开始时的分栏比例（增量换算与取消还原的基准） */
  startRatio: number;
  /** 手势开始时实测的容器宽度（增量换算的基准） */
  containerWidth: number;
  /** 最近一次实时换算出的比例（兜底落盘用） */
  liveRatio: number;
  /** 本次手势是否已由 hook 的 onCommit 提交过 */
  commitSeen: boolean;
  /** 本次手势是否被 Esc 取消（捕获期监听标记，先于 hook 的结束回调） */
  escCancel: boolean;
}

export const FilesCard: React.FC<FilesCardProps> = React.memo(
  ({ initialPath, sessionId, leafId }) => {
    const { showToast } = useToast();
    const scope = useLeafScope();
    const scopedSessionId = useScopedSessionId(sessionId);
    const effectiveLeafId = leafId ?? scope.leafId;
    const preview = useFilePreview();
    const nav = useFileNavigation(() => preview.dirty);
    const filterInputRef = useRef<HTMLInputElement>(null);
    const bodySplitRef = useRef<HTMLDivElement>(null);
    const [listWidthRatio, setListWidthRatio] = useFileListRatio();

    // ── 分栏拖拽（分割线统一波次 R5：手势协议收编至统一 hook） ──────────
    // 架构分工与 R3 DockResizeSash 同构：
    // 1. 手势协议由 useSplitResize 托管：指针捕获、window 级 move/up、
    //    rAF 节流、Esc 取消、blur / pointercancel 按提交当前值兜底、单一
    //    body 协议（data-split-resizing + 光标锁）。本组件不再自滚手势监听，
    //    迁移前 onPointerDown / onMouseDown 双绑同一 handler 的问题随之消除。
    // 2. 文件域语义全部留在本组件：比例域 [15, 75]% 的钳制单一真源
    //    clampFilesListRatio；hook 只提供指针增量（px），增量以手势开始时
    //    实测的容器宽度换算为比例（filesListRatioFromDelta）。
    // 3. 拖中实时呈现直写容器 --files-list-ratio 变量（零 setState、零每帧
    //    重渲染，与迁移前 setState 写比例的观感等价）；松手提交时才写回
    //    listWidthRatio 状态并落盘偏好。Esc 取消时 hook 的恢复回调把变量
    //    刷回起始比例，本组件经捕获期标记识别取消——取消不提交、不落盘。
    // 4. 结束落盘契约：迁移前 pointerup / pointercancel 恒落盘一次（含按下
    //    未移动），故落盘挂在 onDragStateChange 兜底（onCommit 未触发且非
    //    Esc 取消时补落盘），与 R3 的兜底提交同例。
    const splitSessionRef = useRef<FilesSplitDragSession | null>(null);

    const measureSplitContainerWidth = useCallback(() => {
      const container = bodySplitRef.current;
      if (!container) return 0;
      const rect = container.getBoundingClientRect();
      return rect.width || container.clientWidth || 0;
    }, []);

    // 容器宽度实测：仅作 hook 的 px 值域基准（增量与原点无关），渲染后校正即可
    const [splitContainerWidth, setSplitContainerWidth] = useState(0);
    useLayoutEffect(() => {
      const width = measureSplitContainerWidth();
      if (width > 0) {
        setSplitContainerWidth((prev) =>
          Math.abs(prev - width) > 0.5 ? width : prev
        );
      }
    });

    const persistListRatio = useCallback((ratio: number) => {
      void preferencesClient
        .setPreference('files_list_ratio', ratio)
        .catch(() => {
          /* best-effort ratio persist */
        });
    }, []);

    const splitResize = useSplitResize({
      value: (listWidthRatio / 100) * splitContainerWidth,
      min: -SPLIT_HOOK_WIDE_BOUND,
      max: SPLIT_HOOK_WIDE_BOUND,
      orientation: 'vertical',
      commitMode: 'release',
      onLiveChange: (px) => {
        const session = splitSessionRef.current;
        if (!session) return;
        const ratio = filesListRatioFromDelta(
          session.startRatio,
          px - splitResizeRef.current.dragStartValueRef.current,
          session.containerWidth
        );
        session.liveRatio = ratio;
        bodySplitRef.current?.style.setProperty(
          '--files-list-ratio',
          `${ratio}%`
        );
      },
      onCommit: (px) => {
        const session = splitSessionRef.current;
        if (!session) return;
        session.commitSeen = true;
        const ratio = filesListRatioFromDelta(
          session.startRatio,
          px - splitResizeRef.current.dragStartValueRef.current,
          session.containerWidth
        );
        session.liveRatio = ratio;
        setListWidthRatio(ratio);
        persistListRatio(ratio);
      },
      onDragStateChange: (nowDragging) => {
        if (nowDragging) {
          splitSessionRef.current = {
            startRatio: listWidthRatio,
            containerWidth: measureSplitContainerWidth(),
            liveRatio: listWidthRatio,
            commitSeen: false,
            escCancel: false,
          };
        } else {
          const session = splitSessionRef.current;
          splitSessionRef.current = null;
          if (session && !session.commitSeen && !session.escCancel) {
            setListWidthRatio(session.liveRatio);
            persistListRatio(session.liveRatio);
          }
        }
      },
    });
    const splitResizeRef = useRef(splitResize);
    splitResizeRef.current = splitResize;
    const { dragging: splitDragging, separatorProps: splitSeparatorProps } =
      splitResize;

    // Esc 取消标记：捕获期监听先于 hook 的结束回调置位，供兜底落盘判别
    useEffect(() => {
      if (!splitDragging) return;
      const onKeyDownCapture = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && splitSessionRef.current) {
          splitSessionRef.current.escCancel = true;
        }
      };
      window.addEventListener('keydown', onKeyDownCapture, {
        capture: true,
      });
      return () => {
        window.removeEventListener('keydown', onKeyDownCapture, {
          capture: true,
        });
      };
    }, [splitDragging]);

    // 键盘微调：比例域步进 ±2%（Shift ±10%），Home / End 到界，立即提交并
    // 落盘。hook 的 px 步进对比例域无意义，与 R3 同例在本组件覆写。
    const handleSplitKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        const step = e.shiftKey ? 10 : 2;
        let next: number | null = null;
        if (e.key === 'ArrowLeft') next = listWidthRatio - step;
        else if (e.key === 'ArrowRight') next = listWidthRatio + step;
        else if (e.key === 'Home') next = FILES_LIST_RATIO_MIN;
        else if (e.key === 'End') next = FILES_LIST_RATIO_MAX;
        if (next === null) return;
        e.preventDefault();
        const ratio = clampFilesListRatio(next);
        setListWidthRatio(ratio);
        persistListRatio(ratio);
      },
      [listWidthRatio, persistListRatio]
    );

    const handleOpenFile = useCallback(
      async (path: string) => {
        if (!(await nav.confirmNavigation())) return;
        const resolved = resolveReadableFilePath(path);
        const wsPath = resolveWorkspacePath(path);
        if (wsPath) {
          try {
            await nav.revealPath(wsPath);
          } catch {
            /* 外部路径或定位失败时不阻断预览 */
          }
        }
        await preview.openFile(resolved || path);
      },
      [nav, preview]
    );

    const handleRefresh = useCallback(async () => {
      if (!(await nav.confirmNavigation())) return;
      preview.resetPreview();
      preview.setView('browse');
      preview.setSelected(null);
      preview.clearActionHint();
      await nav.refresh();
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

    // 纠偏 L180-L186：文件夹双击严格收敛为 toggleExpand，绝不下钻刷新
    const handleFileDoubleClick = useCallback(
      (path: string, isDir: boolean) => {
        if (isDir) void nav.toggleExpand(path);
        else void handleOpenFile(path);
      },
      [nav, handleOpenFile]
    );

    // 文件树右键菜单：按命中节点 path 定向复制（不依赖当前选择态）
    const handleCopyPathFor = useCallback(
      (path: string, mode: 'abs' | 'rel') => {
        preview.copyPath(path, nav.root, mode);
        showToast(
          mode === 'abs'
            ? t('workspace.fileTree.pathCopiedAbs')
            : t('workspace.fileTree.pathCopiedRel')
        );
      },
      [preview, nav.root, showToast]
    );

    // 纠偏 L190：使用 nav.root，彻底消除 nav.cwd 死锁
    const handleCopyPath = useCallback(
      (mode: 'abs' | 'rel') => {
        handleCopyPathFor(preview.selected || nav.root, mode);
      },
      [handleCopyPathFor, preview.selected, nav.root]
    );

    const handleNavigate = useCallback(
      async (path: string) => {
        if (!(await nav.confirmNavigation())) return;
        preview.resetPreview();
        preview.clearActionHint();
        nav.setError('');
        void nav.revealPath(path);
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

    // 纠偏 L227：切除 nav.setCwd，仅执行状态重置与刷新
    useEffect(() => {
      const onProject = () => {
        preview.setView('browse');
        preview.setSelected(null);
        void nav.refresh();
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
        const detail = (
          ev as CustomEvent<{
            path?: string;
            sessionId?: string;
            leafId?: string;
          }>
        ).detail;
        if (!detail?.path) return;
        if (
          !shouldConsumeScopedEvent(detail, {
            sessionId: scopedSessionId,
            leafId: effectiveLeafId,
            isActive: scope.inLeafScope ? scope.isActive : undefined,
          })
        ) {
          return;
        }
        takePendingOpenPath();
        const resolved = resolveReadableFilePath(detail.path);
        void handleOpenFile(resolved || detail.path);
      };
      window.addEventListener('crish-open-file', onOpen);
      return () => window.removeEventListener('crish-open-file', onOpen);
    }, [handleOpenFile, scopedSessionId, effectiveLeafId, scope]);

    useEffect(() => {
      preview.setPendingCount(countPendingFileAnnotations(scopedSessionId));
    }, [preview, scopedSessionId]);

    useEffect(() => {
      const onAnn = () =>
        preview.setPendingCount(countPendingFileAnnotations(scopedSessionId));
      window.addEventListener('crish-file-annotations-changed', onAnn);
      return () =>
        window.removeEventListener('crish-file-annotations-changed', onAnn);
    }, [preview, scopedSessionId]);

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
        <div
          className={`${styles.filesCard} chat-side-panel`}
          data-file-preview-host="files"
        >
          <div
            className={`${styles.filesBar} side-panel-toolbar`}
            role="toolbar"
            aria-label="文件导航"
          >
            <Tooltip content={REFRESH_LABEL}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.filesNavBtn}
                aria-label={REFRESH_LABEL}
                onClick={handleRefreshBtn}
                icon={<AppIcon name="rotate-cw" size={14} />}
              />
            </Tooltip>

            {!noRoot ? (
              <FileBreadcrumb
                root={nav.root}
                selected={preview.selected}
                view={preview.view}
                dirty={preview.dirty}
                onNavigate={handleNavigate}
                onOpenFile={handleOpenFile}
              />
            ) : null}

            {preview.view === 'browse' && (nav.filterMode || nav.filter) ? (
              <Input
                bare
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
                      <AppIcon name="x" size={14} />
                    ) : (
                      <AppIcon name="search" size={14} />
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
                root={nav.root}
                view={preview.view}
                canEdit={preview.canEdit}
                isMd={preview.isMd}
                mdMode={preview.mdMode}
                editing={preview.editing}
                dirty={preview.dirty}
                openDefaultLabel={preview.openDefaultLabel}
                fileOpeners={preview.fileOpeners}
                isJson={preview.isJson}
                isFormatted={preview.isFormatted}
                onToggleFormatJson={() => void preview.toggleFormatJson()}
                wordWrap={preview.wordWrap}
                onToggleWordWrap={() => preview.toggleWordWrap()}
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
                  icon={<AppIcon name="x" size={12} />}
                />
              </Tooltip>
            </div>
          ) : null}

          {noRoot ? (
            <div className={`${styles.filesEmpty} ${styles.filesEmptyCompact}`}>
              <div className={styles.filesEmptyTitle}>未选择项目</div>
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
              {/* 彻底切除 cwd 传参（原 L468） */}
              <FileTreeView
                root={nav.root}
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
                fileOpeners={preview.fileOpeners}
                onCopyPath={handleCopyPathFor}
              />
              <div
                {...splitSeparatorProps}
                className={`${styles.filesSplitResizer} ${splitDragging ? styles.isResizing : ''}`}
                aria-label="调整目录树与预览宽度"
                aria-valuemin={FILES_LIST_RATIO_MIN}
                aria-valuemax={FILES_LIST_RATIO_MAX}
                aria-valuenow={Math.round(listWidthRatio)}
                onKeyDown={handleSplitKeyDown}
              >
                <ElasticSplitHandle
                  orientation="vertical"
                  isDragging={splitDragging}
                />
              </div>
              <FilePreview
                targetSessionId={scopedSessionId}
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
                  wordWrap: preview.wordWrap,
                  formattedContent: preview.formattedContent,
                  isFormatted: preview.isFormatted,
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
