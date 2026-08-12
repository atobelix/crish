import React, { useRef } from 'react';
import { useLayoutStore } from '../../api/store-access/componentAccess';
import type { LayoutStore, WorkspaceState } from '../../store/types';
import styles from './Workspace.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { Button, Tooltip } from '../ui';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import { useResponsiveLayout } from '../../hooks/useResponsiveLayout';
import { Columns, X } from 'lucide-react';
import { WorkspaceCanvas } from './WorkspaceCanvas';
import { WorkspaceProductEmptyHost } from './workspaceProductMirrorDetect';
import {
  computeRenderedColumns,
  isEmptyWorkspace,
  resolveDropLiveMessage,
  workspaceOrdinalLabel,
} from './workspaceLayoutLib';

interface WorkspaceProps {
  wsId: string;
  onShowToast: ShowToastFn;
}

// re-export：WorkspaceCanvas 等消费方经壳层取渲染类型
export type { RenderedColumn } from './workspaceLayoutLib';

/**
 * 工作区壳组件：容器 + 拆分 chrome + 读屏 live region + 画布/空态编排。
 * 列/组渲染派生（拖拽折叠、占位拼接）见 workspaceLayoutLib；
 * 画布与分割器见 WorkspaceCanvas / WorkspaceResizer。
 *
 * CONN-E2′：空态走 WorkspaceProductEmptyHost（默传 detect 策略 + 产品 mirrorIpc）。
 * EmptyState 组件默认仍关。≠ EL-03 / ≠ inotify / ≠ 重做 E3。
 */
export const Workspace: React.FC<WorkspaceProps> = React.memo(
  ({ wsId, onShowToast }) => {
    const resizeColumns = useLayoutStore((s) => s.resizeColumns);
    const resizeGroups = useLayoutStore((s) => s.resizeGroups);
    const closeWorkspace = useLayoutStore((s) => s.closeWorkspace);
    const activeWorkspaceIndex = useLayoutStore((s) => s.activeWorkspaceIndex);
    const draggedTab = useLayoutStore((s) => s.draggedTab);
    const dropPreview = useLayoutStore((s) => s.dropPreview);
    const containerRef = useRef<HTMLDivElement>(null);
    const liveRegionRef = useRef<HTMLDivElement>(null);

    const wsSelector = React.useMemo(
      () => (s: LayoutStore) =>
        s.workspaces.find((w: WorkspaceState) => w.id === wsId),
      [wsId]
    );
    const ws = useLayoutStore(wsSelector);

    const wsIndexSelector = React.useMemo(
      () => (s: LayoutStore) =>
        s.workspaces.findIndex((w: WorkspaceState) => w.id === wsId),
      [wsId]
    );
    const wsIndex = useLayoutStore(wsIndexSelector);

    const isSplitMode = useLayoutStore((s) => s.workspaces.length > 1);

    const { isNarrow } = useResponsiveLayout();

    /** 点击 / 聚焦本区时切到活动工作区（多拆分时 panel focus） */
    const focusThisWorkspace = React.useCallback(() => {
      if (wsIndex < 0) return;
      const cur = useLayoutStore.getState().activeWorkspaceIndex;
      if (cur === wsIndex) return;
      // T-E 步骤 4（C3）：raw setState → setActiveWorkspaceIndex action（clamp 内建）
      useLayoutStore.getState().setActiveWorkspaceIndex(wsIndex);
    }, [wsIndex]);

    const renderedColumns = React.useMemo(
      () => computeRenderedColumns(ws, draggedTab, dropPreview),
      [ws, draggedTab, dropPreview]
    );

    /** 拖标签时的读屏播报（与占位中文同步） */
    const dropLiveMessage = React.useMemo(
      () => resolveDropLiveMessage(ws, draggedTab, dropPreview),
      [draggedTab, dropPreview, ws]
    );

    if (!ws) return null;

    const isActiveWorkspace =
      wsIndex >= 0 ? wsIndex === activeWorkspaceIndex : false;
    const ordinal = workspaceOrdinalLabel(ws.id);
    const regionLabel = isSplitMode
      ? `拆分工作区 ${ordinal}${isActiveWorkspace ? '（当前）' : ''}`
      : '主工作区';

    // Column / group sash: useColumnResize (pointer capture, iframe shield, rAF, commit-on-up)
    // Keyboard nudge / Home-End remain local; focus via onPointerDownCapture on section.

    const empty = isEmptyWorkspace(ws, renderedColumns);
    const colCountLabel = `${ws.columns.length} 列`;

    return (
      <div
        ref={containerRef}
        className={`${styles.section} workspace-section ${isNarrow ? styles.isNarrow : ''}`}
        role="region"
        aria-label={regionLabel}
        aria-current={isSplitMode && isActiveWorkspace ? 'true' : undefined}
        data-ws-id={ws.id}
        data-ws-active={isActiveWorkspace ? 'true' : 'false'}
        data-ws-empty={empty ? 'true' : 'false'}
        data-ws-split={isSplitMode ? 'true' : 'false'}
        data-ws-ordinal={ordinal}
        data-ws-narrow={isNarrow ? 'true' : 'false'}
        onPointerDownCapture={focusThisWorkspace}
        onFocusCapture={focusThisWorkspace}
      >
        {/* 读屏：标签拖放落点（与 CardPanel tablist 协同） */}
        <div
          ref={liveRegionRef}
          className={`${styles.live} workspace-dnd-live`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {dropLiveMessage}
        </div>

        {/* Workspace top close controls (for split views) */}
        {isSplitMode && (
          <div
            className={`${styles.splitChrome} workspace-split-chrome`}
            role="toolbar"
            aria-label={`拆分工作区 ${ordinal} 工具栏`}
          >
            <div className={styles.splitInfo}>
              <Columns size={12} strokeWidth={1.75} aria-hidden />
              <span className={styles.splitLabel}>
                拆分工作区 {ordinal}
                <span className={styles.splitSubLabel}>
                  · {colCountLabel}
                  {isActiveWorkspace ? ' · 当前焦点' : ''}
                </span>
              </span>
            </div>
            <Tooltip content={`关闭拆分工作区 ${ordinal}`}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="workspace-close-btn card-action-btn"
                onClick={() => closeWorkspace(ws.id)}
                aria-label={`关闭拆分工作区 ${ordinal}`}
                icon={<X size={14} strokeWidth={1.75} aria-hidden />}
              />
            </Tooltip>
          </div>
        )}

        {/* Main Column Grid — isolated so a panel crash doesn't blank the whole workspace chrome */}
        <AppErrorBoundary compact>
          {empty ? (
            /* CONN-E2′：产品宿主默装 detect；EmptyState 默认仍关 */
            <WorkspaceProductEmptyHost
              wsId={ws.id}
              onActivate={focusThisWorkspace}
            />
          ) : (
            <WorkspaceCanvas
              ws={ws}
              renderedColumns={renderedColumns}
              containerRef={containerRef}
              focusThisWorkspace={focusThisWorkspace}
              resizeColumns={resizeColumns}
              resizeGroups={resizeGroups}
              regionLabel={regionLabel}
              colCountLabel={colCountLabel}
              onShowToast={onShowToast}
            />
          )}

          {/* Drag Indicator drop overlay layer */}
          <div
            id={`drop-indicator-${ws.id}`}
            className="drop-indicator"
            aria-hidden="true"
            style={{ display: 'none' }}
          />
        </AppErrorBoundary>
      </div>
    );
  }
);
