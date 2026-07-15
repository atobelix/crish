import React, { useState, useMemo } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import * as Lucide from 'lucide-react';
import { isDemoMode } from '../api/appMode';

export const TasksCard: React.FC = () => {
  const demo = isDemoMode();
  const { planApproved } = useLayoutStore();

  const [tasksList, setTasksList] = useState<
    Array<{ id: string; text: string; done: boolean }>
  >(() =>
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
    setTasksList((prev) =>
      prev.map((t) => (t.id === 't2' ? { ...t, done: planApproved } : t)),
    );
  }, [planApproved, demo]);

  const doneCount = useMemo(() => tasksList.filter((t) => t.done).length, [tasksList]);
  const pct = tasksList.length ? Math.round((doneCount / tasksList.length) * 100) : 0;

  const handleAddTask = () => {
    if (!newIncomingTask.trim()) return;
    setTasksList((prev) => [
      ...prev,
      { id: `task-${Date.now()}`, text: newIncomingTask.trim(), done: false },
    ]);
    setNewIncomingTask('');
    setIsAddingTask(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1, background: '#fff' }}>
      <div
        className="card-subheader"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 12px',
          borderBottom: '1px solid var(--border-subtle)',
          background: '#fff',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>任务</span>
          {tasksList.length > 0 && (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              {doneCount}/{tasksList.length}
            </span>
          )}
        </div>
        <button
          type="button"
          className="sub-btn"
          title="添加任务"
          onClick={() => setIsAddingTask(!isAddingTask)}
        >
          <Lucide.Plus size={14} />
        </button>
      </div>

      <div
        style={{
          padding: '14px 14px 20px',
          overflowY: 'auto',
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {!demo && tasksList.length === 0 && !isAddingTask && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              color: 'var(--text-tertiary)',
              fontSize: 13,
              textAlign: 'center',
              padding: 24,
              lineHeight: 1.6,
            }}
          >
            <Lucide.CheckSquare size={28} style={{ opacity: 0.35 }} />
            <div>任务列表尚未接入引擎计划</div>
            <div style={{ fontSize: 12 }}>可手动添加备忘，或在对话中让助手拆解步骤。</div>
          </div>
        )}

        {isAddingTask && (
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="settings-field-input"
              style={{ flex: 1 }}
              placeholder="新任务…"
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
        )}

        {tasksList.length > 0 && (
          <>
            <div
              style={{
                height: 4,
                borderRadius: 2,
                background: 'var(--bg-tertiary)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  background: 'var(--accent-color)',
                  transition: 'width 0.2s',
                }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {tasksList.map((t) => (
                <label
                  key={t.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={t.done}
                    onChange={() =>
                      setTasksList((prev) =>
                        prev.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)),
                      )
                    }
                  />
                  <span
                    style={{
                      textDecoration: t.done ? 'line-through' : 'none',
                      color: t.done ? 'var(--text-tertiary)' : 'var(--text-primary)',
                    }}
                  >
                    {t.text}
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
