import { useToast } from '../../services/toast/ToastContext';
/**
 * ChatAssistantMessageRow.tsx
 * 纯净助手消息行容器（DIM-02 / FIN-02 权威重构版）
 *
 * 架构裁决：
 * - 彻底拔除置顶独立的 MessageThinkingBlock 单体思维链；
 * - 思维链完全下放至 MessageContent 交错时间线管道中渲染（24px 极简思考行）；
 * - 工具行采用 24px 单行流式紧凑排布；
 * - 展开或收拢思考/工具时，联动 ResizeObserver 触发 VSM 树状数组动态测高自愈，零重排撕裂；
 * - 保持 assistantRowPropsEqual 比较契约与 memo 完整性。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './ChatMessageRow.module.css';
import { assistantCopyText } from '../../api/toolPresentation';

import { copyTextBestEffort, messageRowAriaLabel } from './chatMessageRowUtils';

import {
  assistantRowPropsEqual,
  type ChatAssistantMessageRowProps,
} from './chatMessageRowUtils';

import { MessageContent } from '../chat-message/MessageContent';
import { MessageActions } from '../chat-message/MessageActions';
import { isContextStateCarrierMessage } from '../../store/sessionInjectionMount';

export type { ChatAssistantMessageRowProps } from './chatMessageRowUtils';

const ChatAssistantMessageRowInner: React.FC<
  ChatAssistantMessageRowProps
> = ({
  msg,
  streamText,
  isFollowUp,
  isPinned,
  pinnedColor,
  isSearchHit,
  isThinkingMsg,
  hideThinkingBlock,
  inPlanMode,
  planApproved,
  isLastAssistant,
  toolStackProps,
  onTogglePin,
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
  onRetract,
  messageIndex: _messageIndex,
  virtualScrollManager,
}) => {
  void _onBranch;
  void _messageIndex;

  const rowRef = useRef<HTMLDivElement>(null);
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const rowAria = messageRowAriaLabel({
    role: 'assistant',
    isPinned,
    isThinking: isThinkingMsg,
    status: msg.status,
  });

  useEffect(
    () => () => {
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    },
    []
  );

  // 测高单轨：禁止行级私有 RO 直写 manager.setActual（会绕过 actualTick → 总高/滚动条不更新）。
  // 尺寸变化由 MessageVirtualizer 宿主 ResizeObserver → useVirtualScroll.setActual 统一回写。

  // 内容/折叠态变化 → 作废旧实测；宿主 RO 在尺寸变化时重测并触发 tick
  useEffect(() => {
    if (isThinkingMsg || msg.status === 'processing') return;
    virtualScrollManager?.invalidateActual(msg.id);
  }, [
    msg.text,
    msg.id,
    msg.status,
    msg.thinking,
    msg.toolCalls,
    msg.blocks,
    isThinkingMsg,
    hideThinkingBlock,
    toolStackProps?.expandedToolsByMessage?.[msg.id] ??
      toolStackProps?.expandedTools,
    virtualScrollManager,
  ]);

  // 增强 toolStackProps：
  // D7.3（FE-INV-5）：expandedTools 按 msgId 从 expandedToolsByMessage 切片注入，
  // 其它消息 toggle 时本行 expandedTools 引用稳定；onToggleTool 绑定 msg.id。
  // D7.4：对象引用稳定（useMemo），供下游 ProcessItemRenderer / 工具链 memo 短路。
  const augmentedToolStackProps = useMemo(() => {
    if (!toolStackProps) return toolStackProps;
    const perMessage =
      toolStackProps.expandedToolsByMessage?.[msg.id] ??
      toolStackProps.expandedTools;
    return {
      ...toolStackProps,
      expandedTools: perMessage,
      // 切片后的嵌套 map 不再下传（避免下游误读全会话 map）
      expandedToolsByMessage: undefined,
      onToggleTool: (toolId: string, currentlyOpen: boolean) => {
        toolStackProps.onToggleTool?.(toolId, currentlyOpen, msg.id);
        virtualScrollManager?.invalidateActual(msg.id);
      },
      onToggleInjection: (injectionId: string, currentlyOpen: boolean) => {
        toolStackProps.onToggleInjection?.(injectionId, currentlyOpen);
        virtualScrollManager?.invalidateActual(msg.id);
      },
    };
  }, [toolStackProps, virtualScrollManager, msg.id]);

  // 过程段展开/收起（含铁律四强制展开段、检索命中唤醒）→ 走同一单轨测高作废通道。
  // 禁止行级私有 RO 直写 setActual：尺寸变化统一由宿主 ResizeObserver 回写。
  const handleInvalidateActual = useCallback(
    (_msgId: string) => {
      virtualScrollManager?.invalidateActual(msg.id);
    },
    [virtualScrollManager, msg.id]
  );

  const isLive = isThinkingMsg || msg.status === 'processing';
  const isPureCarrier = useMemo(() => {
    // 完善 isPureCarrier 判定：处于深度思考、流式输出、或消息本身包含实质数据时不为纯载体
    if (isThinkingMsg || (streamText || '').trim().length > 0) return false;
    return isContextStateCarrierMessage(msg);
  }, [msg, isThinkingMsg, streamText]);

  const handleCopy = useCallback(() => {
    // T4 A1：壳层已装配合并 view model——流式期间 msg.text 即热缓冲累积正文，
    // 无需再命令式读 streamingStore（S4.4 无订阅语义保持：本行零 store 访问）。
    const text = assistantCopyText(msg);
    if (!text.trim()) {
      showToast('没有可复制的正文');
      return;
    }
    void copyTextBestEffort(text).then((ok) => {
      if (!ok) {
        showToast('复制失败');
        return;
      }
      setCopied(true);
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
    });
  }, [msg, showToast]);

  return (
    <div
      ref={rowRef}
      className={`${styles.row} ${isPureCarrier ? styles.rowCarrier : styles.rowAssistant} msg-row ${isPureCarrier ? 'msg-row-carrier' : 'msg-row-assistant'} ${!isPureCarrier && isFollowUp ? styles.isFollowup : ''}${!isPureCarrier && isSearchHit ? ` ${styles.searchHit} msg-search-hit` : ''}${!isPureCarrier && isPinned ? ` ${styles.isPinned}` : ''}`}
      data-msg-id={msg.id}
      data-role={isPureCarrier ? 'system' : 'assistant'}
      data-pinned={!isPureCarrier && isPinned ? 'true' : undefined}
      data-followup={!isPureCarrier && isFollowUp ? 'true' : undefined}
      role={isPureCarrier ? 'region' : 'article'}
      aria-label={isPureCarrier ? '系统状态提示行' : rowAria}
    >
      {/* 拔除置顶独立的 MessageThinkingBlock，所有思维链下放至 MessageContent 自然交错渲染 */}
      <div className={isPureCarrier ? styles.carrierBody : styles.assistantBody} data-message-body={isPureCarrier ? 'carrier' : 'assistant'}>
        <MessageContent
          msg={msg}
          streamText={streamText}
          isThinkingMsg={isThinkingMsg}
          hideThinkingBlock={hideThinkingBlock}
          toolStackProps={augmentedToolStackProps}
          onInvalidateActual={handleInvalidateActual}
        />
      </div>

      {!isLive && !isPureCarrier && (
        <MessageActions
          msg={msg}
          state={{
            copied,
            isLastAssistant,
            isPinned,
            pinnedColor,
            isThinkingMsg,
            inPlanMode,
            planApproved,
            followUpDismissed,
          }}
          actions={{
            onCopy: handleCopy,
            ...(onRegenerate !== undefined && { onRegenerate }),
            onTogglePin,
            setPermissionMode,
            setPlanApproved,
            ...(onFillFollowUp !== undefined && { onFillFollowUp }),
            ...(onSendFollowUp !== undefined && { onSendFollowUp }),
            ...(onDismissFollowUp !== undefined && { onDismissFollowUp }),
            onOpenDiff,
            ...(onOpenDiffPanel !== undefined && { onOpenDiffPanel }),
            ...(isLastAssistant && onRetract !== undefined && { onRetract }),
          }}
          cacheMetricsNode={null}
        />
      )}
    </div>
  );
};

export const ChatAssistantMessageRow = React.memo(
  ChatAssistantMessageRowInner,
  assistantRowPropsEqual
);
