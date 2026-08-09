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
import * as Lucide from 'lucide-react';
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

/**
 * 归一化风险事实；payload（S9 审批载荷）仅后端来源 MessageToolApprovalMeta
 * 携带，UI 归一形态 ApprovalRiskMeta 无此字段——用 in 收窄后透传。
 */
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
  if (zone) return zone;
  if (risk) return risk;
  return '';
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
  /** 首次点击「记住并准备允许」时保留意图，二次确认后仍走 remember */
  const [rememberIntent, setRememberIntent] = useState(false);
  const prevToolIdRef = useRef<string | undefined>(toolId);
  const prevMsgIdRef = useRef(msgId);
  const allowBtnRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const commitLockRef = useRef(false);
  /** 超时倒计时百分比 0-100，用于进度条宽度 */
  const [timeoutPercent, setTimeoutPercent] = useState(100);
  const timeoutTotalRef = useRef(remainingMs ?? 0);
  const timeoutFiredRef = useRef(false);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- riskMeta 每次渲染新引用，字段级依赖有意为之
  }, [
    riskMeta?.trustZone,
    riskMeta?.risk,
    riskMeta?.riskLevel,
    riskMeta?.requiresDoubleConfirm,
    riskMeta?.recommendSnapshot,
  ]);

  const zoneHint = chineseZoneHint(riskMeta);
  const hasRiskFacts = hasApprovalRiskFacts(riskMeta);
  const zoneTitle =
    riskMeta?.riskReason ||
    approvalTrustZoneHint(riskMeta?.trustZone) ||
    (hasRiskFacts ? approvalRiskSummary(riskMeta) : '') ||
    zoneHint;
  /** 仅有后端事实时才注入隐藏摘要，避免无 meta 时「缺少…」噪音 */
  const riskAriaSummary = hasRiskFacts ? approvalRiskSummary(riskMeta) : '';

  const showSummary = Boolean(summary && summary !== question);
  const showReason = Boolean(
    riskMeta?.riskReason && riskMeta.riskReason !== summary
  );
  const hasCmd = Boolean(cmd && cmd.trim());
  const hasExtraDesc = showSummary || showReason;
  /** 紧凑：无命令、无长描述、chips ≤2 时降低视觉密度 */
  const density: 'compact' | 'default' =
    !hasCmd && !hasExtraDesc && chips.length <= 2 ? 'compact' : 'default';

  const disarm = useCallback(() => {
    setConfirmArmed(false);
    setRememberIntent(false);
    commitLockRef.current = false;
  }, []);

  /**
   * toolId / msgId 切换或后端取消二次确认：解除武装。
   * 与 shouldResetAllowConfirmArmed 策略一致；msgId 变化额外防护跨消息残留。
   */
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
      commitLockRef.current = false;
    }
    prevToolIdRef.current = nextTool;
    prevMsgIdRef.current = msgId;
  }, [toolId, msgId, needsDouble]);

  // busy：提交中解除武装；busy 结束后释放 commit 锁，避免父级未置 busy 时卡死
  useEffect(() => {
    if (busy) {
      setConfirmArmed(false);
      setRememberIntent(false);
    } else {
      commitLockRef.current = false;
    }
  }, [busy]);

  // Esc：取消「再次确认」武装，不提交拒绝
  useEffect(() => {
    if (!confirmArmed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        disarm();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirmArmed, disarm]);

  // mount 时自动聚焦到卡片根，键盘用户立即可达。
  // 旧实现无 auto-focus，用户需手动 Tab 多次才能到达审批按钮。
  useEffect(() => {
    const t = window.setTimeout(() => {
      rootRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(t);
  }, [msgId, toolId]);

  // 超时倒计时进度条
  useEffect(() => {
    if (remainingMs == null || remainingMs <= 0) return;
    timeoutTotalRef.current = Math.max(remainingMs, 1);
    timeoutFiredRef.current = false;
    setTimeoutPercent(100);

    const interval = setInterval(() => {
      const pct = Math.max(
        0,
        Math.min(100, (remainingMs / timeoutTotalRef.current) * 100)
      );
      setTimeoutPercent(pct);
    }, 100);
    return () => clearInterval(interval);
  }, [remainingMs]);

  // 超时触发
  useEffect(() => {
    if (remainingMs == null || remainingMs > 0) return;
    if (timeoutFiredRef.current) return;
    if (busy || commitLockRef.current) return;
    timeoutFiredRef.current = true;
    onTimeout?.();
  }, [remainingMs, busy, onTimeout]);

  // Focus trap：Tab / Shift+Tab 在卡片内循环，不漂回页面其他元素。
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last!.focus({ preventScroll: true });
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first!.focus({ preventScroll: true });
        }
      }
    };
    root.addEventListener('keydown', onKey);
    return () => root.removeEventListener('keydown', onKey);
  }, [confirmArmed]);

  // Enter 快捷键：武装状态下触发允许，未武装时武装。
  // 注意：textarea 内 Enter 仍换行（不阻止默认行为），仅在按钮焦点时触发。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      // textarea 内不拦截——用户可能输入多行 note
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'TEXTAREA') return;
      e.preventDefault();
      e.stopPropagation();
      fireAllow(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // fireAllow 依赖 confirmArmed / busy / rememberIntent / note，需重绑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmArmed, busy, rememberIntent, note]);

  // 武装后把焦点移到主允许按钮，降低误触其它控件概率
  useEffect(() => {
    if (!confirmArmed || busy) return;
    const t = window.setTimeout(() => {
      allowBtnRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(t);
  }, [confirmArmed, busy]);

  const fireAllow = (remember: boolean) => {
    if (busy || commitLockRef.current) return;
    const phase = nextAllowConfirmPhase(needsDouble, confirmArmed);
    if (phase === 'armed') {
      setConfirmArmed(true);
      setRememberIntent(remember);
      return;
    }
    // commit：合并首次「记住」意图与本次点击；短锁防双击连发
    const doRemember = remember || rememberIntent;
    commitLockRef.current = true;
    setConfirmArmed(false);
    setRememberIntent(false);
    if (doRemember) onAllowRemember(note);
    else onAllow(note);
    window.setTimeout(() => {
      commitLockRef.current = false;
    }, 480);
  };

  const handleDeny = () => {
    // 拒绝前先解除武装，避免残留 is-confirm-armed 样式
    if (confirmArmed || rememberIntent) disarm();
    if (busy || commitLockRef.current) return;
    onDeny();
  };

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
          <Lucide.ShieldQuestion size={14} strokeWidth={1.75} aria-hidden />
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
      {chips.length > 0 ? <ApprovalRiskChips chips={chips} id={chipsId} /> : null}
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
