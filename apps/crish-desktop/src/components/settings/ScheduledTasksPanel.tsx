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
  type WorkflowDefinition,
  type WorkflowRunEntry,
  type WorkflowScheduleDraft,
} from '../../api/workflowApi';
import { clearAgentPanelFocus } from '../../api/openAgentPanel';
import {
  navigateToChatSession,
  navigateToNewDraft,
} from '../../store/storeAccess';
import { useLayoutStore } from '../../store/layoutStore';
import { useSessionStore } from '../../store/sessionStore';
import { getWorkspacePath } from '../../api/projectStore';
import { sessionDraftManager } from '../../api/draft/sessionDraftManager';
import { dispatchWorkflowAssistantCard, WORKFLOW_CREATE_TEMPLATE } from '../../api/workflow-api/workflowAssistantCard';
import styles from './ScheduledTasksPanel.module.css';
import { Button, Tooltip, Menu } from '../ui';
import type { SelectOptionItem } from '../ui';
import { ensureScheduledSession, draftFromWorkflow } from './workflowsSharedLib';
import { useWorkflowsState } from './useWorkflowsState';
import { WorkflowForm } from './WorkflowForm';
import { WorkflowList } from './WorkflowList';
import { RunHistoryList } from './RunHistoryList';

type Props = {
  onBackToChat?: () => void;
};

export const ScheduledTasksPanel: React.FC<Props> = ({ onBackToChat }) => {
  const { showToast } = useToast();
  const currentWorkspacePath = getWorkspacePath();
  const state = useWorkflowsState({ surface: 'chat', workspacePath: currentWorkspacePath });
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
    handleSave,
    handleToggle,
    handleTrigger,
    handleDelete,
    maybeWatchHint,
  } = state;

  const [showForm, setShowForm] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<WorkflowDefinition | null>(null);
  const [draft, setDraft] = useState<WorkflowScheduleDraft>(() =>
    emptyWorkflowDraft(currentWorkspacePath)
  );
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createBtnRef = React.useRef<HTMLButtonElement>(null);

  const applyPreset = (presetId: string) => {
    const preset = WORKFLOW_SCHEDULE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setShowForm(true);
    setEditingWorkflow(null);
    setError('');
    setOk('');
    setDraft({ ...preset.draft, cwd: currentWorkspacePath || preset.draft.cwd });
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingWorkflow(null);
    setError('');
    setOk('');
    setDraft(emptyWorkflowDraft(currentWorkspacePath));
  };

  const handleEdit = (w: WorkflowDefinition) => {
    setShowForm(true);
    setEditingWorkflow(w);
    setError('');
    setOk('');
    setDraft(draftFromWorkflow(w));
  };

  const openRunSession = (run: WorkflowRunEntry) => {
    const matchedWf = workflows.find((w) => w.id === run.workflowId);
    const wfName = matchedWf?.name || '定时任务';
    const targetSessionId =
      run.sessionId || `sched-${run.workflowId}-${run.runId || Date.now()}`;
    ensureScheduledSession(targetSessionId, wfName, {
      activate: true,
      prompt: matchedWf?.prompt || '按计划执行定时任务',
      status: run.status,
      startedAt: run.startedAt ? new Date(run.startedAt).getTime() : Date.now(),
    });
    navigateToChatSession(targetSessionId, { title: `[定时] ${wfName}` });
    onBackToChat?.();
  };

  const handleFormSave = async () => {
    const saved = await handleSave(draft, editingWorkflow);
    if (!saved) return;
    setShowForm(false);
    setEditingWorkflow(null);
    setDraft(emptyWorkflowDraft());
  };

  const handleCreateInChat = () => {
    navigateToNewDraft();
    // 以 store 实际返回的会话 ID 定向注入（禁止 'draft' 字面量兜底）
    const activeSid = useSessionStore.getState().activeSessionId;
    if (!activeSid) {
      console.warn('[ScheduledTasksPanel] 未取到目标会话 ID，跳过草稿注入');
      onBackToChat?.();
      return;
    }
    sessionDraftManager.injectSeed({
      targetSessionId: activeSid,
      content: WORKFLOW_CREATE_TEMPLATE,
      mode: 'safe_seed',
      metadata: { source: 'schedule_panel', title: '定时任务编排模版' },
    });
    // 对话流可见助手卡片（被动直接注入，取代旧 addMessage 纯文本引导——
    // 卡片正文 = 助手指令的 wire 投影文本，WYSIWYG 单一来源）
    dispatchWorkflowAssistantCard(
      activeSid,
      getWorkspacePath() || '',
      'schedule_panel'
    );

    onBackToChat?.();
  };

  const handleSelectCreateMenu = (id: string) => {
    setCreateMenuOpen(false);
    if (id === 'chat') {
      handleCreateInChat();
    } else if (id === 'manual') {
      setEditingWorkflow(null);
      setDraft(emptyWorkflowDraft());
      setError('');
      setOk('');
      setShowForm(true);
    }
  };

  const createMenuItems: SelectOptionItem[] = [
    {
      id: 'chat',
      label: '在对话中创建',
      onClick: () => handleSelectCreateMenu('chat'),
    },
    {
      id: 'manual',
      label: '手动创建',
      onClick: () => handleSelectCreateMenu('manual'),
    },
  ];

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
        <div style={{ position: 'relative' }}>
          <Button
            ref={createBtnRef}
            type="button"
            variant="secondary"
            size="sm"
            className={styles.actionBtn}
            aria-expanded={showForm || createMenuOpen}
            aria-controls={showForm ? 'sched-in-chat-form' : undefined}
            onClick={() => {
              if (showForm) {
                closeForm();
              } else {
                setCreateMenuOpen((prev) => !prev);
              }
            }}
            icon={
              showForm ? (
                <Lucide.ChevronUp size={16} aria-hidden />
              ) : (
                <Lucide.Plus size={16} aria-hidden />
              )
            }
          >
            {showForm ? '收起' : '新建'}
          </Button>
          <Menu
            openState={{
              open: createMenuOpen,
              onOpenChange: setCreateMenuOpen,
            }}
            options={createMenuItems}
            anchor={createBtnRef}
            position={{ side: 'bottom', align: 'end' }}
            onSelect={(id) => handleSelectCreateMenu(id)}
            outsideHandlers={{
              onInteractOutside: () => setCreateMenuOpen(false),
            }}
          />
        </div>
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
          isEditing={Boolean(editingWorkflow)}
          workspacePath={currentWorkspacePath}
          onDraftChange={setDraft}
          onApplyPreset={applyPreset}
          onNameBlur={() => maybeWatchHint(draft.name)}
          onSave={() => {
            void handleFormSave();
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
        onEdit={handleEdit}
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
