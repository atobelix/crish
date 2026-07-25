import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Check, Copy, PinOff, RefreshCw, Send, X } from 'lucide-react';
import styles from '../ChatMessageRow.module.css';
import { Tooltip } from '../settings/SettingsUI';
import type { FileDiff } from '../../store/layoutStore';
import { looksLikePlan, formatMsgTime, pinToggleLabels, copyTextBestEffort } from './ChatMessageRow';
import { assistantCopyText } from '../../api/toolPresentation';
import type { PermissionMode } from '../../api/permissionModes';
import { shouldShowFollowUpSuggestions, buildFollowUpSuggestions, type FollowUpSuggestion } from '../../api/followUpSuggestions';
import { ChangeOverviewCard } from '../ChangeOverviewCard';

interface MessageActionsProps {
  msg: { id: string; text?: string; timestamp?: number; status?: string; toolCalls?: { id?: string; name?: string; status?: string; output?: string }[] };
  isPinned: boolean; isLastAssistant: boolean; isThinkingMsg: boolean; isFollowUp: boolean;
  inPlanMode: boolean; planApproved: boolean; followUpDismissed: boolean;
  onTogglePin: (msgId: string) => void; onRegenerate: (assistantMsgId: string) => void; onBranch: () => void;
  onOpenDiff: (diff: FileDiff) => void; onOpenDiffPanel?: () => void; onShowToast: (message: string) => void;
  setPermissionMode: (mode: PermissionMode) => void; setPlanApproved: (v: boolean) => void;
  onFillFollowUp?: (prompt: string) => void; onSendFollowUp?: (prompt: string) => void; onDismissFollowUp?: (msgId: string) => void;
}

export const MessageActions: React.FC<MessageActionsProps> = React.memo(({ msg, isPinned, isLastAssistant, isThinkingMsg, inPlanMode, planApproved, followUpDismissed, onTogglePin, onRegenerate, onOpenDiff, onOpenDiffPanel, onShowToast, setPermissionMode, setPlanApproved, onFillFollowUp, onSendFollowUp, onDismissFollowUp }) => {
  const pinLabels = pinToggleLabels(isPinned);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current); }, []);
  const onCopyAction = useCallback(() => { const text = assistantCopyText(msg); if (!text.trim()) { onShowToast('没有可复制的正文'); return; } void copyTextBestEffort(text).then((ok) => { if (!ok) { onShowToast('复制失败'); return; } setCopied(true); if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current); copiedTimer.current = window.setTimeout(() => setCopied(false), 1200); }); }, [msg, onShowToast]);

  if (isThinkingMsg) return null;

  return (<>
    {inPlanMode && !planApproved && isLastAssistant && looksLikePlan(assistantCopyText(msg) || msg.text || '') ? <div className={styles.planApproveRow}><button type="button" className={styles.planApproveChip} onClick={() => { setPermissionMode('ask'); setPlanApproved(true); }}>批准此计划</button></div> : null}
    <div className={styles.assistantMeta}>
      <span className={styles.time}>{formatMsgTime(msg.timestamp)}</span>
      <Tooltip content={copied ? '已复制' : '复制正文'}>
        <button type="button" className={`${styles.iconBtn}${copied ? ` ${styles.isCopied}` : ''}`} aria-label={copied ? '已复制' : '复制正文'} onClick={onCopyAction}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </Tooltip>
      {isLastAssistant ? <Tooltip content="重新生成"><button type="button" className={styles.iconBtn} aria-label="重新生成" onClick={() => onRegenerate(msg.id)}><RefreshCw size={14} /></button></Tooltip> : null}
      {isPinned ? <Tooltip content={pinLabels.title}><button type="button" className={`${styles.iconBtn} ${styles.isPinnedActive}`} aria-label={pinLabels.ariaLabel} aria-pressed onClick={() => onTogglePin(msg.id)}><PinOff size={14} /></button></Tooltip> : null}
    </div>
    {(() => {
      if (!onFillFollowUp && !onSendFollowUp) return null;
      if (!shouldShowFollowUpSuggestions({ isLastAssistant, isThinkingMsg, status: msg.status, toolCalls: msg.toolCalls, dismissed: followUpDismissed })) return null;
      const suggestions: FollowUpSuggestion[] = buildFollowUpSuggestions(msg);
      if (!suggestions.length) return null;
      return (<div className={styles.followupRow} role="group" aria-label="后续建议" data-followup-for={msg.id}>
        <div className={styles.followupChips} role="list">
          {suggestions.map((s) => (<div key={s.id} className={styles.followupChip} role="listitem" data-followup-id={s.id}>
            <Tooltip content={s.prompt}><button type="button" className={styles.followupChipMain} aria-label={`填入：${s.label}`} onClick={() => { onFillFollowUp?.(s.prompt); }}><span className={styles.followupChipLabel}>{s.label}</span></button></Tooltip>
            {onSendFollowUp ? <Tooltip content="直接发送"><button type="button" className={styles.followupChipSend} aria-label={`直接发送：${s.label}`} onClick={() => onSendFollowUp(s.prompt)}><Send size={12} strokeWidth={2} aria-hidden /></button></Tooltip> : null}
          </div>))}
        </div>
        {onDismissFollowUp ? <Tooltip content="关闭建议"><button type="button" className={`${styles.followupDismiss} ${styles.iconBtn}`} aria-label="关闭后续建议" onClick={() => onDismissFollowUp(msg.id)}><X size={14} aria-hidden /></button></Tooltip> : null}
      </div>);
    })()}
    <React.Suspense fallback={null}><ChangeOverviewCard message={msg} onOpenDiff={onOpenDiff} onOpenDiffPanel={onOpenDiffPanel} onShowToast={onShowToast} /></React.Suspense>
  </>);
});

MessageActions.displayName = 'MessageActions';
