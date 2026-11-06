/**
 * 权限询问卡（通俗文案 + 可选备注；高风险后端要求二次确认）
 * 风险标签展示后端 metadata（BE-04），不按工具名猜。
 *
 * 连续运行硬化 (continuous-execution-hardening W2-T2)：
 * 1. 接入服务端绝对时间戳 expiresAtMs (SSOT) 与 timeoutMs；
 * 2. 策略模式透明度徽标 (Auto-Allow / Auto-Deny / Manual-Only)；
 * 3. 三阶段渐进张力色彩进度条 (绿色 >50%，琥珀色 20%~50%，绯红色 <20%)；
 * 4. 倒计时到期后锁定按钮交互并呈现“⏳ 倒计时结束，等待系统策略裁决…”，彻底消除双头 IPC 竞态与僵尸死锁。
 */
import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import styles from './ApprovalAskCard.module.css';
import { ScrollFadeRegion, Tooltip } from '@/components/ui';
import {
  approvalRiskBadgeLabel,
  approvalRiskKindLabel,
  approvalRiskSummary,
  approvalTrustZoneHint,
  approvalTrustZoneLabel,
  hasApprovalRiskFacts,
  type ApprovalRiskMeta,
} from '../../api/approvalMeta';
import {
  approvalCardClassName,
  buildApprovalRiskChips,
  nextAllowConfirmPhase,
  plainApprovalQuestion,
  shouldResetAllowConfirmArmed,
} from '../../api/chatApprovalUi';
import type {
  MessageToolApprovalMeta,
  MessageToolApprovalPayload,
} from '../../store/types';
import { ApprovalActions } from './ApprovalActions';
import { ApprovalNoteField } from './ApprovalNoteField';
import { ApprovalPayloadSection } from './ApprovalPayloadSection';
import { ApprovalCountdownBar } from './ApprovalCountdownBar';
import { ApprovalRequesterSection } from './ApprovalRequesterSection';
import {
  ApprovalRiskChips,
  dedupeChipLabels,
  localizeRiskChips,
} from './ApprovalRiskChips';
import { useI18n } from '../../i18n';
import {
  useApprovalCountdown,
  type ApprovalTimeoutPolicy,
} from './useApprovalCountdown';
import { useApprovalKeyboard } from './useApprovalKeyboard';
import { useEntranceReveal } from '../motion/useEntranceReveal';
import { useExitReveal } from '../motion/useExitReveal';
import { AppIcon } from '@/components/ui/icons';

export type { ApprovalTimeoutPolicy };

export interface ApprovalAskCardProps {
  msgId: string;
  /** 工具调用 id，供底部审批条 scrollIntoView */
  toolId?: string | undefined;
  summary: string;
  cmd?: string | undefined;
  busy?: boolean | undefined;
  /** 后端审批风险事实 */
  riskMeta?: MessageToolApprovalMeta | ApprovalRiskMeta | null | undefined;
  onAllow: (note: string) => void;
  onDeny: () => void;

  // ── 连续运行硬化：权威时间基准与策略元数据 ──
  /** 权威绝对到期毫秒时间戳 (Epoch ms，SSOT) */
  expiresAtMs?: number | undefined;
  /** 倒计时预算总时长 (ms，用于百分比分母) */
  timeoutMs?: number | undefined;
  /** 超时动作策略 (auto-allow | auto-deny | manual-only) */
  timeoutPolicy?: ApprovalTimeoutPolicy | undefined;
  /** 策略提示文案 */
  actionHint?: string | undefined;
  /** 遗留兼容：相对剩余毫秒数 */
  remainingMs?: number | undefined;
  /** 前端本地暂停状态 */
  isPaused?: boolean | undefined;
  /** 遗留兼容超时回调 (仅纯 UI 钩子，严禁调 IPC) */
  onTimeout?: (() => void) | undefined;
  /**
   * S4 退场：宿主（CompactToolRow）在裁决已发出后保持挂载播退场。
   * closing=true 时卡片高度收敛 + 淡出，指针/键盘决策均已锁死；
   * onAllow/onDeny 在 closing 置位前已发出，不被退场延迟。
   */
  closing?: boolean | undefined;
}

/** 归一化风险事实与 payload 载荷 */
function toRiskMeta(
  riskMeta?: MessageToolApprovalMeta | ApprovalRiskMeta | null
): (ApprovalRiskMeta & { payload?: MessageToolApprovalPayload }) | null {
  if (!riskMeta) return null;
  const payload = 'payload' in riskMeta ? riskMeta.payload : undefined;
  return {
    ...(riskMeta.trustZone !== undefined && { trustZone: riskMeta.trustZone }),
    ...(riskMeta.risk !== undefined && { risk: riskMeta.risk }),
    ...(riskMeta.riskReason !== undefined && {
      riskReason: riskMeta.riskReason,
    }),
    riskLevel: riskMeta.riskLevel || 'unknown',
    requiresDoubleConfirm: Boolean(riskMeta.requiresDoubleConfirm),
    recommendSnapshot: Boolean(riskMeta.recommendSnapshot),
    source: riskMeta.source || 'unknown',
    ...(payload !== undefined && { payload }),
    ...(riskMeta.metadata !== undefined && { metadata: riskMeta.metadata }),
    ...(riskMeta.requester !== undefined && {
      requester: riskMeta.requester,
    }),
    ...(riskMeta.arbiter !== undefined && { arbiter: riskMeta.arbiter }),
  };
}

/** 状态行 zone 提示：中文信任域 · 风险种类 */
function chineseZoneHint(riskMeta: ApprovalRiskMeta | null): string {
  if (!riskMeta) return '';
  const zone = approvalTrustZoneLabel(riskMeta.trustZone);
  const risk = approvalRiskKindLabel(riskMeta.risk);
  if (zone && risk && risk !== zone) return `${zone} · ${risk}`;
  return zone || risk || '';
}

export const ApprovalAskCard: React.FC<ApprovalAskCardProps> = ({
  msgId,
  toolId,
  summary,
  cmd,
  busy,
  riskMeta: riskMetaProp,
  onAllow,
  onDeny,
  expiresAtMs: propExpiresAtMs,
  timeoutMs: propTimeoutMs,
  timeoutPolicy: propTimeoutPolicy,
  actionHint: propActionHint,
  remainingMs,
  isPaused,
  onTimeout,
  closing = false,
}) => {
  const [note, setNote] = useState('');
  const { t } = useI18n();
  const [confirmArmed, setConfirmArmed] = useState(false);
  const prevToolIdRef = useRef<string | undefined>(toolId);
  const prevMsgIdRef = useRef(msgId);
  const allowBtnRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 统一入场通道：审批卡在请求发生的实况时刻挂载。事件戳优先取
  // 到期反推的请求时刻（expiresAtMs - timeoutMs），缺省时 liveOnMount
  // 兜底；grow 变体让卡片高度同步生长（私有 popover 入场已删除）。
  const entrance = useEntranceReveal({
    key: `approval:${toolId ?? msgId}`,
    eventTs:
      propExpiresAtMs != null && propTimeoutMs != null
        ? propExpiresAtMs - propTimeoutMs
        : undefined,
    liveOnMount: true,
    variant: 'grow',
  });
  // S4 退场：closing 翻 true 时收敛高度并淡出（见 useExitReveal 契约）；
  // 退场期间入场生长让位（data-exiting 标志），由 useEntranceReveal 认领。
  const exit = useExitReveal({ closing });

  const titleId = useId();
  const descId = useId();
  const chipsId = useId();
  const noteId = useId();
  const warnId = useId();

  const question = plainApprovalQuestion(summary, cmd);
  const riskMeta = toRiskMeta(riskMetaProp);
  const needsDouble = Boolean(riskMeta?.requiresDoubleConfirm);
  const badge = riskMeta
    ? approvalRiskBadgeLabel(riskMeta)
    : t('chat.approval.confirmRequired');

  // 健壮提取倒计时与策略元数据 (优先显式 props，降级从 riskMeta.metadata 提取)
  const rawMeta =
    (riskMetaProp as { metadata?: Record<string, unknown> } | null | undefined)
      ?.metadata ||
    (riskMetaProp as Record<string, unknown> | null | undefined) ||
    {};

  const effectiveExpiresAtMs =
    propExpiresAtMs ??
    (typeof rawMeta.expiresAtMs === 'number' ? rawMeta.expiresAtMs : undefined);

  const effectiveTimeoutMs =
    propTimeoutMs ??
    (typeof rawMeta.timeoutMs === 'number' ? rawMeta.timeoutMs : undefined);

  const effectiveTimeoutPolicy: ApprovalTimeoutPolicy =
    propTimeoutPolicy ??
    (rawMeta.timeoutPolicy === 'auto-allow' ||
    rawMeta.timeoutPolicy === 'auto-deny' ||
    rawMeta.timeoutPolicy === 'manual-only'
      ? rawMeta.timeoutPolicy
      : 'auto-deny');

  const effectiveActionHint =
    propActionHint ??
    (typeof rawMeta.actionHint === 'string' ? rawMeta.actionHint : undefined);

  // 引擎裁决原因（SmartClassifier 结构化原因摘要）：解释「为什么需要确认」
  const approvalReason =
    typeof rawMeta.approvalReason === 'string'
      ? rawMeta.approvalReason.trim()
      : '';
  const showApprovalReason = Boolean(
    approvalReason &&
    approvalReason !== summary &&
    approvalReason !== riskMeta?.riskReason
  );

  // 权威时间基准单源驱动的倒计时状态
  const {
    remainingSeconds,
    percent: timeoutPercent,
    tensionStage,
    isExpired,
    isActive: countdownActive,
  } = useApprovalCountdown({
    expiresAtMs: effectiveExpiresAtMs,
    timeoutMs: effectiveTimeoutMs,
    timeoutPolicy: effectiveTimeoutPolicy,
    busy,
    isPaused,
    remainingMs,
    onTimeout,
  });

  // 策略模式徽标信息
  const policyMeta = useMemo(() => {
    switch (effectiveTimeoutPolicy) {
      case 'auto-allow':
        return {
          icon: 'zap' as const,
          label: t('chat.approval.autoAllowLabel'),
          color: 'var(--color-success)',
          bg: 'color-mix(in srgb, var(--color-success) 12%, transparent)',
          border: 'color-mix(in srgb, var(--color-success) 25%, transparent)',
          hint: effectiveActionHint || t('chat.approval.autoAllowHint'),
        };
      case 'manual-only':
        return {
          icon: 'user' as const,
          label: t('chat.approval.manualLabel'),
          color: 'var(--text-secondary)',
          bg: 'color-mix(in srgb, var(--text-tertiary) 12%, transparent)',
          border: 'var(--hairline, var(--border-subtle))',
          hint: effectiveActionHint || t('chat.approval.manualHint'),
        };
      case 'auto-deny':
      default:
        return {
          icon: 'shield-alert' as const,
          label: t('chat.approval.autoDenyLabel'),
          color: 'var(--color-warning)',
          bg: 'color-mix(in srgb, var(--color-warning) 12%, transparent)',
          border: 'color-mix(in srgb, var(--color-warning) 25%, transparent)',
          hint: effectiveActionHint || t('chat.approval.autoDenyHint'),
        };
    }
  }, [effectiveTimeoutPolicy, effectiveActionHint, t]);

  // 超时到期后锁定操作态，完全杜绝前端 IPC 抢跑自决
  const effectiveBusy = Boolean(busy || isExpired);

  const chips = useMemo(() => {
    const raw = buildApprovalRiskChips(riskMeta);
    return dedupeChipLabels(localizeRiskChips(raw, riskMeta));
  }, [riskMeta]);

  const zoneHint = chineseZoneHint(riskMeta);
  const hasRiskFacts = hasApprovalRiskFacts(riskMeta);
  const zoneTitle =
    riskMeta?.riskReason ||
    approvalTrustZoneHint(riskMeta?.trustZone) ||
    (hasRiskFacts ? approvalRiskSummary(riskMeta) : '') ||
    zoneHint;
  const riskAriaSummary = hasRiskFacts ? approvalRiskSummary(riskMeta) : '';

  // 申请人与理由标注：requester 存在 = 子 agent 发起，收口去重
  const requester = riskMeta?.requester;
  const requesterReason =
    requester?.reason &&
    requester.reason !== summary &&
    requester.reason !== riskMeta?.riskReason
      ? requester.reason
      : '';
  const showRequesterReason = Boolean(requesterReason);

  const showSummary = Boolean(summary && summary !== question);
  const showReason = Boolean(
    riskMeta?.riskReason && riskMeta.riskReason !== summary
  );
  const hasCmd = Boolean(cmd && cmd.trim());
  const hasExtraDesc =
    showSummary || showReason || showApprovalReason || showRequesterReason;
  const density: 'compact' | 'default' =
    !hasCmd && !hasExtraDesc && chips.length <= 2 ? 'compact' : 'default';

  const disarm = useCallback(() => {
    setConfirmArmed(false);
  }, []);

  useEffect(() => {
    const prevTool = prevToolIdRef.current;
    const nextTool = toolId;
    const msgChanged = prevMsgIdRef.current !== msgId;
    const shouldReset =
      shouldResetAllowConfirmArmed({
        confirmArmed: true,
        needsDouble,
        ...(prevTool !== undefined && { prevToolId: prevTool }),
        ...(nextTool !== undefined && { nextToolId: nextTool }),
      }) || msgChanged;

    if (shouldReset) {
      setConfirmArmed(false);
    }
    prevToolIdRef.current = nextTool;
    prevMsgIdRef.current = msgId;
  }, [toolId, msgId, needsDouble]);

  useEffect(() => {
    if (effectiveBusy) {
      setConfirmArmed(false);
    }
  }, [effectiveBusy]);

  const fireAllow = useCallback(() => {
    // S4 退场中：裁决已发出，键盘/按钮不得重复决策
    if (closing) return;
    // 倒计时已到期或处理中时坚决阻断任何 IPC 决策请求
    if (effectiveBusy) return;
    const phase = nextAllowConfirmPhase(needsDouble, confirmArmed);
    if (phase === 'armed') {
      setConfirmArmed(true);
      return;
    }
    setConfirmArmed(false);
    onAllow(note);
  }, [effectiveBusy, needsDouble, confirmArmed, onAllow, note, closing]);

  const handleDeny = useCallback(() => {
    // S4 退场中：裁决已发出，键盘/按钮不得重复决策
    if (closing) return;
    if (confirmArmed) disarm();
    // 倒计时已到期或处理中时坚决阻断
    if (effectiveBusy) return;
    onDeny();
  }, [confirmArmed, disarm, effectiveBusy, onDeny, closing]);

  const handleEnterAllow = useCallback(() => {
    if (effectiveBusy) return;
    fireAllow();
  }, [effectiveBusy, fireAllow]);

  useApprovalKeyboard({
    rootRef,
    allowBtnRef,
    confirmArmed,
    busy: effectiveBusy,
    msgId,
    toolId,
    onDisarm: disarm,
    onEnterAllow: handleEnterAllow,
  });

  const statusText = confirmArmed ? '再次确认' : '';

  const regionLabel = confirmArmed
    ? `需要你的确认：${question}（已准备，再点一次才会执行）`
    : `需要你的确认：${question}`;

  const describedByParts: string[] = [];
  if (showSummary || showReason || showApprovalReason || riskAriaSummary)
    describedByParts.push(descId);
  if (chips.length > 0) describedByParts.push(chipsId);
  if (confirmArmed) describedByParts.push(warnId);
  const describedBy =
    describedByParts.length > 0 ? describedByParts.join(' ') : undefined;

  // 张力进度条显隐判断
  const showCountdown =
    (countdownActive || remainingMs != null || effectiveExpiresAtMs != null) &&
    effectiveTimeoutPolicy !== 'manual-only';

  return (
    <div
      ref={(el) => {
        rootRef.current = el;
        entrance.rootRef(el);
        exit.rootRef(el);
      }}
      className={`${styles.approvalCard} ${needsDouble ? styles.approvalCardElevated : ''} ${
        confirmArmed ? styles.isConfirmArmed : ''
      } ${approvalCardClassName({ needsDouble, confirmArmed })}${entrance.entering ? ' crish-entrance-fade' : ''}${closing ? ' crish-exit-fade' : ''}`}
      style={
        entrance.entering || closing
          ? ({
              ...(entrance.entering
                ? { '--reveal-delay': `${entrance.delayMs}ms` }
                : null),
              ...(closing ? { pointerEvents: 'none' } : null),
            } as React.CSSProperties)
          : undefined
      }
      data-entering={entrance.entering ? 'true' : undefined}
      data-exiting={closing ? 'true' : undefined}
      aria-hidden={closing ? true : undefined}
      onAnimationEnd={entrance.handleAnimationEnd}
      role="region"
      aria-label={regionLabel}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      aria-busy={effectiveBusy ? true : undefined}
      data-msg={msgId}
      data-tool-id={toolId || undefined}
      data-risk-level={riskMeta?.riskLevel || undefined}
      data-trust-zone={riskMeta?.trustZone || undefined}
      data-requires-double={needsDouble ? 'true' : undefined}
      data-confirm-armed={confirmArmed ? 'true' : undefined}
      data-density={density}
      data-timeout-policy={effectiveTimeoutPolicy}
      data-is-expired={isExpired ? 'true' : undefined}
      tabIndex={-1}
    >
      <div className={styles.approvalCardTop}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span className={styles.approvalCardBadge}>
            <AppIcon name="shield-question" size={14} aria-hidden />
            {badge}
          </span>

          {/* 策略模式透明度徽标 */}
          <Tooltip content={policyMeta.hint}>
            <span
              className={styles.approvalCardChip}
              data-policy={effectiveTimeoutPolicy}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 8px',
                borderRadius: 'var(--radius-full, 9999px)',
                fontSize: 'var(--font-size-xxs, 11px)',
                fontWeight: 500,
                color: policyMeta.color,
                background: policyMeta.bg,
                border: `1px solid ${policyMeta.border}`,
                cursor: 'default',
              }}
            >
              <AppIcon name={policyMeta.icon} size={12} aria-hidden />
              <span>{policyMeta.label}</span>
            </span>
          </Tooltip>
        </div>

        {statusText || zoneHint ? (
          <span
            className={styles.approvalCardStatus}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {statusText}
            {zoneHint ? (
              <Tooltip content={zoneTitle}>
                <span className={styles.approvalCardZone}>
                  {statusText ? ` · ${zoneHint}` : zoneHint}
                </span>
              </Tooltip>
            ) : null}
          </span>
        ) : null}
      </div>

      <ApprovalRequesterSection
        requester={requester}
        arbiter={riskMeta?.arbiter}
        requesterReason={requesterReason}
      />

      <div className={styles.approvalCardTitle} id={titleId}>
        {question}
      </div>

      {showSummary ? (
        <div className={styles.approvalCardDesc} id={descId}>
          {summary}
        </div>
      ) : showReason ? (
        <Tooltip
          content={riskMeta?.riskReason || ''}
          disabled={!riskMeta?.riskReason}
        >
          <div
            className={`${styles.approvalCardDesc} ${styles.approvalCardReason}`}
            id={descId}
          >
            {riskMeta?.riskReason}
          </div>
        </Tooltip>
      ) : riskAriaSummary && riskAriaSummary !== question ? (
        <div className={styles.approvalCardDesc} id={descId} hidden>
          {riskAriaSummary}
        </div>
      ) : null}

      {showSummary && showReason ? (
        <Tooltip
          content={riskMeta?.riskReason || ''}
          disabled={!riskMeta?.riskReason}
        >
          <div
            className={`${styles.approvalCardDesc} ${styles.approvalCardReason}`}
          >
            {riskMeta?.riskReason}
          </div>
        </Tooltip>
      ) : null}

      {showApprovalReason ? (
        <div
          className={styles.approvalCardHint}
          role="note"
          data-approval-reason
        >
          {t('chat.approval.reasonPrefix')}
          {approvalReason}
        </div>
      ) : null}

      {chips.length > 0 ? (
        <ApprovalRiskChips chips={chips} id={chipsId} />
      ) : null}

      {hasCmd ? (
        <div className={styles.approvalCardCmdWrap}>
          <ScrollFadeRegion
            className={styles.approvalCardCmd}
            innerClassName={styles.approvalCardCmdInner}
            innerAs="pre"
            fadeSize="sm"
            aria-label="command"
          >
            {cmd}
          </ScrollFadeRegion>
        </div>
      ) : null}

      <ApprovalPayloadSection payload={riskMeta?.payload} />

      {riskMeta?.recommendSnapshot ? (
        <div className={styles.approvalCardHint} role="note">
          建议先确认项目快照/可回退后再允许
        </div>
      ) : null}

      {confirmArmed ? (
        <div
          className={`${styles.approvalCardHint} ${styles.approvalCardHintWarn}`}
          id={warnId}
          role="alert"
          aria-live="assertive"
        >
          {confirmArmed
            ? '高风险操作：再点一次「允许」才会执行（Esc 取消准备）'
            : null}
        </div>
      ) : null}

      <ApprovalNoteField
        note={note}
        onNoteChange={setNote}
        busy={effectiveBusy}
        density={density}
        noteId={noteId}
      />

      <ApprovalActions
        confirmArmed={confirmArmed}
        needsDouble={needsDouble}
        busy={effectiveBusy}
        allowBtnRef={allowBtnRef}
        onDisarm={disarm}
        onAllow={fireAllow}
        onDeny={handleDeny}
      />

      <ApprovalCountdownBar
        isExpired={isExpired}
        showCountdown={showCountdown}
        remainingSeconds={remainingSeconds}
        timeoutPercent={timeoutPercent}
        tensionStage={tensionStage}
        effectiveTimeoutPolicy={effectiveTimeoutPolicy}
        isPaused={isPaused}
      />
    </div>
  );
};
