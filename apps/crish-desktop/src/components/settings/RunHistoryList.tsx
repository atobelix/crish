/**
 * ScheduledTasksPanel 专属：最近运行历史列表（对话内紧凑）。
 * run 状态中文走 workflowRunStatusLabel；可打开关联会话。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './ScheduledTasksPanel.module.css';
import { workflowRunStatusLabel, type WorkflowDefinition, type WorkflowRunEntry } from '../../api/workflowApi';
import { Tooltip } from '../ui';

/** 最近运行条数上限（对话内紧凑） */
export const RECENT_RUNS_LIMIT = 10;

export type RunHistoryListProps = {
  runs: WorkflowRunEntry[];
  workflows: WorkflowDefinition[];
  /** 打开运行会话（无关联会话时由壳层 toast） */
  onOpenRun: (run: WorkflowRunEntry) => void;
};

function formatRunWhen(when: string): string {
  if (!when) return '—';
  const ms = Date.parse(when);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const RunHistoryList: React.FC<RunHistoryListProps> = ({
  runs,
  workflows,
  onOpenRun,
}) => {
  const recentRuns = runs.slice(0, RECENT_RUNS_LIMIT);
  if (recentRuns.length === 0) return null;

  return (
    <div className={styles.schedRuns}>
      <div className={styles.schedRunsH} id="sched-runs-heading">
        最近运行
      </div>
      <ul className={`${styles.schedList} ${styles.schedRunsList}`} aria-labelledby="sched-runs-heading">
        {recentRuns.map((r) => {
          const wfName =
            workflows.find((w) => w.id === r.workflowId)?.name || r.workflowId;
          const when = r.startedAt || r.scheduledFor || '';
          const whenLabel = formatRunWhen(when);
          const canOpen = Boolean(r.sessionId);
          return (
            <li
              key={`${r.workflowId}-${r.runId}`}
              className={`${styles.schedItem} ${styles.schedItemDense} ${styles.schedRunItem}`}
            >
              <div className={styles.schedItemMain}>
                <div className={styles.schedItemName}>{wfName}</div>
                <Tooltip content={r.error || ''} disabled={!r.error}>
                  <div className={styles.schedItemMeta}>
                    {workflowRunStatusLabel(r.status)} · {whenLabel}
                    {r.error ? ` · ${r.error.slice(0, 24)}` : ''}
                  </div>
                </Tooltip>
              </div>
              <div className={styles.schedItemActions}>
                <Tooltip content={canOpen ? '打开会话' : '无关联会话'}>
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    aria-label={
                      canOpen ? `打开 ${wfName} 的运行会话` : `${wfName} 无关联会话`
                    }
                    disabled={!canOpen}
                    onClick={() => onOpenRun(r)}
                  >
                    <Lucide.MessageSquare size={16} aria-hidden />
                  </button>
                </Tooltip>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
