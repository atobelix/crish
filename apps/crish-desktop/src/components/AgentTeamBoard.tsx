/**
 * 侧栏内 agent 切换列表（非多卡画布 / 非主列全屏）。
 * 点击必须走 openAgentInSidePanel（或调用方 onSelect），永不 setActiveAgentId 盖住主对话。
 */
import React, { useCallback, useId, useMemo, useRef } from 'react';
import * as Lucide from 'lucide-react';
import type { SessionAgent } from '../store/layoutStore';
import { openAgentInSidePanel } from '../api/openAgentPanel';
import { humanizeAgentSummary } from '../api/toolPresentation';

export interface AgentTeamBoardProps {
  agents: SessionAgent[];
  /** 当前聚焦 agent（高亮） */
  activeId?: string | null;
  /** 紧凑条带（嵌在单 agent 详情顶栏下方） */
  compact?: boolean;
  className?: string;
  /**
   * 选中回调。默认 openAgentInSidePanel；调用方应传入带 sessionId 的版本。
   * 契约：只开侧栏，禁止 setActiveAgentId。
   */
  onSelect?: (id: string) => void;
  /** 打开侧栏时绑定的会话（默认 onSelect 用） */
  sessionId?: string | null;
  /**
   * agents 为空时是否渲染空态（默认 true）。
   * false 时空列表仍 return null（兼容父级自行门控）。
   */
  showEmpty?: boolean;
}

const STATUS_LABEL: Record<SessionAgent['status'], string> = {
  running: '运行中',
  completed: '完成',
  failed: '失败',
  stopped: '已停止',
};

/** compact 侧栏：摘要更短，避免挤掉工具 hint */
const SNIPPET_MAX = { full: 72, compact: 48 } as const;

/** 规范化 agent id：trim；空 → null（防幽灵选项） */
function normalizeAgentId(id: string | null | undefined): string | null {
  if (id == null) return null;
  const t = String(id).trim();
  return t ? t : null;
}

/** 展示名：description → mode → id → 中文兜底 */
function agentTitle(agent: SessionAgent): string {
  const raw = (agent.description || agent.mode || agent.id || '').trim();
  return raw || '子智能体';
}

/** 运行中优先 → 失败 → 已停止 → 完成；同组新在前 */
function rankAgentStatus(st: SessionAgent['status']): number {
  if (st === 'running') return 0;
  if (st === 'failed') return 1;
  if (st === 'stopped') return 2;
  return 3;
}

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

/** 紧凑时长：12秒 / 3分 / 1时2分（空则 null） */
function formatCompactDuration(agent: SessionAgent): string | null {
  const start = agent.startedAt;
  if (!start || !Number.isFinite(start)) return null;
  const end =
    agent.endedAt && Number.isFinite(agent.endedAt) ? agent.endedAt : Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}秒`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `${m}分${s}秒` : `${m}分`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h}时${m}分` : `${h}时`;
}

function isNoiseAgentLine(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^（?主\s*agent/i.test(t) || /已拉起协作/.test(t)) return true;
  if (/^mode=\w+/i.test(t) || /turns=\d+.*tools=\d+/i.test(t)) return true;
  return false;
}

function summarySnippet(agent: SessionAgent, maxLen: number): string {
  const clip = (raw: string) => {
    const t = raw.trim().replace(/\s+/g, ' ');
    return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
  };
  // 1) 清洗后的 summary（去掉 mode=/turns=）
  if ((agent.summary || '').trim()) {
    const h = humanizeAgentSummary(agent.summary, agent.status);
    if (h && !isNoiseAgentLine(h) && h !== '暂无摘要') return clip(h);
  }
  // 2) 最近助手正文
  const msgs = agent.messages || [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m.sender === 'assistant' && (m.text || '').trim()) {
      const t = m.text!.trim();
      if (isNoiseAgentLine(t)) continue;
      return clip(t);
    }
  }
  // 3) 用户任务句（跳过系统灌入）
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m.sender === 'user' && (m.text || '').trim()) {
      const t = m.text!.trim();
      if (isNoiseAgentLine(t)) continue;
      return clip(t);
    }
  }
  return humanizeAgentSummary('', agent.status);
}

/** 工具进度：完成态隐藏「工具 n/n」，只在运行/待批时展示 */
function formatToolsHint(
  agent: SessionAgent,
  prog: ReturnType<typeof toolProgress>,
  compact: boolean,
): string {
  if (prog.total <= 0) {
    return agent.status === 'running' ? '执行中…' : '';
  }
  // 已结束：时长/状态已够，不再刷「工具 9/9」
  if (agent.status === 'completed' || agent.status === 'stopped') {
    return '';
  }
  if (agent.status === 'failed') {
    return compact ? `工具 ${prog.done}/${prog.total}` : `工具 ${prog.done}/${prog.total}`;
  }
  if (compact) {
    let h = `工具 ${prog.done}/${prog.total}`;
    if (prog.pending) h += ` · 待批${prog.pending}`;
    else if (prog.running) h += ` · 执行${prog.running}`;
    return h;
  }
  return `工具 ${prog.done}/${prog.total}${
    prog.running ? ` · ${prog.running} 执行中` : ''
  }${prog.pending ? ` · ${prog.pending} 待批` : ''}`;
}

function progressPercent(
  agent: SessionAgent,
  prog: ReturnType<typeof toolProgress>,
): number {
  if (prog.total > 0) return Math.round((prog.done / prog.total) * 100);
  if (agent.status === 'completed') return 100;
  if (agent.status === 'running') return 35;
  if (agent.status === 'failed') return 100;
  return 0;
}

export const AgentTeamBoard: React.FC<AgentTeamBoardProps> = React.memo(
  ({
    agents,
    activeId,
    compact,
    className,
    onSelect,
    sessionId,
    showEmpty = true,
  }) => {
    const reactId = useId();
    const listRef = useRef<HTMLDivElement>(null);
    const optionIdPrefix = `agent-team-opt-${reactId.replace(/:/g, '')}`;

    const sorted = useMemo(() => {
      const list = (agents || []).filter((a) => normalizeAgentId(a?.id));
      return [...list].sort((a, b) => {
        const d = rankAgentStatus(a.status) - rankAgentStatus(b.status);
        if (d !== 0) return d;
        return (b.startedAt || 0) - (a.startedAt || 0);
      });
    }, [agents]);

    const boardStats = useMemo(() => {
      let runningN = 0;
      let failedN = 0;
      let pendingN = 0;
      for (const a of sorted) {
        if (a.status === 'running') runningN += 1;
        if (a.status === 'failed') failedN += 1;
        pendingN += toolProgress(a).pending;
      }
      return { runningN, failedN, pendingN, total: sorted.length };
    }, [sorted]);

    /**
     * 唯一入口：侧栏；不点亮主列 activeAgent。
     * 已选中则 no-op（避免清草稿误触）。id 空/空白忽略。
     */
    const select = useCallback(
      (rawId: string) => {
        const id = normalizeAgentId(rawId);
        if (!id) return;
        const cur = normalizeAgentId(activeId);
        if (cur && id === cur) return;
        if (onSelect) {
          onSelect(id);
          return;
        }
        // 默认：仅侧栏 openAgentInSidePanel（内部强制 activeAgentId=null）
        openAgentInSidePanel(id, sessionId ? { sessionId } : undefined);
      },
      [activeId, onSelect, sessionId],
    );

    /** listbox 方向键漫游焦点；Enter/Space 由 button 原生处理 */
    const onListKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (sorted.length === 0) return;
        const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'];
        if (!keys.includes(e.key)) return;

        const ids = sorted.map((a) => a.id);
        const activeEl = document.activeElement as HTMLElement | null;
        const focusedId = activeEl?.getAttribute?.('data-agent-id') || '';
        let idx = focusedId ? ids.indexOf(focusedId) : -1;
        if (idx < 0) {
          const cur = normalizeAgentId(activeId);
          idx = cur ? ids.indexOf(cur) : 0;
          if (idx < 0) idx = 0;
        }

        let next = idx;
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          next = (idx + 1) % ids.length;
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          next = (idx - 1 + ids.length) % ids.length;
        } else if (e.key === 'Home') {
          next = 0;
        } else if (e.key === 'End') {
          next = ids.length - 1;
        }
        e.preventDefault();
        const safe =
          typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(ids[next])
            : ids[next].replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const el = listRef.current?.querySelector<HTMLElement>(
          `[data-agent-id="${safe}"]`,
        );
        el?.focus();
      },
      [sorted, activeId],
    );

    const snippetMax = compact ? SNIPPET_MAX.compact : SNIPPET_MAX.full;
    const density = compact ? 'compact' : 'full';
    const headLabel = compact ? '侧栏切换' : '协作切换';
    const regionLabel = compact
      ? '侧栏切换子智能体'
      : '协作 agent 侧栏切换';

    // ── 空团队：中文空态（可 showEmpty=false 静默）────────────────────────
    if (sorted.length === 0) {
      if (!showEmpty) return null;
      return (
        <div
          className={`agent-team-board agent-team-board--hairline agent-team-board--empty ${compact ? 'agent-team-board--compact' : ''} ${className || ''}`}
          role="region"
          aria-label={regionLabel}
          data-agent-side-only="1"
          data-agent-team-board={density}
          data-empty="1"
          data-density={density}
        >
          <div className="agent-team-board-head">
            <Lucide.List size={12} strokeWidth={1.75} aria-hidden />
            <span className="agent-team-board-label">{headLabel}</span>
            <span className="agent-team-board-count" title="协作数量">
              0
            </span>
          </div>
          <div
            className="agent-team-board-grid"
            role="status"
            aria-live="polite"
            data-agent-team-empty="1"
          >
            <div className="agent-team-card-summary" style={{ padding: '4px 2px' }}>
              暂无协作 agent
              {!compact ? (
                <span style={{ display: 'block', marginTop: 2, color: 'var(--text-tertiary)' }}>
                  由主对话 AI 自动拉起；点开仅在侧栏查看，不覆盖主对话。
                </span>
              ) : (
                <span style={{ color: 'var(--text-tertiary)' }}> · 仅侧栏查看</span>
              )}
            </div>
          </div>
        </div>
      );
    }

    const activeNorm = normalizeAgentId(activeId);
    const activeOptionId =
      activeNorm && sorted.some((a) => a.id === activeNorm)
        ? `${optionIdPrefix}-${activeNorm}`
        : undefined;

    return (
      <div
        className={`agent-team-board agent-team-board--hairline ${compact ? 'agent-team-board--compact' : ''} ${className || ''}`}
        role="listbox"
        aria-label={regionLabel}
        aria-orientation={compact ? 'vertical' : 'horizontal'}
        aria-activedescendant={activeOptionId}
        aria-busy={boardStats.runningN > 0 || undefined}
        data-agent-side-only="1"
        data-agent-team-board={density}
        data-density={density}
        data-empty="0"
        data-running={boardStats.runningN || undefined}
        data-pending={boardStats.pendingN || undefined}
        onKeyDown={onListKeyDown}
        ref={listRef}
      >
        <div className="agent-team-board-head">
          <Lucide.List size={12} strokeWidth={1.75} aria-hidden />
          <span className="agent-team-board-label">{headLabel}</span>
          {boardStats.runningN > 0 ? (
            <span
              className="agent-team-board-stat"
              title="运行中"
              aria-label={`${boardStats.runningN} 个运行中`}
            >
              {boardStats.runningN} 运行
            </span>
          ) : null}
          {boardStats.failedN > 0 ? (
            <span
              className="agent-team-board-stat agent-team-board-stat--warn"
              title="失败"
              aria-label={`${boardStats.failedN} 个失败`}
            >
              {boardStats.failedN} 失败
            </span>
          ) : null}
          {boardStats.pendingN > 0 ? (
            <span
              className="agent-team-board-stat agent-team-board-stat--warn"
              title="待审批工具"
              aria-label={`${boardStats.pendingN} 项待批`}
            >
              {boardStats.pendingN} 待批
            </span>
          ) : null}
          <span
            className="agent-team-board-count"
            title="协作数量"
            aria-label={`共 ${boardStats.total} 个协作`}
          >
            {boardStats.total}
          </span>
        </div>
        <div className="agent-team-board-grid" role="presentation">
          {sorted.map((a) => {
            const prog = toolProgress(a);
            const pct = progressPercent(a, prog);
            const isOn = activeNorm === a.id;
            const title = agentTitle(a);
            const snippet = summarySnippet(a, snippetMax);
            const toolsHint = formatToolsHint(a, prog, !!compact);
            const dur = formatCompactDuration(a);
            const optionId = `${optionIdPrefix}-${a.id}`;
            const progressText =
              toolsHint ||
              (dur
                ? `${STATUS_LABEL[a.status]} · ${dur}`
                : STATUS_LABEL[a.status]);
            // roving tabindex：当前项 0，其余 -1（无 active 时首项可 Tab 入）
            const isTabStop =
              isOn || (!activeNorm && sorted[0]?.id === a.id);

            return (
              <button
                key={a.id}
                id={optionId}
                type="button"
                role="option"
                tabIndex={isTabStop ? 0 : -1}
                className={`agent-team-card agent-team-card--${a.status} ${isOn ? 'is-active' : ''}`}
                onClick={() => select(a.id)}
                aria-selected={isOn}
                aria-current={isOn ? 'true' : undefined}
                data-agent-id={a.id}
                data-agent-status={a.status}
                data-agent-active={isOn ? '1' : undefined}
                data-agent-side-only="1"
                aria-label={`${title}，${STATUS_LABEL[a.status]}${
                  toolsHint ? `，${toolsHint}` : ''
                }${dur ? `，${dur}` : ''}。在侧栏打开`}
                title={[title, snippet, toolsHint, dur ? `用时 ${dur}` : '']
                  .filter(Boolean)
                  .join('\n')}
              >
                <div className="agent-team-card-top">
                  <span className="agent-team-card-title">{title}</span>
                  <span
                    className={`agent-card-badge agent-card-badge--${a.status}`}
                    aria-hidden
                  >
                    {STATUS_LABEL[a.status]}
                  </span>
                </div>
                {/* compact：单行摘要+工具/时长，提高侧栏信息密度 */}
                {compact ? (
                  <div className="agent-team-card-meta-line">
                    <span className="agent-team-card-summary agent-team-card-summary--inline">
                      {snippet}
                    </span>
                    {toolsHint ? (
                      <span className="agent-team-card-tools">{toolsHint}</span>
                    ) : dur ? (
                      <span className="agent-team-card-tools" title={`用时 ${dur}`}>
                        {dur}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <div className="agent-team-card-summary">
                    {snippet}
                    {dur ? (
                      <span style={{ color: 'var(--text-tertiary)' }}>{` · ${dur}`}</span>
                    ) : null}
                  </div>
                )}
                {/* 进度条纯视觉：文案已进 button aria-label，避免 button 内嵌 progressbar 角色 */}
                <div
                  className="agent-team-card-progress"
                  aria-hidden
                  data-progress-pct={pct}
                  data-progress-text={progressText}
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
