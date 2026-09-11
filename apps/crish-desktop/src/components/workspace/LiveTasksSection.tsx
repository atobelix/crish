/**
 * RuntimePanel 活动任务区段：跨 sessions+activeRuns 合并后的进行中任务列表。
 * 点击 / Enter / Space 聚焦对应会话（无会话行不可点）。
 */
import React from 'react';

import { Tooltip } from '../ui';
import styles from './RuntimePanel.module.css';
import type { LiveTask } from './useRuntimePanelData';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import {
  emptyLiveTasksHint,
  formatElapsed,
  liveTaskAriaLabel,
} from './runtimePanelLib';
import { AppIcon } from '../ui/icons/index';

export type LiveTasksSectionProps = {
  liveTasks: LiveTask[];
  countLabel: string | null;
  onFocusSession: (sessionId: string) => void;
};

export const LiveTasksSection: React.FC<LiveTasksSectionProps> = ({
  liveTasks,
  countLabel,
  onFocusSession,
}) => {
  // D2（C-10）：连接态投影（errorStore 真源），不再由 RuntimePanel props 下传
  const connectionStatus = useConnectionStatus();
  return (
    <section className={styles.section} aria-labelledby="rt-sec-live">
      <div className={styles.sectionHead}>
        <h4 id="rt-sec-live" className={styles.sectionTitle}>
          活动任务
        </h4>
        {countLabel ? (
          <span className={styles.rowMeta} aria-live="polite" aria-label={`${countLabel} 个进行中`}>
            {countLabel}
          </span>
        ) : null}
      </div>
      {liveTasks.length === 0 ? (
        <div className={styles.empty} role="status">
          {emptyLiveTasksHint(connectionStatus)}
        </div>
      ) : (
        <div
          className={`${styles.list} ${liveTasks.length > 4 ? styles.listScroll : ''}`}
          role="list"
          aria-label="进行中的任务"
        >
          {liveTasks.map((wk) => {
            const elapsedText = formatElapsed(wk.elapsedSeconds);
            const clickable = Boolean(wk.sessionId);
            const rowNode = (
              <div
                key={wk.id}
                className={`${styles.row} ${styles.isLive}${clickable ? ` ${styles.isClickable}` : ''}`}
                role={clickable ? 'button' : 'listitem'}
                tabIndex={clickable ? 0 : undefined}
                aria-label={liveTaskAriaLabel({
                  taskName: wk.taskName,
                  elapsedSeconds: wk.elapsedSeconds,
                  hasSession: clickable,
                })}
                onClick={() => {
                  if (wk.sessionId) onFocusSession(wk.sessionId);
                }}
                onKeyDown={(e) => {
                  if (!wk.sessionId) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onFocusSession(wk.sessionId);
                  }
                }}
              >
                <div className={styles.rowMain}>
                  <div className={`loading-spinner ${styles.spinner}`} aria-hidden />
                  <div className={styles.rowText}>
                    <span className={styles.rowTitle}>{wk.taskName}</span>
                    <span className={styles.rowMeta}>已运行 {elapsedText}</span>
                  </div>
                </div>
                {clickable ? (
                  <AppIcon name="chevron-right" size={16} className={styles.rowChevron} aria-hidden />
                ) : null}
              </div>
            );
            return clickable ? (
              <Tooltip key={wk.id} content="打开对应会话">
                {rowNode}
              </Tooltip>
            ) : (
              rowNode
            );
          })}
        </div>
      )}
    </section>
  );
};
