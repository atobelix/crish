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
import { Tooltip } from '@/components/ui';
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
}) => {
  const [note, setNote] = useState('');
  const { t } = useI18n();
  const [confirmArmed, setConfirmArmed] = useState(false);
  const prevToolIdRef = useRef<string | undefined>(toolId);
  const prevMsgIdRef = useRef(msgId);
  const allowBtnRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

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

  const showSummary = Boolean(summary && summary !== question);
  const showReason = Boolean(
    riskMeta?.riskReason && riskMeta.riskReason !== summary
  );
  const hasCmd = Boolean(cmd && cmd.trim());
  const hasExtraDesc = showSummary || showReason || showApprovalReason;
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
    // 倒计时已到期或处理中时坚决阻断任何 IPC 决策请求
    if (effectiveBusy) return;
    const phase = nextAllowConfirmPhase(needsDouble, confirmArmed);
    if (phase === 'armed') {
      setConfirmArmed(true);
      return;
    }
    setConfirmArmed(false);
    onAllow(note);
  }, [effectiveBusy, needsDouble, confirmArmed, onAllow, note]);

  const handleDeny = useCallback(() => {
    if (confirmArmed) disarm();
    // 倒计时已到期或处理中时坚决阻断
    if (effectiveBusy) return;
    onDeny();
  }, [confirmArmed, disarm, effectiveBusy, onDeny]);

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

  const tensionColor =
    tensionStage === 'critical'
      ? 'var(--color-danger)'
      : tensionStage === 'warning'
        ? 'var(--color-warning)'
        : 'var(--color-success)';

  return (
    <div
      ref={rootRef}
      className={`${styles.approvalCard} ${needsDouble ? styles.approvalCardElevated : ''} ${
        confirmArmed ? styles.isConfirmArmed : ''
      } ${approvalCardClassName({ needsDouble, confirmArmed })}`}
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
          <code className={styles.approvalCardCmd} aria-label="将执行">
            {cmd}
          </code>
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

      {/* 倒计时归零时锁定提示：纯等待后端系统策略广播，0 竞态 */}
      {isExpired ? (
        <div
          className={styles.approvalCardStatus}
          role="status"
          aria-live="polite"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 10px',
            borderRadius: 'var(--radius-sm)',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-warning)',
            background:
              'color-mix(in srgb, var(--color-warning) 8%, transparent)',
            border:
              '1px solid color-mix(in srgb, var(--color-warning) 20%, transparent)',
            marginTop: 4,
          }}
        >
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <AppIcon name="timer" size={12} aria-hidden />
            <span>{t('chat.approval.countdownExpiredDecision')}</span>
          </span>
        </div>
      ) : null}

      {/* 三阶段渐进张力进度条 */}
      {showCountdown ? (
        <div
          style={{
            marginTop: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}
          role="progressbar"
          aria-valuenow={Math.round(timeoutPercent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`审批剩余时间 ${remainingSeconds} 秒`}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: 'var(--font-size-xxs, 11px)',
              color: 'var(--text-tertiary)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <AppIcon
                name={
                  isExpired
                    ? 'timer'
                    : isPaused
                      ? 'pause'
                      : effectiveTimeoutPolicy === 'auto-allow'
                        ? 'zap'
                        : 'shield-alert'
                }
                size={12}
                aria-hidden
              />
              <span>
                {isExpired
                  ? t('chat.approval.countdownExpired')
                  : isPaused
                    ? t('chat.approval.countdownPaused')
                    : effectiveTimeoutPolicy === 'auto-allow'
                      ? t('chat.approval.countdownAutoAllow', {
                          seconds: remainingSeconds,
                        })
                      : t('chat.approval.countdownAutoDeny', {
                          seconds: remainingSeconds,
                        })}
              </span>
            </span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontFamily: 'var(--font-mono)',
                fontWeight: tensionStage === 'critical' ? 700 : 600,
                color: isPaused ? 'var(--text-tertiary)' : tensionColor,
              }}
            >
              <AppIcon name="clock" size={12} aria-hidden />
              <span>
                {String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:
                {String(remainingSeconds % 60).padStart(2, '0')}
              </span>
            </span>
          </div>

          <div
            style={{
              position: 'relative',
              height: 4,
              borderRadius: 2,
              background: 'var(--hairline, var(--border-subtle))',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                height: '100%',
                width: `${timeoutPercent}%`,
                borderRadius: 2,
                background: isPaused ? 'var(--text-tertiary)' : tensionColor,
                transition: 'width 0.1s linear, background-color 0.3s ease',
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
};
