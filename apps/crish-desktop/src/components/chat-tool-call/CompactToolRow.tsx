import React, { Suspense, useState, useMemo, useEffect } from 'react';
import styles from './ChatToolCallBlock.module.css';
import type { MessageToolCall } from '../../store/types';
import { ApprovalAskCard } from '../agent-card/ApprovalAskCard';
import { isEditToolName } from '../../api/toolFeedback';
import {
  extractToolCommand,
  formatToolDiffStat,
  isToolRowDefaultOpen,
  normalizeToolDiffStat,
  resolveToolRowOpen,
  toolCommandPreview,
  toolDiffLineStats,
  toolHasExpandableBody,
  toolHumanLabel,
  toolPathDisplayName,
  toolRowTone,
} from '../../api/toolPresentation';
import { extractFilePathFromToolArgs } from '../../api/workspaceFsApi';
import type { ChatToolStackProps } from './ChatToolCallBlock';
import { ToolCallHeader } from './ToolCallHeader';
import { ToolCallOutput } from './ToolCallOutput';
import { toolStatusZh, toolResultBodyId, findAgentForTool } from './chatToolCallUtils';

export interface CompactToolRowProps {
  tc: MessageToolCall;
  rowKey: string | number;
  msgId?: string | undefined;
  props: ChatToolStackProps;
}

export const CompactToolRow: React.FC<CompactToolRowProps> = ({
  tc,
  rowKey,
  msgId,
  props,
}) => {
  const {
    agents,
    activeSessionId,
    expandedTools,
    onToggleTool,
    approvalBusy,
    pendingApprovalMsgId,
  } = props;
  const {
    onOpenDiff,
    onOpenPath,
    onOpenTerminal,
    onApprovalAllow,
    onApprovalDeny,
    onRetryTool,
    renderLinkedAgentPanel,
  } = props.actions ?? {};

  const [liveNow, setLiveNow] = useState(Date.now());
  useEffect(() => {
    if (tc.status !== 'running' || !tc.startedAt) return;
    const id = setInterval(() => setLiveNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [tc.status, tc.startedAt]);

  const durationStr = useMemo(() => {
    if (tc.startedAt && tc.completedAt) {
      const sec = (tc.completedAt - tc.startedAt) / 1000;
      return sec >= 0.1 ? `${sec.toFixed(1)}s` : null;
    }
    if (tc.status === 'running' && tc.startedAt) {
      const sec = (liveNow - tc.startedAt) / 1000;
      return `${sec.toFixed(1)}s`;
    }
    return null;
  }, [tc.startedAt, tc.completedAt, tc.status, liveNow]);

  if (tc.status === 'pending_approval') {
    const summary = toolHumanLabel(tc);
    const techFull = extractToolCommand(tc.arguments || '');
    const tech =
      techFull && techFull !== summary ? techFull : toolCommandPreview(tc, 72);
    const mid = msgId || pendingApprovalMsgId;
    return (
      <div
        key={rowKey}
        className={`${styles.toolRow} ${styles.toolRowApproval} ${styles.isPending} tool-row tool-row-approval is-pending`}
        data-tool-id={tc.id}
      >
        <ApprovalAskCard
          msgId={mid ?? ''}
          toolId={tc.id}
          summary={summary}
          cmd={tech && tech !== summary ? tech : techFull || undefined}
          busy={approvalBusy}
          riskMeta={tc.approvalMeta}
          onAllow={() => {
            if (tc.id && mid) onApprovalAllow?.(tc.id, mid, false);
          }}
          onAllowRemember={() => {
            if (tc.id && mid) onApprovalAllow?.(tc.id, mid, true);
          }}
          onDeny={() => {
            if (tc.id && mid) onApprovalDeny?.(tc.id, mid);
          }}
        />
      </div>
    );
  }

  const linkedAgent = findAgentForTool(tc, agents);
  if (linkedAgent && activeSessionId) {
    // 关联子 agent 行：由组合根注入的渲染器（ChatToolStackProps.renderLinkedAgentPanel）
    // 渲染内嵌 InlineAgentPanel；未注入（无子 agent 上下文）时回退普通工具行。
    const linkedPanel = renderLinkedAgentPanel?.(
      linkedAgent,
      activeSessionId,
      tc,
    );
    if (linkedPanel) {
      return (
        <Suspense
          key={String(rowKey)}
          fallback={
            <div
              className={`${styles.toolRow} ${styles.isRunning} tool-row is-running`}
            >
              <div
                className={`${styles.toolRowHead} ${styles.toolRowHeadStatic}`}
              >
                <span className={styles.toolRowIcoSlot} aria-hidden>
                  <span className={styles.toolRowLive}>
                    <span
                      className="loading-spinner"
                      style={{ width: 8, height: 8, borderWidth: 1.5 }}
                    />
                  </span>
                </span>
                <span className={styles.toolRowSummary}>协作子任务…</span>
              </div>
            </div>
          }
        >
          {linkedPanel}
        </Suspense>
      );
    }
  }

  const expandable = toolHasExpandableBody(tc);
  const defaultOpen = isToolRowDefaultOpen(tc);
  const isOpen = resolveToolRowOpen(expandedTools, tc.id, tc);
  const human = toolHumanLabel(tc);
  const running = tc.status === 'running';
  const tone = toolRowTone(tc.status);
  const statusZhText = toolStatusZh(tc.status);
  const canToggle = expandable;
  const bodyId = toolResultBodyId(tc.id);
  const filePath = extractFilePathFromToolArgs(tc.arguments || '');
  const n = (tc.name || '').toLowerCase();
  const pathClickable =
    Boolean(filePath) &&
    (isEditToolName(n) ||
      n.includes('read') ||
      n.includes('write') ||
      n.includes('edit') ||
      n.includes('glob'));
  const pathLabel = filePath ? toolPathDisplayName(filePath) : '';
  const diffStatsRaw = toolDiffLineStats(tc);
  const diffStats = diffStatsRaw ? normalizeToolDiffStat(diffStatsRaw) : null;
  const diffStatLabel = diffStats ? formatToolDiffStat(diffStats) : '';

  const rowAriaLabel = [
    human,
    statusZhText,
    diffStatLabel || null,
    canToggle ? (isOpen ? '已展开' : '已折叠') : null,
    canToggle ? (isOpen ? '按 Enter 或空格折叠' : '按 Enter 或空格展开') : null,
  ]
    .filter(Boolean)
    .join('，');

  return (
    <div
      className={`${styles.toolRow} ${
        tone === 'running'
          ? `${styles.isRunning} is-running`
          : tone === 'error'
            ? `${styles.isError} is-error`
            : tone === 'pending'
              ? `${styles.isPending} is-pending`
              : ''
      } ${isOpen ? `${styles.isOpen} is-open` : `${styles.isCollapsed} is-collapsed`} tool-row`}
      key={rowKey}
      data-tool-id={tc.id}
      data-tool-label={human}
      data-tool-status={statusZhText}
      data-default-collapsed={defaultOpen ? 'false' : 'true'}
      data-diff-stat={diffStatLabel || undefined}
      aria-busy={running || undefined}
    >
      <ToolCallHeader
        tc={tc}
        human={human}
        statusZh={statusZhText}
        running={running}
        isOpen={isOpen}
        canToggle={canToggle}
        durationStr={durationStr}
        diffStats={diffStats}
        pathClickable={pathClickable}
        filePath={filePath ?? ''}
        pathLabel={pathLabel}
        rowAriaLabel={rowAriaLabel}
        bodyId={bodyId}
        onToggleTool={onToggleTool}
        onOpenPath={onOpenPath}
        onRetryTool={onRetryTool}
      />
      {canToggle ? (
        <div
          className={`${styles.toolBody}${isOpen ? ' ' + styles.expanded : ''}`}
        >
          <div className={styles.toolBodyInner}>
            <ToolCallOutput
              tc={tc}
              bodyId={bodyId}
              onOpenDiff={onOpenDiff}
              onOpenTerminal={onOpenTerminal}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
};
