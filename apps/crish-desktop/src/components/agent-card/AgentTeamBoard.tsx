/**
 * 侧栏内 agent 切换列表（非多卡画布 / 非主列全屏）。
 * 点击必须走 openAgentInSidePanel（或调用方 onSelect），永不 setActiveAgentId 盖住主对话。
 */
import React, { useCallback, useId, useMemo, useRef } from 'react';
import styles from './AgentCard.module.css';
import { ICON_STROKE } from '@/components/ui/icons';
import { Button, Tooltip } from '@/components/ui';

import type { SessionAgent } from '../../store/types';
import { openAgentInSidePanel } from '../../api/openAgentPanel';
import { AgentStatusDot } from './AgentStatusDot';
import {
  STATUS_LABEL,
  SNIPPET_MAX,
  normalizeAgentId,
  agentTitle,
  rankAgentStatus,
  toolProgress,
  formatCompactDuration,
  summarySnippet,
  formatToolsHint,
  progressPercent,
} from './agentTeamBoardUtils';

// 保留测试消费入口（AgentTeamBoard.title.test.ts 从 ./AgentTeamBoard 导入 agentTitle）
export { agentTitle } from './agentTeamBoardUtils';
import { AppIcon } from '@/components/ui/icons';

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
      [activeId, onSelect, sessionId]
    );

    /** listbox 方向键漫游焦点；Enter/Space 由 button 原生处理 */
    const onListKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (sorted.length === 0) return;
        const keys = [
          'ArrowDown',
          'ArrowUp',
          'ArrowRight',
          'ArrowLeft',
          'Home',
          'End',
        ];
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
        const targetId = ids[next];
        if (!targetId) return;
        const safe =
          typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(targetId)
            : targetId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const el = listRef.current?.querySelector<HTMLElement>(
          `[data-agent-id="${safe}"]`
        );
        el?.focus();
      },
      [sorted, activeId]
    );

    const snippetMax = compact ? SNIPPET_MAX.compact : SNIPPET_MAX.full;
    const density = compact ? 'compact' : 'full';
    const headLabel = compact ? '侧栏切换' : '协作切换';
    const regionLabel = compact ? '侧栏切换子智能体' : '协作 agent 侧栏切换';

    // ── 空团队：中文空态（可 showEmpty=false 静默）────────────────────────
    if (sorted.length === 0) {
      if (!showEmpty) return null;
      return (
        <div
          className={`${styles.agentTeamBoard} ${styles.agentTeamBoardHairline} ${styles.agentTeamBoardEmpty || 'agent-team-board--empty'} ${compact ? styles.agentTeamBoardCompact : ''} ${className || ''}`}
          role="region"
          aria-label={regionLabel}
          data-agent-side-only="1"
          data-agent-team-board={density}
          data-empty="1"
          data-density={density}
        >
          <div className={styles.agentTeamBoardHead}>
            <AppIcon name="list" size={12} aria-hidden />
            <span className={styles.agentTeamBoardLabel}>{headLabel}</span>
            <span className={styles.agentTeamBoardCount} aria-label="协作数量">
              0
            </span>
          </div>
          <div
            className={styles.agentTeamBoardGrid}
            role="status"
            aria-live="polite"
            data-agent-team-empty="1"
          >
            <div className={styles.agentTeamCardSummary}>暂无协作智能体</div>
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
        className={`${styles.agentTeamBoard} ${styles.agentTeamBoardHairline} ${compact ? styles.agentTeamBoardCompact : ''} ${className || ''}`}
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
        <div className={styles.agentTeamBoardHead}>
          <AppIcon name="list" size={12} aria-hidden />
          <span className={styles.agentTeamBoardLabel}>
            {compact ? '子智能体' : '协作智能体'} ({boardStats.total})
          </span>
          <div
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {boardStats.runningN > 0 ? (
              <span
                className={styles.statusSpinner}
                aria-label="有正在运行的子智能体"
              >
                <svg className={styles.spinnerSvg} viewBox="0 0 24 24">
                  <circle
                    className={styles.spinnerCircle}
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="var(--text-tertiary)"
                    strokeWidth={ICON_STROKE.heavy}
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray="40, 10"
                  />
                </svg>
              </span>
            ) : boardStats.pendingN > 0 || boardStats.failedN > 0 ? (
              <span
                className={styles.statusDot}
                style={{ backgroundColor: 'var(--accent-orange)' }}
                aria-label="有待审批或失败的协作"
              />
            ) : (
              <span
                className={styles.statusDot}
                style={{ backgroundColor: 'var(--accent-green)' }}
                aria-label="所有协作已完成"
              />
            )}
          </div>
        </div>
        <div className={styles.agentTeamBoardGrid} role="presentation">
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
            const isTabStop = isOn || (!activeNorm && sorted[0]?.id === a.id);

            return (
              <Tooltip
                key={a.id}
                content={[title, snippet, toolsHint, dur ? `用时 ${dur}` : '']
                  .filter(Boolean)
                  .join('\n')}
              >
                <Button
                  bare
                  id={optionId}
                  type="button"
                  role="option"
                  tabIndex={isTabStop ? 0 : -1}
                  className={`${styles.agentTeamCard} ${styles['agentTeamCard' + a.status.charAt(0).toUpperCase() + a.status.slice(1)] || ''} ${isOn ? styles.isActive : ''}`}
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
                >
                  <div className={styles.agentTeamCardTop}>
                    <AgentStatusDot status={a.status} />
                    <span className={styles.agentTeamCardTitle}>{title}</span>
                  </div>
                  {/* compact：单行摘要+工具/时长，提高侧栏信息密度 */}
                  {compact ? (
                    <div className={styles.agentTeamCardMetaLine}>
                      <span
                        className={`${styles.agentTeamCardSummary} ${styles.agentTeamCardSummaryInline}`}
                      >
                        {snippet}
                      </span>
                      {toolsHint ? (
                        <span className={styles.agentTeamCardTools}>
                          {toolsHint}
                        </span>
                      ) : dur ? (
                        <span className={styles.agentTeamCardTools}>{dur}</span>
                      ) : null}
                    </div>
                  ) : (
                    <div className={styles.agentTeamCardSummary}>
                      {snippet}
                      {dur ? (
                        <span
                          style={{ color: 'var(--text-tertiary)' }}
                        >{` · ${dur}`}</span>
                      ) : null}
                    </div>
                  )}
                  {/* 进度条纯视觉：文案已进 button aria-label，避免 button 内嵌 progressbar 角色 */}
                  <div
                    className={styles.agentTeamCardProgress}
                    aria-hidden
                    data-progress-pct={pct}
                    data-progress-text={progressText}
                  >
                    <div className={styles.agentTeamCardBar}>
                      <div
                        className={`${styles.agentTeamCardBarFill} ${styles['agentTeamCardBarFill' + a.status.charAt(0).toUpperCase() + a.status.slice(1)] || ''}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {!compact && toolsHint ? (
                      <span className={styles.agentTeamCardTools}>
                        {toolsHint}
                      </span>
                    ) : null}
                  </div>
                </Button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    );
  }
);

AgentTeamBoard.displayName = 'AgentTeamBoard';
