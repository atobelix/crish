import { useToast } from '../../services/toast/ToastContext';
/**
 * 设置 · 定时任务：筛选、新建、编辑、启停与立即执行；成功静默，仅错误提示。
 * 壳组件：筛选与创建方式走 SegmentedControl（7px），动作走 ui/Button；
 * 状态/动作见 useWorkflowsState，表单/列表见 WorkflowForm / WorkflowList。
 */
import React, { useState } from 'react';
import { getWorkspacePath } from '../../api/projectStore';
import { emitUiEvent } from '../../api/uiEvents';
import {
  WORKFLOW_SCHEDULE_PRESETS,
  emptyWorkflowDraft,
  type WorkflowDefinition,
  type WorkflowScheduleDraft,
} from '../../api/workflowApi';
import { useSessionStore } from '../../store/sessionStore';
import { sessionDraftManager } from '../../api/draft/sessionDraftManager';
import { closeSettings } from '../../store/storeAccess';
import styles from './SettingsScheduleTab.module.css';
import { Button, SegmentedControl } from '../ui';
import { SettingsPage, SettingsSection, SettingsCard } from './SettingsUI';
import {
  FILTER_OPTIONS,
  draftFromWorkflow,
  type ScheduleFilter,
} from './workflowsSharedLib';
import { useWorkflowsState } from './useWorkflowsState';
import { WorkflowForm } from './WorkflowForm';
import { WorkflowList } from './WorkflowList';
import { AppIcon } from '../ui/icons/index';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
};

const CREATE_PATH_OPTIONS = [
  { value: 'ai', label: '用对话创建（推荐）' },
  { value: 'manual', label: '手动创建' },
];

export const SettingsScheduleTab: React.FC<Props> = ({ _onBlockingOverlayChange }) => {
  const { showToast } = useToast();
  const state = useWorkflowsState({
    surface: 'settings',
    workspacePath: getWorkspacePath() || '',
  });
  const {
    loading,
    busy,
    error,
    ok,
    setError,
    setOk,
    filter,
    setFilter,
    filtered,
    emptyCopy,
    maybeWatchHint,
    handleSave,
    handleToggle,
    handleTrigger,
    handleDelete,
  } = state;

  /** none | paths 双入口 | form 手动表单 */
  const [createMode, setCreateMode] = useState<'none' | 'paths' | 'form'>(
    'none'
  );
  const [wfDraft, setWfDraft] =
    useState<WorkflowScheduleDraft>(emptyWorkflowDraft);
  const [editingWorkflow, setEditingWorkflow] =
    useState<WorkflowDefinition | null>(null);

  const workspacePath = getWorkspacePath() || '';

  const resetDraft = () => {
    setWfDraft(emptyWorkflowDraft());
  };

  const closeForm = () => {
    setCreateMode('none');
    setError('');
    setOk('');
    resetDraft();
    setEditingWorkflow(null);
  };

  const applyPreset = (presetId: string) => {
    const preset = WORKFLOW_SCHEDULE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setCreateMode('form');
    setError('');
    setOk('');
    setWfDraft({ ...preset.draft });
  };

  const handleEditClick = (w: WorkflowDefinition) => {
    setEditingWorkflow(w);
    setCreateMode('form');
    setError('');
    setOk('');
    setWfDraft(draftFromWorkflow(w));
  };

  /** 关闭设置，在对话里用 AI 写定时任务名称与提示词（定向注入 + 可见助手卡片） */
  const handleAiCreateSchedule = () => {
    // 以 store 当前活跃会话定向（返回对话时即该会话）；无活跃会话则中止注入
    const targetSid = useSessionStore.getState().activeSessionId;
    if (targetSid) {
      sessionDraftManager.injectSeed({
        targetSessionId: targetSid,
        content: [
          '请帮我设计一个 Crish 定时任务。',
          '输出：任务名称、触发方式（手动 / 每日时刻 / 间隔分钟）、完整提示词（可直接粘贴使用）。',
          '我想用它来：',
        ].join('\n'),
        mode: 'safe_seed',
        metadata: { source: 'settings_tab', title: '定时任务对话创建' },
      });
      showToast('已填入定时任务对话创建提示，请返回对话补全');
    } else {
      console.warn('[SettingsScheduleTab] 无活跃会话，跳过草稿注入');
      showToast('无活跃会话，无法注入创建提示');
    }
    setCreateMode('none');
    closeSettings();
    setTimeout(() => emitUiEvent('open-chat'), 100);
  };

  const isEditing = editingWorkflow !== null;

  const handleFormSave = async () => {
    const saved = await handleSave(wfDraft, editingWorkflow);
    if (!saved) return;
    setCreateMode('none');
    resetDraft();
    setEditingWorkflow(null);
  };

  const onNameBlur = () => {
    maybeWatchHint(wfDraft.name);
  };

  return (
    <SettingsPage title="定时任务">
      <div aria-busy={loading || busy} aria-label="定时任务">
        <div
          className={`sched-settings-toolbar ${styles.toolbar}`}
          role="toolbar"
          aria-label="筛选与新建"
        >
          <SegmentedControl
            aria-label="任务筛选"
            size="sm"
            className={styles.segment}
            value={filter}
            options={FILTER_OPTIONS.map((opt) => ({
              value: opt.id,
              label: opt.label,
            }))}
            onChange={(v) => setFilter(v as ScheduleFilter)}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={styles.actionBtn}
            aria-expanded={createMode !== 'none'}
            aria-controls="sched-settings-form"
            disabled={busy}
            onClick={() => {
              if (createMode !== 'none') {
                closeForm();
              } else {
                setCreateMode('paths');
                setError('');
                setOk('');
              }
            }}
            icon={<AppIcon name="plus" size={16} aria-hidden />}
          >
            {createMode !== 'none' ? '收起' : '新建'}
          </Button>
        </div>

        {(error || ok) && (
          <div
            className="sched-settings-status"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {error ? (
              <span
                className="settings-list-sub settings-list-sub--force"
                role="alert"
              >
                {error}
              </span>
            ) : null}
            {ok && !error ? (
              <span
                className="settings-list-sub settings-list-sub--force"
                role="status"
              >
                {ok}
              </span>
            ) : null}
          </div>
        )}

        {createMode !== 'none' && !isEditing ? (
          <div
            className={styles.createSeg}
            id={createMode === 'paths' ? 'sched-settings-form' : undefined}
          >
            <SegmentedControl
              aria-label="创建方式"
              size="sm"
              block
              className={styles.segment}
              disabled={busy}
              value={createMode === 'form' ? 'manual' : ''}
              options={CREATE_PATH_OPTIONS}
              onChange={(v) => {
                if (v === 'ai') {
                  handleAiCreateSchedule();
                  return;
                }
                setCreateMode('form');
                setError('');
                setOk('');
              }}
            />
          </div>
        ) : null}

        {createMode === 'form' ? (
          <WorkflowForm
            variant="settings"
            formId="sched-settings-form"
            draft={wfDraft}
            busy={busy}
            isEditing={isEditing}
            workspacePath={workspacePath}
            onDraftChange={setWfDraft}
            onApplyPreset={applyPreset}
            onNameBlur={onNameBlur}
            onSave={() => {
              void handleFormSave();
            }}
            onClose={closeForm}
          />
        ) : null}

        <SettingsSection>
          <SettingsCard>
            <WorkflowList
              variant="settings"
              workflows={filtered}
              busy={busy}
              loading={loading}
              emptyCopy={emptyCopy}
              onToggle={(w) => {
                void handleToggle(w);
              }}
              onTrigger={(w) => {
                void handleTrigger(w);
              }}
              onDelete={(w) => {
                void handleDelete(w);
              }}
              onEdit={handleEditClick}
            />
          </SettingsCard>
        </SettingsSection>
      </div>
    </SettingsPage>
  );
};
