/**
 * 最近运行历史列表（RunHistoryList）。
 *
 * 彻底解决「点击无反应」与「小按钮置灰锁死」问题：
 * 1. 行级全域可点（点击整行卡片即呼出完整的 RunDetailDialog 诊断弹窗）；
 * 2. 状态色阶显式区分（已完成绿 / 失败红 / 运行中蓝 / 取消灰）；
 * 3. 性能耗时与触发源清晰标示；
 * 4. 辅助动作独立隔离（stopPropagation 防冒泡）；按钮恒不置灰锁死，缺失 session 时平滑兜底。
 */

import React, { useState } from 'react';
import styles from './RunHistoryList.module.css';
import {
  workflowRunStatusLabel,
  type WorkflowDefinition,
  type WorkflowRunEntry,
} from '../../api/workflowApi';
import { Button, Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { RunDetailDialog } from './RunDetailDialog';

export type RunHistoryEntryItem = WorkflowRunEntry & {
  /** 扩展输出内容（用于悬停查看完整输出详情） */
  output?: string;
};

export type RunHistoryListProps = {
  runs: RunHistoryEntryItem[];
  workflows: WorkflowDefinition[];
  /** 打开运行会话（无关联会话时由壳层自动创建或导航） */
  onOpenRun?: (run: WorkflowRunEntry) => void;
  /** 重新运行任务 */
  onRerun?: (workflow: WorkflowDefinition) => void;
  /** 样式形态：'chat'（对话紧凑面板）| 'settings'（设置页列表） */
  variant?: 'chat' | 'settings';
  /** 显示数量限制 */
  limit?: number;
  /** 自定义表头标题（默认为“最近运行记录”） */
  title?: React.ReactNode;
  /** 是否隐藏表头 */
  hideHeading?: boolean;
};

function formatRunWhen(when?: string): { formatted: string; full: string } {
  if (!when) return { formatted: '—', full: '无时间戳' };
  const ms = Date.parse(when);
  if (!Number.isFinite(ms)) return { formatted: when, full: when };
  const d = new Date(ms);
  const formatted = d.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return { formatted, full: d.toISOString() };
}

function formatDurationMini(ms?: number): string | null {
  if (ms === undefined || ms === null) return null;
  if (ms < 100) return '<0.1s';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

export const RunHistoryList: React.FC<RunHistoryListProps> = ({
  runs,
  workflows,
  onOpenRun,
  onRerun,
  variant = 'chat',
  limit,
  title,
  hideHeading = false,
}) => {
  const [selectedRun, setSelectedRun] = useState<WorkflowRunEntry | null>(null);

  const displayLimit = limit ?? (variant === 'settings' ? 30 : 10);
  const displayRuns = runs.slice(0, displayLimit);

  if (displayRuns.length === 0) {
    if (variant === 'settings') {
      return <div className={styles.emptyRuns}>暂无历史运行记录</div>;
    }
    return null;
  }

  const selectedWorkflow = selectedRun
    ? workflows.find((w) => w.id === selectedRun.workflowId)
    : undefined;

  return (
    <div
      className={`${styles.runsContainer} ${
        variant === 'settings' ? styles.runsContainerSettings : ''
      }`}
    >
      {!hideHeading && (
        <div className={styles.runsHeading} id="sched-runs-heading">
          <span>{title ?? '最近运行记录'}</span>
          <span className={styles.runsHeadingCount}>
            共 {runs.length} 次运行
          </span>
        </div>
      )}

      <ul
        className={styles.runsList}
        aria-labelledby={!hideHeading ? 'sched-runs-heading' : undefined}
        role="list"
      >
        {displayRuns.map((r) => {
          const wf = workflows.find((w) => w.id === r.workflowId);
          const wfName = wf?.name || r.workflowId;
          const whenInfo = formatRunWhen(r.startedAt || r.scheduledFor);
          const durationStr = formatDurationMini(r.durationMs);
          const statusNorm = (r.status || '').trim().toLowerCase();

          const isSuccess =
            statusNorm === 'completed' ||
            statusNorm === 'success' ||
            statusNorm === 'ok';
          const isInterrupted = statusNorm === 'interrupted';
          const isFailed =
            statusNorm === 'failed' ||
            statusNorm === 'error' ||
            statusNorm === 'errored';
          const isRunning =
            !isInterrupted &&
            (statusNorm === 'running' ||
              statusNorm === 'in_progress' ||
              statusNorm === 'pending');

          const badgeClass = isSuccess
            ? styles.badgeSuccess
            : isInterrupted
              ? styles.badgeInterrupted
              : isFailed
                ? styles.badgeFailed
                : isRunning
                  ? styles.badgeRunning
                  : styles.badgeCancelled;

          const detailTooltipContent = r.error || r.output;

          const handleRowClick = () => {
            setSelectedRun(r);
          };

          const handleKeyDown = (e: React.KeyboardEvent) => {
            if (
              !e.nativeEvent.isComposing &&
              (e.key === 'Enter' || e.key === ' ')
            ) {
              e.preventDefault();
              setSelectedRun(r);
            }
          };

          return (
            <li
              key={`${r.workflowId}-${r.runId}-${r.startedAt || ''}`}
              className={styles.runItem}
              onClick={handleRowClick}
              onKeyDown={handleKeyDown}
              role="button"
              tabIndex={0}
              data-testid={`run-item-${r.runId}`}
              aria-label={`查看 ${wfName} 运行详情`}
            >
              <div className={styles.runItemMain}>
                <div className={styles.runItemTitleRow}>
                  <Tooltip content={wfName}>
                    <span className={styles.runItemName}>{wfName}</span>
                  </Tooltip>
                  <span
                    className={`${styles.runBadge} ${badgeClass}`}
                    data-status={statusNorm || 'unknown'}
                  >
                    {workflowRunStatusLabel(r.status)}
                  </span>
                </div>

                <div className={styles.runItemMeta}>
                  <Tooltip content={whenInfo.full}>
                    <span className={styles.metaChip}>
                      {whenInfo.formatted}
                    </span>
                  </Tooltip>

                  {durationStr ? (
                    <>
                      <span>·</span>
                      <Tooltip content="执行耗时">
                        <span className={styles.metaChip}>{durationStr}</span>
                      </Tooltip>
                    </>
                  ) : null}

                  {r.triggerKind ? (
                    <>
                      <span>·</span>
                      <span className={styles.metaChip}>
                        {r.triggerKind === 'manual'
                          ? '手动'
                          : r.triggerKind === 'cron'
                            ? '计划'
                            : '定时'}
                      </span>
                    </>
                  ) : null}

                  {detailTooltipContent ? (
                    <>
                      <span>·</span>
                      <Tooltip content={detailTooltipContent}>
                        <span className={styles.errorSnippet}>
                          {detailTooltipContent}
                        </span>
                      </Tooltip>
                    </>
                  ) : null}
                </div>
              </div>

              <div
                className={styles.runItemActions}
                onClick={(e) => e.stopPropagation()}
              >
                <Tooltip content="查看运行详情与诊断">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.actionBtn}
                    aria-label={`查看 ${wfName} 运行详情`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedRun(r);
                    }}
                    icon={<AppIcon name="info" size={15} aria-hidden />}
                  />
                </Tooltip>

                {onOpenRun ? (
                  <Tooltip
                    content={r.sessionId ? '打开关联会话' : '前往专属定时会话'}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={styles.actionBtn}
                      aria-label={`打开 ${wfName} 会话`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenRun(r);
                      }}
                      icon={
                        <AppIcon name="message-square" size={15} aria-hidden />
                      }
                    />
                  </Tooltip>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {/* 完整执行详情与诊断弹窗 */}
      <RunDetailDialog
        open={Boolean(selectedRun)}
        onClose={() => setSelectedRun(null)}
        run={selectedRun}
        workflow={selectedWorkflow}
        onNavigateToSession={onOpenRun}
        onRerun={onRerun}
      />
    </div>
  );
};
