/**
 * 权限询问卡（通俗文案 + 可选备注；高风险后端要求二次确认）
 * 风险标签仅展示后端 metadata（BE-04），不按工具名猜。
 * 单条主时间线仅靠本卡；底部 dock 由 chatApprovalUi.resolveApprovalDockVisible 关闭。
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
import { Tooltip } from '../ui';
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
import { ApprovalCountdown } from './ApprovalCountdown';
import { ApprovalNoteField } from './ApprovalNoteField';
import { ApprovalPayloadSection } from './ApprovalPayloadSection';
import {
  ApprovalRiskChips,
  dedupeChipLabels,
  localizeRiskChips,
} from './ApprovalRiskChips';
import { useApprovalCountdown } from './useApprovalCountdown';
import { useApprovalKeyboard } from './useApprovalKeyboard';
import { AppIcon } from '../ui/icons/index';

type Props = {
  msgId: string;
  /** 工具调用 id，供底部审批条 scrollIntoView */
  toolId?: string | undefined;
  summary: string;
  cmd?: string | undefined;
  busy?: boolean | undefined;
  /** 后端审批风险事实 */
  riskMeta?: MessageToolApprovalMeta | ApprovalRiskMeta | null | undefined;
  onAllow: (note: string) => void;
  onAllowRemember: (note: string) => void;
  onDeny: () => void;
  /** 超时倒计时 ms（父级传入则渲染进度条） */
  remainingMs?: number | undefined;
  /** 超时回调 */
  onTimeout?: (() => void) | undefined;
};

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

export const ApprovalAskCard: React.FC<Props> = ({
  msgId,
  toolId,
  summary,
  cmd,
  busy,
  riskMeta: riskMetaProp,
  onAllow,
  onAllowRemember,
  onDeny,
  remainingMs,
  onTimeout,
}) => {
  const [note, setNote] = useState('');
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [rememberIntent, setRememberIntent] = useState(false);
  const prevToolIdRef = useRef<string | undefined>(toolId);
  const prevMsgIdRef = useRef(msgId);
  const allowBtnRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const titleId = useId();
  const descId = useId();
  const chipsId = useId();
  const noteId = useId();
  const warnId = useId();
  const cmdLabelId = useId();

  const question = plainApprovalQuestion(summary, cmd);
  const riskMeta = toRiskMeta(riskMetaProp);
  const needsDouble = Boolean(riskMeta?.requiresDoubleConfirm);
  const badge = riskMeta ? approvalRiskBadgeLabel(riskMeta) : '需要你的确认';

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
  const hasExtraDesc = showSummary || showReason;
  const density: 'compact' | 'default' =
    !hasCmd && !hasExtraDesc && chips.length <= 2 ? 'compact' : 'default';

  const disarm = useCallback(() => {
    setConfirmArmed(false);
    setRememberIntent(false);
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
      setRememberIntent(false);
    }
    prevToolIdRef.current = nextTool;
    prevMsgIdRef.current = msgId;
  }, [toolId, msgId, needsDouble]);

  useEffect(() => {
    if (busy) {
      setConfirmArmed(false);
      setRememberIntent(false);
    }
  }, [busy]);

  const fireAllow = useCallback(
    (remember: boolean) => {
      if (busy) return;
      const phase = nextAllowConfirmPhase(needsDouble, confirmArmed);
      if (phase === 'armed') {
        setConfirmArmed(true);
        setRememberIntent(remember);
        return;
      }
      const doRemember = remember || rememberIntent;
      setConfirmArmed(false);
      setRememberIntent(false);
      if (doRemember) onAllowRemember(note);
      else onAllow(note);
    },
    [
      busy,
      needsDouble,
      confirmArmed,
      rememberIntent,
      onAllowRemember,
      onAllow,
      note,
    ]
  );

  const handleDeny = useCallback(() => {
    if (confirmArmed || rememberIntent) disarm();
    if (busy) return;
    onDeny();
  }, [confirmArmed, rememberIntent, disarm, busy, onDeny]);

  const handleEnterAllow = useCallback(() => {
    fireAllow(false);
  }, [fireAllow]);

  const { timeoutPercent } = useApprovalCountdown({
    remainingMs,
    busy,
    onTimeout,
  });

  useApprovalKeyboard({
    rootRef,
    allowBtnRef,
    confirmArmed,
    busy: Boolean(busy),
    msgId,
    toolId,
    onDisarm: disarm,
    onEnterAllow: handleEnterAllow,
  });

  const statusText = confirmArmed
    ? rememberIntent
      ? '再次确认（将记住）'
      : '再次确认'
    : '等待中';

  const regionLabel = confirmArmed
    ? `需要你的确认：${question}（已准备，再点一次才会执行）`
    : `需要你的确认：${question}`;

  const describedByParts: string[] = [];
  if (showSummary || showReason || riskAriaSummary)
    describedByParts.push(descId);
  if (chips.length > 0) describedByParts.push(chipsId);
  if (confirmArmed) describedByParts.push(warnId);
  const describedBy =
    describedByParts.length > 0 ? describedByParts.join(' ') : undefined;

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
      aria-busy={busy ? true : undefined}
      data-msg={msgId}
      data-tool-id={toolId || undefined}
      data-risk-level={riskMeta?.riskLevel || undefined}
      data-trust-zone={riskMeta?.trustZone || undefined}
      data-requires-double={needsDouble ? 'true' : undefined}
      data-confirm-armed={confirmArmed ? 'true' : undefined}
      data-remember-intent={rememberIntent ? 'true' : undefined}
      data-density={density}
      tabIndex={-1}
    >
      <div className={styles.approvalCardTop}>
        <span className={styles.approvalCardBadge}>
          <AppIcon name="shield-question" size={14} aria-hidden />
          {badge}
        </span>
        <span
          className={styles.approvalCardStatus}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {statusText}
          {zoneHint ? (
            <Tooltip content={zoneTitle}>
              <span className={styles.approvalCardZone}> · {zoneHint}</span>
            </Tooltip>
          ) : null}
        </span>
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
      {chips.length > 0 ? (
        <ApprovalRiskChips chips={chips} id={chipsId} />
      ) : null}
      {hasCmd ? (
        <div className={styles.approvalCardCmdWrap}>
          <span className={styles.approvalCardCmdLabel} id={cmdLabelId}>
            将执行
          </span>
          <code className={styles.approvalCardCmd} aria-labelledby={cmdLabelId}>
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
          {rememberIntent
            ? '高风险操作：再点一次「再次确认并记住」才会执行并加入白名单（Esc 取消准备）'
            : '高风险操作：再点一次「允许」才会执行（Esc 取消准备）'}
        </div>
      ) : null}

      <ApprovalNoteField
        note={note}
        onNoteChange={setNote}
        busy={!!busy}
        density={density}
        noteId={noteId}
      />

      <ApprovalActions
        confirmArmed={confirmArmed}
        rememberIntent={rememberIntent}
        needsDouble={needsDouble}
        busy={!!busy}
        allowBtnRef={allowBtnRef}
        onDisarm={disarm}
        onAllow={fireAllow}
        onDeny={handleDeny}
      />

      {remainingMs != null ? (
        <ApprovalCountdown remainingMs={remainingMs} percent={timeoutPercent} />
      ) : null}
    </div>
  );
};
