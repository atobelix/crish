import React, { useState, useEffect, useMemo } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import * as Lucide from 'lucide-react';

export const TasksCard: React.FC = () => {
  const { planApproved } = useLayoutStore();

  const [tasksList, setTasksList] = useState<
    Array<{ id: string; text: string; done: boolean }>
  >([
    { id: 't1', text: '读取并锁定 trigger-injector.ts', done: true },
    { id: 't2', text: '重写 acquireInlineBtn 检测逻辑', done: false },
    { id: 't3', text: '执行构建校验', done: false },
  ]);
  const [newIncomingTask, setNewIncomingTask] = useState('');
  const [isAddingTask, setIsAddingTask] = useState(false);

  useEffect(() => {
    setTasksList((prev) =>
      prev.map((t) => (t.id === 't2' ? { ...t, done: planApproved } : t)),
    );
  }, [planApproved]);

  const doneCount = useMemo(() => tasksList.filter((t) => t.done).length, [tasksList]);
  const pct = tasksList.length
    ? Math.round((doneCount / tasksList.length) * 100)
    : 0;

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
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
            任务
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {doneCount}/{tasksList.length}
          </span>
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
        {tasksList.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <svg width={44} height={44} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
              <circle
                cx="22"
                cy="22"
                r="18"
                stroke="var(--bg-tertiary)"
                strokeWidth="3.5"
                fill="transparent"
              />
              <circle
                cx="22"
                cy="22"
                r="18"
                stroke="var(--accent-green)"
                strokeWidth="3.5"
                fill="transparent"
                strokeDasharray={2 * Math.PI * 18}
                strokeDashoffset={
                  2 * Math.PI * 18 - (pct / 100) * 2 * Math.PI * 18
                }
                strokeLinecap="round"
              />
            </svg>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                进度 {pct}%
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                {doneCount} 项已完成
              </div>
            </div>
          </div>
        )}

        {isAddingTask && (
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="ui-input"
              placeholder="新任务…"
              value={newIncomingTask}
              autoFocus
              onChange={(e) => setNewIncomingTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddTask();
                if (e.key === 'Escape') setIsAddingTask(false);
              }}
              style={{ flex: 1 }}
            />
            <button type="button" className="ui-btn ui-btn-success-solid ui-btn-sm" onClick={handleAddTask}>
              添加
            </button>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {tasksList.map((task) => (
            <label
              key={task.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '10px 4px',
                borderBottom: '1px solid var(--border-subtle)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={task.done}
                onChange={() => {
                  setTasksList((prev) =>
                    prev.map((t) =>
                      t.id === task.id ? { ...t, done: !t.done } : t,
                    ),
                  );
                }}
                style={{ marginTop: 3, accentColor: 'var(--accent-green)' }}
              />
              <span
                style={{
                  fontSize: 13,
                  lineHeight: 1.45,
                  color: task.done ? 'var(--text-tertiary)' : 'var(--text-primary)',
                  textDecoration: task.done ? 'line-through' : 'none',
                  flex: 1,
                }}
              >
                {task.text}
              </span>
              <button
                type="button"
                className="ui-btn ui-btn-ghost danger"
                title="删除"
                onClick={(e) => {
                  e.preventDefault();
                  setTasksList((prev) => prev.filter((t) => t.id !== task.id));
                }}
              >
                <Lucide.X size={13} />
              </button>
            </label>
          ))}
          {tasksList.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '16px 4px' }}>
              暂无任务，点击右上角添加
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
