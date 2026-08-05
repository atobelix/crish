/**
 * 后台任务卡片（T-AB-20）：状态徽标 / 时长 / 命令摘要 / 日志尾部 /
 * 资源快照摘要（缺失容忍）/ prompt 等待输入高亮 / 疑似卡死标记 /
 * 异常状态（failed / killed）高亮 + 退出码展示，并装配操作面 BgTaskActions。
 *
 * 依赖注入：getOutput / onKill / onSendInput 均可由测试桩替换；
 * 缺省接线到 backgroundTasksApi 真实实现。
 */
import React, { useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './BgTaskCard.module.css';
import {
  backgroundTaskStateLabel,
  getBackgroundTaskOutput,
  killBackgroundTask,
  sendBackgroundTaskInput,
  type BackgroundTaskInfo,
  type KillBackgroundTaskResult,
  type SendBackgroundTaskInputResult,
} from '../../api/backgroundTasksApi';
import { BgTaskActions } from './BgTaskActions';
import {
  BGTASK_CARD_LOG_TAIL_LINES,
  SUSPICIOUS_TASK_TEXT,
  TASK_AWAITING_INPUT_TEXT,
  formatBgTaskDurationLabel,
  formatBgTaskExitCode,
  formatBgTaskResourceSummary,
  formatLogTailLines,
  isBgTaskAbnormalState,
  recommendPromptAnswer,
} from './bgTaskCardLib';

export type BgTaskCardProps = {
  /** 已解析任务（backgroundTasksApi.parseBackgroundTask 产物） */
  task: BackgroundTaskInfo;
  /** 当前时间注入（测试用）；缺省 Date.now() */
  now?: number;
  /** 疑似卡死标记（task-suspicious 事件驱动）；缺省取 task.suspicious */
  suspicious?: boolean;
  /** 打开中（防连点视觉降级，由父级区段传入） */
  opening?: boolean;
  /** 日志尾部读取实现（缺省接真实 API；读取失败回退摘要展示） */
  getOutput?: (taskId: string) => Promise<string>;
  /** 点击卡片主体：在终端中打开完整日志（由父级区段接线） */
  onOpenOutput?: (task: BackgroundTaskInfo) => void;
  /** kill 实现（缺省接真实 API） */
  onKill?: (taskId: string) => Promise<KillBackgroundTaskResult | null>;
  /** send_input 实现（缺省接真实 API） */
  onSendInput?: (
    taskId: string,
    text: string,
    appendNewline: boolean,
  ) => Promise<SendBackgroundTaskInputResult>;
  /** kill 成功后通知父组件（本地状态翻转 / 列表刷新） */
  onKillApplied?: (result: KillBackgroundTaskResult) => void;
};

const defaultGetOutput = (taskId: string) => getBackgroundTaskOutput(taskId);
const defaultKill = (taskId: string) => killBackgroundTask(taskId);
const defaultSendInput = (taskId: string, text: string, appendNewline: boolean) =>
  sendBackgroundTaskInput(taskId, text, appendNewline);

export const BgTaskCard: React.FC<BgTaskCardProps> = ({
  task,
  now,
  suspicious,
  opening = false,
  getOutput = defaultGetOutput,
  onOpenOutput,
  onKill = defaultKill,
  onSendInput = defaultSendInput,
  onKillApplied,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [logLines, setLogLines] = useState<string[] | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logFailed, setLogFailed] = useState(false);

  const isSuspicious = suspicious ?? task.suspicious ?? false;
  const abnormal = isBgTaskAbnormalState(task.state);
  const stateZh = backgroundTaskStateLabel(task.state);
  const exitCodeText = formatBgTaskExitCode(task.exitCode);
  const durationLabel = formatBgTaskDurationLabel(task, now);
  const prompt = (task.prompt || '').trim() || null;
  const recommendedInput = recommendPromptAnswer(prompt);
  const resourceText = formatBgTaskResourceSummary(task.resource);

  const loadLogTail = async () => {
    if (expanded && (logLines !== null || logLoading)) return;
    setExpanded(true);
    setLogLoading(true);
    setLogFailed(false);
    try {
      const out = await getOutput(task.id);
      setLogLines(formatLogTailLines(out));
    } catch {
      // 读取失败：回退展示 summary / command 摘要，不打断卡片
      const fallback = task.summary || task.command || null;
      setLogLines(formatLogTailLines(fallback));
      setLogFailed(true);
    } finally {
      setLogLoading(false);
    }
  };

  const toggleLogTail = () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    void loadLogTail();
  };

  const handleOpenOutput = () => {
    onOpenOutput?.(task);
  };

  const ariaParts = [task.label, stateZh];
  if (durationLabel) ariaParts.push(durationLabel);
  if (exitCodeText) ariaParts.push(exitCodeText);
  if (isSuspicious) ariaParts.push(SUSPICIOUS_TASK_TEXT);

  return (
    <div
      className={`${styles.card}${abnormal ? ` ${styles.isAbnormal}` : ''}${
        isSuspicious ? ` ${styles.isSuspicious}` : ''
      }${opening ? ` ${styles.isOpening}` : ''}`}
      role="listitem"
      aria-label={ariaParts.join('，')}
      aria-busy={opening || undefined}
      data-testid="bg-task-card"
    >
      <div className={styles.head}>
        <div
          className={styles.headMain}
          role="button"
          tabIndex={0}
          aria-label={`${task.label}，${stateZh}，在终端中查看输出`}
          onClick={handleOpenOutput}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleOpenOutput();
            }
          }}
        >
          <span
            className={`${styles.badge} ${
              task.state === 'running'
                ? styles.isRunning
                : task.state === 'succeeded'
                  ? styles.isSucceeded
                  : task.state === 'failed'
                    ? styles.isFailed
                    : task.state === 'killed'
                      ? styles.isKilled
                      : task.state === 'timed-out'
                        ? styles.isTimedOut
                        : task.state === 'queued'
                          ? styles.isQueued
                          : ''
            }`}
          >
            {stateZh}
          </span>
          <span className={styles.title}>{task.label}</span>
          {durationLabel ? (
            <span className={styles.duration}>{durationLabel}</span>
          ) : null}
        </div>
        <div className={styles.headMeta}>
          {isSuspicious && (
            <span className={styles.suspiciousMark}>
              <Lucide.AlertTriangle size={12} aria-hidden />
              {SUSPICIOUS_TASK_TEXT}
            </span>
          )}
          {exitCodeText && abnormal ? (
            <span className={styles.exitCode}>{exitCodeText}</span>
          ) : null}
        </div>
      </div>

      {task.command ? (
        <div className={styles.command} title={task.command}>
          {task.command}
        </div>
      ) : null}

      {prompt && (
        <div className={styles.promptBanner} data-testid="bg-task-prompt-banner">
          <span className={styles.promptLabel}>{TASK_AWAITING_INPUT_TEXT}</span>
          <span className={styles.promptText} title={prompt}>
            {prompt}
          </span>
        </div>
      )}

      <div className={styles.resource} data-testid="bg-task-resource">
        {resourceText}
      </div>

      {expanded && (
        <div className={styles.logTail}>
          {logLoading ? (
            <div className={styles.resource} role="status">
              加载日志尾部…
            </div>
          ) : (
            <pre className={styles.logTailPre} data-testid="bg-task-log-tail">
              {logLines?.join('\n') ?? ''}
            </pre>
          )}
          {logFailed ? (
            <div className={styles.resource} role="status">
              读取日志失败，已回退展示摘要
            </div>
          ) : null}
        </div>
      )}

      <button
        type="button"
        className={styles.expandToggle}
        onClick={toggleLogTail}
        aria-expanded={expanded}
        disabled={logLoading}
      >
        {expanded ? (
          <>
            <Lucide.ChevronUp size={12} aria-hidden />
            收起日志
          </>
        ) : (
          <>
            <Lucide.ChevronDown size={12} aria-hidden />
            日志尾部（{BGTASK_CARD_LOG_TAIL_LINES} 行）
          </>
        )}
      </button>

      <BgTaskActions
        task={task}
        recommendedInput={recommendedInput}
        onKill={onKill}
        onSendInput={onSendInput}
        onKillApplied={onKillApplied}
      />
    </div>
  );
};
