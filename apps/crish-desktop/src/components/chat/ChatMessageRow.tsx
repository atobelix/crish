import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pin, Check, Copy, PinOff } from 'lucide-react';
import styles from '../ChatMessageRow.module.css';
import { Tooltip } from '../settings/SettingsUI';
import type { FileDiff, SessionMessage } from '../../store/layoutStore';
import { ChatToolStack, type ChatToolStackSharedProps } from '../ChatToolCallBlock';
import { buildAssistantTimeline, type ToolRenderItem, assistantCopyText } from '../../api/toolPresentation';
import { THINKING_DOM_CHAR_CAP, budgetDomText } from '../../api/messageWindow';
import { useBubbleShrinkWidth } from '../../hooks/useTextMeasure';
import { buildPretextFontForUiSize } from '../../utils/pretextFontBridge';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import type { PermissionMode } from '../../api/permissionModes';
import { MessageContent } from './MessageContent';
import { MessageActions } from './MessageActions';
import { MessageThinking } from './MessageThinking';

export const USER_BUBBLE_LONG_CHARS = 260;
export const USER_BUBBLE_PREVIEW_CHARS = 240;
export type MessageRole = SessionMessage['sender'];

export function messageRoleLabelZh(role: MessageRole): string { return role === 'user' ? '你' : '助手'; }
export function messageRowAriaLabel(opts: { role: MessageRole; isPinned?: boolean; isThinking?: boolean; status?: SessionMessage['status'] }): string {
  const parts: string[] = [messageRoleLabelZh(opts.role)];
  if (opts.isPinned) parts.push('已固定');
  if (opts.status === 'queued') parts.push('排队中');
  else if (opts.isThinking || opts.status === 'processing') parts.push('生成中');
  return parts.join(' · ');
}
export function pinToggleLabels(isPinned: boolean): { title: string; ariaLabel: string } { return isPinned ? { title: '取消固定', ariaLabel: '取消固定' } : { title: '固定', ariaLabel: '固定消息' }; }
export function userBubbleExpandAria(isExpanded: boolean): string { return isExpanded ? '收起全文' : '展开全文'; }
export function thinkingFoldAria(opts: { isLive: boolean; isOpen: boolean }): string { if (opts.isLive) return '思考中'; return opts.isOpen ? '收起思考' : '展开思考'; }
export function formatMsgTime(ts?: number): string { if (!ts) return ''; return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }); }
export function isUserBubbleLong(text: string | undefined | null): boolean { return (text || '').length > USER_BUBBLE_LONG_CHARS; }
export function userBubbleDisplayText(text: string | undefined | null, isExpanded: boolean): string { const t = text || ''; if (isUserBubbleLong(t) && !isExpanded) return t.slice(0, USER_BUBBLE_PREVIEW_CHARS) + '…'; return t; }
export function looksLikePlan(text: string): boolean { const t = (text || '').trim(); if (!t) return false; if (/步骤|计划/.test(t)) return true; if (/^#{1,3}\s/m.test(t)) return true; if (/(?:^|\n)\s*\d+[.、]\s*\S/.test(t)) return true; return false; }
export function shouldHostToolStack(items: readonly ToolRenderItem[] | undefined | null): boolean { return Array.isArray(items) && items.length > 0; }
export function buildToolStackHostProps(items: ToolRenderItem[], msgId: string, shared: ChatToolStackSharedProps): ChatToolStackSharedProps & { items: ToolRenderItem[]; msgId: string } { return { items, msgId, ...shared }; }

export async function copyTextBestEffort(text: string): Promise<boolean> {
  if (!text) return false;
  try { if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch {}
  try { if (typeof document === 'undefined') return false; const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.left = '-9999px'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok; } catch { return false; }
}

export function toolStackSharedPropsEqual(a: ChatToolStackSharedProps, b: ChatToolStackSharedProps): boolean { return a.expandedTools === b.expandedTools && a.approvalBusy === b.approvalBusy && a.pendingApprovalMsgId === b.pendingApprovalMsgId && a.agents === b.agents && a.activeSessionId === b.activeSessionId; }
export type ChatToolStackProps = ChatToolStackSharedProps;

// ─── User Row ───────────────────────────────────────────────────────────────

export type ChatUserMessageRowProps = {
  msg: SessionMessage; isPinned: boolean; isSearchHit: boolean; isExpanded: boolean;
  onToggleExpand: (msgId: string) => void; onTogglePin: (msgId: string) => void; onWithdraw: (msgId: string, text: string) => void;
  onShowToast?: (message: string) => void; messageIndex: number; virtualScrollManager: VirtualScrollManager | null;
};

function userRowPropsEqual(prev: ChatUserMessageRowProps, next: ChatUserMessageRowProps): boolean {
  return prev.msg.id === next.msg.id && prev.msg.status === next.msg.status && prev.msg.text === next.msg.text && prev.msg.timestamp === next.msg.timestamp && prev.isPinned === next.isPinned && prev.isSearchHit === next.isSearchHit && prev.isExpanded === next.isExpanded;
}

const ChatUserMessageRowInner: React.FC<ChatUserMessageRowProps> = ({ msg, isPinned, isSearchHit, isExpanded, onToggleExpand, onTogglePin, onWithdraw: _onWithdraw, onShowToast, messageIndex, virtualScrollManager }) => {
  void _onWithdraw;
  const isLong = isUserBubbleLong(msg.text);
  const displayText = userBubbleDisplayText(msg.text, isExpanded);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const userRowRef = useRef<HTMLDivElement>(null);
  const userBubbleFont = useMemo(() => buildPretextFontForUiSize('medium', 'sans', 'normal'), []);
  const userBubbleWidth = useBubbleShrinkWidth(displayText, userBubbleFont, userRowRef, 32);
  const pinLabels = pinToggleLabels(isPinned);
  const rowAria = messageRowAriaLabel({ role: 'user', isPinned, status: msg.status });
  useEffect(() => () => { if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current); }, []);
  useEffect(() => { virtualScrollManager?.invalidateActual(messageIndex); }, [msg.text, messageIndex, virtualScrollManager]);
  const handleCopy = useCallback(() => { const text = msg.text || ''; if (!text) return; void copyTextBestEffort(text).then((ok) => { if (!ok) { onShowToast?.('复制失败'); return; } setCopied(true); if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current); copiedTimer.current = window.setTimeout(() => setCopied(false), 1200); }); }, [msg.text, onShowToast]);
  const toggleExpand = useCallback(() => { if (isLong) { const sel = window.getSelection()?.toString(); if (sel) return; onToggleExpand(msg.id); } }, [isLong, msg.id, onToggleExpand]);
  const onBubbleKeyDown = useCallback((e: React.KeyboardEvent) => { if (!isLong) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleExpand(msg.id); } }, [isLong, msg.id, onToggleExpand]);
  return (
    <div className={`${styles.row} ${styles.rowUser} msg-row msg-row-user${isSearchHit ? ` ${styles.searchHit} msg-search-hit` : ''}${isPinned ? ` ${styles.isPinned}` : ''}`} ref={userRowRef}
      data-msg-id={msg.id} data-role="user" data-pinned={isPinned ? 'true' : undefined} role="article" aria-label={rowAria}>
      <div className={styles.userStack}>
        {isPinned ? <Tooltip content="已固定"><span className={styles.pinBadge} aria-hidden="true"><Pin size={11} strokeWidth={2.25} />已固定</span></Tooltip> : null}
        <div className={`${styles.userBubble} ${isExpanded ? 'expanded' : ''}`} onClick={toggleExpand} onKeyDown={onBubbleKeyDown}
          style={{ cursor: isLong ? 'pointer' : 'default', maxWidth: userBubbleWidth ?? undefined }} role={isLong ? 'button' : undefined} tabIndex={isLong ? 0 : undefined}
          aria-expanded={isLong ? isExpanded : undefined} aria-label={isLong ? userBubbleExpandAria(isExpanded) : undefined}>
          <span className={styles.userText}>{displayText}</span>
          {msg.status === 'queued' && <span className={styles.queued}>排队中</span>}
        </div>
        <div className={styles.userMeta}>
          <span className={styles.time}>{formatMsgTime(msg.timestamp)}</span>
          <Tooltip content={copied ? '已复制' : '复制消息'}>
            <button type="button" className={`${styles.iconBtn}${copied ? ` ${styles.isCopied}` : ''}`} aria-label={copied ? '已复制' : '复制消息'} onClick={handleCopy}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </Tooltip>
          {isPinned ? <Tooltip content={pinLabels.title}><button type="button" className={`${styles.iconBtn} ${styles.isPinnedActive}`} aria-label={pinLabels.ariaLabel} aria-pressed onClick={() => onTogglePin(msg.id)}><PinOff size={14} /></button></Tooltip> : null}
        </div>
      </div>
    </div>
  );
};

export const ChatUserMessageRow = React.memo(ChatUserMessageRowInner, userRowPropsEqual);

// ─── Assistant Row ──────────────────────────────────────────────────────────

export type ChatAssistantMessageRowProps = {
  msg: SessionMessage; isFollowUp: boolean; isPinned: boolean; isSearchHit: boolean; isThinkingMsg: boolean;
  thinkingSeconds: number; hideThinkingBlock: boolean; inPlanMode: boolean; planApproved: boolean; isLastAssistant: boolean;
  toolStackProps: ChatToolStackSharedProps; onTogglePin: (msgId: string) => void; onShowToast: (message: string) => void;
  onRegenerate: (assistantMsgId: string) => void; onBranch: () => void; onOpenDiff: (diff: FileDiff) => void; onOpenDiffPanel?: () => void;
  setPermissionMode: (mode: PermissionMode) => void; setPlanApproved: (v: boolean) => void; onFillFollowUp?: (prompt: string) => void;
  onSendFollowUp?: (prompt: string) => void; followUpDismissed?: boolean; onDismissFollowUp?: (msgId: string) => void; messageIndex: number; virtualScrollManager: VirtualScrollManager | null;
};

function assistantRowPropsEqual(prev: ChatAssistantMessageRowProps, next: ChatAssistantMessageRowProps): boolean {
  if (prev.isThinkingMsg || next.isThinkingMsg) { if (prev.thinkingSeconds !== next.thinkingSeconds) return false; }
  return prev.msg.id === next.msg.id && prev.msg.status === next.msg.status && prev.msg.text === next.msg.text && prev.msg.thinking === next.msg.thinking && prev.msg.toolCalls === next.msg.toolCalls && prev.msg.blocks === next.msg.blocks && prev.msg.thinkingTime === next.msg.thinkingTime && prev.msg.timestamp === next.msg.timestamp && prev.isPinned === next.isPinned && prev.isSearchHit === next.isSearchHit && prev.isFollowUp === next.isFollowUp && prev.isThinkingMsg === next.isThinkingMsg && prev.hideThinkingBlock === next.hideThinkingBlock && prev.inPlanMode === next.inPlanMode && prev.planApproved === next.planApproved && prev.isLastAssistant === next.isLastAssistant && prev.followUpDismissed === next.followUpDismissed && toolStackSharedPropsEqual(prev.toolStackProps, next.toolStackProps);
}

const ChatAssistantMessageRowInner: React.FC<ChatAssistantMessageRowProps> = ({ msg, isFollowUp, isPinned, isSearchHit, isThinkingMsg, thinkingSeconds, hideThinkingBlock, inPlanMode, planApproved, isLastAssistant, toolStackProps, onTogglePin, onShowToast, onRegenerate, onBranch: _onBranch, onOpenDiff, onOpenDiffPanel, setPermissionMode, setPlanApproved, onFillFollowUp, onSendFollowUp, followUpDismissed = false, onDismissFollowUp, messageIndex, virtualScrollManager }) => {
  void _onBranch;
  const assistantRowRef = useRef<HTMLDivElement>(null);
  const assistantBubbleFont = useMemo(() => buildPretextFontForUiSize('medium', 'sans', 'normal'), []);
  const assistantPlainText = msg.text || '';
  const assistantBubbleWidth = useBubbleShrinkWidth(assistantPlainText, assistantBubbleFont, assistantRowRef, 0);
  const thinkingRaw = msg.thinking && msg.thinking.trim() && msg.thinking !== '正在处理…' && msg.thinking !== '正在思考中...' ? msg.thinking.trim() : '';
  const thinkingText = thinkingRaw || (isThinkingMsg ? '…' : '');
  const thinkingLineCount = thinkingText ? thinkingText.split(/\r?\n/).length : 0;
  const showThinking = !hideThinkingBlock && (isThinkingMsg || thinkingLineCount > 0);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const pinLabels = pinToggleLabels(isPinned);
  const rowAria = messageRowAriaLabel({ role: 'assistant', isPinned, isThinking: isThinkingMsg, status: msg.status });
  const thinkingBodyId = `msg-thinking-${msg.id}`;
  useEffect(() => { if (isThinkingMsg) setThinkingOpen(true); else setThinkingOpen(false); }, [isThinkingMsg, msg.id]);
  useEffect(() => () => { if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current); }, []);
  useEffect(() => { virtualScrollManager?.invalidateActual(messageIndex); }, [msg.text, messageIndex, virtualScrollManager]);
  const thinkingBodyOpen = isThinkingMsg || thinkingOpen;
  const thinkingBudget = budgetDomText(thinkingText, THINKING_DOM_CHAR_CAP);
  const timeline = useMemo(() => buildAssistantTimeline(msg), [msg]);
  return (
    <div className={`${styles.row} ${styles.rowAssistant} msg-row msg-row-assistant ${isFollowUp ? styles.isFollowup : ''}${isSearchHit ? ` ${styles.searchHit} msg-search-hit` : ''}${isPinned ? ` ${styles.isPinned}` : ''}`}
      ref={assistantRowRef} data-msg-id={msg.id} data-role="assistant" data-pinned={isPinned ? 'true' : undefined} data-followup={isFollowUp ? 'true' : undefined} role="article" aria-label={rowAria}>
      {isPinned ? <Tooltip content="已固定"><span className={styles.pinBadge} aria-hidden="true"><Pin size={11} strokeWidth={2.25} />已固定</span></Tooltip> : null}
      {showThinking ? <MessageThinking isThinkingMsg={isThinkingMsg} thinkingBodyOpen={thinkingBodyOpen} thinkingSeconds={thinkingSeconds} thinkingBudget={thinkingBudget} thinkingFoldAria={thinkingFoldAria} thinkingBodyId={thinkingBodyId} onToggleThinking={() => { if (isThinkingMsg) return; setThinkingOpen((v) => !v); }} /> : null}
      <MessageContent timeline={timeline} isThinkingMsg={isThinkingMsg} msgStatus={msg.status} msgId={msg.id} assistantBodyStyle={{ maxWidth: assistantBubbleWidth ?? undefined }} />
      {(() => {
        if (timeline.length) return timeline.map((item) => { if (item.kind !== 'tool') return null; if (!shouldHostToolStack(item.items)) return null; const host = buildToolStackHostProps(item.items, msg.id, toolStackProps); return <div key={item.key} className={styles.timelineTools}><ChatToolStack {...host} /></div>; });
        return null;
      })()}
      {msg.status !== 'processing' && !isThinkingMsg && (
        <MessageActions msg={msg} isPinned={isPinned} isLastAssistant={isLastAssistant} isThinkingMsg={isThinkingMsg} isFollowUp={isFollowUp}
          inPlanMode={inPlanMode} planApproved={planApproved} followUpDismissed={followUpDismissed}
          onTogglePin={onTogglePin} onRegenerate={onRegenerate} onBranch={_onBranch} onOpenDiff={onOpenDiff} onOpenDiffPanel={onOpenDiffPanel}
          onShowToast={onShowToast} setPermissionMode={setPermissionMode} setPlanApproved={setPlanApproved}
          onFillFollowUp={onFillFollowUp} onSendFollowUp={onSendFollowUp} onDismissFollowUp={onDismissFollowUp} />
      )}
    </div>
  );
};

export const ChatAssistantMessageRow = React.memo(ChatAssistantMessageRowInner, assistantRowPropsEqual);
