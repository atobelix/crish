/**
 * InlineAgentPanel 折叠头（F1-β 拆分，纯展示）：
 * 标题 / 状态徽标 / 待批计数 / mode / 消息计数 / 侧栏入口 / 折叠态停止。
 * 零 hook / 零 store，全部经 props 传入（壳组件收敛编排）。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './InlineAgentPanel.module.css';
import { Button, Tooltip } from '../ui';
import type { SessionAgent } from '../../store/types';

export interface InlineAgentPanelHeaderProps {
  open: boolean;
  onToggleOpen: () => void;
  status: SessionAgent['status'];
  running: boolean;
  stopping: boolean;
  /** 折叠态停止（L2，壳已绑定 summary） */
  onStop: () => void;
  displayLabel: string;
  statusLabel: string;
  pendingTools: number;
  mode?: string | null;
  msgCount: number;
  summary?: string;
  sideFocused: boolean;
  sideOpenTitle: string;
  sideOpenAria: string;
  /** 侧栏入口禁用（无有效 agentId） */
  sideDisabled: boolean;
  onOpenSide: (e?: React.MouseEvent) => void;
  labelDomId: string;
  bodyDomId: string;
}

export const InlineAgentPanelHeader: React.FC<InlineAgentPanelHeaderProps> = ({
  open,
  onToggleOpen,
  status,
  running,
  stopping,
  onStop,
  displayLabel,
  statusLabel,
  pendingTools,
  mode,
  msgCount,
  summary,
  sideFocused,
  sideOpenTitle,
  sideOpenAria,
  sideDisabled,
  onOpenSide,
  labelDomId,
  bodyDomId,
}) => {
  return (
    <div className={styles.inlineAgentHeadRow}>
      <button
        type="button"
        className={styles.inlineAgentHead}
        aria-expanded={open}
        aria-controls={bodyDomId}
        id={labelDomId}
        onClick={onToggleOpen}
      >
        {running ? (
          <span className="tool-row-live" aria-hidden>
            <span
              className="loading-spinner"
              style={{ width: 8, height: 8, borderWidth: 1.5 }}
            />
          </span>
        ) : (
          <Lucide.Bot size={13} className="inline-agent-ico" aria-hidden />
        )}
        <span className={styles.inlineAgentLabel}>{displayLabel}</span>
        <span
          className={`${styles.inlineAgentBadge} ${
            status === 'running'
              ? styles.inlineAgentBadgeRunning
              : status === 'failed'
                ? styles.inlineAgentBadgeFailed
                : status === 'stopped'
                  ? styles.inlineAgentBadgeStopped
                  : ''
          }`}
          aria-live="polite"
        >
          {statusLabel}
        </span>
        {pendingTools > 0 ? (
          <Tooltip content={`待审批 ${pendingTools} 项`}>
            <span
              className={`${styles.inlineAgentBadge} ${styles.inlineAgentBadgePending}`}
              aria-label={`待审批 ${pendingTools} 项`}
            >
              待批 {pendingTools}
            </span>
          </Tooltip>
        ) : null}
        {mode ? (
          <Tooltip content={mode}>
            <span className={styles.inlineAgentMode}>{mode}</span>
          </Tooltip>
        ) : null}
        <span className={styles.inlineAgentMeta}>
          {msgCount} 条{summary ? ` · ${summary.slice(0, 36)}` : ''}
        </span>
        <Lucide.ChevronRight
          size={13}
          className={`tool-row-chevron ${open ? 'rot' : ''}`}
          aria-hidden
        />
      </button>
      {/* 折叠态也可：停止 / 侧栏 only（不依赖展开 Composer） */}
      <div className={styles.inlineAgentHeadActions}>
        {running ? (
          <Tooltip content={stopping ? '停止中…' : '停止子智能体'}>
            <Button
              type="button"
              variant="danger"
              size="sm"
              className={`${styles.agentHeadBtn} ${styles.inlineAgentStopBtn}`}
              aria-label={stopping ? '正在停止子智能体' : '停止子智能体'}
              aria-busy={stopping || undefined}
              disabled={stopping}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onStop();
              }}
              icon={<Lucide.Square size={11} fill="currentColor" aria-hidden />}
            />
          </Tooltip>
        ) : null}
        <Tooltip content={sideOpenTitle}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`${styles.agentHeadBtn} ${sideFocused ? styles.isActive : ''}`}
            aria-label={sideOpenAria}
            aria-pressed={sideFocused}
            disabled={sideDisabled}
            onClick={onOpenSide}
            icon={<Lucide.PanelRight size={13} aria-hidden />}
          />
        </Tooltip>
      </div>
    </div>
  );
};
