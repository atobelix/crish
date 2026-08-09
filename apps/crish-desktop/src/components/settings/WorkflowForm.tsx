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
import { Button, Select, Tooltip } from '../ui';
import styles from './ScheduledTasksPanel.module.css';

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
      <input
        className="settings-field-input"
        placeholder="名称"
        value={draft.name}
        disabled={busy}
        onChange={(e) => onDraftChange({ ...draft, name: e.target.value })}
        onBlur={onNameBlur}
        aria-label="名称"
        autoComplete="off"
      />
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
    <input
      className="settings-field-input sched-settings-prompt"
      placeholder="要执行的内容"
      value={draft.prompt}
      disabled={busy}
      onChange={(e) => onDraftChange({ ...draft, prompt: e.target.value })}
      aria-label="执行内容"
      autoComplete="off"
    />
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
      <input
        className="settings-field-input"
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
      <input
        className="settings-field-input"
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
        className="sched-settings-form"
        role="form"
        aria-label={isEditing ? '编辑定时任务' : '新建定时任务'}
      >
        <div className="sched-preset-chips" role="group" aria-label="模板">
          {WORKFLOW_SCHEDULE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="sched-preset-chip"
              disabled={busy}
              onClick={() => onApplyPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="sched-settings-form-row sched-settings-form-row--fields">
          {nameInput}
          {promptInput}
        </div>
        <div className="sched-settings-form-row">
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
