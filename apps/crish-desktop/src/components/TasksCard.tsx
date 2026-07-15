/**
 * 任务面板：会话工具步骤 + 本机备忘。
 * 正式版从当前会话 toolCalls 生成进度；可手动添加备忘（不伪造引擎计划）。
 */
import React, { useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import { useLayoutStore } from '../store/layoutStore';
import { isDemoMode } from '../api/appMode';
import { toolHumanLabel } from '../api/toolPresentation';
import type { MessageToolCall } from '../store/layoutStore';

type MemoTask = { id: string; text: string; done: boolean };

function toolStatusLabel(status: MessageToolCall['status']): string {
  if (status === 'running') return '进行中';
  if (status === 'pending_approval') return '待确认';
  if (status === 'error') return '失败';
  if (status === 'success') return '完成';
  return '步骤';
}

export const TasksCard: React.FC = () => {
  const demo = isDemoMode();
  const sessions = useLayoutStore((s) => s.sessions);
  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const planModeEnabled = useLayoutStore((s) => s.planModeEnabled);
  const planApproved = useLayoutStore((s) => s.planApproved);
  const setPlanApproved = useLayoutStore((s) => s.setPlanApproved);

  const session = sessions.find((s) => s.id === activeSessionId);

  const engineSteps = useMemo(() => {
    const tools = session?.messages?.flatMap((m) => m.toolCalls || []) || [];
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
  }, [session?.messages]);

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
  const totalTrack = engineSteps.length + memos.length;
  const doneTrack =
    doneEngine + memos.filter((t) => t.done).length + engineSteps.filter((t) => t.status === 'error').length;
  const pct = totalTrack ? Math.round((doneTrack / totalTrack) * 100) : 0;

  const handleAddTask = () => {
    if (!newIncomingTask.trim()) return;
    setMemos((prev) => [
      ...prev,
      { id: `task-${Date.now()}`, text: newIncomingTask.trim(), done: false },
    ]);
    setNewIncomingTask('');
    setIsAddingTask(false);
  };

  const empty = engineSteps.length === 0 && memos.length === 0 && !isAddingTask;

  return (
    <div className="tasks-card">
      <div className="card-subheader tasks-card-head">
        <div className="tasks-card-head-left">
          <span className="tasks-card-title">任务</span>
          {totalTrack > 0 ? (
            <span className="tasks-card-count">
              {doneTrack}/{totalTrack}
              {liveEngine > 0 ? ` · ${liveEngine} 进行中` : ''}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="sub-btn"
          title="添加备忘"
          onClick={() => setIsAddingTask(!isAddingTask)}
        >
          <Lucide.Plus size={16} />
        </button>
      </div>

      <div className="tasks-card-body">
        {planModeEnabled ? (
          <div className="tasks-plan-banner">
            <div className="tasks-plan-banner-t">计划模式：只读分析，不改项目文件</div>
            <button
              type="button"
              className={`overview-chip ${planApproved ? 'active' : ''}`}
              onClick={() => setPlanApproved(!planApproved)}
            >
              {planApproved ? '已确认计划' : '确认计划'}
            </button>
          </div>
        ) : null}

        {empty ? (
          <div className="tasks-empty">
            <Lucide.CheckSquare size={28} style={{ opacity: 0.35 }} />
            <div>暂无任务步骤</div>
            <div className="tasks-empty-sub">
              助手调用工具后，这里会显示进行中与已完成的步骤；也可手动添加备忘。
            </div>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('crish-open-overview'));
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
          <div className="tasks-progress-track" aria-hidden>
            <div className="tasks-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        ) : null}

        {engineSteps.length > 0 ? (
          <section className="tasks-section">
            <div className="tasks-section-h">本会话步骤</div>
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
                    <span className={`tasks-step-dot ${live ? 'live' : ''} ${failed ? 'err' : ''}`} />
                    <div className="tasks-step-main">
                      <span className="tasks-step-label" title={label}>
                        {label}
                      </span>
                      <span className="tasks-step-meta">{st}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {memos.length > 0 ? (
          <section className="tasks-section">
            <div className="tasks-section-h">备忘</div>
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
