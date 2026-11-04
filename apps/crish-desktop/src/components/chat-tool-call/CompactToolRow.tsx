import React, { useState, useMemo, useEffect, useCallback } from 'react';
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
  diffStatsFromFileDiffs,
  extractToolCommand,
  formatToolDiffStat,
  isToolRowDefaultOpen,
  normalizeToolDiffStat,
  resolveToolCallDiffs,
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
  STATUS_WORD,
  toolStatusZh,
  toolResultBodyId,
} from './chatToolCallUtils';
import {
  cancelToolBackgroundTask,
  parseToolBackgroundPlaceholder,
  toolBackgroundElapsedMs,
} from '../../api/toolBackgroundApi';
import { formatDurationLabel } from '../../api/tool-presentation/processMetricsEngine';
import { Button } from '@/components/ui';
import { useI18n } from '../../i18n';
import {
  useToolExpansionState,
  findPreviousToolInItems,
} from './toolExpansionState';
import { useRevealEntrance } from './useRevealEntrance';
import { markToolInteracted, settleToolReveal } from './toolRevealState';

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
    } = props.actions ?? {};
    const { t } = useI18n();

    // BG5：转后台识别——output 为 BG2 占位信封且 callId 与本行一致时，
    // 本行处于后台态（BG3 settled 回注替换 output 后信封消失、自动
    // 回到常规终态呈现）。取消的本地收口态仅活在本行内：注册表取消
    // 成功即先行呈「已停止」，settled 事件到达后由数据层接管。
    const backgroundPlaceholder = useMemo(() => {
      const ph = parseToolBackgroundPlaceholder(tc.output);
      return ph && ph.callId === tc.id ? ph : null;
    }, [tc.output, tc.id]);

    // E1 §7：一处派生——展开政策、行头改道目标、diff 统计共用同一
    // 解析 diff 列表（结构化 diffs 优先，否则输出解析 / 入参合成），
    // 禁止三处平行派生。政策函数内部亦走同一 resolveToolCallDiffs。
    const resolvedDiffs = useMemo(() => resolveToolCallDiffs(tc), [tc]);
    const [cancelState, setCancelState] = useState<
      'idle' | 'cancelling' | 'cancelled'
    >('idle');
    const backgroundActive = backgroundPlaceholder !== null;
    const backgroundSettledLocally =
      backgroundActive && cancelState === 'cancelled';

    const [liveNow, setLiveNow] = useState(Date.now());
    useEffect(() => {
      const runningLive = tc.status === 'running' && tc.startedAt;
      const backgroundLive = backgroundActive && !backgroundSettledLocally;
      if (!runningLive && !backgroundLive) return;
      // 活时长走字 tick 口径钉死 500ms（2026-11-02 整波收口裁定）
      const id = setInterval(() => setLiveNow(Date.now()), 500);
      return () => clearInterval(id);
    }, [tc.status, tc.startedAt, backgroundActive, backgroundSettledLocally]);

    const durationStr = useMemo(() => {
      // 后台态的已运行时长由行内后台条独占呈现，行头不重复计时
      if (backgroundActive) return null;
      if (tc.startedAt && tc.completedAt) {
        const sec = (tc.completedAt - tc.startedAt) / 1000;
        return sec >= 0.1 ? `${sec.toFixed(1)}s` : null;
      }
      if (tc.status === 'running' && tc.startedAt) {
        const sec = (liveNow - tc.startedAt) / 1000;
        return `${sec.toFixed(1)}s`;
      }
      return null;
    }, [tc.startedAt, tc.completedAt, tc.status, liveNow, backgroundActive]);

    const backgroundElapsedMs = backgroundPlaceholder
      ? toolBackgroundElapsedMs(backgroundPlaceholder, tc, liveNow)
      : null;

    const handleCancelBackground = async () => {
      if (!backgroundPlaceholder || cancelState !== 'idle') return;
      setCancelState('cancelling');
      const ok = await cancelToolBackgroundTask(backgroundPlaceholder.callId);
      // 取消未生效（已终态 / 命令缺失）时不伪造状态：退回 idle，
      // 条目真实状态以注册表与 settled 回注为准。
      setCancelState(ok ? 'cancelled' : 'idle');
    };

    // 定位前驱工具（支持显式 prevTc 注入或从 props.items 中按索引检索）
    const effectivePrevTc = useMemo(() => {
      if (prevTc) return prevTc;
      return findPreviousToolInItems(props?.items, tc.id);
    }, [prevTc, props?.items, tc.id]);

    // 100ms 原地替换缓冲契约、展开防抖与 usePreActionAnchor 相对位移状态机
    const {
      isOpen,
      canToggle,
      expansionPolicy,
      isFlipping,
      shouldReplace,
      handleToggle,
      rowRef,
      isAccordionAnimating,
      handleAccordionTransitionEnd,
    } = useToolExpansionState({
      tc,
      prevTc: effectivePrevTc,
      expandedTools,
      onToggleTool,
      activeSessionId,
      scrollerRef,
      vsm,
    });

    // AN4：工具行入场（实况 + 首次呈现 + 非原地替换才播，交错
    // 延时按挂载序发放；审批分支不挂入场——审批即时类归 AN2）
    const rowEntrance = useRevealEntrance({
      key: tc.id || '',
      eventTs: tc.completedAt ?? tc.startedAt,
      replaceHit: shouldReplace,
    });

    // AN4 让位（分析 §5.1）：行内任何指针按下 / 焦点进入都意味着
    // 人在接管这一行——登记交互并让进行中的输出排空同帧抵达终态
    const handleRevealSettle = useCallback(() => {
      if (!tc.id) return;
      markToolInteracted(tc.id);
      settleToolReveal(tc.id);
    }, [tc.id]);

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

    // 注：关联子 agent 的分派行不会到达本组件——R4b 起分派在组合根
    // （MessageToolCallsSection）已被提取为独立分派卡；未命中 agent 的
    // 分派调用按普通工具行在此呈现（降级口径与 findAgentForTool 一致）。

    const defaultOpen = isToolRowDefaultOpen(tc);
    const human = toolHumanLabel(tc);
    const running = tc.status === 'running';
    const tone = toolRowTone(tc.status);
    const statusZhText = backgroundActive
      ? backgroundSettledLocally
        ? STATUS_WORD.stopped
        : STATUS_WORD.backgrounded
      : toolStatusZh(tc.status);
    const bodyId = toolResultBodyId(tc.id);
    const filePath = extractFilePathFromToolArgs(tc.arguments || '');
    const n = (tc.name || '').toLowerCase();
    const pathClickable =
      Boolean(filePath) &&
      (isEditToolName(n) ||
        n.includes('read') ||
        n.includes('write') ||
        n.includes('edit') ||
        n.includes('glob') ||
        // E1 §6.3：file_stat / list_dir 路径同入可点集合——stat 点开
        // 文件查看器、list_dir 点开 files 面板定位目录（与 read 同路）
        n === 'file_stat' ||
        n.includes('stat') ||
        n === 'list_dir' ||
        n.includes('listdir'));
    const pathLabel = filePath ? toolPathDisplayName(filePath) : '';
    const targetDiff = resolvedDiffs[0];
    // 统计与改道共用一处派生：有可发布 diff 时按解析列表计；
    // 结构化 diffs 存在但全部不可发布时不回退文本统计（不可改道的
    // 行不贴统计）；其余沿 toolDiffLineStats 的输出文本口径。
    const diffStatsRaw =
      resolvedDiffs.length > 0
        ? diffStatsFromFileDiffs(resolvedDiffs)
        : tc.diffs && tc.diffs.length > 0
          ? null
          : toolDiffLineStats(tc);
    const diffStats = diffStatsRaw ? normalizeToolDiffStat(diffStatsRaw) : null;
    const diffStatLabel = diffStats ? formatToolDiffStat(diffStats) : '';

    // E1 §7：改道行——政策判 side-diff 且宿主提供 onOpenDiff 且有
    // 解析目标时整行改道；宿主未提供 onOpenDiff 时诚实降级为静态行
    const sideDiffActive =
      expansionPolicy === 'side-diff' &&
      Boolean(onOpenDiff) &&
      Boolean(targetDiff);

    const rowAriaLabel = [
      human,
      statusZhText,
      diffStatLabel || null,
      canToggle ? (isOpen ? '已展开' : '已折叠') : null,
      canToggle
        ? isOpen
          ? '按 Enter 或空格折叠'
          : '按 Enter 或空格展开'
        : sideDiffActive
          ? t('tool.toolRow.viewDiffInPanel')
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
        }${rowEntrance.entering ? ` ${styles.toolRowEnter}` : ''} tool-row`}
        key={rowKey}
        data-tool-id={tc.id}
        data-entering={rowEntrance.entering ? 'true' : undefined}
        onAnimationEnd={rowEntrance.handleAnimationEnd}
        onPointerDownCapture={handleRevealSettle}
        onFocusCapture={handleRevealSettle}
        style={
          rowEntrance.entering
            ? ({
                '--reveal-delay': `${rowEntrance.delayMs}ms`,
              } as React.CSSProperties)
            : undefined
        }
        data-tool-label={human}
        data-tool-status={statusZhText}
        data-tool-backgrounded={backgroundActive ? 'true' : undefined}
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
          targetDiff={targetDiff}
          sideDiff={sideDiffActive}
          onToggleTool={handleToggle}
          onOpenPath={onOpenPath}
          onOpenDiff={onOpenDiff}
        />
        {backgroundPlaceholder ? (
          <div
            className={styles.batchBar}
            data-testid={`tool-background-bar-${tc.id}`}
            data-background-state={cancelState}
            role="status"
          >
            <span className={styles.batchBarLabel}>
              {backgroundSettledLocally
                ? STATUS_WORD.stopped
                : t('tool.background.rowStatus', {
                    status: STATUS_WORD.backgrounded,
                    duration: formatDurationLabel(
                      backgroundElapsedMs ?? backgroundPlaceholder.elapsedMs
                    ),
                  })}
            </span>
            {!backgroundSettledLocally ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={cancelState === 'cancelling'}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleCancelBackground();
                }}
              >
                {cancelState === 'cancelling'
                  ? t('tool.background.cancelling')
                  : t('tool.background.cancel')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {canToggle ? (
          <div
            className={`${styles.toolBody}${isOpen ? ' ' + styles.expanded : ''}`}
            onTransitionEnd={handleAccordionTransitionEnd}
          >
            <div className={styles.toolBodyInner}>
              {isOpen ? (
                isAccordionAnimating ? (
                  <div
                    className={styles.toolSkeletonPlaceholder}
                    data-testid={`tool-skeleton-${tc.id}`}
                  >
                    <div className={styles.toolSkeletonLine} />
                    <div className={styles.toolSkeletonLineShort} />
                  </div>
                ) : (
                  <ToolCallOutput
                    tc={tc}
                    bodyId={bodyId}
                    onOpenDiff={onOpenDiff}
                    onOpenTerminal={onOpenTerminal}
                  />
                )
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    );
  },
  compactToolRowPropsEqual
);

CompactToolRow.displayName = 'CompactToolRow';
