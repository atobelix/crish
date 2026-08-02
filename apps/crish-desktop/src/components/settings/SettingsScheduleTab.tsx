/**
 * 设置 · 定时任务：筛选、新建、编辑、启停与立即执行；成功静默，仅错误提示。
 * 壳组件：只保留 tab 外壳（筛选栏 + 双入口 + 表单/列表装配）；
 * 状态/动作见 useWorkflowsState，表单/列表见 WorkflowForm / WorkflowList。
 */
import React, { useState } from 'react';
import * as Lucide from 'lucide-react';
import { getWorkspacePath } from '../../api/projectStore';
import { emitUiEvent } from '../../api/uiEvents';
import {
  WORKFLOW_SCHEDULE_PRESETS,
  emptyWorkflowDraft,
  type WorkflowDefinition,
  type WorkflowScheduleDraft,
} from '../../api/workflowApi';
import { setComposerSeed } from '../../api/composerSeed';
import { closeSettings } from '../../store/settingsUiStore';
import styles from './SettingsScheduleTab.module.css';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
} from './SettingsUI';
import {
  FILTER_OPTIONS,
  draftFromWorkflow,
} from './workflowsSharedLib';
import { useWorkflowsState } from './useWorkflowsState';
import { WorkflowForm } from './WorkflowForm';
import { WorkflowList } from './WorkflowList';

type Props = {
  onShowToast: (msg: string) => void;
};

export const SettingsScheduleTab: React.FC<Props> = ({ onShowToast }) => {
  const state = useWorkflowsState({
    surface: 'settings',
    onShowToast,
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
  const [createMode, setCreateMode] = useState<'none' | 'paths' | 'form'>('none');
  const [wfDraft, setWfDraft] = useState<WorkflowScheduleDraft>(emptyWorkflowDraft);
  const [editingWorkflow, setEditingWorkflow] = useState<WorkflowDefinition | null>(null);

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

  /** 关闭设置，在对话里用 AI 写定时任务名称与提示词 */
  const handleAiCreateSchedule = () => {
    setComposerSeed(
      [
        '请帮我设计一个 Crish 定时任务。',
        '输出：任务名称、触发方式（手动 / 每日时刻 / 间隔分钟）、完整提示词（可直接粘贴使用）。',
        '我想用它来：',
      ].join('\n'),
    );
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
      <div
        aria-busy={loading || busy}
        aria-label="定时任务"
      >
        <div className={`sched-settings-toolbar ${styles.toolbar}`} role="toolbar" aria-label="筛选与新建">
          <div className="settings-choice-group" role="group" aria-label="任务筛选">
            {FILTER_OPTIONS.map((opt) => {
              const active = filter === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={`settings-choice-btn ${active ? 'active' : ''}`}
                  aria-pressed={active}
                  onClick={() => setFilter(opt.id)}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
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
          >
            <Lucide.Plus size={16} aria-hidden />
            {createMode !== 'none' ? '收起' : '新建'}
          </button>
        </div>

        {(error || ok) && (
          <div
            className="sched-settings-status"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {error ? (
              <span className="settings-list-sub settings-list-sub--force" role="alert">
                {error}
              </span>
            ) : null}
            {ok && !error ? (
              <span className="settings-list-sub settings-list-sub--force" role="status">
                {ok}
              </span>
            ) : null}
          </div>
        )}

        {createMode === 'paths' ? (
        <div className="settings-create-paths" id="sched-settings-form">
          <button
            type="button"
            className="settings-create-path"
            onClick={handleAiCreateSchedule}
          >
            <span className="settings-create-path-title">用对话创建</span>
            <span className="settings-create-path-desc">
              描述目标和频率，让 AI 帮你写好（推荐）
            </span>
          </button>
          <button
            type="button"
            className="settings-create-path"
            onClick={() => {
              setCreateMode('form');
              setError('');
              setOk('');
            }}
          >
            <span className="settings-create-path-title">手动创建</span>
            <span className="settings-create-path-desc">
              自己填名称、内容和触发方式
            </span>
          </button>
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
