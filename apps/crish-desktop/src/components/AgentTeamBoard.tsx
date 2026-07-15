/**
 * 多代理协作看板：并行 agent 以 CI job 风格卡片网格展示。
 */
import React, { useMemo } from 'react';
import * as Lucide from 'lucide-react';
import { useLayoutStore } from '../store/layoutStore';
import type { SessionAgent } from '../store/layoutStore';

export interface AgentTeamBoardProps {
  agents: SessionAgent[];
  /** 当前聚焦 agent（高亮） */
  activeId?: string | null;
  /** 紧凑条带（嵌在单 agent 详情顶栏下方） */
  compact?: boolean;
  className?: string;
}

const STATUS_LABEL: Record<SessionAgent['status'], string> = {
  running: '运行中',
  completed: '完成',
  failed: '失败',
  stopped: '已停止',
};

function toolProgress(agent: SessionAgent): {
  total: number;
  done: number;
  running: number;
  pending: number;
} {
  const tools = (agent.messages || []).flatMap((m) => m.toolCalls || []);
  let done = 0;
  let running = 0;
  let pending = 0;
  for (const t of tools) {
    if (t.status === 'success' || t.status === 'error') done += 1;
    else if (t.status === 'running') running += 1;
    else pending += 1;
  }
  return { total: tools.length, done, running, pending };
}

function summarySnippet(agent: SessionAgent): string {
  const s = (agent.summary || '').trim();
  if (s) return s.length > 72 ? `${s.slice(0, 71)}…` : s;
  const msgs = agent.messages || [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m.sender === 'assistant' && (m.text || '').trim()) {
      const t = m.text!.trim().replace(/\s+/g, ' ');
      return t.length > 72 ? `${t.slice(0, 71)}…` : t;
    }
  }
  const user = msgs.find((m) => m.sender === 'user' && (m.text || '').trim());
  if (user?.text) {
    const t = user.text.trim().replace(/\s+/g, ' ');
    return t.length > 72 ? `${t.slice(0, 71)}…` : t;
  }
  return agent.status === 'running' ? '执行中…' : '暂无摘要';
}

export const AgentTeamBoard: React.FC<AgentTeamBoardProps> = React.memo(
  ({ agents, activeId, compact, className }) => {
    const setPanelAgentId = useLayoutStore((s) => s.setPanelAgentId);
    const setActiveAgentId = useLayoutStore((s) => s.setActiveAgentId);

    const sorted = useMemo(() => {
      const rank = (st: SessionAgent['status']) =>
        st === 'running' ? 0 : st === 'failed' ? 1 : st === 'stopped' ? 2 : 3;
      return [...agents].sort((a, b) => {
        const d = rank(a.status) - rank(b.status);
        if (d !== 0) return d;
        return (b.startedAt || 0) - (a.startedAt || 0);
      });
    }, [agents]);

    if (sorted.length === 0) return null;

    const onSelect = (id: string) => {
      setPanelAgentId(id);
      setActiveAgentId(id);
    };

    return (
      <div
        className={`agent-team-board ${compact ? 'agent-team-board--compact' : ''} ${className || ''}`}
        role="list"
        aria-label="协作看板"
      >
        <div className="agent-team-board-head">
          <Lucide.LayoutGrid size={13} strokeWidth={1.75} aria-hidden />
          <span className="agent-team-board-count" title="协作数量">
            {sorted.length}
          </span>
        </div>
        <div className="agent-team-board-grid">
          {sorted.map((a) => {
            const prog = toolProgress(a);
            const pct =
              prog.total > 0
                ? Math.round((prog.done / prog.total) * 100)
                : a.status === 'completed'
                  ? 100
                  : a.status === 'running'
                    ? 35
                    : 0;
            const isOn = activeId === a.id;
            const snippet = summarySnippet(a);
            const toolsHint =
              prog.total > 0
                ? `工具 ${prog.done}/${prog.total}${prog.running ? ` · ${prog.running} 执行中` : ''}`
                : a.status === 'running'
                  ? '执行中…'
                  : '';
            return (
              <button
                key={a.id}
                type="button"
                role="listitem"
                className={`agent-team-card agent-team-card--${a.status} ${isOn ? 'is-active' : ''}`}
                onClick={() => onSelect(a.id)}
                title={[a.description || a.mode || a.id, snippet, toolsHint]
                  .filter(Boolean)
                  .join('\n')}
              >
                <div className="agent-team-card-top">
                  <span className="agent-team-card-title">
                    {a.description || a.mode || a.id}
                  </span>
                  <span className={`agent-card-badge agent-card-badge--${a.status}`}>
                    {STATUS_LABEL[a.status]}
                  </span>
                </div>
                {/* 紧凑：只留标题+徽章+进度条；详情靠 title 悬浮 */}
                {!compact ? (
                  <div className="agent-team-card-summary">{snippet}</div>
                ) : null}
                <div
                  className="agent-team-card-progress"
                  aria-label={toolsHint || STATUS_LABEL[a.status]}
                >
                  <div className="agent-team-card-bar">
                    <div
                      className={`agent-team-card-bar-fill agent-team-card-bar-fill--${a.status}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {!compact && toolsHint ? (
                    <span className="agent-team-card-tools">{toolsHint}</span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  },
);

AgentTeamBoard.displayName = 'AgentTeamBoard';
