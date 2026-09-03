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
  type WorkflowScheduleDraft,
} from '../../api/workflowApi';
import { listProjects } from '../../api/projectStore';
import { Button, Input, Select, Tooltip } from '../ui';
import styles from './ScheduledTasksPanel.module.css';
import scheduleStyles from './SettingsScheduleTab.module.css';

export type WorkflowFormProps = {
  variant: 'settings' | 'chat';
  /** 表单容器 id（aria-controls / 锚点） */
  formId: string;
  draft: WorkflowScheduleDraft;
  busy: boolean;
  isEditing: boolean;
  /** settings 面：工作区路径提示 */
  workspacePath?: string;
  onDraftChange: (d: WorkflowScheduleDraft) => void;
  onApplyPreset: (presetId: string) => void;
  /** 名称失焦：监听类关键词提示（maybeWatchHint） */
  onNameBlur: () => void;
  onSave: () => void;
  onClose: () => void;
};

export const WorkflowForm: React.FC<WorkflowFormProps> = ({
  variant,
  formId,
  draft,
  busy,
  isEditing,
  workspacePath,
  onDraftChange,
  onApplyPreset,
  onNameBlur,
  onSave,
  onClose,
}) => {
  const settingsVariant = variant === 'settings';

  const nameInput =
    settingsVariant ? (
      <div className={scheduleStyles.formField}>
        <Input
          size="sm"
          placeholder="名称"
          value={draft.name}
          disabled={busy}
          onChange={(e) => onDraftChange({ ...draft, name: e.target.value })}
          onBlur={onNameBlur}
          aria-label="名称"
          autoComplete="off"
        />
      </div>
    ) : (
      <label className={styles.schedField}>
        <span className={styles.schedFieldLabel}>名称</span>
        <input
          className={styles.schedFieldInput}
          placeholder="例如：每日代码体检"
          value={draft.name}
          disabled={busy}
          onChange={(e) => onDraftChange({ ...draft, name: e.target.value })}
          onBlur={onNameBlur}
          autoComplete="off"
        />
      </label>
    );

  const promptInput = settingsVariant ? (
    <div className={scheduleStyles.formField}>
      <Input
        size="sm"
        placeholder="要执行的内容"
        value={draft.prompt}
        disabled={busy}
        onChange={(e) => onDraftChange({ ...draft, prompt: e.target.value })}
        aria-label="执行内容"
        autoComplete="off"
      />
    </div>
  ) : (
    <label className={styles.schedField}>
      <span className={styles.schedFieldLabel}>要做什么</span>
      <textarea
        className={`${styles.schedFieldInput} ${styles.schedFieldTextarea}`}
        placeholder="描述任务内容…"
        value={draft.prompt}
        disabled={busy}
        rows={3}
        onChange={(e) => onDraftChange({ ...draft, prompt: e.target.value })}
      />
    </label>
  );

  const scheduleSelect = (
    <Select
      {...(settingsVariant
        ? { className: 'sched-settings-select' }
        : styles.schedSelect !== undefined
          ? { className: styles.schedSelect }
          : {})}
      value={draft.scheduleType}
      disabled={busy}
      options={WORKFLOW_SCHEDULE_TYPES.map((t) => ({
        id: t.value,
        label: t.label,
        hint: t.hint,
      }))}
      onChange={(v) =>
        onDraftChange({
          ...draft,
          scheduleType: v as WorkflowScheduleDraft['scheduleType'],
        })
      }
    />
  );

  const dailyField = draft.scheduleType === 'daily' ? (
    settingsVariant ? (
      <Input
        size="sm"
        type="time"
        value={draft.dailyTime}
        disabled={busy}
        onChange={(e) => onDraftChange({ ...draft, dailyTime: e.target.value })}
        aria-label="每日时刻"
      />
    ) : (
      <label className={styles.schedField}>
        <span className={styles.schedFieldLabel}>时间</span>
        <input
          className={styles.schedFieldInput}
          type="time"
          value={draft.dailyTime}
          disabled={busy}
          onChange={(e) => onDraftChange({ ...draft, dailyTime: e.target.value })}
        />
      </label>
    )
  ) : null;

  const intervalField = draft.scheduleType === 'intervalMinutes' ? (
    settingsVariant ? (
      <Input
        size="sm"
        type="number"
        min={WORKFLOW_INTERVAL_MINUTES_MIN}
        max={WORKFLOW_INTERVAL_MINUTES_MAX}
        step={1}
        inputMode="numeric"
        placeholder={`${WORKFLOW_INTERVAL_MINUTES_MIN}–${WORKFLOW_INTERVAL_MINUTES_MAX} 分钟`}
        value={draft.intervalMinutes}
        disabled={busy}
        onChange={(e) =>
          onDraftChange({ ...draft, intervalMinutes: e.target.value })
        }
        aria-label="间隔分钟"
      />
    ) : (
      <label className={styles.schedField}>
        <span className={styles.schedFieldLabel}>间隔（分钟）</span>
        <input
          className={styles.schedFieldInput}
          type="number"
          min={WORKFLOW_INTERVAL_MINUTES_MIN}
          max={WORKFLOW_INTERVAL_MINUTES_MAX}
          step={1}
          inputMode="numeric"
          placeholder={`${WORKFLOW_INTERVAL_MINUTES_MIN}–${WORKFLOW_INTERVAL_MINUTES_MAX}`}
          value={draft.intervalMinutes}
          disabled={busy}
          onChange={(e) =>
            onDraftChange({ ...draft, intervalMinutes: e.target.value })
          }
        />
      </label>
    )
  ) : null;

  if (settingsVariant) {
    return (
      <div
        id={formId}
        className={scheduleStyles.form}
        role="form"
        aria-label={isEditing ? '编辑定时任务' : '新建定时任务'}
      >
        <div className={scheduleStyles.presetChips} role="group" aria-label="模板">
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
          {nameInput}
          {promptInput}
        </div>
        <div className={scheduleStyles.formRow}>
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
            {busy ? '…' : (isEditing ? '保存' : '创建')}
          </Button>
        </div>
        {workspacePath ? (
          <Tooltip content={workspacePath}>
            <div className="sched-settings-path">
              {workspacePath}
            </div>
          </Tooltip>
        ) : null}
      </div>
    );
  }

  const projects = React.useMemo(() => listProjects(), []);
  const projectOptions = React.useMemo(
    () =>
      projects.map((p) => ({
        id: p.path,
        label: p.name,
        hint: p.path,
      })),
    [projects]
  );

  React.useEffect(() => {
    if (!draft.cwd && projectOptions.length > 0) {
      const defaultPath = workspacePath || projectOptions[0]?.id || '';
      if (defaultPath) {
        onDraftChange({ ...draft, cwd: defaultPath });
      }
    }
  }, [draft.cwd, projectOptions, workspacePath]);

  const projectSelect = (
    <Select
      {...(settingsVariant
        ? { className: 'sched-settings-select' }
        : styles.schedSelect !== undefined
          ? { className: styles.schedSelect }
          : {})}
      value={draft.cwd || (projectOptions[0]?.id ?? '')}
      disabled={busy}
      options={projectOptions}
      onChange={(v) => onDraftChange({ ...draft, cwd: v })}
      aria-label="所属项目"
    />
  );

  return (
    <div
      id={formId}
      className={`${styles.schedForm} ${styles.schedFormStack}`}
      role="form"
      aria-label="新建计划"
    >
      {nameInput}
      {promptInput}
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
        {dailyField}
        {intervalField}
      </div>
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
