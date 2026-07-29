/**
 * 右坞顶栏：仅工具 tabs（总览/文件/…）。
 * 折叠开关在对话 unit 的 ChatHeader；此处只渲染本 unit 所属 session 的工具 tabs。
 * 必须挂在 tool 列 leaf 内，并通过 ownerSessionId 绑定会话（多 unit 互不串坞）。
 *
 * Tab 支持 pointer 拖拽：
 * - 坞内重排 openPanelIds
 * - 拖到同 unit tool 边缘 → split（layoutTreeStore.commitDrop）
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import {
  useWorkspaceShellStore,
  openToolInSession,
  openToolInActiveTab,
} from '../../store/workspace-shell';
import { useToolDockTabDrag } from '../../hooks/useToolDockTabDrag';
import styles from './RightToolDockHeader.module.css';

const PANEL_LABELS: Record<string, string> = {
  overview: '总览',
  files: '文件',
  diff: '差异',
  terminal: '终端',
  preview: '预览',
  runtime: '运行时',
  agent: '协作体',
};

export interface RightToolDockHeaderProps {
  /** 该 tool leaf 所属会话；多 unit 时必须传入 */
  ownerSessionId?: string;
  /** 当前 header 所在 tool leaf id（拖拽源回退） */
  leafId?: string;
}

export const RightToolDockHeader: React.FC<RightToolDockHeaderProps> = React.memo(
  ({ ownerSessionId, leafId }) => {
    const tab = useWorkspaceShellStore((s) => {
      const sid = (ownerSessionId || '').trim();
      if (sid) {
        return s.openTabs.find((t) => t.sessionId === sid) ?? null;
      }
      const id = s.activeTabId;
      return s.openTabs.find((t) => t.tabId === id) ?? null;
    });
    const updateRightDock = useWorkspaceShellStore((s) => s.updateRightDock);

    const dock = tab?.rightDock;
    const openPanelIds = dock?.openPanelIds ?? [];

    const {
      isDragging,
      draggingPanelId,
      ghostLabel,
      setGhostRef,
      startTabDrag,
      consumeDidDrag,
    } = useToolDockTabDrag({
      leafId,
      ownerSessionId: tab?.sessionId || ownerSessionId,
      tabId: tab?.tabId ?? '',
      openPanelIds,
    });

    if (!tab || !dock) return null;
    if (dock.collapsed || dock.openPanelIds.length === 0) {
      return null;
    }

    const openPanel = (pid: string) => {
      if (consumeDidDrag()) return;
      if (tab.sessionId) openToolInSession(tab.sessionId, pid);
      else openToolInActiveTab(pid);
    };

    const ownerSid = tab.sessionId || ownerSessionId || '';

    return (
      <>
        <div
          className={styles.header}
          data-right-dock-header="true"
          data-owner-session={ownerSid || undefined}
          data-tab-strip-leaf-id={leafId || undefined}
          data-collapsed="false"
          data-dragging={isDragging ? 'true' : 'false'}
        >
          <div className={styles.tabs} role="tablist" aria-label="工具面板">
            {dock.openPanelIds.map((pid) => {
              const active = dock.activePanelId === pid;
              const isSource = draggingPanelId === pid;
              const label = PANEL_LABELS[pid] || pid;
              return (
                <button
                  key={pid}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-tool-dock-tab="true"
                  data-panel-id={pid}
                  data-owner-session={ownerSid || undefined}
                  className={`${styles.tab} ${active ? styles.tabActive : ''} ${
                    isSource ? styles.tabDragging : ''
                  }`}
                  onClick={() => openPanel(pid)}
                  onPointerDown={(e) => startTabDrag(pid, label, e)}
                >
                  <span className={styles.tabLabel}>{label}</span>
                  <span
                    className={styles.tabClose}
                    role="button"
                    tabIndex={0}
                    data-no-tab-drag="true"
                    aria-label={`关闭 ${label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = dock.openPanelIds.filter((x) => x !== pid);
                      const nextActive =
                        dock.activePanelId === pid
                          ? next[next.length - 1] || null
                          : dock.activePanelId;
                      updateRightDock(tab.tabId, {
                        openPanelIds: next,
                        activePanelId: nextActive,
                        collapsed: next.length === 0,
                      });
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        (e.currentTarget as HTMLElement).click();
                      }
                    }}
                  >
                    <X size={12} strokeWidth={2} aria-hidden />
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {isDragging && ghostLabel
          ? createPortal(
              <div
                ref={setGhostRef}
                className={styles.ghost}
                data-tool-dock-ghost="true"
                style={{
                  position: 'fixed',
                  left: 0,
                  top: 0,
                  transform: 'translate(-9999px, -9999px)',
                }}
                aria-hidden="true"
              >
                <span className={styles.ghostLabel}>{ghostLabel}</span>
              </div>,
              document.body
            )
          : null}
      </>
    );
  }
);

RightToolDockHeader.displayName = 'RightToolDockHeader';
