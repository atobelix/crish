/**
 * 定时任务共享表单：settings（sched-settings-form 全局类）与 chat
 * （ScheduledTasksPanel.module.css 模块类）双变体。
 * 草稿值/校验/保存动作由 useWorkflowsState 提供，本组件纯受控渲染。
 */
import React from 'react';
import {
  WORKFLOW_INTERVAL_MINUTES_MAX,
  WORKFLOW_INTERVAL_MINUTES_MIN,
  WORKFLOW_SCHEDULE_PRESETS,
  WORKFLOW_SCHEDULE_TYPES,
  cronExpressionLabel,
  validateCronExpression,
  type WorkflowScheduleDraft,
} from '../../api/workflowApi';
import { listProjects } from '../../api/projectStore';
import { useSessionStore } from '../../store/storeAccess';
import {
  Button,
  Input,
  SegmentedControl,
  Select,
  Textarea,
  Tooltip,
} from '../ui';
import styles from './ScheduledTasksPanel.module.css';
import scheduleStyles from './SettingsScheduleTab.module.css';

export type WorkflowExecutionTarget = 'isolated_session' | 'current_session';

export type ExtendedWorkflowScheduleDraft = Omit<
  WorkflowScheduleDraft,
  'scheduleType'
> & {
  scheduleType: WorkflowScheduleDraft['scheduleType'] | 'cron';
  cronExpression?: string;
  executionTarget?: WorkflowExecutionTarget;
  sessionMode?: WorkflowExecutionTarget;
  targetSessionId?: string;
};

/** 执行会话模式选项 */
export const EXECUTION_SESSION_MODE_OPTIONS = [
  {
    value: 'isolated_session' as const,
    label: '后台独立执行',
  },
  {
    value: 'current_session' as const,
    label: '绑定当前对话',
  },
];

function getActiveSessionIdSafe(propSessionId?: string): string {
  if (propSessionId) return propSessionId;
  try {
    return useSessionStore?.getState?.()?.activeSessionId ?? '';
  } catch {
    return '';
  }
}

/** 实时解析 5 段式 Cron 中文语义预览（简洁内联呈现） */
function resolveCronPreview(rawExpr?: string): {
  valid: boolean;
  message: string;
} {
  const expr = String(rawExpr ?? '').trim();
  if (!expr) {
    return {
      valid: false,
      message: '',
    };
  }
  const validation = validateCronExpression(expr);
  if (!validation.ok) {
    return { valid: false, message: validation.error || '格式不符' };
  }
  const norm = validation.expression;
  const baseLabel = cronExpressionLabel(norm);
  if (norm === '0 9 * * 1-5' && baseLabel === norm) {
    return { valid: true, message: '工作日 09:00' };
  }
  if (norm === '0 9,18 * * *' && baseLabel === norm) {
    return { valid: true, message: '每日 09:00 & 18:00' };
  }
  return { valid: true, message: baseLabel };
}

export type WorkflowFormProps = {
  variant: 'settings' | 'chat';
  /** 表单容器 id（aria-controls / 锚点） */
  formId: string;
  draft: WorkflowScheduleDraft;
  busy: boolean;
  isEditing: boolean;
  /** settings 面：工作区路径提示 */
  workspacePath?: string;
  /** 当前活动会话 ID（可选，缺省自动读取当前活跃会话） */
  activeSessionId?: string;
  onDraftChange: (d: WorkflowScheduleDraft) => void;
  onApplyPreset: (presetId: string) => void;
  /** 名称失焦：监听类关键词提示（maybeWatchHint） */
  onNameBlur: () => void;
  onSave: () => void;
  onClose: () => void;
};

// eslint-disable-next-line max-lines-per-function
export const WorkflowForm: React.FC<WorkflowFormProps> = ({
  variant,
  formId,
  draft,
  busy,
  isEditing,
  workspacePath,
  activeSessionId,
  onDraftChange,
  onApplyPreset,
  onNameBlur,
  onSave,
  onClose,
}) => {
  const settingsVariant = variant === 'settings';
  const extDraft = draft as ExtendedWorkflowScheduleDraft;
  const resolvedActiveSessionId = getActiveSessionIdSafe(activeSessionId);

  const updateDraft = (patch: Partial<ExtendedWorkflowScheduleDraft>) => {
    onDraftChange({
      ...draft,
      ...patch,
    } as WorkflowScheduleDraft);
  };

  // 关联项目下拉列表：首项固定提供全局工作区
  const projects = React.useMemo(() => listProjects(), []);
  const projectOptions = React.useMemo(
    () => [
      {
        id: '',
        label: '🌐 全局工作区',
        hint: '默认沙箱',
      },
      ...projects.map((p) => ({
        id: p.path,
        label: p.name,
        hint: p.path,
      })),
    ],
    [projects]
  );

  // 触发方式下拉选项：包含自定义 Cron
  const scheduleOptions = React.useMemo(() => {
    const opts = WORKFLOW_SCHEDULE_TYPES.map((t) => ({
      id: String(t.value),
      label: String(t.value) === 'cron' ? '自定义 Cron' : t.label,
      hint: t.hint,
    }));
    if (!opts.some((o) => o.id === 'cron')) {
      opts.push({
        id: 'cron',
        label: '自定义 Cron',
        hint: '标准 5 字段 cron（分 时 日 月 周）',
      });
    }
    return opts;
  }, []);

  const currentExecutionTarget: WorkflowExecutionTarget =
    extDraft.executionTarget ??
    extDraft.sessionMode ??
    (extDraft.targetSessionId ? 'current_session' : 'isolated_session');

  const cronPreview = resolveCronPreview(extDraft.cronExpression);
  const selectClassProps = settingsVariant
    ? { className: 'sched-settings-select' }
    : styles.schedSelect !== undefined
      ? { className: styles.schedSelect }
      : {};

  const projectSelect = (
    <Select
      {...selectClassProps}
      value={draft.cwd ?? ''}
      disabled={busy}
      options={projectOptions}
      onChange={(v) => updateDraft({ cwd: v })}
      aria-label="所属项目"
    />
  );

  const scheduleSelect = (
    <Select
      {...selectClassProps}
      value={extDraft.scheduleType}
      disabled={busy}
      options={scheduleOptions}
      onChange={(v) =>
        updateDraft({
          scheduleType: v as ExtendedWorkflowScheduleDraft['scheduleType'],
          ...(v === 'cron' && !extDraft.cronExpression
            ? { cronExpression: '*/30 * * * *' }
            : {}),
        })
      }
      aria-label="触发方式"
    />
  );

  const dailyField =
    extDraft.scheduleType === 'daily' ? (
      <Input
        bare={!settingsVariant}
        size="sm"
        className={settingsVariant ? undefined : styles.schedFieldInput}
        type="time"
        value={draft.dailyTime}
        disabled={busy}
        onChange={(e) => updateDraft({ dailyTime: e.target.value })}
        aria-label="每日时刻"
      />
    ) : null;

  const intervalField =
    extDraft.scheduleType === 'intervalMinutes' ? (
      <Input
        bare={!settingsVariant}
        size="sm"
        className={settingsVariant ? undefined : styles.schedFieldInput}
        type="number"
        min={WORKFLOW_INTERVAL_MINUTES_MIN}
        max={WORKFLOW_INTERVAL_MINUTES_MAX}
        step={1}
        inputMode="numeric"
        placeholder={
          settingsVariant
            ? `${WORKFLOW_INTERVAL_MINUTES_MIN}–${WORKFLOW_INTERVAL_MINUTES_MAX} 分钟`
            : `${WORKFLOW_INTERVAL_MINUTES_MIN}–${WORKFLOW_INTERVAL_MINUTES_MAX}`
        }
        value={draft.intervalMinutes}
        disabled={busy}
        onChange={(e) => updateDraft({ intervalMinutes: e.target.value })}
        aria-label="间隔分钟"
      />
    ) : null;

  const cronSection =
    extDraft.scheduleType === 'cron' ? (
      <div className={styles.schedField} data-testid="workflow-cron-section">
        <div className={styles.schedFieldLabelRow}>
          <span className={styles.schedFieldLabel}>Cron 表达式</span>
          {extDraft.cronExpression?.trim() ? (
            <span
              className={
                cronPreview.valid
                  ? styles.cronInlinePreview
                  : styles.cronInlineError
              }
              role={cronPreview.valid ? 'status' : 'alert'}
              data-testid="cron-preview-status"
            >
              {cronPreview.message}
            </span>
          ) : null}
        </div>
        <Input
          bare={!settingsVariant}
          size="sm"
          className={settingsVariant ? undefined : styles.schedFieldInput}
          style={{ fontFamily: 'var(--font-mono)' }}
          placeholder="*/30 * * * *"
          value={extDraft.cronExpression ?? ''}
          disabled={busy}
          onChange={(e) => updateDraft({ cronExpression: e.target.value })}
          aria-label="Cron 表达式"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
    ) : null;

  const sessionBindingSection = (
    <div
      className={styles.schedField}
      data-testid="workflow-session-mode-section"
    >
      <span className={styles.schedFieldLabel}>执行模式</span>
      <SegmentedControl
        aria-label="执行模式"
        size="sm"
        disabled={busy}
        value={currentExecutionTarget}
        options={EXECUTION_SESSION_MODE_OPTIONS}
        onChange={(mode) => {
          const nextMode = mode as WorkflowExecutionTarget;
          if (nextMode === 'current_session') {
            updateDraft({
              executionTarget: 'current_session',
              sessionMode: 'current_session',
              targetSessionId:
                extDraft.targetSessionId || resolvedActiveSessionId || '',
            });
          } else {
            updateDraft({
              executionTarget: 'isolated_session',
              sessionMode: 'isolated_session',
              targetSessionId: '',
            });
          }
        }}
      />
      {currentExecutionTarget === 'current_session' ? (
        <div className={styles.schedFieldRow}>
          <div className={`${styles.schedField} ${styles.schedFieldGrow}`}>
            <Input
              bare={!settingsVariant}
              size="sm"
              className={settingsVariant ? undefined : styles.schedFieldInput}
              placeholder="会话 ID"
              value={extDraft.targetSessionId ?? ''}
              disabled={busy}
              onChange={(e) =>
                updateDraft({
                  executionTarget: 'current_session',
                  sessionMode: 'current_session',
                  targetSessionId: e.target.value,
                })
              }
              aria-label="目标会话 ID"
              autoComplete="off"
            />
          </div>
          {resolvedActiveSessionId ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={
                busy || extDraft.targetSessionId === resolvedActiveSessionId
              }
              onClick={() =>
                updateDraft({
                  executionTarget: 'current_session',
                  sessionMode: 'current_session',
                  targetSessionId: resolvedActiveSessionId,
                })
              }
            >
              使用当前会话
            </Button>
          ) : null}
          {extDraft.targetSessionId ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                updateDraft({
                  executionTarget: 'isolated_session',
                  sessionMode: 'isolated_session',
                  targetSessionId: '',
                })
              }
            >
              解绑对话
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  if (settingsVariant) {
    return (
      <div
        id={formId}
        className={scheduleStyles.form}
        role="form"
        aria-label={isEditing ? '编辑定时任务' : '新建定时任务'}
      >
        <div
          className={scheduleStyles.presetChips}
          role="group"
          aria-label="模板"
        >
          {WORKFLOW_SCHEDULE_PRESETS.map((p) => (
            <Button
              key={p.id}
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => onApplyPreset(p.id)}
            >
              {p.label}
            </Button>
          ))}
        </div>
        <div className={scheduleStyles.formRow}>
          <div className={scheduleStyles.formField}>
            <Input
              size="sm"
              placeholder="名称"
              value={draft.name}
              disabled={busy}
              onChange={(e) => updateDraft({ name: e.target.value })}
              onBlur={onNameBlur}
              aria-label="名称"
              autoComplete="off"
            />
          </div>
          <div className={scheduleStyles.formField}>
            <Input
              size="sm"
              placeholder="要执行的内容"
              value={draft.prompt}
              disabled={busy}
              onChange={(e) => updateDraft({ prompt: e.target.value })}
              aria-label="执行内容"
              autoComplete="off"
            />
          </div>
        </div>
        <div className={scheduleStyles.formRow}>
          <div className={scheduleStyles.formField}>{projectSelect}</div>
          {scheduleSelect}
          {dailyField}
          {intervalField}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            aria-busy={busy}
            onClick={onSave}
          >
            {busy ? '…' : isEditing ? '保存' : '创建'}
          </Button>
        </div>
        {cronSection}
        {sessionBindingSection}
        {workspacePath ? (
          <Tooltip content={workspacePath}>
            <div className="sched-settings-path">{workspacePath}</div>
          </Tooltip>
        ) : null}
      </div>
    );
  }

  return (
    <div
      id={formId}
      className={`${styles.schedForm} ${styles.schedFormStack}`}
      role="form"
      aria-label="新建计划"
    >
      <label className={styles.schedField}>
        <span className={styles.schedFieldLabel}>名称</span>
        <Input
          bare
          className={styles.schedFieldInput}
          placeholder="例如：每日代码体检"
          value={draft.name}
          disabled={busy}
          onChange={(e) => updateDraft({ name: e.target.value })}
          onBlur={onNameBlur}
          autoComplete="off"
        />
      </label>
      <label className={styles.schedField}>
        <span className={styles.schedFieldLabel}>要做什么</span>
        <Textarea
          bare
          className={`${styles.schedFieldInput} ${styles.schedFieldTextarea}`}
          placeholder="描述任务内容…"
          value={draft.prompt}
          disabled={busy}
          rows={3}
          onChange={(e) => updateDraft({ prompt: e.target.value })}
        />
      </label>
      <div className={styles.schedFieldRow}>
        <label className={`${styles.schedField} ${styles.schedFieldGrow}`}>
          <span className={styles.schedFieldLabel}>所属项目</span>
          {projectSelect}
        </label>
      </div>
      <div className={styles.schedFieldRow}>
        <label className={`${styles.schedField} ${styles.schedFieldGrow}`}>
          <span className={styles.schedFieldLabel}>频率</span>
          {scheduleSelect}
        </label>
        {dailyField ? (
          <label className={styles.schedField}>
            <span className={styles.schedFieldLabel}>时间</span>
            {dailyField}
          </label>
        ) : null}
        {intervalField ? (
          <label className={styles.schedField}>
            <span className={styles.schedFieldLabel}>间隔（分钟）</span>
            {intervalField}
          </label>
        ) : null}
      </div>
      {cronSection}
      {sessionBindingSection}
      <div className={styles.schedFormActions}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy}
          aria-busy={busy}
          onClick={onSave}
        >
          {busy ? '…' : '保存'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onClose}
        >
          取消
        </Button>
      </div>
    </div>
  );
};
