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
} from '@/components/ui';
import {
  PERMISSION_MODES,
  coercePermissionMode,
} from '../../api/permissionModes';
import { useI18n } from '../../i18n';
import { G2Surface } from '../ui/G2Surface';
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

/** 执行会话模式选项（labelKey 指向 settings.schedule.* 词条） */
export const EXECUTION_SESSION_MODE_OPTIONS = [
  {
    value: 'isolated_session' as const,
    labelKey: 'settings.schedule.isolatedSession',
    fallback: '后台独立执行',
  },
  {
    value: 'current_session' as const,
    labelKey: 'settings.schedule.currentSession',
    fallback: '绑定当前对话',
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
type TranslateFn = (
  key: string,
  fallback?: string,
  params?: Record<string, string | number>
) => string;

function resolveCronPreview(
  rawExpr: string | undefined,
  t: TranslateFn
): {
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
    return {
      valid: false,
      message:
        validation.error ||
        t('settings.schedule.cronInvalidFormat', '格式不符'),
    };
  }
  const norm = validation.expression;
  const baseLabel = cronExpressionLabel(norm);
  if (norm === '0 9 * * 1-5' && baseLabel === norm) {
    return {
      valid: true,
      message: t('settings.schedule.cronWeekdayMorning', '工作日 09:00'),
    };
  }
  if (norm === '0 9,18 * * *' && baseLabel === norm) {
    return {
      valid: true,
      message: t('settings.schedule.cronDailyTwice', '每日 09:00 & 18:00'),
    };
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
  activeSessionId,
  onDraftChange,
  onApplyPreset,
  onNameBlur,
  onSave,
  onClose,
}) => {
  const settingsVariant = variant === 'settings';
  const { t } = useI18n();
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
        label: t('settings.schedule.globalWorkspace', '全局工作区'),
        hint: t('settings.schedule.defaultSandbox', '默认沙箱'),
      },
      ...projects.map((p) => ({
        id: p.path,
        label: p.name,
        hint: p.path,
      })),
    ],
    [projects, t]
  );

  // 触发方式下拉选项：包含自定义 Cron
  const scheduleOptions = React.useMemo(() => {
    const opts: { id: string; label: string; hint: string }[] =
      WORKFLOW_SCHEDULE_TYPES.map((st) => ({
        id: String(st.value),
        label:
          String(st.value) === 'cron'
            ? t('settings.schedule.cronCustom', '自定义 Cron')
            : st.label,
        hint: st.hint,
      }));
    if (!opts.some((o) => o.id === 'cron')) {
      opts.push({
        id: 'cron',
        label: t('settings.schedule.cronCustom', '自定义 Cron'),
        hint: t(
          'settings.schedule.cronHint',
          '标准 5 字段 cron（分 时 日 月 周）'
        ),
      });
    }
    return opts;
  }, [t]);

  // 执行权限模式下拉选项：三态 SSOT（ask / smart / full），文案经 i18n 键在渲染层解析
  const permissionOptions = React.useMemo(
    () =>
      PERMISSION_MODES.map((m) => ({
        id: m.id,
        label: t(m.labelKey),
        hint: t(m.descriptionKey),
      })),
    [t]
  );

  const currentExecutionTarget: WorkflowExecutionTarget =
    extDraft.executionTarget ??
    extDraft.sessionMode ??
    (extDraft.targetSessionId ? 'current_session' : 'isolated_session');

  const cronPreview = resolveCronPreview(extDraft.cronExpression, t);
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
      aria-label={t('settings.schedule.projectBelong', '所属项目')}
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
      aria-label={t('settings.schedule.triggerTypeAria', '触发方式')}
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
        aria-label={t('settings.schedule.dailyTimeAria', '每日时刻')}
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
            ? t('settings.schedule.intervalPlaceholder', '{min}–{max} 分钟', {
                min: WORKFLOW_INTERVAL_MINUTES_MIN,
                max: WORKFLOW_INTERVAL_MINUTES_MAX,
              })
            : `${WORKFLOW_INTERVAL_MINUTES_MIN}–${WORKFLOW_INTERVAL_MINUTES_MAX}`
        }
        value={draft.intervalMinutes}
        disabled={busy}
        onChange={(e) => updateDraft({ intervalMinutes: e.target.value })}
        aria-label={t('settings.schedule.intervalMinutesAria', '间隔分钟')}
      />
    ) : null;

  const cronSection =
    extDraft.scheduleType === 'cron' ? (
      <div className={styles.schedField} data-testid="workflow-cron-section">
        <div className={styles.schedFieldLabelRow}>
          <span className={styles.schedFieldLabel}>
            {t('settings.schedule.cronExpr', 'Cron 表达式')}
          </span>
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
          aria-label={t('settings.schedule.cronExpr', 'Cron 表达式')}
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
      <span className={styles.schedFieldLabel}>
        {t('settings.schedule.executionMode', '执行模式')}
      </span>
      <SegmentedControl
        aria-label={t('settings.schedule.executionModeAria', '执行模式')}
        size="sm"
        disabled={busy}
        value={currentExecutionTarget}
        options={EXECUTION_SESSION_MODE_OPTIONS.map((o) => ({
          value: o.value,
          label: t(o.labelKey, o.fallback),
        }))}
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
              placeholder={t(
                'settings.schedule.targetSessionPlaceholder',
                '会话 ID'
              )}
              value={extDraft.targetSessionId ?? ''}
              disabled={busy}
              onChange={(e) =>
                updateDraft({
                  executionTarget: 'current_session',
                  sessionMode: 'current_session',
                  targetSessionId: e.target.value,
                })
              }
              aria-label={t(
                'settings.schedule.targetSessionAria',
                '目标会话 ID'
              )}
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
              {t('settings.schedule.useCurrentSession', '使用当前会话')}
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
              {t('settings.schedule.unbindConversation', '解绑对话')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const permissionSection = (
    <div
      className={styles.schedField}
      data-testid="workflow-permission-mode-section"
    >
      <span className={styles.schedFieldLabel}>
        {t('settings.workflow.permissionLabel')}
      </span>
      <Select
        {...selectClassProps}
        value={coercePermissionMode(extDraft.permissionMode)}
        disabled={busy}
        options={permissionOptions}
        onChange={(v) =>
          updateDraft({ permissionMode: coercePermissionMode(v) })
        }
        aria-label={t('settings.workflow.permissionAria')}
      />
    </div>
  );

  if (settingsVariant) {
    return (
      <div
        id={formId}
        className={scheduleStyles.form}
        role="form"
        aria-label={
          isEditing
            ? t('settings.schedule.editFormAria', '编辑定时任务')
            : t('settings.schedule.createFormAria', '新建定时任务')
        }
      >
        <div
          className={scheduleStyles.presetChips}
          role="group"
          aria-label={t('settings.schedule.presetsAria', '模板')}
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
          <label className={`${styles.schedField} ${scheduleStyles.formField}`}>
            <span className={styles.schedFieldLabel}>
              {t('settings.schedule.taskName', '任务名称')}
            </span>
            <Input
              size="sm"
              placeholder={t(
                'settings.schedule.taskNamePlaceholder',
                '例如：每日代码体检'
              )}
              value={draft.name}
              disabled={busy}
              onChange={(e) => updateDraft({ name: e.target.value })}
              onBlur={onNameBlur}
              aria-label={t('settings.schedule.taskName', '任务名称')}
              autoComplete="off"
            />
          </label>
          <label className={`${styles.schedField} ${scheduleStyles.formField}`}>
            <span className={styles.schedFieldLabel}>
              {t('settings.schedule.taskInstruction', '任务指令')}
            </span>
            <Textarea
              size="sm"
              rows={3}
              placeholder={t(
                'settings.schedule.taskInstructionPlaceholder',
                '描述按计划执行的内容…'
              )}
              value={draft.prompt}
              disabled={busy}
              onChange={(e) => updateDraft({ prompt: e.target.value })}
              aria-label={t('settings.schedule.taskInstruction', '任务指令')}
              autoComplete="off"
            />
          </label>
        </div>
        <div className={scheduleStyles.formRow}>
          <div className={scheduleStyles.formField}>{projectSelect}</div>
          {scheduleSelect}
          {dailyField}
          {intervalField}
        </div>
        {cronSection}
        {sessionBindingSection}
        {permissionSection}
        <div className={scheduleStyles.formActions}>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={busy}
            aria-busy={busy}
            onClick={onSave}
          >
            {busy
              ? '…'
              : isEditing
                ? t('settings.schedule.save', '保存')
                : t('settings.schedule.create', '创建')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onClose}
          >
            {t('settings.schedule.cancel', '取消')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      id={formId}
      className={`${styles.schedForm} ${styles.schedFormStack}`}
      role="form"
      aria-label={t('settings.schedule.chatFormAria', '新建计划')}
    >
      {/* G² 形状层（槽 C）：透明底表单卡仅描边——同路径描边覆盖 CSS 边框环
          （.schedForm 已备 isolation 层叠上下文，本层负 z 绘于边框之上、
          内容之下）；内容距角 16px 内边距起，不入 r16 角域，无需 clip。 */}
      <div className={styles.g2ShapeBleed}>
        <G2Surface
          radius="r16"
          stroke="var(--border-subtle)"
          className={styles.g2ShapeBleedFill}
        />
      </div>
      <label className={styles.schedField}>
        <span className={styles.schedFieldLabel}>
          {t('settings.schedule.taskName', '任务名称')}
        </span>
        <Input
          bare
          className={styles.schedFieldInput}
          placeholder={t(
            'settings.schedule.taskNamePlaceholder',
            '例如：每日代码体检'
          )}
          value={draft.name}
          disabled={busy}
          onChange={(e) => updateDraft({ name: e.target.value })}
          onBlur={onNameBlur}
          autoComplete="off"
        />
      </label>
      <label className={styles.schedField}>
        <span className={styles.schedFieldLabel}>
          {t('settings.schedule.taskInstruction', '任务指令')}
        </span>
        <Textarea
          bare
          className={`${styles.schedFieldInput} ${styles.schedFieldTextarea}`}
          placeholder={t(
            'settings.schedule.chatPromptPlaceholder',
            '描述任务内容…'
          )}
          value={draft.prompt}
          disabled={busy}
          rows={3}
          onChange={(e) => updateDraft({ prompt: e.target.value })}
        />
      </label>
      <div className={styles.schedFieldRow}>
        <label className={`${styles.schedField} ${styles.schedFieldGrow}`}>
          <span className={styles.schedFieldLabel}>
            {t('settings.schedule.projectBelong', '所属项目')}
          </span>
          {projectSelect}
        </label>
      </div>
      <div className={styles.schedFieldRow}>
        <label className={`${styles.schedField} ${styles.schedFieldGrow}`}>
          <span className={styles.schedFieldLabel}>
            {t('settings.schedule.frequencyLabel', '频率')}
          </span>
          {scheduleSelect}
        </label>
        {dailyField ? (
          <label className={styles.schedField}>
            <span className={styles.schedFieldLabel}>
              {t('settings.schedule.timeLabel', '时间')}
            </span>
            {dailyField}
          </label>
        ) : null}
        {intervalField ? (
          <label className={styles.schedField}>
            <span className={styles.schedFieldLabel}>
              {t('settings.schedule.intervalLabel', '间隔（分钟）')}
            </span>
            {intervalField}
          </label>
        ) : null}
      </div>
      {cronSection}
      {sessionBindingSection}
      {permissionSection}
      <div className={styles.schedFormActions}>
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={busy}
          aria-busy={busy}
          onClick={onSave}
        >
          {busy ? '…' : t('settings.schedule.save', '保存')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onClose}
        >
          {t('settings.schedule.cancel', '取消')}
        </Button>
      </div>
    </div>
  );
};
