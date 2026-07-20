/**
 * 消息行：user / assistant 行级组件，React.memo 避免流式时历史行无谓 reconcile。
 * className 与 ChatMessageList 原逻辑保持一致。
 *
 * 契约：
 * - 复制：成功静默（按钮 is-copied）；失败 toast「复制失败」
 * - Pin：行内 toggle + data-msg-id 供列表 pin 跳转 / 闪高亮；role=article + 中文 aria
 * - 角色文案：messageRoleLabelZh（你 / 助手）与固定条 chat-pinned-role 一致
 * - 工具栈：仅经 toolStackProps handoff 托管 ChatToolStack，禁止行内二次实现工具 UI
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatMessageRow.module.css';
import { Tooltip } from './settings/SettingsUI';
import type { FileDiff, SessionMessage } from '../store/layoutStore';
import {
  ChatToolStack,
  type ChatToolStackSharedProps,
} from './ChatToolCallBlock';
import {
  assistantCopyText,
  buildAssistantTimeline,
  extractImageRefs,
  type ToolRenderItem,
} from '../api/toolPresentation';
import {
  buildFollowUpSuggestions,
  shouldShowFollowUpSuggestions,
  type FollowUpSuggestion,
} from '../api/followUpSuggestions';
import { stripThoughtPlaceholders, escapeHtml } from '../api/markdownRender';
import { parseMarkdownToHtmlAsync } from '../api/markdownRenderAsync';
import { getMarkdownHtmlCache } from '../api/markdownCache';
import { IncrementalMarkdownBridge } from '../api/incrementalMarkdownBridge';
import { chunkUpdatesToDomPatches, applyDomPatches } from '../api/domPatch';
import { Priority } from '../workers';
import { ChangeOverviewCard } from './ChangeOverviewCard';
import type { PermissionMode } from '../api/permissionModes';
import { THINKING_DOM_CHAR_CAP, budgetDomText } from '../api/messageWindow';
import { useBubbleShrinkWidth, usePreparedText } from '../hooks/useTextMeasure';
import { buildPretextFontForUiSize } from '../utils/pretextFontBridge';
import { VirtualScrollManager } from '../api/VirtualScrollManager';

// ─── 密度常量（长用户气泡截断） ─────────────────────────────────────────────

/** 超过此字数视为长气泡，默认截断展示 */
export const USER_BUBBLE_LONG_CHARS = 260;
/** 折叠预览保留字数（其后加省略号） */
export const USER_BUBBLE_PREVIEW_CHARS = 240;

// ─── 中文角色 / Pin a11y 纯助手 ─────────────────────────────────────────────

export type MessageRole = SessionMessage['sender'];

/**
 * 消息角色中文短标签（与 ChatMessageList 固定条 chat-pinned-role 文案一致）。
 * user → 你；assistant → 助手。
 */
export function messageRoleLabelZh(role: MessageRole): string {
  return role === 'user' ? '你' : '助手';
}

/**
 * 行级 article aria-label：角色 · 固定 · 状态（中文、克制、可测）。
 */
export function messageRowAriaLabel(opts: {
  role: MessageRole;
  isPinned?: boolean;
  isThinking?: boolean;
  status?: SessionMessage['status'];
}): string {
  const parts: string[] = [messageRoleLabelZh(opts.role)];
  if (opts.isPinned) parts.push('已固定');
  if (opts.status === 'queued') parts.push('排队中');
  else if (opts.isThinking || opts.status === 'processing') parts.push('生成中');
  return parts.join(' · ');
}

/** Pin 按钮中文 title / aria-label（pressed 态由调用方挂 aria-pressed） */
export function pinToggleLabels(isPinned: boolean): {
  title: string;
  ariaLabel: string;
} {
  return isPinned
    ? { title: '取消固定', ariaLabel: '取消固定' }
    : { title: '固定', ariaLabel: '固定消息' };
}

/** 长用户气泡展开控件中文 a11y */
export function userBubbleExpandAria(isExpanded: boolean): string {
  return isExpanded ? '收起全文' : '展开全文';
}

/** 思考折叠按钮中文 a11y（进行中不可切换） */
export function thinkingFoldAria(opts: {
  isLive: boolean;
  isOpen: boolean;
}): string {
  if (opts.isLive) return '思考中';
  return opts.isOpen ? '收起思考' : '展开思考';
}

// ─── 密度：时间 / 长气泡 / 计划探测 ─────────────────────────────────────────

/** 行内时间：24h 两位；无时间戳 → 空串 */
export function formatMsgTime(ts?: number): string {
  if (!ts) return '';
  const date = new Date(ts);
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** @deprecated 使用 formatMsgTime；保留别名避免外部 import 断裂 */
function formatTime(ts?: number) {
  return formatMsgTime(ts);
}

/** 是否超过长气泡阈值 */
export function isUserBubbleLong(text: string | undefined | null): boolean {
  return (text || '').length > USER_BUBBLE_LONG_CHARS;
}

/**
 * 用户气泡展示正文：长且未展开 → 截断 + …；否则全文。
 * 空/undefined → ''。
 */
export function userBubbleDisplayText(
  text: string | undefined | null,
  isExpanded: boolean,
): string {
  const t = text || '';
  if (isUserBubbleLong(t) && !isExpanded) {
    return t.slice(0, USER_BUBBLE_PREVIEW_CHARS) + '…';
  }
  return t;
}

/** 助手回复是否像「计划」：含步骤/计划/编号列表/标题 */
export function looksLikePlan(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  if (/步骤|计划/.test(t)) return true;
  if (/^#{1,3}\s/m.test(t)) return true;
  // 1. / 1、 / 2. 等有序列表（顿号后可无空格）
  if (/(?:^|\n)\s*\d+[\.、]\s*\S/.test(t)) return true;
  return false;
}

// ─── 工具栈 handoff（仅托管，无工具 UI 逻辑） ───────────────────────────────

/**
 * 是否应挂载工具时间线段：有可渲染 items 才 host，避免空壳 DOM。
 * 行组件不解析 toolCalls / 不自建工具行——只 handoff 给 ChatToolStack。
 */
export function shouldHostToolStack(
  items: readonly ToolRenderItem[] | undefined | null,
): boolean {
  return Array.isArray(items) && items.length > 0;
}

/**
 * 组装 ChatToolStack 入参：msg 局部 items/msgId + List 下发的共享 props。
 * 单一 handoff 出口，禁止在行内展开工具审批/diff/终端逻辑。
 */
export function buildToolStackHostProps(
  items: ToolRenderItem[],
  msgId: string,
  shared: ChatToolStackSharedProps,
): ChatToolStackSharedProps & { items: ToolRenderItem[]; msgId: string } {
  return { items, msgId, ...shared };
}

/**
 * 尽力复制：clipboard API → execCommand 回退。
 * 返回 false 时调用方应 toast「复制失败」（禁止成功 toast）。
 */
export async function copyTextBestEffort(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 行级工具栈共享 props 浅比较（仅数据字段；回调假定稳定） */
export function toolStackSharedPropsEqual(
  a: ChatToolStackSharedProps,
  b: ChatToolStackSharedProps,
): boolean {
  return (
    a.expandedTools === b.expandedTools &&
    a.approvalBusy === b.approvalBusy &&
    a.pendingApprovalMsgId === b.pendingApprovalMsgId &&
    a.agents === b.agents &&
    a.activeSessionId === b.activeSessionId
  );
}

/** @deprecated 使用 ChatToolStackSharedProps；保留别名避免外部 import 断裂 */
export type ChatToolStackProps = ChatToolStackSharedProps;

// ─── User row ───────────────────────────────────────────────────────────────

export type ChatUserMessageRowProps = {
  msg: SessionMessage;
  isPinned: boolean;
  isSearchHit: boolean;
  isExpanded: boolean;
  onToggleExpand: (msgId: string) => void;
  onTogglePin: (msgId: string) => void;
  onWithdraw: (msgId: string, text: string) => void;
  /** 仅错误级（复制失败）；成功静默 */
  onShowToast?: (message: string) => void;
  messageIndex: number;
  virtualScrollManager: VirtualScrollManager | null;
};

function userRowPropsEqual(prev: ChatUserMessageRowProps, next: ChatUserMessageRowProps): boolean {
  return (
    prev.msg.id === next.msg.id &&
    prev.msg.status === next.msg.status &&
    prev.msg.text === next.msg.text &&
    prev.msg.timestamp === next.msg.timestamp &&
    prev.isPinned === next.isPinned &&
    prev.isSearchHit === next.isSearchHit &&
    prev.isExpanded === next.isExpanded &&
    prev.onToggleExpand === next.onToggleExpand &&
    prev.onTogglePin === next.onTogglePin &&
    prev.onWithdraw === next.onWithdraw &&
    prev.onShowToast === next.onShowToast
  );
}

const ChatUserMessageRowInner: React.FC<ChatUserMessageRowProps> = ({
  msg,
  isPinned,
  isSearchHit,
  isExpanded,
  onToggleExpand,
  onTogglePin,
  onWithdraw: _onWithdraw,
  onShowToast,
  messageIndex,
  virtualScrollManager,
}) => {
  void _onWithdraw;
  const isLong = isUserBubbleLong(msg.text);
  const displayText = userBubbleDisplayText(msg.text, isExpanded);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const userRowRef = useRef<HTMLDivElement>(null);
  const userBubbleFont = useMemo(() => buildPretextFontForUiSize('medium', 'sans', 'normal'), []);
  const userBubbleWidth = useBubbleShrinkWidth(displayText, userBubbleFont, userRowRef, 32);
  const pinLabels = pinToggleLabels(isPinned);
  const rowAria = messageRowAriaLabel({
    role: 'user',
    isPinned,
    status: msg.status,
  });

  useEffect(
    () => () => {
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  useEffect(() => {
    virtualScrollManager?.invalidateActual(messageIndex);
  }, [msg.text, messageIndex, virtualScrollManager]);

  const handleCopy = useCallback(() => {
    const text = msg.text || '';
    if (!text) return;
    void copyTextBestEffort(text).then((ok) => {
      if (!ok) {
        onShowToast?.('复制失败');
        return;
      }
      setCopied(true);
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
    });
  }, [msg.text, onShowToast]);

  const toggleExpand = useCallback(() => {
    if (isLong) {
      const sel = window.getSelection()?.toString();
      if (sel) return;
      onToggleExpand(msg.id);
    }
  }, [isLong, msg.id, onToggleExpand]);

  const onBubbleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isLong) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onToggleExpand(msg.id);
      }
    },
    [isLong, msg.id, onToggleExpand],
  );

  return (
    <div
      className={`${styles.row} ${styles.rowUser} msg-row msg-row-user${isSearchHit ? ` ${styles.searchHit} msg-search-hit` : ''}${isPinned ? ` ${styles.isPinned}` : ''}`}
      ref={userRowRef}
      data-msg-id={msg.id}
      data-role="user"
      data-pinned={isPinned ? 'true' : undefined}
      role="article"
      aria-label={rowAria}
    >
      <div className={styles.userStack}>
        {isPinned ? (
          <Tooltip content="已固定">
            <span className={styles.pinBadge} aria-hidden="true">
              <Lucide.Pin size={11} strokeWidth={2.25} />
              已固定
            </span>
          </Tooltip>
        ) : null}
        <div
          className={`${styles.userBubble} ${isExpanded ? 'expanded' : ''}`}
          onClick={toggleExpand}
          onKeyDown={onBubbleKeyDown}
          style={{
            cursor: isLong ? 'pointer' : 'default',
            maxWidth: userBubbleWidth ?? undefined,
          }}
          role={isLong ? 'button' : undefined}
          tabIndex={isLong ? 0 : undefined}
          aria-expanded={isLong ? isExpanded : undefined}
          aria-label={isLong ? userBubbleExpandAria(isExpanded) : undefined}
        >
          <span className={styles.userText}>{displayText}</span>
          {msg.status === 'queued' && (
            <span className={styles.queued}>排队中</span>
          )}
        </div>
        <div className={styles.userMeta}>
          <span className={styles.time}>{formatTime(msg.timestamp)}</span>
          {/* 默认只留复制；已固定时显示取消固定。钉/撤回走右键或悬停 secondary */}
          <Tooltip content={copied ? '已复制' : '复制消息'}>
            <button
              type="button"
              className={`${styles.iconBtn}${copied ? ` ${styles.isCopied}` : ''}`}
              aria-label={copied ? '已复制' : '复制消息'}
              onClick={handleCopy}
            >
              {copied ? <Lucide.Check size={14} /> : <Lucide.Copy size={14} />}
            </button>
          </Tooltip>
          {isPinned ? (
            <Tooltip content={pinLabels.title}>
              <button
                type="button"
                className={`${styles.iconBtn} ${styles.isPinnedActive}`}
                aria-label={pinLabels.ariaLabel}
                aria-pressed
                onClick={() => onTogglePin(msg.id)}
              >
                <Lucide.PinOff size={14} />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export const ChatUserMessageRow = React.memo(ChatUserMessageRowInner, userRowPropsEqual);

// ─── Assistant row ──────────────────────────────────────────────────────────

export type ChatAssistantMessageRowProps = {
  msg: SessionMessage;
  isFollowUp: boolean;
  isPinned: boolean;
  isSearchHit: boolean;
  isThinkingMsg: boolean;
  thinkingSeconds: number;
  hideThinkingBlock: boolean;
  inPlanMode: boolean;
  planApproved: boolean;
  isLastAssistant: boolean;
  /** 工具栈共享 props：List 组装一次，行内仅 handoff 进 ChatToolStack */
  toolStackProps: ChatToolStackSharedProps;
  onTogglePin: (msgId: string) => void;
  onShowToast: (message: string) => void;
  onRegenerate: (assistantMsgId: string) => void;
  onBranch: () => void;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenDiffPanel?: () => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setPlanApproved: (v: boolean) => void;
  /**
   * 后续引导：填入 composer（不发送）。
   * 缺省则不挂芯片，避免无发送能力的宿主（如只读预览）误展示。
   */
  onFillFollowUp?: (prompt: string) => void;
  /** 后续引导：直接发送 prompt（不经 composer 异步 state） */
  onSendFollowUp?: (prompt: string) => void;
  /** 本消息引导被用户关闭后 true */
  followUpDismissed?: boolean;
  onDismissFollowUp?: (msgId: string) => void;
  messageIndex: number;
  virtualScrollManager: VirtualScrollManager | null;
};

function assistantRowPropsEqual(
  prev: ChatAssistantMessageRowProps,
  next: ChatAssistantMessageRowProps,
): boolean {
  if (prev.isThinkingMsg || next.isThinkingMsg) {
    if (prev.thinkingSeconds !== next.thinkingSeconds) return false;
  }
  return (
    prev.msg.id === next.msg.id &&
    prev.msg.status === next.msg.status &&
    prev.msg.text === next.msg.text &&
    prev.msg.thinking === next.msg.thinking &&
    prev.msg.toolCalls === next.msg.toolCalls &&
    prev.msg.blocks === next.msg.blocks &&
    prev.msg.thinkingTime === next.msg.thinkingTime &&
    prev.msg.timestamp === next.msg.timestamp &&
    prev.isPinned === next.isPinned &&
    prev.isSearchHit === next.isSearchHit &&
    prev.isFollowUp === next.isFollowUp &&
    prev.isThinkingMsg === next.isThinkingMsg &&
    prev.hideThinkingBlock === next.hideThinkingBlock &&
    prev.inPlanMode === next.inPlanMode &&
    prev.planApproved === next.planApproved &&
    prev.isLastAssistant === next.isLastAssistant &&
    prev.followUpDismissed === next.followUpDismissed &&
    toolStackSharedPropsEqual(prev.toolStackProps, next.toolStackProps) &&
    prev.onTogglePin === next.onTogglePin &&
    prev.onShowToast === next.onShowToast &&
    prev.onRegenerate === next.onRegenerate &&
    prev.onBranch === next.onBranch &&
    prev.onOpenDiff === next.onOpenDiff &&
    prev.onOpenDiffPanel === next.onOpenDiffPanel &&
    prev.setPermissionMode === next.setPermissionMode &&
    prev.setPlanApproved === next.setPlanApproved &&
    prev.onFillFollowUp === next.onFillFollowUp &&
    prev.onSendFollowUp === next.onSendFollowUp &&
    prev.onDismissFollowUp === next.onDismissFollowUp
  );
}

/** 聚焦主列 composer（与空态快捷 prompt 同源口径） */
function focusChatComposer(): void {
  const scope =
    document.querySelector<HTMLElement>('.chat-body') ??
    document.querySelector<HTMLElement>('.chat-doc-flow') ??
    document.body;
  const ta =
    scope.querySelector<HTMLTextAreaElement>(
      '.input-container textarea:not([disabled])',
    ) ??
    scope.querySelector<HTMLTextAreaElement>('textarea:not([disabled])');
  ta?.focus();
}

const ChatAssistantMessageRowInner: React.FC<ChatAssistantMessageRowProps> = ({
  msg,
  isFollowUp,
  isPinned,
  isSearchHit,
  isThinkingMsg,
  thinkingSeconds,
  hideThinkingBlock,
  inPlanMode,
  planApproved,
  isLastAssistant,
  toolStackProps,
  onTogglePin,
  onShowToast,
  onRegenerate,
  onBranch: _onBranch,
  onOpenDiff,
  onOpenDiffPanel,
  setPermissionMode,
  setPlanApproved,
  onFillFollowUp,
  onSendFollowUp,
  followUpDismissed = false,
  onDismissFollowUp,
  messageIndex,
  virtualScrollManager,
}) => {
  void _onBranch;
  const assistantRowRef = useRef<HTMLDivElement>(null);
  const assistantBubbleFont = useMemo(() => buildPretextFontForUiSize('medium', 'sans', 'normal'), []);
  const assistantPlainText = msg.text || '';
  const assistantBubbleWidth = useBubbleShrinkWidth(assistantPlainText, assistantBubbleFont, assistantRowRef, 0);

  const thinkingRaw =
    msg.thinking &&
    msg.thinking.trim() &&
    msg.thinking !== '正在处理…' &&
    msg.thinking !== '正在思考中...'
      ? msg.thinking.trim()
      : '';
  const thinkingText = thinkingRaw || (isThinkingMsg ? '…' : '');
  const thinkingLineCount = thinkingText ? thinkingText.split(/\r?\n/).length : 0;
  /** 设置「隐藏思考过程」时整段不展示（含进行中） */
  const showThinking = !hideThinkingBlock && (isThinkingMsg || thinkingLineCount > 0);
  /**
   * 完成态默认折叠且不挂载 body，避免长思考撑爆 DOM；
   * 进行中自动打开（仍受字符预算约束）。
   */
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const pinLabels = pinToggleLabels(isPinned);
  const rowAria = messageRowAriaLabel({
    role: 'assistant',
    isPinned,
    isThinking: isThinkingMsg,
    status: msg.status,
  });
  const thinkingBodyId = `msg-thinking-${msg.id}`;

  useEffect(() => {
    if (isThinkingMsg) setThinkingOpen(true);
    else setThinkingOpen(false);
  }, [isThinkingMsg, msg.id]);

  useEffect(
    () => () => {
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  useEffect(() => {
    virtualScrollManager?.invalidateActual(messageIndex);
  }, [msg.text, messageIndex, virtualScrollManager]);

  const thinkingBodyOpen = isThinkingMsg || thinkingOpen;
  const thinkingBudget = budgetDomText(thinkingText, THINKING_DOM_CHAR_CAP);

  const handleCopy = useCallback(() => {
    const text = assistantCopyText(msg);
    if (!text.trim()) {
      onShowToast('没有可复制的正文');
      return;
    }
    void copyTextBestEffort(text).then((ok) => {
      if (!ok) {
        onShowToast('复制失败');
        return;
      }
      setCopied(true);
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
    });
  }, [msg, onShowToast]);

  return (
    <div
      className={`${styles.row} ${styles.rowAssistant} msg-row msg-row-assistant ${isFollowUp ? styles.isFollowup : ''}${isSearchHit ? ` ${styles.searchHit} msg-search-hit` : ''}${isPinned ? ` ${styles.isPinned}` : ''}`}
      ref={assistantRowRef}
      data-msg-id={msg.id}
      data-role="assistant"
      data-pinned={isPinned ? 'true' : undefined}
      data-followup={isFollowUp ? 'true' : undefined}
      role="article"
      aria-label={rowAria}
    >
      {isPinned ? (
        <Tooltip content="已固定">
          <span className={styles.pinBadge} aria-hidden="true">
            <Lucide.Pin size={11} strokeWidth={2.25} />
            已固定
          </span>
        </Tooltip>
      ) : null}
      {/* 角色徽标已去掉（助手/你 不展示，靠气泡与排版区分） */}
      {/* 思考：默认折叠；折叠时不挂 body，展开后仍受 DOM 字符预算 */}
      {showThinking ? (
        <div
          className={`${styles.thinkingFold} ${isThinkingMsg ? styles.isLive : ''}${thinkingBodyOpen ? ` ${styles.isOpen}` : ''}`}
        >
          <button
            type="button"
            className={styles.thinkingFoldSum}
            aria-expanded={thinkingBodyOpen}
            aria-controls={thinkingBodyOpen ? thinkingBodyId : undefined}
            aria-label={thinkingFoldAria({
              isLive: isThinkingMsg,
              isOpen: thinkingBodyOpen,
            })}
            aria-disabled={isThinkingMsg || undefined}
            onClick={() => {
              if (isThinkingMsg) return;
              setThinkingOpen((v) => !v);
            }}
          >
            {isThinkingMsg ? (
              <span
                className="loading-spinner"
                style={{ width: 8, height: 8, borderWidth: 1.5 }}
                aria-hidden
              />
            ) : (
              <Lucide.ChevronRight
                size={14}
                className={`${styles.thinkingChevron}${thinkingBodyOpen ? ` ${styles.isOpen}` : ''}`}
                aria-hidden
              />
            )}
            <span className={styles.thinkingFoldLabel}>
              {isThinkingMsg ? '思考中' : '思考'}
              {isThinkingMsg ? (
                <span className={styles.thinkingSec}> · {thinkingSeconds}s</span>
              ) : thinkingBudget.truncated && thinkingBodyOpen ? (
                <span className={styles.thinkingSec}> · 已截断</span>
              ) : null}
            </span>
          </button>
          <div className={styles.accordionWrapper} data-expanded={thinkingBodyOpen ? 'true' : 'false'}>
            <div className={styles.accordionInner}>
              <div className={styles.thinkingFoldBody} id={thinkingBodyId}>
                {thinkingBudget.text}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className={styles.assistantBody} style={{ maxWidth: assistantBubbleWidth ?? undefined }}>
        {(() => {
          try {
            const timeline = buildAssistantTimeline(msg);
            if (!timeline.length) {
               const fallback = stripThoughtPlaceholders(msg.text || '');
               if (!fallback.trim()) {
                 if (msg.status === 'error') {
                   return (
                     <div className={styles.timelineText}>
                       <div style={{ padding: '8px 12px', background: 'var(--bg-error-subtle, rgba(239, 68, 68, 0.08))', borderRadius: 8, color: 'var(--text-error, #ef4444)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                         <Lucide.AlertCircle size={14} />
                         <span>服务暂时不可用，请检查网络或后端配置</span>
                       </div>
                     </div>
                   );
                 }
                 return null;
               }
               if (isThinkingMsg) {
                 return (
                   <div className={styles.timelineText}>
                     <div
                       className={`${styles.assistantText} ${styles.isStreaming}`}
                       style={{ whiteSpace: 'pre-wrap' }}
                     >
                       {fallback}
                     </div>
                   </div>
                 );
               }
               return (
                  <div className={styles.timelineText}>
                    <AsyncMarkdownBlock
                      text={fallback}
                      priority={msg.status === 'processing' ? Priority.Normal : Priority.High}
                    />
                  </div>
                );
            }
            const textItems = timeline.filter((i) => i.kind === 'text');
            const lastTextKey = textItems.length
              ? textItems[textItems.length - 1]!.key
              : null;
            return timeline.map((item) => {
              if (item.kind === 'text') {
                // stripThoughtPlaceholders 同时去掉「本轮总结」类噪音标题
                const bodyText = stripThoughtPlaceholders(item.content || '');
                if (!bodyText.trim()) return null;
                const imgs = extractImageRefs(bodyText);
                const streaming = isThinkingMsg && item.key === lastTextKey;
                if (streaming) {
                  return (
                    <div key={item.key} className={styles.timelineText}>
                      <div
                        className={`${styles.assistantText} ${styles.isStreaming}`}
                        style={{ whiteSpace: 'pre-wrap' }}
                      >
                        {bodyText}
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={item.key} className={styles.timelineText}>
                    <AsyncMarkdownBlock
                      text={bodyText}
                      priority={msg.status === 'processing' ? Priority.Normal : Priority.High}
                    />
                    {imgs.length > 0 && (
                      <div className={styles.inlineImages}>
                        {imgs.map((src) => (
                          <img
                            key={src}
                            src={src}
                            alt=""
                            className={styles.mdImg}
                            loading="lazy"
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              }
              // handoff only：空 items 不挂载；工具 UI 全权 ChatToolStack
              if (!shouldHostToolStack(item.items)) return null;
              const host = buildToolStackHostProps(
                item.items!,
                msg.id,
                toolStackProps,
              );
              return (
                <div key={item.key} className={styles.timelineTools}>
                  <ChatToolStack {...host} />
                </div>
              );
            });
          } catch (err) {
            console.error('[ChatMessageRow] timeline render', err);
            const fallback = stripThoughtPlaceholders(msg.text || '');
            return fallback ? (
              <div className={`${styles.assistantText} md-rendered`}>{fallback}</div>
            ) : null;
          }
        })()}
      </div>

      {/* 完成态：计划批准 → 操作栏 → 后续引导 → 改动总览（均在时间线外，不进 blocks） */}
      {!isThinkingMsg && msg.status !== 'processing' && (
        <>
          {inPlanMode &&
          !planApproved &&
          isLastAssistant &&
          looksLikePlan(assistantCopyText(msg) || msg.text || '') ? (
            <div className={styles.planApproveRow}>
              <button
                type="button"
                className={styles.planApproveChip}
                onClick={() => {
                  setPermissionMode('ask');
                  setPlanApproved(true);
                }}
              >
                批准此计划
              </button>
            </div>
          ) : null}
          <div className={styles.assistantMeta}>
            <span className={styles.time}>{formatTime(msg.timestamp)}</span>
            {/* 精简：复制 + 最后一条可重试；钉/分支不再常驻刷屏 */}
            <Tooltip content={copied ? '已复制' : '复制正文'}>
              <button
                type="button"
                className={`${styles.iconBtn}${copied ? ` ${styles.isCopied}` : ''}`}
                aria-label={copied ? '已复制' : '复制正文'}
                onClick={handleCopy}
              >
                {copied ? <Lucide.Check size={14} /> : <Lucide.Copy size={14} />}
              </button>
            </Tooltip>
            {isLastAssistant ? (
              <Tooltip content="重新生成">
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label="重新生成"
                  onClick={() => onRegenerate(msg.id)}
                >
                  <Lucide.RefreshCw size={14} />
                </button>
              </Tooltip>
            ) : null}
            {isPinned ? (
              <Tooltip content={pinLabels.title}>
                <button
                  type="button"
                  className={`${styles.iconBtn} ${styles.isPinnedActive}`}
                  aria-label={pinLabels.ariaLabel}
                  aria-pressed
                  onClick={() => onTogglePin(msg.id)}
                >
                  <Lucide.PinOff size={14} />
                </button>
              </Tooltip>
            ) : null}
          </div>
          {(() => {
            // 引导芯片：仅 UI 派生，禁止写入 msg.blocks / text / streamTextOffset
            if (!onFillFollowUp && !onSendFollowUp) return null;
            if (
              !shouldShowFollowUpSuggestions({
                isLastAssistant,
                isThinkingMsg,
                status: msg.status,
                toolCalls: msg.toolCalls,
                dismissed: followUpDismissed,
              })
            ) {
              return null;
            }
            const suggestions: FollowUpSuggestion[] = buildFollowUpSuggestions(msg);
            if (!suggestions.length) return null;
            return (
              <div
                className={styles.followupRow}
                role="group"
                aria-label="后续建议"
                data-followup-for={msg.id}
              >
                <div className={styles.followupChips} role="list">
                  {suggestions.map((s) => (
                    <div
                      key={s.id}
                      className={styles.followupChip}
                      role="listitem"
                      data-followup-id={s.id}
                    >
                      <Tooltip content={s.prompt}>
                        <button
                          type="button"
                          className={styles.followupChipMain}
                          aria-label={`填入：${s.label}`}
                          onClick={() => {
                            onFillFollowUp?.(s.prompt);
                            focusChatComposer();
                          }}
                        >
                          <span className={styles.followupChipLabel}>{s.label}</span>
                        </button>
                      </Tooltip>
                      {onSendFollowUp ? (
                        <Tooltip content="直接发送">
                          <button
                            type="button"
                            className={styles.followupChipSend}
                            aria-label={`直接发送：${s.label}`}
                            onClick={() => onSendFollowUp(s.prompt)}
                          >
                            <Lucide.Send size={12} strokeWidth={2} aria-hidden />
                          </button>
                        </Tooltip>
                      ) : null}
                    </div>
                  ))}
                </div>
                {onDismissFollowUp ? (
                  <Tooltip content="关闭建议">
                    <button
                      type="button"
                      className={`${styles.followupDismiss} ${styles.iconBtn}`}
                      aria-label="关闭后续建议"
                      onClick={() => onDismissFollowUp(msg.id)}
                    >
                      <Lucide.X size={14} aria-hidden />
                    </button>
                  </Tooltip>
                ) : null}
              </div>
            );
          })()}
          <ChangeOverviewCard
            message={msg}
            onOpenDiff={onOpenDiff}
            onOpenDiffPanel={onOpenDiffPanel}
            onShowToast={onShowToast}
          />
        </>
      )}
    </div>
  );
};

export const ChatAssistantMessageRow = React.memo(
  ChatAssistantMessageRowInner,
  assistantRowPropsEqual,
);

// ─── Async Markdown ──────────────────────────────────────────────────────────

function useAsyncMarkdownHtml(markdown: string, priority: Priority): { html: string; loading: boolean } {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!markdown) { setHtml(''); setLoading(false); return; }

    const cached = getMarkdownHtmlCache(markdown);
    if (cached !== undefined) {
      setHtml(cached);
      setLoading(false);
      return;
    }

    setLoading(true);
    cancelledRef.current = false;

    parseMarkdownToHtmlAsync(markdown, priority).then((result) => {
      if (!cancelledRef.current) {
        setHtml(result);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelledRef.current) setLoading(false);
    });

    return () => { cancelledRef.current = true; };
  }, [markdown, priority]);

  return { html, loading };
}

function AsyncMarkdownBlock({ text, priority }: { text: string; priority: Priority }) {
  const { html, loading } = useAsyncMarkdownHtml(text, priority);
  const skeletonRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<IncrementalMarkdownBridge | null>(null);
  const initializedRef = useRef(false);
  const font = useMemo(() => buildPretextFontForUiSize('medium', 'sans', 'normal'), []);
  const { measureHeight } = usePreparedText({ text, font });
  const [skeletonMinH, setSkeletonMinH] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (!loading || !skeletonRef.current || !text) {
      setSkeletonMinH(undefined);
      return;
    }
    const parentW = skeletonRef.current.parentElement?.clientWidth ?? 0;
    const fontSize = parseFloat(font.match(/([\d.]+)px/)?.[0] ?? '14');
    const lineHeightPx = fontSize * 1.65;
    const h = measureHeight(Math.max(1, parentW), lineHeightPx);
    setSkeletonMinH(h > 0 ? Math.ceil(h * 1.15) : undefined);
  }, [loading, measureHeight, font, text]);

  useLayoutEffect(() => {
    if (!containerRef.current || loading || !html) return;

    const bridge = bridgeRef.current ?? (bridgeRef.current = new IncrementalMarkdownBridge());
    const result = bridge.push(text);

    if (!initializedRef.current) {
      initializedRef.current = true;
      const wrappedHtml = result.updates.map(u =>
        `<span data-chunk-id="${u.id}">${u.html}</span>`
      ).join('');
      containerRef.current.innerHTML = wrappedHtml;
    } else if (result.updates.length > 0) {
      const patches = chunkUpdatesToDomPatches(containerRef.current, result.updates, false);
      applyDomPatches(containerRef.current, patches);
    }
  }, [html, loading, text]);

  if (!text) return null;
  if (loading) {
    return (
      <div
        ref={skeletonRef}
        className={styles.assistantText}
        style={{ whiteSpace: 'pre-wrap', minHeight: skeletonMinH }}
      >
        {escapeHtml(text)}
      </div>
    );
  }
  return (
    <div
      ref={containerRef}
      className={`${styles.assistantText} md-rendered`}
    />
  );
}
