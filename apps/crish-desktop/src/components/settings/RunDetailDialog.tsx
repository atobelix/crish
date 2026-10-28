/**
 * 定时任务 / 工作流运行详情弹窗（RunDetailDialog）。
 *
 * 提供立体的执行诊断面：
 * - 头部：任务名、运行状态徽标、触发模式徽标
 * - 指标网格：触发时刻、完成时刻、执行耗时、Run ID、关联会话
 * - 任务提示词卡片（带复制）
 * - 运行输出摘要 / 错误堆栈排查代码框（带复制）
 * - 操作底栏：前往会话、重新运行、复制运行简报
 */

import React, { useState } from 'react';
import styles from './RunDetailDialog.module.css';
import {
  workflowRunStatusLabel,
  type WorkflowDefinition,
  type WorkflowRunEntry,
} from '../../api/workflowApi';
import { Button, Dialog, Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';

export type RunDetailDialogProps = {
  open: boolean;
  onClose: () => void;
  run: WorkflowRunEntry | null;
  workflow?: WorkflowDefinition | undefined;
  /** 前往会话（打开并激活目标会话） */
  onNavigateToSession?: (run: WorkflowRunEntry) => void;
  /** 重新运行（再次触发该任务） */
  onRerun?: (workflow: WorkflowDefinition) => void;
};

function formatIso(isoString?: string): { formatted: string; full: string } {
  if (!isoString) return { formatted: '—', full: '无时间戳记录' };
  const ms = Date.parse(isoString);
  if (!Number.isFinite(ms)) return { formatted: isoString, full: isoString };
  const d = new Date(ms);
  const formatted = d.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return { formatted, full: d.toISOString() };
}

function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return '—';
  if (ms < 100) return '< 0.1s';
  if (ms < 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const remSecs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${remSecs}s`;
}

function triggerKindLabel(kind?: string): string {
  const k = (kind || '').toLowerCase();
  if (k === 'manual') return '手动触发';
  if (k === 'timer') return '单次定时器';
  if (k === 'cron') return '计划调度';
  return kind || '自动触发';
}

export const RunDetailDialog: React.FC<RunDetailDialogProps> = ({
  open,
  onClose,
  run,
  workflow,
  onNavigateToSession,
  onRerun,
}) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  if (!run) return null;

  const wfName = workflow?.name || run.workflowId;
  const started = formatIso(run.startedAt || run.scheduledFor);
  const finished = formatIso(run.finishedAt);
  const durationText = formatDuration(run.durationMs);
  const statusLabel = workflowRunStatusLabel(run.status);
  const promptText = run.prompt || workflow?.prompt || '（无提示词记录）';

  const statusNorm = (run.status || '').trim().toLowerCase();
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

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // 容错兜底
    }
  };

  const handleCopyReport = () => {
    const report = [
      `【定时任务运行报告】`,
      `任务名称: ${wfName}`,
      `工作流 ID: ${run.workflowId}`,
      `运行 ID: ${run.runId}`,
      `关联会话: ${run.sessionId || '（无）'}`,
      `触发类型: ${triggerKindLabel(run.triggerKind)}`,
      `运行状态: ${statusLabel}`,
      `触发时刻: ${started.full}`,
      `完成时刻: ${finished.full}`,
      `执行耗时: ${durationText}`,
      `执行提示词:\n${promptText}`,
      run.error ? `错误信息:\n${run.error}` : '',
      run.outputSummary ? `输出摘要:\n${run.outputSummary}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    void copyToClipboard(report, 'report');
  };

  const headerNode = (
    <div className={styles.headerTitle}>
      <Tooltip content={wfName}>
        <span className={styles.taskName}>{wfName}</span>
      </Tooltip>
      <span className={`${styles.badge} ${badgeClass}`}>{statusLabel}</span>
      <span className={`${styles.badge} ${styles.badgeTrigger}`}>
        {triggerKindLabel(run.triggerKind)}
      </span>
    </div>
  );

  const footerNode = (
    <div className={styles.footerActions}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleCopyReport}
        icon={
          <AppIcon
            name={copiedKey === 'report' ? 'check' : 'copy'}
            size={14}
            aria-hidden
          />
        }
      >
        {copiedKey === 'report' ? '已复制简报' : '复制运行简报'}
      </Button>

      {workflow && onRerun ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            onRerun(workflow);
            onClose();
          }}
          icon={<AppIcon name="refresh" size={14} aria-hidden />}
        >
          重新运行
        </Button>
      ) : null}

      {onNavigateToSession ? (
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => {
            onNavigateToSession(run);
            onClose();
          }}
          icon={<AppIcon name="message-square" size={14} aria-hidden />}
        >
          前往会话
        </Button>
      ) : (
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          关闭
        </Button>
      )}
    </div>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={headerNode}
      footer={footerNode}
      classNames={{ panel: styles.dialogPanel }}
    >
      <div className={styles.contentWrapper}>
        {/* 指标卡片网格 */}
        <div className={styles.metricsGrid}>
          <div className={styles.metricCell}>
            <span className={styles.metricLabel}>触发时刻</span>
            <Tooltip content={started.full}>
              <span className={styles.metricValue}>{started.formatted}</span>
            </Tooltip>
          </div>

          <div className={styles.metricCell}>
            <span className={styles.metricLabel}>完成时刻</span>
            <Tooltip content={finished.full}>
              <span className={styles.metricValue}>{finished.formatted}</span>
            </Tooltip>
          </div>

          <div className={styles.metricCell}>
            <span className={styles.metricLabel}>执行总耗时</span>
            <span className={styles.metricValue}>{durationText}</span>
          </div>

          <div className={styles.metricCell}>
            <span className={styles.metricLabel}>关联会话</span>
            <div className={styles.metricValue}>
              {run.sessionId ? (
                <>
                  <code className={styles.idCode}>{run.sessionId}</code>
                  <Tooltip content="复制会话 ID">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        copyToClipboard(run.sessionId || '', 'sessionId')
                      }
                      icon={
                        <AppIcon
                          name={copiedKey === 'sessionId' ? 'check' : 'copy'}
                          size={12}
                          aria-hidden
                        />
                      }
                    />
                  </Tooltip>
                </>
              ) : (
                <span style={{ color: 'var(--text-tertiary)' }}>
                  未绑定会话
                </span>
              )}
            </div>
          </div>
        </div>

        {/* 任务指令卡片 */}
        <div className={styles.cardSection}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>
              <AppIcon name="file-text" size={14} aria-hidden />
              任务提示词与指令
            </span>
            <Tooltip content="复制提示词">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => copyToClipboard(promptText, 'prompt')}
                icon={
                  <AppIcon
                    name={copiedKey === 'prompt' ? 'check' : 'copy'}
                    size={13}
                    aria-hidden
                  />
                }
              >
                {copiedKey === 'prompt' ? '已复制' : '复制'}
              </Button>
            </Tooltip>
          </div>
          <pre className={styles.promptBody}>{promptText}</pre>
        </div>

        {/* 诊断输出 / 错误信息卡片 */}
        {run.error ? (
          <div className={`${styles.cardSection} ${styles.errorCard}`}>
            <div className={styles.sectionHeader}>
              <span className={`${styles.sectionTitle} ${styles.errorTitle}`}>
                <AppIcon name="alert-triangle" size={14} aria-hidden />
                执行错误与异常堆栈 (Technical Error)
              </span>
              <Tooltip content="复制错误堆栈">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => copyToClipboard(run.error || '', 'error')}
                  icon={
                    <AppIcon
                      name={copiedKey === 'error' ? 'check' : 'copy'}
                      size={13}
                      aria-hidden
                    />
                  }
                >
                  {copiedKey === 'error' ? '已复制' : '复制错误'}
                </Button>
              </Tooltip>
            </div>
            <pre className={styles.errorCodeBlock}>{run.error}</pre>
          </div>
        ) : run.outputSummary ? (
          <div className={styles.cardSection}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>
                <AppIcon name="check-circle" size={14} aria-hidden />
                运行结果摘要 (Output Summary)
              </span>
              <Tooltip content="复制输出摘要">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    copyToClipboard(run.outputSummary || '', 'summary')
                  }
                  icon={
                    <AppIcon
                      name={copiedKey === 'summary' ? 'check' : 'copy'}
                      size={13}
                      aria-hidden
                    />
                  }
                >
                  {copiedKey === 'summary' ? '已复制' : '复制'}
                </Button>
              </Tooltip>
            </div>
            <pre className={styles.outputBody}>{run.outputSummary}</pre>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
};
