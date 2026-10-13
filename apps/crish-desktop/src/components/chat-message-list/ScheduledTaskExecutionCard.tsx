/**
 * 对话流结构化定时任务执行卡片（ScheduledTaskExecutionCard）。
 *
 * 在目标会话时间线中以结构化卡片呈现定时任务的触发与执行状态：
 * - 头部摘要栏（Header Bar）：时钟图标、`[定时执行] {workflowName}`、状态徽标、耗时、展开/折叠切换按钮；
 * - 可折叠详情面板（Collapsible Body）：触发时间、定时规则 `scheduleText`、执行提示词 `prompt`、执行结论摘要 `summary` 或错误信息 `error`；
 * - 默认展开策略：`running` / `failed` 默认展开，`completed` 默认折叠为单行摘要条，防止刷屏长对话。
 */

import React, { useEffect, useRef, useState } from 'react';
import styles from './ScheduledTaskExecutionCard.module.css';
import { workflowRunStatusLabel } from '../../api/workflowApi';
import { Button, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';

export type ScheduledTaskExecutionStatus =
  'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';

export interface ScheduledTaskExecutionCardProps {
  workflowId: string;
  workflowName: string;
  runId?: string;
  scheduleText?: string;
  status: ScheduledTaskExecutionStatus;
  triggeredAt?: string | number;
  durationMs?: number;
  prompt?: string;
  summary?: string;
  error?: string;
  /**
   * 默认展开态：
   * 未显式指定时，`status === 'running' || status === 'failed'` 自动展开，
   * `status === 'completed'` 等终态自动折叠为单行摘要条，防止刷屏长对话。
   */
  defaultExpanded?: boolean;
  onOpenDetail?: () => void;
}

export interface ExtractedScheduledTaskMeta {
  isScheduled: boolean;
  workflowName?: string;
  body: string;
}

/**
 * 识别并提取消息文本中的定时任务前缀或后缀标记。
 * 支持格式：
 * - `[定时任务: xxx] 正文` / `[定时任务：xxx]\n正文` / `[定时: xxx] 正文` / `[定时执行: xxx] 正文`
 * - `[定时] xxx\n正文` / `[定时任务] xxx\n正文` / `[定时任务执行] xxx\n\n正文` / `[定时执行] xxx\n正文`
 * - `正文（定时任务 cron-1 第 N 次触发）` / `正文（cron cron-1 第 N 次触发）`
 */
// eslint-disable-next-line react-refresh/only-export-components
export function extractScheduledTaskMetaFromPrompt(
  text: string
): ExtractedScheduledTaskMeta {
  const raw = typeof text === 'string' ? text : '';
  const trimmed = raw.trim();
  if (!trimmed) {
    return { isScheduled: false, body: raw };
  }

  // 1. 匹配形如 `[定时任务: xxx] body` 或 `[定时: xxx] body` 的括号内带冒号前缀
  const bracketColonMatch =
    /^\s*\[(?:定时任务(?:执行)?|定时执行|定时)\s*[:：]\s*([^\]\r\n]+)\]\s*([\s\S]*)$/.exec(
      raw
    );
  if (bracketColonMatch) {
    const workflowName = bracketColonMatch[1]?.trim();
    const restBody = bracketColonMatch[2]?.trim() ?? '';
    return {
      isScheduled: true,
      ...(workflowName ? { workflowName } : {}),
      body: restBody || workflowName || '',
    };
  }

  // 2. 匹配形如 `[定时] xxx` 或 `[定时任务执行] xxx\n\nbody` 的前缀标签
  const bracketTagMatch =
    /^\s*\[(?:定时任务(?:执行)?|定时执行|定时)\]\s*([\s\S]*)$/.exec(raw);
  if (bracketTagMatch) {
    const rest = (bracketTagMatch[1] ?? '').trim();
    if (!rest) {
      return { isScheduled: true, body: '' };
    }

    const newlineIdx = rest.search(/\r?\n/);
    if (newlineIdx !== -1) {
      const firstLine = rest.slice(0, newlineIdx).trim();
      const remaining = rest.slice(newlineIdx).trim();
      return {
        isScheduled: true,
        ...(firstLine ? { workflowName: firstLine } : {}),
        body: remaining || firstLine,
      };
    }

    const colonSplit = /^([^:：\r\n]{1,48})\s*[:：]\s*([\s\S]+)$/.exec(rest);
    if (colonSplit) {
      const namePart = colonSplit[1]?.trim();
      const bodyPart = colonSplit[2]?.trim() ?? '';
      return {
        isScheduled: true,
        ...(namePart ? { workflowName: namePart } : {}),
        body: bodyPart || namePart || '',
      };
    }

    return {
      isScheduled: true,
      workflowName: rest,
      body: rest,
    };
  }

  // 3. 匹配引擎 Steering 注入的后缀格式：`prompt（定时任务 cron-1 第 N 次触发）`
  const steeringSuffixMatch =
    /^([\s\S]+?)\s*[（(](?:定时任务|cron)\s+([^\s）)]+)\s+第\s*\d+\s*次触发[）)]\s*$/i.exec(
      raw
    );
  if (steeringSuffixMatch) {
    const bodyPart = steeringSuffixMatch[1]?.trim() ?? '';
    const wfName = steeringSuffixMatch[2]?.trim();
    return {
      isScheduled: true,
      ...(wfName ? { workflowName: wfName } : {}),
      body: bodyPart,
    };
  }

  return { isScheduled: false, body: raw };
}

function resolveDefaultExpanded(
  status: ScheduledTaskExecutionStatus,
  defaultExpanded?: boolean
): boolean {
  if (typeof defaultExpanded === 'boolean') return defaultExpanded;
  return status === 'running' || status === 'failed';
}

function formatDurationMs(durationMs?: number): string | null {
  if (
    durationMs === undefined ||
    durationMs === null ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return null;
  }
  if (durationMs < 100) return '<0.1s';
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatTriggeredAt(triggeredAt?: string | number): string | null {
  if (triggeredAt === undefined || triggeredAt === null || triggeredAt === '') {
    return null;
  }
  const timeOpts: Intl.DateTimeFormatOptions = {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  };
  if (typeof triggeredAt === 'number') {
    if (!Number.isFinite(triggeredAt) || triggeredAt <= 0) return null;
    return new Date(triggeredAt).toLocaleString('zh-CN', timeOpts);
  }
  const trimmed = triggeredAt.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleString('zh-CN', timeOpts)
    : trimmed;
}

function statusBadgeClassName(
  status: ScheduledTaskExecutionStatus
): string | undefined {
  switch (status) {
    case 'running':
      return styles.statusRunning;
    case 'completed':
      return styles.statusCompleted;
    case 'failed':
      return styles.statusFailed;
    case 'interrupted':
      return styles.statusInterrupted;
    case 'cancelled':
    default:
      return styles.statusCancelled;
  }
}

export const ScheduledTaskExecutionCard: React.FC<
  ScheduledTaskExecutionCardProps
> = ({
  workflowId,
  workflowName,
  runId,
  scheduleText,
  status,
  triggeredAt,
  durationMs,
  prompt,
  summary,
  error,
  defaultExpanded,
  onOpenDetail,
}) => {
  const [expanded, setExpanded] = useState<boolean>(() =>
    resolveDefaultExpanded(status, defaultExpanded)
  );
  const userToggledRef = useRef(false);

  useEffect(() => {
    if (typeof defaultExpanded === 'boolean') {
      setExpanded(defaultExpanded);
      return;
    }
    if (!userToggledRef.current) {
      setExpanded(status === 'running' || status === 'failed');
    }
  }, [status, defaultExpanded]);

  const handleToggleExpand = () => {
    userToggledRef.current = true;
    setExpanded((prev) => !prev);
  };

  const displayWorkflowName = workflowName.trim() || workflowId || '定时任务';
  const statusLabel = workflowRunStatusLabel(status);
  const durationLabel = formatDurationMs(durationMs);
  const triggeredAtLabel = formatTriggeredAt(triggeredAt);
  const collapsedSnippet = error?.trim() || summary?.trim() || prompt?.trim();
  const toggleTip = expanded ? '收起执行详情' : '展开执行详情';
  const badgeCls = [styles.statusBadge, statusBadgeClassName(status)]
    .filter(Boolean)
    .join(' ');
  const cardCls = [
    styles.card,
    status === 'running' ? styles.cardRunning : null,
    status === 'failed' ? styles.cardFailed : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section
      className={cardCls}
      data-testid="scheduled-task-execution-card"
      data-workflow-id={workflowId}
      data-run-id={runId}
      data-status={status}
      data-expanded={expanded ? 'true' : 'false'}
      aria-label={`定时执行任务 ${displayWorkflowName}`}
    >
      {/* 头部摘要栏（Header Bar） */}
      <div className={styles.headerBar}>
        <div className={styles.headerMain}>
          <span className={styles.clockIcon}>
            <AppIcon name="clock" size={14} aria-hidden />
          </span>
          <Tooltip content={`定时执行任务：${displayWorkflowName}`}>
            <span className={styles.titleText}>
              <span className={styles.prefixTag}>[定时执行]</span>
              {displayWorkflowName}
            </span>
          </Tooltip>
          <span
            className={badgeCls}
            data-testid="scheduled-card-status-badge"
            data-status={status}
          >
            {statusLabel}
          </span>
          {durationLabel ? (
            <Tooltip content={`执行耗时 ${durationLabel}`}>
              <span
                className={styles.durationBadge}
                data-testid="scheduled-card-duration"
              >
                {durationLabel}
              </span>
            </Tooltip>
          ) : null}
          {!expanded && collapsedSnippet ? (
            <span
              className={styles.collapsedPreview}
              data-testid="scheduled-card-collapsed-preview"
            >
              {collapsedSnippet}
            </span>
          ) : null}
        </div>

        <div className={styles.headerActions}>
          {onOpenDetail ? (
            <Tooltip content="查看运行诊断详情">
              <Button
                variant="ghost"
                size="xs"
                onClick={onOpenDetail}
                data-testid="scheduled-card-open-detail-btn"
              >
                详情
              </Button>
            </Tooltip>
          ) : null}
          <Tooltip content={toggleTip}>
            <Button
              variant="ghost"
              size="xs"
              onClick={handleToggleExpand}
              aria-expanded={expanded}
              aria-label={toggleTip}
              data-testid="scheduled-card-toggle-btn"
            >
              <AppIcon
                name={expanded ? 'chevron-up' : 'chevron-down'}
                size={14}
                aria-hidden
              />
              <span>{expanded ? '收起' : '展开'}</span>
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* 可折叠详情面板（Collapsible Body） */}
      {expanded ? (
        <div className={styles.body} data-testid="scheduled-card-body">
          {triggeredAtLabel || scheduleText || runId ? (
            <div className={styles.metaRow}>
              {triggeredAtLabel ? (
                <span
                  className={styles.metaItem}
                  data-testid="scheduled-card-triggered-at"
                >
                  <span className={styles.metaLabel}>触发时间：</span>
                  <span className={styles.metaValue}>{triggeredAtLabel}</span>
                </span>
              ) : null}
              {scheduleText ? (
                <span
                  className={styles.metaItem}
                  data-testid="scheduled-card-schedule-text"
                >
                  <span className={styles.metaLabel}>定时规则：</span>
                  <span className={styles.metaValue}>{scheduleText}</span>
                </span>
              ) : null}
              {runId ? (
                <span
                  className={styles.metaItem}
                  data-testid="scheduled-card-run-id"
                >
                  <span className={styles.metaLabel}>运行 ID：</span>
                  <span className={styles.metaValue}>{runId}</span>
                </span>
              ) : null}
            </div>
          ) : null}

          {prompt ? (
            <div className={styles.section}>
              <span className={styles.sectionLabel}>执行指令</span>
              <pre
                className={styles.sectionContent}
                data-testid="scheduled-card-prompt"
              >
                {prompt}
              </pre>
            </div>
          ) : null}

          {summary ? (
            <div className={styles.section}>
              <span className={styles.sectionLabel}>执行结论摘要</span>
              <div
                className={styles.sectionContent}
                data-testid="scheduled-card-summary"
              >
                {summary}
              </div>
            </div>
          ) : null}

          {error ? (
            <div className={styles.section}>
              <span className={styles.sectionLabel}>异常信息</span>
              <pre
                className={styles.errorBox}
                data-testid="scheduled-card-error"
              >
                {error}
              </pre>
            </div>
          ) : null}

          {status === 'running' && !summary && !error ? (
            <div
              className={styles.runningHint}
              data-testid="scheduled-card-running-hint"
            >
              <span>正在执行定时任务并等待 Agent 响应…</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};

ScheduledTaskExecutionCard.displayName = 'ScheduledTaskExecutionCard';
