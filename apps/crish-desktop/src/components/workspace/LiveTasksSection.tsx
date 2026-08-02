/**
 * RuntimePanel 活动任务区段：跨 sessions+activeRuns 合并后的进行中任务列表。
 * 点击 / Enter / Space 聚焦对应会话（无会话行不可点）。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './RuntimePanel.module.css';
import type { LiveTask } from './useRuntimePanelData';
import {
  emptyLiveTasksHint,
  formatElapsed,
  liveTaskAriaLabel,
} from './runtimePanelLib';

export type LiveTasksSectionProps = {
  liveTasks: LiveTask[];
  countLabel: string | null;
  engineOnline: boolean;
  onFocusSession: (sessionId: string) => void;
};

export const LiveTasksSection: React.FC<LiveTasksSectionProps> = ({
  liveTasks,
  countLabel,
  engineOnline,
  onFocusSession,
}) => {
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
          {emptyLiveTasksHint(engineOnline)}
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
            return (
              <div
                key={wk.id}
                className={`${styles.row} ${styles.isLive}${clickable ? ` ${styles.isClickable}` : ''}`}
                role={clickable ? 'button' : 'listitem'}
                tabIndex={clickable ? 0 : undefined}
                title={clickable ? '打开对应会话' : undefined}
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
                  <Lucide.ChevronRight size={16} className={styles.rowChevron} aria-hidden />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
