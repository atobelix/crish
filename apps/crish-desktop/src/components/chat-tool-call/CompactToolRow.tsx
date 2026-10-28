import React, { Suspense, useState, useMemo, useEffect } from 'react';
import styles from './ChatToolCallBlock.module.css';
import type { MessageToolCall } from '../../store/types';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import {
  ApprovalAskCard,
  type ApprovalTimeoutPolicy,
} from '../agent-card/ApprovalAskCard';
import { slotCore } from '../../services/view-registry/SlotCore';
import '../chat-card/workspaceChatComposerAbove.slot';
import { isEditToolName } from '../../api/toolFeedback';
import {
  extractToolCommand,
  formatToolDiffStat,
  isToolRowDefaultOpen,
  normalizeToolDiffStat,
  toolCommandPreview,
  toolDiffLineStats,
  toolHumanLabel,
  toolPathDisplayName,
  toolRowTone,
} from '../../api/toolPresentation';
import { extractFilePathFromToolArgs } from '../../api/workspaceFsApi';
import type { ChatToolStackProps } from './ChatToolCallBlock';
import { ToolCallHeader } from './ToolCallHeader';
import { ToolCallOutput } from './ToolCallOutput';
import {
  toolStatusZh,
  toolResultBodyId,
  findAgentForTool,
} from './chatToolCallUtils';
import {
  useToolExpansionState,
  findPreviousToolInItems,
} from './toolExpansionState';

export interface CompactToolRowProps {
  tc: MessageToolCall;
  rowKey: string | number;
  msgId?: string | undefined;
  props: ChatToolStackProps;
  prevTc?: MessageToolCall | undefined;
  scrollerRef?: React.RefObject<HTMLElement | null> | undefined;
  vsm?: VirtualScrollManager | null | undefined;
}

/**
 * D7.4：React.memo——tc / props 引用稳定时跳过单行重渲染。
 * 比较器字段与 chatToolStackPropsEqual 同法（显式字段，禁伪 memo）。
 */
export function compactToolRowPropsEqual(
  a: CompactToolRowProps,
  b: CompactToolRowProps
): boolean {
  return (
    a.tc === b.tc &&
    a.rowKey === b.rowKey &&
    a.msgId === b.msgId &&
    a.prevTc === b.prevTc &&
    a.scrollerRef === b.scrollerRef &&
    a.vsm === b.vsm &&
    a.props === b.props
  );
}

export const CompactToolRow: React.FC<CompactToolRowProps> = React.memo(
  function CompactToolRow({
    tc,
    rowKey,
    msgId,
    props,
    prevTc,
    scrollerRef,
    vsm,
  }) {
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
      renderLinkedAgentPanel,
    } = props.actions ?? {};

    const [liveNow, setLiveNow] = useState(Date.now());
    useEffect(() => {
      if (tc.status !== 'running' || !tc.startedAt) return;
      const id = setInterval(() => setLiveNow(Date.now()), 500);
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

    // 定位前驱工具（支持显式 prevTc 注入或从 props.items 中按索引检索）
    const effectivePrevTc = useMemo(() => {
      if (prevTc) return prevTc;
      return findPreviousToolInItems(props?.items, tc.id);
    }, [prevTc, props?.items, tc.id]);

    // 100ms 原地替换缓冲契约、展开防抖与 usePreActionAnchor 相对位移状态机
    const {
      isOpen,
      canToggle,
      isFlipping,
      shouldReplace,
      handleToggle,
      rowRef,
    } = useToolExpansionState({
      tc,
      prevTc: effectivePrevTc,
      expandedTools,
      onToggleTool,
      activeSessionId,
      scrollerRef,
      vsm,
    });

    if (tc.status === 'pending_approval') {
      // 插件开：审批上提 composer 冷静条，流内不画 ApprovalAskCard
      if (slotCore.getSingle('workspace.chat.composerAbove')) {
        return null;
      }
      const summary = toolHumanLabel(tc);
      const techFull = extractToolCommand(tc.arguments || '');
      const tech =
        techFull && techFull !== summary
          ? techFull
          : toolCommandPreview(tc, 72);
      const mid = msgId || pendingApprovalMsgId;
      const approvalWired = Boolean(onApprovalAllow && onApprovalDeny);

      // 服务端下发的倒计时与策略权威元数据 (SSOT)：approvalMeta.metadata 透传
      const rawMeta: Record<string, unknown> =
        tc.approvalMeta?.metadata ??
        (tc.approvalMeta as unknown as Record<string, unknown> | undefined) ??
        {};

      const expiresAtMs: number | undefined =
        typeof rawMeta.expiresAtMs === 'number'
          ? rawMeta.expiresAtMs
          : undefined;

      const timeoutMs: number | undefined =
        typeof rawMeta.timeoutMs === 'number' ? rawMeta.timeoutMs : undefined;

      const timeoutPolicy: ApprovalTimeoutPolicy =
        rawMeta.timeoutPolicy === 'auto-allow' ||
        rawMeta.timeoutPolicy === 'auto-deny' ||
        rawMeta.timeoutPolicy === 'manual-only'
          ? rawMeta.timeoutPolicy
          : 'auto-deny';

      const actionHint: string | undefined =
        typeof rawMeta.actionHint === 'string' ? rawMeta.actionHint : undefined;

      const isPaused: boolean = Boolean(rawMeta.isPaused);

      return (
        <div
          key={rowKey}
          className={`${styles.toolRow} ${styles.toolRowApproval} ${styles.isPending} tool-row tool-row-approval is-pending`}
          data-tool-id={tc.id}
          data-approval-wired={approvalWired ? 'true' : 'false'}
          data-timeout-policy={timeoutPolicy}
        >
          {approvalWired ? (
            <ApprovalAskCard
              msgId={mid ?? ''}
              toolId={tc.id}
              summary={summary}
              cmd={tech && tech !== summary ? tech : techFull || undefined}
              busy={approvalBusy}
              riskMeta={tc.approvalMeta}
              expiresAtMs={expiresAtMs}
              timeoutMs={timeoutMs}
              timeoutPolicy={timeoutPolicy}
              actionHint={actionHint}
              isPaused={isPaused}
              onAllow={() => {
                if (tc.id && mid) onApprovalAllow!(tc.id, mid, false);
              }}
              onDeny={() => {
                if (tc.id && mid) onApprovalDeny!(tc.id, mid);
              }}
            />
          ) : (
            <div
              role="status"
              aria-live="polite"
              data-testid="approval-unavailable"
              style={{
                padding: '8px 10px',
                fontSize: 'var(--font-size-xs)',
                color: 'var(--text-secondary)',
              }}
            >
              审批操作不可用（未接入真实回调）
            </div>
          )}
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
        tc
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
                  <span className={styles.toolRowSummary}>
                    <span className={styles.toolActionText}>协作子任务…</span>
                  </span>
                </div>
              </div>
            }
          >
            {linkedPanel}
          </Suspense>
        );
      }
    }

    const defaultOpen = isToolRowDefaultOpen(tc);
    const human = toolHumanLabel(tc);
    const running = tc.status === 'running';
    const tone = toolRowTone(tc.status);
    const statusZhText = toolStatusZh(tc.status);
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
      canToggle
        ? isOpen
          ? '按 Enter 或空格折叠'
          : '按 Enter 或空格展开'
        : null,
    ]
      .filter(Boolean)
      .join('，');

    return (
      <div
        ref={rowRef}
        className={`${styles.toolRow} ${
          tone === 'running'
            ? `${styles.isRunning} is-running`
            : tone === 'error'
              ? `${styles.isError} is-error`
              : tone === 'pending'
                ? `${styles.isPending} is-pending`
                : ''
        } ${isOpen ? `${styles.isOpen} is-open` : `${styles.isCollapsed} is-collapsed`} ${
          isFlipping ? `${styles.inPlaceFlipping} is-in-place-flipping` : ''
        } tool-row`}
        key={rowKey}
        data-tool-id={tc.id}
        data-tool-label={human}
        data-tool-status={statusZhText}
        data-default-collapsed={defaultOpen ? 'false' : 'true'}
        data-diff-stat={diffStatLabel || undefined}
        data-in-place-replace={shouldReplace ? 'true' : undefined}
        data-in-place-flipping={isFlipping ? 'true' : undefined}
        data-expanded={isOpen ? 'true' : 'false'}
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
          onToggleTool={handleToggle}
          onOpenPath={onOpenPath}
          onOpenDiff={onOpenDiff}
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
  },
  compactToolRowPropsEqual
);

CompactToolRow.displayName = 'CompactToolRow';
