import { useToast } from '../../services/toast/ToastContext';
/**
 * 主对话区 · 定时任务：与设置页同源 workflow API，嵌入 chat-doc-flow 展示。
 * 壳组件：只保留头部 + 预设行 + 表单/列表/运行历史装配；共享状态与动作
 * 见 useWorkflowsState，表单/列表见 WorkflowForm / WorkflowList，
 * 最近运行见 RunHistoryList。
 * 密度：无 essay、单行表单、紧凑列表；toast 仅错误；占位会话不抢焦点。
 */
import React, { useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  WORKFLOW_SCHEDULE_PRESETS,
  emptyWorkflowDraft,
  type WorkflowRunEntry,
  type WorkflowScheduleDraft,
} from '../../api/workflowApi';
import { clearAgentPanelFocus } from '../../api/openAgentPanel';
import { setActiveSessionId } from '../../api/storeAccess';
import { useLayoutStore } from '../../store/layoutStore';
import styles from './ScheduledTasksPanel.module.css';
import { Button, Tooltip } from '../ui';
import { ensureScheduledSession } from './workflowsSharedLib';
import { useWorkflowsState } from './useWorkflowsState';
import { WorkflowForm } from './WorkflowForm';
import { WorkflowList } from './WorkflowList';
import { RunHistoryList } from './RunHistoryList';

type Props = {
  onBackToChat?: () => void;
};

export const ScheduledTasksPanel: React.FC<Props> = ({ onBackToChat }) => {
  const { showToast } = useToast();
  const state = useWorkflowsState({ surface: 'chat' });
  const {
    workflows,
    runs,
    loading,
    busy,
    error,
    ok,
    setError,
    setOk,
    emptyCopy,
    handleCreate,
    handleToggle,
    handleTrigger,
    handleDelete,
    maybeWatchHint,
  } = state;

  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<WorkflowScheduleDraft>(emptyWorkflowDraft);

  const applyPreset = (presetId: string) => {
    const preset = WORKFLOW_SCHEDULE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setShowForm(true);
    setError('');
    setOk('');
    setDraft({ ...preset.draft });
  };

  const closeForm = () => {
    setShowForm(false);
    setError('');
    setOk('');
    setDraft(emptyWorkflowDraft());
  };

  const openRunSession = (run: WorkflowRunEntry) => {
    if (!run.sessionId) {
      // 无会话：错误路径，可 toast
      showToast('该次运行暂无关联会话');
      return;
    }
    const wfName = workflows.find((w) => w.id === run.workflowId)?.name || '任务';
    ensureScheduledSession(run.sessionId, wfName, { activate: true });
    setActiveSessionId(run.sessionId);
    clearAgentPanelFocus();
    useLayoutStore.getState().setChatMainSurface('chat');
    onBackToChat?.();
    // 切会话即反馈，不 toast
  };

  const handleFormCreate = async () => {
    const created = await handleCreate(draft);
    if (!created) return;
    setShowForm(false);
    setDraft(emptyWorkflowDraft());
  };

  return (
    <div
      className={`${styles.schedInChat} ${styles.schedInChatDense}`}
      aria-busy={loading || busy}
      aria-label="定时任务"
    >
      <div className={styles.schedInChatHead}>
        <div className={styles.schedInChatTitles}>
          <h3 id="sched-in-chat-title">定时任务</h3>
          <span className={styles.schedInChatCount} aria-live="polite">
            {workflows.length > 0 ? `${workflows.length} 条` : ' '}
          </span>
        </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={styles.actionBtn}
              aria-expanded={showForm}
              aria-controls="sched-in-chat-form"
              onClick={() => {
                if (showForm) {
                  closeForm();
                } else {
                  setShowForm(true);
                  setError('');
                  setOk('');
                }
              }}
              icon={<Lucide.Plus size={16} aria-hidden />}
            >
              {showForm ? '收起' : '新建'}
            </Button>
          </div>

      <div className={styles.schedPresetRow}>
        <div className={styles.schedPresetChips} role="group" aria-label="计划模板">
          {WORKFLOW_SCHEDULE_PRESETS.map((p) => (
            <Button
              key={p.id}
              type="button"
              variant="secondary"
              size="sm"
              className={styles.schedPresetChip}
              disabled={busy}
              onClick={() => applyPreset(p.id)}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </div>

      {/* 状态：aria-live 行内；成功永不 toast */}
      <div className="sched-status-live" aria-live="polite" aria-relevant="additions text">
        {error ? (
          <Tooltip content={error}>
            <div className={`${styles.schedStatusLine} ${styles.isErr}`} role="alert">
              {error}
            </div>
          </Tooltip>
        ) : null}
        {ok && !error ? (
          <div className={`${styles.schedStatusLine} ${styles.isOk}`} role="status">
            {ok}
          </div>
        ) : null}
      </div>

      {showForm ? (
        <WorkflowForm
          variant="chat"
          formId="sched-in-chat-form"
          draft={draft}
          busy={busy}
          isEditing={false}
          onDraftChange={setDraft}
          onApplyPreset={applyPreset}
          onNameBlur={() => maybeWatchHint(draft.name)}
          onSave={() => {
            void handleFormCreate();
          }}
          onClose={closeForm}
        />
      ) : null}

      <WorkflowList
        variant="chat"
        workflows={workflows}
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
        listTitleId="sched-in-chat-title"
      />

      <RunHistoryList
        runs={runs}
        workflows={workflows}
        onOpenRun={openRunSession}
      />
    </div>
  );
};
