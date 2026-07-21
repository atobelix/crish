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
import { Tooltip } from './settings/SettingsUI';
import {
  approvalRiskBadgeLabel,
  approvalRiskKindLabel,
  approvalRiskLevelLabel,
  approvalRiskSummary,
  approvalTrustZoneHint,
  approvalTrustZoneLabel,
  hasApprovalRiskFacts,
  type ApprovalRiskMeta,
} from '../api/approvalMeta';
import {
  allowButtonLabel,
  approvalCardClassName,
  buildApprovalRiskChips,
  nextAllowConfirmPhase,
  plainApprovalQuestion,
  shouldResetAllowConfirmArmed,
  type ApprovalRiskChip,
} from '../api/chatApprovalUi';
import type { MessageToolApprovalMeta } from '../store/types';

type Props = {
  msgId: string;
  /** 工具调用 id，供底部审批条 scrollIntoView */
  toolId?: string;
  summary: string;
  cmd?: string;
  busy?: boolean;
  /** 后端审批风险事实 */
  riskMeta?: MessageToolApprovalMeta | ApprovalRiskMeta | null;
  onAllow: (note: string) => void;
  onAllowRemember: (note: string) => void;
  onDeny: () => void;
  /** 超时倒计时 ms（父级传入则渲染进度条） */
  remainingMs?: number;
  /** 超时回调 */
  onTimeout?: () => void;
};

function toRiskMeta(
  riskMeta?: MessageToolApprovalMeta | ApprovalRiskMeta | null,
): ApprovalRiskMeta | null {
  if (!riskMeta) return null;
  return {
    trustZone: riskMeta.trustZone,
    risk: riskMeta.risk,
    riskReason: riskMeta.riskReason,
    riskLevel: riskMeta.riskLevel || 'unknown',
    requiresDoubleConfirm: Boolean(riskMeta.requiresDoubleConfirm),
    recommendSnapshot: Boolean(riskMeta.recommendSnapshot),
    source: riskMeta.source || 'unknown',
  };
}

/** 将 helper 产出的英/代码 chips 本地化为中文短标签（不改 chatApprovalUi） */
function localizeRiskChips(
  chips: ApprovalRiskChip[],
  riskMeta: ApprovalRiskMeta | null,
): ApprovalRiskChip[] {
  if (chips.length === 0) return chips;
  return chips.map((chip) => {
    if (chip.key === 'zone') {
      const zh = approvalTrustZoneLabel(riskMeta?.trustZone || chip.label);
      return zh && zh !== chip.label ? { ...chip, label: zh } : chip;
    }
    if (chip.key === 'risk') {
      const zh = approvalRiskKindLabel(riskMeta?.risk || chip.label);
      return zh && zh !== chip.label ? { ...chip, label: zh } : chip;
    }
    if (chip.key === 'level') {
      const raw = riskMeta?.riskLevel || chip.label;
      const zh = approvalRiskLevelLabel(raw);
      return zh && zh !== chip.label ? { ...chip, label: zh } : chip;
    }
    // double / snap 已是中文
    return chip;
  });
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

/** 去重中文 chip 标签（zone/risk 中文可能撞车，如写操作） */
function dedupeChipLabels(chips: ApprovalRiskChip[]): ApprovalRiskChip[] {
  const seen = new Set<string>();
  const out: ApprovalRiskChip[] = [];
  for (const c of chips) {
    const k = c.label.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
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
    riskMeta?.riskReason && riskMeta.riskReason !== summary,
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
        prevToolId: prevTool,
        nextToolId: nextTool,
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
      const elapsed = timeoutTotalRef.current - remainingMs;
      const pct = Math.max(0, Math.min(100, (remainingMs / timeoutTotalRef.current) * 100));
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
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus({ preventScroll: true });
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
  if (showSummary || showReason || riskAriaSummary) describedByParts.push(descId);
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
            <span className={styles.approvalCardZone} title={zoneTitle}>
              {' '}
              · {zoneHint}
            </span>
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
        <div
          className={`${styles.approvalCardDesc} ${styles.approvalCardReason}`}
          id={descId}
          title={riskMeta?.riskReason}
        >
          {riskMeta?.riskReason}
        </div>
      ) : riskAriaSummary && riskAriaSummary !== question ? (
        <div className={styles.approvalCardDesc} id={descId} hidden>
          {riskAriaSummary}
        </div>
      ) : null}
      {showSummary && showReason ? (
        <div
          className={`${styles.approvalCardDesc} ${styles.approvalCardReason}`}
          title={riskMeta?.riskReason}
        >
          {riskMeta?.riskReason}
        </div>
      ) : null}
      {chips.length > 0 ? (
        <div
          className={styles.approvalCardMeta}
          id={chipsId}
          role="list"
          aria-label="风险标签"
        >
          {chips.map((chip) => (
            <span
              key={chip.key}
              role="listitem"
              className={`${styles.approvalCardChip} ${
                chip.tone === 'warn'
                  ? styles.approvalCardChipWarn
                  : chip.tone === 'danger'
                    ? styles.approvalCardChipDanger
                    : chip.tone === 'info'
                      ? styles.approvalCardChipInfo
                      : chip.tone === 'neutral'
                        ? styles.approvalCardChipNeutral
                        : ''
              }`}
              title={chip.label}
            >
              {chip.label}
            </span>
          ))}
        </div>
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

      <label className={styles.approvalCardNote} htmlFor={noteId}>
        <span>补充说明（可选，也可直接写你的要求）</span>
        <textarea
          id={noteId}
          className={styles.approvalCardInput}
          rows={density === 'compact' && !note ? 1 : 2}
          maxLength={500}
          placeholder="例如：只允许这一次 / 不要改测试文件…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
          aria-label="补充说明（可选）"
        />
        {note.length > 0 || density === 'default' ? (
          <span className={styles.approvalCardCount} aria-hidden={note.length === 0}>
            {note.length}/500
          </span>
        ) : null}
      </label>

      <div className={styles.approvalCardActions} role="group" aria-label="审批操作">
        {confirmArmed ? (
          <Tooltip content="取消二次确认准备 (Esc)">
            <button
              type="button"
              className={`${styles.approvalCardBtn} ${styles.ghost} ${styles.disarm}`}
              disabled={busy}
              onClick={disarm}
              aria-label="取消二次确认准备"
              aria-keyshortcuts="Escape"
            >
              取消准备
            </button>
          </Tooltip>
        ) : (
          <Tooltip content="允许，并将命令前缀加入白名单">
            <button
              type="button"
              className={`${styles.approvalCardBtn} ${styles.ghost}`}
              disabled={busy}
              onClick={() => fireAllow(true)}
              aria-label={
                needsDouble
                  ? '记住并准备允许（需再次确认）'
                  : '允许并记住命令前缀'
              }
              aria-busy={busy ? true : undefined}
            >
              {allowButtonLabel(needsDouble, confirmArmed, true)}
            </button>
          </Tooltip>
        )}
        <button
          type="button"
          className={`${styles.approvalCardBtn} ${styles.deny}`}
          disabled={busy}
          onClick={handleDeny}
          aria-label="拒绝此操作"
          aria-busy={busy ? true : undefined}
        >
          拒绝
        </button>
        <button
          ref={allowBtnRef}
          type="button"
          className={`${styles.approvalCardBtn} ${styles.allow}${confirmArmed ? ` ${styles.isArmed}` : ''}`}
          disabled={busy}
          onClick={() => fireAllow(false)}
          aria-label={
            confirmArmed
              ? rememberIntent
                ? '再次确认允许并记住'
                : '再次确认允许'
              : needsDouble
                ? '准备允许（需再次确认）'
                : '允许'
          }
          aria-pressed={needsDouble ? confirmArmed : undefined}
          aria-busy={busy ? true : undefined}
          data-armed={confirmArmed ? 'true' : undefined}
        >
          {allowButtonLabel(needsDouble, confirmArmed, rememberIntent)}
        </button>
      </div>

      {remainingMs != null ? (
        <div
          className={`${styles.approvalCardTimeoutBar} ${
            timeoutPercent <= 0 ? styles.approvalCardTimeoutBarExpired : ''
          }`}
          role="progressbar"
          aria-valuenow={Math.round(timeoutPercent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`审批剩余时间 ${Math.ceil((remainingMs) / 1000)} 秒`}
        >
          <span
            className={styles.approvalCardTimeoutFill}
            style={{ width: `${timeoutPercent}%` }}
          />
        </div>
      ) : null}
    </div>
  );
};
