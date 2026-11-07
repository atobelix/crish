/**
 * apps/crish-desktop/src/components/chat-tool-call/CompactToolRow.tsx
 *
 * 单工具行组件（P4 方案纯化重构）。
 * 彻底切除 500ms 定时器、liveNow 轮询、durationStr 耗时跳秒与入参路径反推。
 * 遵循 D3 规范：单行原位流转，纯响应式渲染。
 */

import React, {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
} from 'react';
import styles from './ChatToolCallBlock.module.css';
import type { MessageToolCall } from '../../store/types';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import {
  ApprovalAskCard,
  type ApprovalTimeoutPolicy,
} from '../agent-card/ApprovalAskCard';
import { slotCore } from '../../services/view-registry/SlotCore';
import '../chat-card/workspaceChatComposerAbove.slot';
import {
  extractToolCommand,
  isToolRowDefaultOpen,
  resolveToolCallDiffs,
  toolCommandPreview,
  toolHumanLabel,
  toolRowTone,
} from '../../api/toolPresentation';
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
} from '../../api/toolBackgroundApi';
import { Button } from '@/components/ui';
import { useI18n } from '../../i18n';
import {
  useToolExpansionState,
  findPreviousToolInItems,
} from './toolExpansionState';
import { useRevealEntrance } from './useRevealEntrance';
import { markToolInteracted, settleToolReveal } from './toolRevealState';
import { useClosingFlag } from '../motion/useExitReveal';
import { stripReferencesToPlainText } from './Reference';

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

    // 转后台识别：output 为后台占位信封且 callId 一致时处于后台态
    const backgroundPlaceholder = useMemo(() => {
      const ph = parseToolBackgroundPlaceholder(tc.output);
      return ph && ph.callId === tc.id ? ph : null;
    }, [tc.output, tc.id]);

    // 一处派生：展开政策与改道目标共用同一解析 diff 列表
    const resolvedDiffs = useMemo(() => resolveToolCallDiffs(tc), [tc]);
    const [cancelState, setCancelState] = useState<
      'idle' | 'cancelling' | 'cancelled'
    >('idle');
    const backgroundActive = backgroundPlaceholder !== null;
    const backgroundSettledLocally =
      backgroundActive && cancelState === 'cancelled';

    const handleCancelBackground = async () => {
      if (!backgroundPlaceholder || cancelState !== 'idle') return;
      setCancelState('cancelling');
      const ok = await cancelToolBackgroundTask(backgroundPlaceholder.callId);
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

    // User-Intent-First（F3 §根因 5）：跟踪用户是否显式展开过该工具行
    const userExpandedRef = useRef(
      Boolean(expandedTools && expandedTools[tc.id] === true)
    );

    if (expandedTools && expandedTools[tc.id] === true) {
      userExpandedRef.current = true;
    } else if (expandedTools && expandedTools[tc.id] === false) {
      userExpandedRef.current = false;
    }

    const handleToggleWrapped = useCallback(
      (toolId: string, currentOpen: boolean) => {
        userExpandedRef.current = !currentOpen;
        handleToggle(toolId, currentOpen);
      },
      [handleToggle]
    );

    // 有可展示内容判断
    const hasDisplayableContent = Boolean(
      (tc.output && tc.output.trim()) ||
      (tc.arguments && tc.arguments.trim().length > 2) ||
      (tc.diffs && tc.diffs.length > 0)
    );

    // 用户显式展开后，终态变化不得卸载展开体（忽略政策变为 none 的 unmount）
    const isForceKeptByUser = Boolean(userExpandedRef.current);
    const effectiveCanToggle =
      canToggle || (isForceKeptByUser && hasDisplayableContent);
    const effectiveIsOpen = isForceKeptByUser
      ? (expandedTools?.[tc.id] ?? isOpen)
      : isOpen;

    // 退出动画生命周期管理
    const [shouldMountContent, setShouldMountContent] =
      useState(effectiveIsOpen);

    useEffect(() => {
      if (effectiveIsOpen) {
        setShouldMountContent(true);
        return undefined;
      }
      const timer = setTimeout(() => {
        setShouldMountContent(false);
      }, 350);
      return () => {
        clearTimeout(timer);
      };
    }, [effectiveIsOpen]);

    const handleAccordionEnd = useCallback(
      (e: React.TransitionEvent<HTMLDivElement>) => {
        handleAccordionTransitionEnd();
        if (e.propertyName !== 'grid-template-rows') return;
        if (!effectiveIsOpen) {
          setShouldMountContent(false);
        }
      },
      [handleAccordionTransitionEnd, effectiveIsOpen]
    );

    // AN4：工具行入场动效
    const rowEntrance = useRevealEntrance({
      key: tc.id || '',
      eventTs: tc.completedAt ?? tc.startedAt,
      replaceHit: shouldReplace,
    });

    // AN4 让位：指针按下或焦点进入时沉降排空
    const handleRevealSettle = useCallback(() => {
      if (!tc.id) return;
      markToolInteracted(tc.id);
      settleToolReveal(tc.id);
    }, [tc.id]);

    // S4 退场宿主：审批卡的卸载由宿主保活——裁决发出后（tc.status 离开
    // pending_approval），卡片先播 150ms 退场再卸载；决策回调在卡片内
    // 立即发出，不被退场延迟。键与卡片的入场键同构，entered 缺省读
    // 入场记忆：从未挂载过的卡（挂载时已裁决 / 上提 composer）直落。
    const approvalExit = useClosingFlag(tc.status === 'pending_approval', {
      key: `approval:${tc.id ?? (msgId || pendingApprovalMsgId || '')}`,
    });

    // S4：审批卡的渲染（含派生）收拢为一处，pending 分支与退场分支
    // 共用；退场分支的 tc 是裁决后的同一对象（intent/arguments 不变）。
    const renderApprovalCard = (closing: boolean) => {
      // 插件开启：审批上提 composer 冷静条，流内静默
      if (slotCore.getSingle('workspace.chat.composerAbove')) {
        return null;
      }

      const summary = tc.intent
        ? stripReferencesToPlainText(tc.intent)
        : toolHumanLabel(tc);
      const techFull = extractToolCommand(tc.arguments || '');
      const tech =
        techFull && techFull !== summary
          ? techFull
          : toolCommandPreview(tc, 72);
      const mid = msgId || pendingApprovalMsgId;
      const approvalWired = Boolean(onApprovalAllow && onApprovalDeny);

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
              closing={closing}
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
    };

    if (approvalExit.visible) {
      return renderApprovalCard(approvalExit.closing);
    }

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
    const targetDiff = resolvedDiffs[0];

    // E1 §7：改道行政策判 side-diff 且宿主提供 onOpenDiff
    const sideDiffActive =
      expansionPolicy === 'side-diff' &&
      Boolean(onOpenDiff) &&
      Boolean(targetDiff);

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
        } ${effectiveIsOpen ? `${styles.isOpen} is-open` : `${styles.isCollapsed} is-collapsed`} ${
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
        data-in-place-replace={shouldReplace ? 'true' : undefined}
        data-in-place-flipping={isFlipping ? 'true' : undefined}
        data-expanded={effectiveIsOpen ? 'true' : 'false'}
        aria-busy={running || undefined}
      >
        <ToolCallHeader
          tc={tc}
          isOpen={effectiveIsOpen}
          canToggle={effectiveCanToggle}
          bodyId={bodyId}
          targetDiff={targetDiff}
          sideDiff={sideDiffActive}
          onToggleTool={handleToggleWrapped}
          onOpenPath={onOpenPath}
          onOpenDiff={onOpenDiff}
          onOpenTerminal={onOpenTerminal}
        />
        {/* 转后台静态条：无耗时跳秒走字 */}
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
                : STATUS_WORD.backgrounded}
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
        {effectiveCanToggle ? (
          <div
            className={`${styles.toolBody}${effectiveIsOpen ? ' ' + styles.expanded : ''}`}
            onTransitionEnd={handleAccordionEnd}
          >
            <div className={styles.toolBodyInner}>
              {shouldMountContent ? (
                <ToolCallOutput
                  tc={tc}
                  bodyId={bodyId}
                  onOpenDiff={onOpenDiff}
                  onOpenTerminal={onOpenTerminal}
                />
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
