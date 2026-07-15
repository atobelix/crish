/**
 * AI 多步进度板：解析助手 checklist + 引擎工具步骤 + 本机备忘。
 * 正式版不伪造引擎计划；goalMode 仅在会话字段存在时展示。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { useLayoutStore } from '../store/layoutStore';
import { isDemoMode } from '../api/appMode';
import { toolHumanLabel } from '../api/toolPresentation';
import { emitUiEvent } from '../api/uiEvents';
import type { MessageToolCall, SessionMessage, SessionState } from '../store/layoutStore';

type MemoTask = { id: string; text: string; done: boolean };

export type ChecklistItem = {
  id: string;
  text: string;
  done: boolean;
};

/** 解析 markdown 任务列表：`- [ ]` / `- [x]` / `* [ ]` / `* [x]` */
export function parseMarkdownChecklist(text: string | undefined | null): ChecklistItem[] {
  if (!text) return [];
  const items: ChecklistItem[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (!m) continue;
    const body = m[2].trim();
    if (!body) continue;
    items.push({
      id: `cl-${i}-${body.slice(0, 48)}`,
      text: body,
      done: m[1].toLowerCase() === 'x',
    });
  }
  return items;
}

/** 自后向前找最近一条含 checklist 的助手消息（流式中取最新正文） */
export function findLatestAssistantChecklist(messages: SessionMessage[] | undefined): {
  messageId: string | null;
  items: ChecklistItem[];
} {
  if (!messages?.length) return { messageId: null, items: [] };
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.sender !== 'assistant') continue;
    const items = parseMarkdownChecklist(m.text);
    if (items.length > 0) return { messageId: m.id, items };
  }
  return { messageId: null, items: [] };
}

function toolStatusLabel(status: MessageToolCall['status']): string {
  if (status === 'running') return '进行中';
  if (status === 'pending_approval') return '待确认';
  if (status === 'error') return '失败';
  if (status === 'success') return '完成';
  return '步骤';
}

/**
 * 轻量自动打开：会话首次出现 checklist 时派发 open-tasks（只一次）。
 * 须挂在始终挂载处（如 CardPanel），因 TasksCard 仅在任务页激活时渲染。
 */
export function useSuggestOpenTasksOnChecklist(session: SessionState | undefined): void {
  const firedForSession = useRef<string | null>(null);

  useEffect(() => {
    if (!session?.id) return;
    if (firedForSession.current === session.id) return;
    // 仅在本轮有 processing 助手消息时建议打开，避免历史 hydrate 抢面板
    const hasLive = session.messages?.some(
      (m) => m.sender === 'assistant' && m.status === 'processing',
    );
    if (!hasLive) return;
    const { items } = findLatestAssistantChecklist(session.messages);
    if (items.length === 0) return;
    firedForSession.current = session.id;
    // 轻量：只发事件，由 CardPanel 切换；每会话一次，不反复抢焦点
    try {
      emitUiEvent('open-tasks');
    } catch {
      /* ignore */
    }
  }, [session?.id, session?.messages]);
}

export const TasksCard: React.FC = () => {
  const demo = isDemoMode();
  const sessions = useLayoutStore((s) => s.sessions);
  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const permissionMode = useLayoutStore((s) => s.permissionMode);
  const planModeEnabled = useLayoutStore((s) => s.planModeEnabled);
  const planApproved = useLayoutStore((s) => s.planApproved);
  const setPlanApproved = useLayoutStore((s) => s.setPlanApproved);
  const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
  const setPanelAgentId = useLayoutStore((s) => s.setPanelAgentId);
  const inPlanMode = permissionMode === 'plan' || planModeEnabled;

  const session = sessions.find((s) => s.id === activeSessionId);
  const agents = session?.agents || [];

  const checklist = useMemo(() => {
    // 目标模式优先用 session.goalMode.tasks（与续写绑定）；否则解析助手 checklist
    const goalTasks = session?.goalMode?.tasks;
    if (goalTasks && goalTasks.length > 0) {
      return goalTasks.map((t) => ({
        id: t.id,
        text: t.text,
        done: Boolean(t.done),
      }));
    }
    return findLatestAssistantChecklist(session?.messages).items;
  }, [session?.messages, session?.goalMode?.tasks]);

  const engineSteps = useMemo(() => {
    // 主会话 + 协作 agent 工具步骤
    const tools: MessageToolCall[] = [
      ...(session?.messages?.flatMap((m) => m.toolCalls || []) || []),
      ...(session?.agents || []).flatMap((a) =>
        (a.messages || []).flatMap((m) => m.toolCalls || []),
      ),
    ];
    // 最近步骤倒序，去重 id，最多 40
    const seen = new Set<string>();
    const list: MessageToolCall[] = [];
    for (let i = tools.length - 1; i >= 0; i--) {
      const t = tools[i];
      if (!t?.id || seen.has(t.id)) continue;
      seen.add(t.id);
      list.push(t);
      if (list.length >= 40) break;
    }
    return list;
  }, [session?.messages, session?.agents]);

  const [memos, setMemos] = useState<MemoTask[]>(() =>
    demo
      ? [
          { id: 't1', text: '读取并锁定 trigger-injector.ts', done: true },
          { id: 't2', text: '重写 acquireInlineBtn 检测逻辑', done: false },
          { id: 't3', text: '执行构建校验', done: false },
        ]
      : [],
  );
  const [newIncomingTask, setNewIncomingTask] = useState('');
  const [isAddingTask, setIsAddingTask] = useState(false);

  React.useEffect(() => {
    if (!demo) return;
    setMemos((prev) => prev.map((t) => (t.id === 't2' ? { ...t, done: planApproved } : t)));
  }, [planApproved, demo]);

  const doneEngine = engineSteps.filter((t) => t.status === 'success').length;
  const liveEngine = engineSteps.filter(
    (t) => t.status === 'running' || t.status === 'pending_approval',
  ).length;
  const doneChecklist = checklist.filter((c) => c.done).length;
  const doneMemo = memos.filter((t) => t.done).length;
  const doneToolTerminal = engineSteps.filter(
    (t) => t.status === 'success' || t.status === 'error',
  ).length;

  const totalTrack = checklist.length + engineSteps.length + memos.length;
  const doneTrack = doneChecklist + doneToolTerminal + doneMemo;
  const pct = totalTrack ? Math.round((doneTrack / totalTrack) * 100) : 0;

  const goalMode = session?.goalMode?.active ? session.goalMode : null;
  const empty =
    checklist.length === 0 &&
    engineSteps.length === 0 &&
    memos.length === 0 &&
    !isAddingTask &&
    !goalMode;

  const handleAddTask = () => {
    if (!newIncomingTask.trim()) return;
    setMemos((prev) => [
      ...prev,
      { id: `task-${Date.now()}`, text: newIncomingTask.trim(), done: false },
    ]);
    setNewIncomingTask('');
    setIsAddingTask(false);
  };

  const openAgentBoard = () => {
    const first = agents[0];
    if (first?.id) setPanelAgentId(first.id);
    emitUiEvent('open-agent-panel', first?.id ? { agentId: first.id } : {});
  };

  return (
    <div className="tasks-card">
      <div className="card-subheader tasks-card-head">
        <div className="tasks-card-head-left">
          <span className="tasks-card-title">AI 进度</span>
          {totalTrack > 0 ? (
            <span className="tasks-card-count">
              {doneTrack}/{totalTrack}
              {pct > 0 ? ` · ${pct}%` : ''}
              {liveEngine > 0 ? ` · ${liveEngine} 进行中` : ''}
            </span>
          ) : null}
        </div>
        <div className="tasks-card-head-actions">
          {agents.length > 0 ? (
            <button
              type="button"
              className="tasks-agent-link"
              title="打开协作 Agent 看板"
              onClick={openAgentBoard}
            >
              查看协作看板
            </button>
          ) : null}
          <button
            type="button"
            className="sub-btn"
            title="添加备忘"
            onClick={() => setIsAddingTask(!isAddingTask)}
          >
            <Lucide.Plus size={16} />
          </button>
        </div>
      </div>

      <div className="tasks-card-body">
        {goalMode ? (
          <div className="tasks-goal-banner">
            <div className="tasks-goal-banner-top">
              <Lucide.Target size={14} className="tasks-goal-icon" />
              <span className="tasks-goal-label">目标</span>
              <span className="tasks-goal-iter">
                第 {(goalMode.iteration ?? 0) + 1}
                {typeof goalMode.maxIterations === 'number'
                  ? ` / ${goalMode.maxIterations}`
                  : ''}{' '}
                轮
              </span>
            </div>
            <div className="tasks-goal-text" title={goalMode.goal}>
              {goalMode.goal || '（未设置目标文案）'}
            </div>
          </div>
        ) : null}

        {inPlanMode ? (
          <div className="tasks-plan-banner">
            <div className="tasks-plan-banner-t">
              计划模式：AI 只规划不改文件。审阅后可批准执行。
            </div>
            <div className="tasks-plan-banner-actions">
              <button
                type="button"
                className="overview-chip"
                title="继续留在计划模式，只规划不改文件"
                onClick={() => {
                  /* 继续留在计划模式 */
                }}
              >
                继续计划
              </button>
              <button
                type="button"
                className={`overview-chip ${planApproved ? 'active' : ''}`}
                onClick={() => {
                  setPermissionMode('ask');
                  setPlanApproved(true);
                }}
              >
                批准执行
              </button>
            </div>
          </div>
        ) : null}

        {inPlanMode || planApproved ? (
          <section className="tasks-section">
            <div className="tasks-section-h">当前计划状态</div>
            <div className="tasks-plan-status">
              <span className={`tasks-plan-status-dot ${planApproved ? 'is-yes' : ''}`} />
              <span>{planApproved ? '已批准' : '未批准'}</span>
              {inPlanMode ? (
                <span className="tasks-plan-status-meta">· 计划模式中</span>
              ) : planApproved ? (
                <span className="tasks-plan-status-meta">· 可执行</span>
              ) : null}
            </div>
          </section>
        ) : null}

        {empty ? (
          <div className="tasks-empty">
            <Lucide.ListChecks size={28} style={{ opacity: 0.35 }} />
            <div>暂无 AI 进度</div>
            <div className="tasks-empty-sub">
              助手在回复中写出 <code>- [ ]</code> 清单，或调用工具后，这里会汇总进度；也可手动添加备忘。
            </div>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              onClick={() => {
                emitUiEvent('open-overview');
              }}
            >
              打开总览
            </button>
          </div>
        ) : null}

        {isAddingTask ? (
          <div className="tasks-add-row">
            <input
              className="settings-field-input"
              style={{ flex: 1 }}
              placeholder="新备忘…"
              value={newIncomingTask}
              onChange={(e) => setNewIncomingTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddTask();
              }}
              autoFocus
            />
            <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={handleAddTask}>
              添加
            </button>
          </div>
        ) : null}

        {totalTrack > 0 ? (
          <div className="tasks-progress-block">
            <div className="tasks-progress-meta">
              <span>整体进度</span>
              <span>{pct}%</span>
            </div>
            <div className="tasks-progress-track" aria-hidden>
              <div className="tasks-progress-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : null}

        {checklist.length > 0 ? (
          <section className="tasks-section">
            <div className="tasks-section-h">
              <span>AI 进度</span>
              <span className="tasks-section-count">
                {doneChecklist}/{checklist.length}
              </span>
            </div>
            <ul className="tasks-checklist">
              {checklist.map((item) => (
                <li
                  key={item.id}
                  className={`tasks-check-item ${item.done ? 'is-done' : ''}`}
                >
                  <span className={`tasks-check-mark ${item.done ? 'checked' : ''}`} aria-hidden>
                    {item.done ? <Lucide.Check size={12} strokeWidth={2.5} /> : null}
                  </span>
                  <span className="tasks-check-text">{item.text}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {engineSteps.length > 0 ? (
          <section className="tasks-section">
            <div className="tasks-section-h">
              <span>工具步骤</span>
              <span className="tasks-section-count">
                {doneEngine}/{engineSteps.length}
                {liveEngine > 0 ? ` · ${liveEngine} 进行中` : ''}
              </span>
            </div>
            <ul className="tasks-step-list">
              {engineSteps.map((t) => {
                const label = toolHumanLabel(t);
                const st = toolStatusLabel(t.status);
                const live = t.status === 'running' || t.status === 'pending_approval';
                const failed = t.status === 'error';
                const done = t.status === 'success';
                return (
                  <li
                    key={t.id}
                    className={`tasks-step ${live ? 'is-live' : ''} ${failed ? 'is-error' : ''} ${done ? 'is-done' : ''}`}
                  >
                    <span
                      className={`tasks-step-dot ${live ? 'live' : ''} ${failed ? 'err' : ''} ${done ? 'ok' : ''}`}
                    />
                    <div className="tasks-step-main">
                      <span className="tasks-step-label" title={label}>
                        {label}
                      </span>
                      <span className="tasks-step-meta">{st}</span>
                    </div>
                    {done ? (
                      <Lucide.Check size={14} className="tasks-step-check" strokeWidth={2.25} />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {memos.length > 0 || isAddingTask ? (
          <section className="tasks-section">
            <div className="tasks-section-h">
              <span>备忘</span>
              {memos.length > 0 ? (
                <span className="tasks-section-count">
                  {doneMemo}/{memos.length}
                </span>
              ) : null}
            </div>
            <div className="tasks-memo-list">
              {memos.map((t) => (
                <label key={t.id} className="tasks-memo-item">
                  <input
                    type="checkbox"
                    checked={t.done}
                    onChange={() =>
                      setMemos((prev) =>
                        prev.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)),
                      )
                    }
                  />
                  <span className={t.done ? 'is-done' : ''}>{t.text}</span>
                </label>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
};
