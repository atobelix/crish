import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  WORKFLOW_INTERVAL_MINUTES_MAX,
  WORKFLOW_INTERVAL_MINUTES_MIN,
  WORKFLOW_SCHEDULE_TYPES,
  cronExpressionLabel,
  validateCronExpression,
  validateWorkflowDraft,
  buildScheduleFromDraft,
  validateWorkflowSchedule,
  emptyWorkflowDraft,
  type WorkflowDefinition,
  type WorkflowScheduleDraft,
} from '../../api/workflowApi';
import { listProjects } from '../../api/projectStore';
import { useSessionStore } from '../../store/storeAccess';
import {
  Button,
  Dialog,
  Input,
  Select,
  Textarea,
  SegmentedControl,
} from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { draftFromWorkflow } from './workflowsSharedLib';
import { useI18n } from '../../i18n';
import styles from './WorkflowEditModal.module.css';

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

function resolveCronPreview(
  rawExpr: string | undefined,
  t: (key: any, fallbackOrParams?: any, params?: any) => string
): {
  valid: boolean;
  message: string;
} {
  const expr = String(rawExpr ?? '').trim();
  if (!expr) {
    return { valid: false, message: '' };
  }
  const validation = validateCronExpression(expr);
  if (!validation.ok) {
    return {
      valid: false,
      message: validation.error || t('schedule.cronInvalidFormat', '格式不符'),
    };
  }
  const norm = validation.expression;
  const baseLabel = cronExpressionLabel(norm);
  if (norm === '0 9 * * 1-5' && baseLabel === norm) {
    return {
      valid: true,
      message: t('schedule.cronWeekdayMorning', '工作日 09:00'),
    };
  }
  if (norm === '0 9,18 * * *' && baseLabel === norm) {
    return {
      valid: true,
      message: t('schedule.cronDailyTwice', '每日 09:00 & 18:00'),
    };
  }
  return { valid: true, message: baseLabel };
}

export interface WorkflowEditModalProps {
  open: boolean;
  onClose: () => void;
  workflow: WorkflowDefinition | null;
  busy: boolean;
  workspacePath?: string;
  onSave: (
    draft: WorkflowScheduleDraft,
    workflow: WorkflowDefinition
  ) => Promise<boolean>;
}

export const WorkflowEditModal: React.FC<WorkflowEditModalProps> = ({
  open,
  onClose,
  workflow,
  busy,
  workspacePath,
  onSave,
}) => {
  const { t } = useI18n();

  const executionModeOptions = useMemo(
    () => [
      {
        value: 'isolated_session' as const,
        label: t('schedule.isolatedSession', '后台独立执行'),
      },
      {
        value: 'current_session' as const,
        label: t('schedule.currentSession', '绑定当前对话'),
      },
    ],
    [t]
  );

  const [draft, setDraft] = useState<ExtendedWorkflowScheduleDraft>(() =>
    workflow
      ? (draftFromWorkflow(workflow) as ExtendedWorkflowScheduleDraft)
      : {
          ...emptyWorkflowDraft(workspacePath),
          scheduleType: 'daily',
          executionTarget: 'isolated_session',
          sessionMode: 'isolated_session',
        }
  );

  const [validationError, setValidationError] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    if (workflow) {
      setDraft(draftFromWorkflow(workflow) as ExtendedWorkflowScheduleDraft);
    } else {
      setDraft({
        ...emptyWorkflowDraft(workspacePath),
        scheduleType: 'daily',
        executionTarget: 'isolated_session',
        sessionMode: 'isolated_session',
      });
    }
    setValidationError('');
  }, [open, workflow, workspacePath]);

  const activeSessionId = useSessionStore.getState().activeSessionId;
  const resolvedActiveSessionId = useMemo(() => {
    try {
      return String(activeSessionId ?? '').trim();
    } catch {
      return '';
    }
  }, [activeSessionId]);

  const projects = useMemo(() => listProjects(), []);
  const projectOptions = useMemo(
    () => [
      {
        id: '',
        label: t('schedule.globalWorkspace', '全局工作区'),
        hint: t('schedule.defaultSandbox', '默认沙箱'),
      },
      ...projects.map((p) => ({
        id: p.path,
        label: p.name,
        hint: p.path,
      })),
    ],
    [projects, t]
  );

  const scheduleOptions = useMemo(() => {
    const opts: Array<{ id: string; label: string; hint: string }> =
      WORKFLOW_SCHEDULE_TYPES.map((type) => ({
        id: String(type.value),
        label:
          String(type.value) === 'cron'
            ? t('schedule.cronCustom', '自定义 Cron')
            : type.label,
        hint: type.hint,
      }));
    if (!opts.some((o) => o.id === 'cron')) {
      opts.push({
        id: 'cron',
        label: t('schedule.cronCustom', '自定义 Cron'),
        hint: t('schedule.cronHint', '标准 5 字段 cron（分 时 日 月 周）'),
      });
    }
    return opts;
  }, [t]);

  const updateDraft = useCallback(
    (patch: Partial<ExtendedWorkflowScheduleDraft>) => {
      setDraft((prev) => ({ ...prev, ...patch }));
      setValidationError('');
    },
    []
  );

  const currentExecutionTarget: WorkflowExecutionTarget =
    draft.executionTarget ??
    draft.sessionMode ??
    (draft.targetSessionId ? 'current_session' : 'isolated_session');

  const cronPreview = resolveCronPreview(draft.cronExpression, t);

  const handleSave = async () => {
    if (!workflow) return;
    const draftErr = validateWorkflowDraft(draft as WorkflowScheduleDraft);
    if (draftErr) {
      setValidationError(draftErr);
      return;
    }
    const schedule = buildScheduleFromDraft(draft as WorkflowScheduleDraft);
    const schedGuard = validateWorkflowSchedule(schedule);
    if (schedGuard.ok === false) {
      setValidationError(
        schedGuard.error || t('schedule.cronExprInvalid', '计划表达式无效')
      );
      return;
    }
    const success = await onSave(draft as WorkflowScheduleDraft, workflow);
    if (success) {
      onClose();
    }
  };

  const footer = (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={onClose}
      >
        {t('schedule.cancel', '取消')}
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void handleSave()}
      >
        {busy ? '…' : t('schedule.save', '保存')}
      </Button>
    </>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={t('schedule.modalTitle', '编辑定时任务')}
      footer={footer}
    >
      <div
        className={styles.modalBody}
        role="form"
        aria-label={t('schedule.formAria', '编辑定时任务表单')}
      >
        {validationError ? (
          <div
            className={styles.warningBanner}
            role="alert"
            data-testid="edit-warning-banner"
          >
            <span className={styles.warningBannerIcon}>
              <AppIcon name="alert-triangle" size={14} aria-hidden />
            </span>
            <span className={styles.warningBannerText}>{validationError}</span>
          </div>
        ) : null}

        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="sched-edit-name">
            {t('schedule.taskName', '任务名称')}
          </label>
          <Input
            id="sched-edit-name"
            size="sm"
            placeholder={t(
              'schedule.taskNamePlaceholder',
              '例如：每日代码体检'
            )}
            value={draft.name}
            disabled={busy}
            onChange={(e) => updateDraft({ name: e.target.value })}
            autoComplete="off"
          />
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="sched-edit-prompt">
            {t('schedule.taskInstruction', '任务指令')}
          </label>
          <Textarea
            id="sched-edit-prompt"
            placeholder={t(
              'schedule.taskInstructionPlaceholder',
              '描述按计划执行的内容…'
            )}
            value={draft.prompt}
            disabled={busy}
            rows={3}
            onChange={(e) => updateDraft({ prompt: e.target.value })}
          />
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>
            {t('schedule.projectBelong', '所属项目')}
          </label>
          <Select
            value={draft.cwd ?? ''}
            disabled={busy}
            options={projectOptions}
            onChange={(v) => updateDraft({ cwd: v })}
            aria-label={t('schedule.projectAria', '所属项目')}
          />
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>
            {t('schedule.triggerType', '触发方式')}
          </label>
          <div className={styles.fieldRow}>
            <div className={styles.fieldGrow}>
              <Select
                value={draft.scheduleType}
                disabled={busy}
                options={scheduleOptions}
                onChange={(v) =>
                  updateDraft({
                    scheduleType:
                      v as ExtendedWorkflowScheduleDraft['scheduleType'],
                  })
                }
                aria-label={t('schedule.triggerTypeAria', '触发方式')}
              />
            </div>
            {draft.scheduleType === 'daily' ? (
              <Input
                type="time"
                size="sm"
                value={draft.dailyTime}
                disabled={busy}
                onChange={(e) => updateDraft({ dailyTime: e.target.value })}
                aria-label={t('schedule.dailyTimeAria', '每日时间')}
              />
            ) : null}
            {draft.scheduleType === 'intervalMinutes' ? (
              <Input
                type="number"
                size="sm"
                min={WORKFLOW_INTERVAL_MINUTES_MIN}
                max={WORKFLOW_INTERVAL_MINUTES_MAX}
                step={1}
                inputMode="numeric"
                placeholder={t(
                  'schedule.intervalMinutesPlaceholder',
                  '{min}–{max} 分钟',
                  {
                    min: WORKFLOW_INTERVAL_MINUTES_MIN,
                    max: WORKFLOW_INTERVAL_MINUTES_MAX,
                  }
                )}
                value={draft.intervalMinutes}
                disabled={busy}
                onChange={(e) =>
                  updateDraft({ intervalMinutes: e.target.value })
                }
                aria-label={t('schedule.intervalMinutesAria', '间隔分钟')}
              />
            ) : null}
          </div>
        </div>

        {draft.scheduleType === 'cron' ? (
          <div
            className={styles.fieldGroup}
            data-testid="workflow-cron-section"
          >
            <div className={styles.fieldLabelRow}>
              <label className={styles.fieldLabel} htmlFor="sched-edit-cron">
                {t('schedule.cronExpr', 'Cron 表达式')}
              </label>
              {draft.cronExpression?.trim() ? (
                <span
                  className={
                    cronPreview.valid ? styles.cronPreview : styles.cronError
                  }
                  role={cronPreview.valid ? 'status' : 'alert'}
                >
                  {cronPreview.message}
                </span>
              ) : null}
            </div>
            <Input
              id="sched-edit-cron"
              size="sm"
              style={{ fontFamily: 'var(--font-mono)' }}
              placeholder="*/30 * * * *"
              value={draft.cronExpression ?? ''}
              disabled={busy}
              onChange={(e) => updateDraft({ cronExpression: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        ) : null}

        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>
            {t('schedule.executionMode', '执行模式')}
          </label>
          <SegmentedControl
            aria-label={t('schedule.executionModeAria', '执行模式')}
            size="sm"
            disabled={busy}
            value={currentExecutionTarget}
            options={executionModeOptions}
            onChange={(mode) => {
              const nextMode = mode as WorkflowExecutionTarget;
              if (nextMode === 'current_session') {
                updateDraft({
                  executionTarget: 'current_session',
                  sessionMode: 'current_session',
                  targetSessionId:
                    draft.targetSessionId || resolvedActiveSessionId || '',
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
            <div className={styles.fieldRow}>
              <div className={styles.fieldGrow}>
                <Input
                  size="sm"
                  placeholder={t(
                    'schedule.targetSessionPlaceholder',
                    '会话 ID'
                  )}
                  value={draft.targetSessionId ?? ''}
                  disabled={busy}
                  onChange={(e) =>
                    updateDraft({
                      executionTarget: 'current_session',
                      sessionMode: 'current_session',
                      targetSessionId: e.target.value,
                    })
                  }
                  aria-label={t('schedule.targetSessionAria', '目标会话 ID')}
                  autoComplete="off"
                />
              </div>
              {resolvedActiveSessionId ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={
                    busy || draft.targetSessionId === resolvedActiveSessionId
                  }
                  onClick={() =>
                    updateDraft({
                      executionTarget: 'current_session',
                      sessionMode: 'current_session',
                      targetSessionId: resolvedActiveSessionId,
                    })
                  }
                >
                  {t('schedule.currentSessionBadge', '当前会话')}
                </Button>
              ) : null}
              {draft.targetSessionId ? (
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
                  {t('schedule.unbind', '解绑')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
};
