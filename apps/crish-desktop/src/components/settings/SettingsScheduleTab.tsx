import { useToast } from '../../services/toast/ToastContext';
/**
 * 设置 · 定时任务：筛选、新建、编辑、启停与立即执行；成功静默，仅错误提示。
 * 壳组件：筛选与创建方式走 SegmentedControl（7px），动作走 ui/Button；
 * 状态/动作见 useWorkflowsState，表单/列表见 WorkflowForm / WorkflowList。
 */
import React, { useMemo, useState } from 'react';
import { getWorkspacePath } from '../../api/projectStore';
import { emitUiEvent } from '../../api/uiEvents';
import {
  WORKFLOW_SCHEDULE_PRESETS,
  emptyWorkflowDraft,
  type WorkflowDefinition,
  type WorkflowRunEntry,
  type WorkflowScheduleDraft,
} from '../../api/workflowApi';
import { useSessionStore } from '../../store/storeAccess';
import { sessionDraftManager } from '../../api/draft/sessionDraftManager';
import { closeSettings, navigateToChatSession } from '../../store/storeAccess';
import styles from './SettingsScheduleTab.module.css';
import { Button, SegmentedControl } from '../ui';
import { SettingsPage, SettingsSection, SettingsCard } from './SettingsUI';
import {
  FILTER_OPTIONS,
  draftFromWorkflow,
  ensureScheduledSession,
  type ScheduleFilter,
} from './workflowsSharedLib';
import { useWorkflowsState } from './useWorkflowsState';
import { WorkflowForm } from './WorkflowForm';
import { WorkflowList } from './WorkflowList';
import { RunHistoryList } from './RunHistoryList';
import { AppIcon } from '../ui/icons/index';
import { useI18n } from '../../i18n';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
};

export const SettingsScheduleTab: React.FC<Props> = ({
  _onBlockingOverlayChange,
}) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const state = useWorkflowsState({
    surface: 'settings',
    workspacePath: getWorkspacePath() || '',
  });
  const {
    workflows,
    runs,
    loading,
    busy,
    togglingIds,
    triggeringIds,
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
  } = state as typeof state & {
    togglingIds?: ReadonlySet<string>;
    triggeringIds?: ReadonlySet<string>;
  };

  /** none | paths 双入口 | form 手动表单 */
  const [createMode, setCreateMode] = useState<'none' | 'paths' | 'form'>(
    'none'
  );
  const [wfDraft, setWfDraft] =
    useState<WorkflowScheduleDraft>(emptyWorkflowDraft);
  const [editingWorkflow, setEditingWorkflow] =
    useState<WorkflowDefinition | null>(null);

  const workspacePath = getWorkspacePath() || '';

  const createPathOptions = useMemo(
    () => [
      {
        value: 'ai',
        label: t('settings.schedule.createAi', '用对话创建（推荐）'),
      },
      {
        value: 'manual',
        label: t('settings.schedule.createManual', '手动创建'),
      },
    ],
    [t]
  );

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
    requestAnimationFrame(() => {
      document
        .getElementById('sched-settings-form')
        ?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const handleOpenRunSession = (run: WorkflowRunEntry) => {
    const matchedWf = workflows.find((w) => w.id === run.workflowId);
    const wfName =
      matchedWf?.name || t('settings.schedule.defaultTaskName', '定时任务');
    const targetSessionId =
      run.sessionId || `sched-${run.workflowId}-${run.runId || Date.now()}`;
    ensureScheduledSession(targetSessionId, wfName, {
      activate: true,
      prompt:
        matchedWf?.prompt ||
        t('settings.schedule.defaultPrompt', '按计划执行定时任务'),
      status: run.status,
      startedAt: run.startedAt ? new Date(run.startedAt).getTime() : Date.now(),
    });
    closeSettings();
    navigateToChatSession(targetSessionId, {
      title: `[${t('settings.schedule.tag', '定时')}] ${wfName}`,
    });
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
        metadata: {
          source: 'settings_tab',
          title: t('settings.schedule.aiCreateTitle', '定时任务对话创建'),
        },
      });
      showToast(
        t(
          'settings.schedule.injectSuccessToast',
          '已填入定时任务对话创建提示，请返回对话补全'
        )
      );
    } else {
      console.warn('[SettingsScheduleTab] 无活跃会话，跳过草稿注入');
      showToast(
        t(
          'settings.schedule.noActiveSessionToast',
          '无活跃会话，无法注入创建提示'
        )
      );
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
    <SettingsPage title={t('settings.schedule.pageTitle', '定时任务')}>
      <div
        aria-busy={loading || busy}
        aria-label={t('settings.schedule.pageTitle', '定时任务')}
      >
        <div
          className={`sched-settings-toolbar ${styles.toolbar}`}
          role="toolbar"
          aria-label={t('settings.schedule.toolbarAria', '筛选与新建')}
        >
          <SegmentedControl
            aria-label={t('settings.schedule.filterAria', '任务筛选')}
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
            {createMode !== 'none'
              ? t('settings.schedule.collapse', '收起')
              : t('settings.schedule.new', '新建')}
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
              aria-label={t('settings.schedule.createModeAria', '创建方式')}
              size="sm"
              block
              className={styles.segment}
              disabled={busy}
              value={createMode === 'form' ? 'manual' : ''}
              options={createPathOptions}
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
              togglingIds={togglingIds}
              triggeringIds={triggeringIds}
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
              onOpenSession={(sid) => {
                closeSettings();
                navigateToChatSession(sid);
              }}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          title={t('settings.schedule.runHistorySection', '运行历史记录')}
        >
          <SettingsCard>
            <RunHistoryList
              variant="settings"
              runs={runs}
              workflows={workflows}
              onOpenRun={handleOpenRunSession}
              onRerun={(w) => {
                void handleTrigger(w);
              }}
            />
          </SettingsCard>
        </SettingsSection>
      </div>
    </SettingsPage>
  );
};
