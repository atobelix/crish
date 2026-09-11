import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useNarrativeRenderSlots } from './narrativeRenderSlots';
import styles from './MessageContent.module.css';
import type { SessionMessage } from '../../store/types';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import {
  buildAssistantTimelineCached,
  partitionTimelineSegments,
  buildSlotId,
  type AssistantTimelineItem,
  type TimelineSegment,
} from '../../api/toolPresentation';
import { stripThoughtPlaceholders } from '../../api/markdownRenderLite';
import { Priority } from '../../workers';
import { StreamingMarkdownView } from '../chat-message-row/StreamingMarkdownView';
import {
  isContextStateInjection,
  formatContextStateDisplayText,
} from './contextStateUtils';
import { WorkingStatusIndicator } from '../chat-message-row/WorkingStatusIndicator';
import { ModelRetryNode } from '../chat-message-row/ModelRetryNode';
import { TurnErrorNode } from '../chat-message-row/TurnErrorNode';
import { FoldableProcessSection } from './FoldableProcessSection';
import {
  subscribeMessageProcessExpansion,
  isMessageProcessExpanded,
  setMessageProcessExpanded,
} from './searchExpandBridge';
import { useEphemeralChatStore } from '../../store/ephemeralChatStore';
import { useSessionStore } from '../../store/sessionStore';

import { ProcessItemRenderer } from './ProcessItemRenderer';

export interface MessageContentProps {
  /**
   * 已合并的流式渲染 view model（T4 A1：由页面壳层 useStreamMessageViewModel
   * 装配后传入；本组件不再直读 streamingStore）。
   */
  msg: SessionMessage;
  /**
   * 流式累积正文（undefined = 热缓冲无条目）。驱动流式增量区 / 图片扫描 /
   * streaming 判定；正文合并已由壳层完成（msg.text 即当前有效正文）。
   */
  streamText?: string;
  isThinkingMsg?: boolean;
  /** true = 新渲染的思考段默认折叠；false = 默认展开 */
  hideThinkingBlock?: boolean;
  toolStackProps?: ChatToolStackSharedProps;
  className?: string;
  /**
   * 测高作废回调（由虚拟滚动宿主注入）。
   * 折叠段展开/收起的物理高度变更必须经此单轨通知宿主动态测高。
   */
  onInvalidateActual?: (msgId: string) => void;
}

/**
 * 单段折叠展开态字典：`sectionId → boolean`。
 *
 * 收敛说明：历史实现使用「整条消息一个布尔」的 `searchExpandBridge`，
 * 无法表达「同一消息内多过程段各自独立展开」。此处以 section 粒度收敛，
 * 并保留 bridge 作为外部（检索命中）命令入口。
 */
type SectionExpandedMap = Record<string, boolean>;

export const MessageContent: React.FC<MessageContentProps> = React.memo(
  ({
    msg,
    streamText,
    isThinkingMsg = false,
    hideThinkingBlock = false,
    toolStackProps,
    className,
    onInvalidateActual,
  }) => {
    /* ═══════════════════════════════════════════════════════════════════════
     * Hooks 无条件区（Hooks 顺序铁律）
     *
     * 历史缺陷（P0-1）：原实现在 `linearItems.length === 0` 分支提前 `return`，
     * 导致其后的 `useState` 在「时间线非空」与「时间线为空」两种渲染间
     * 产生 Hooks 数量差异，违反 React Hooks 规则。
     * 现统一：所有 Hooks 在组件顶部无条件执行，分支仅决定「渲染什么」，
     * 绝不影响「Hook 调用序列」。
     * ═══════════════════════════════════════════════════════════════════════ */

    const displayMsg = msg;
    const { renderTools, renderThought } = useNarrativeRenderSlots();
    // 纸墨极简流：思考段折叠受 hideThinkingBlock 契约管控（默认受控收起/展开）
    const thoughtDefaultOpen = !hideThinkingBlock;

    const sessionId = useSessionStore((s) => s.activeSessionId) || '';
    const ephemeralStatus = useEphemeralChatStore(
      useCallback((s) => s.statusBySession[sessionId], [sessionId])
    );

    const isLiveTurn = Boolean(msg.status === 'processing' || isThinkingMsg);

    const hasThoughtContent = Boolean(
      (displayMsg.thinking && displayMsg.thinking.trim()) ||
      (displayMsg.thinkingTurns && displayMsg.thinkingTurns.some((tt) => tt.content?.trim() || tt.isStreaming))
    );

    const hasTextContent = Boolean(
      displayMsg.text?.trim() ||
      streamText?.trim()
    );

    const hasToolContent = Boolean(
      displayMsg.toolCalls && displayMsg.toolCalls.length > 0
    );

    const isInitialWaiting = Boolean(
      isLiveTurn &&
      !hasThoughtContent &&
      !hasTextContent &&
      !hasToolContent
    );

    const isThinkingLive = Boolean(
      isThinkingMsg &&
      !hasTextContent &&
      hasThoughtContent
    );

    const isWorkingAfterThought = Boolean(
      isLiveTurn &&
      !isInitialWaiting &&
      !isThinkingLive
    );

    const inFlowRetry =
      (isThinkingMsg || msg.status === 'processing')
        ? ephemeralStatus?.retryState
        : undefined;
    const isErrorMsg = msg.status === 'error';
    const errorDetail = msg.errorDetail;

    const handleRetryNow = useCallback(() => {
      if (sessionId) {
        useEphemeralChatStore.getState().clearEphemeralStatus(sessionId);
      }
    }, [sessionId]);

    const handleCancelRetry = useCallback(() => {
      if (sessionId) {
        useEphemeralChatStore.getState().clearEphemeralStatus(sessionId);
      }
    }, [sessionId]);

    const handleRetryTurn = useCallback(() => {
      if (!sessionId) return;
      useEphemeralChatStore.getState().clearEphemeralStatus(sessionId);
      const currentSession = useSessionStore.getState().sessionsById[sessionId];
      const msgs = currentSession?.messages || [];
      const thisIdx = msgs.findIndex((m) => m.id === msg.id);
      let promptText = '';
      if (thisIdx > 0) {
        for (let i = thisIdx - 1; i >= 0; i--) {
          if (msgs[i]?.sender === 'user') {
            promptText = msgs[i]?.text || '';
            break;
          }
        }
      }
      if (!promptText && ephemeralStatus?.retryContext?.promptText) {
        promptText = ephemeralStatus.retryContext.promptText;
      }
      if (promptText) {
        void import('../../app/compositionRoot').then(({ getCompositionRoot }) => {
          void getCompositionRoot().session.getState().setComposerDraft(sessionId, promptText);
        });
      }
    }, [sessionId, msg.id, ephemeralStatus]);

    // timeline 签名缓存
    const timelineCacheRef = useRef<{
      msgId: string;
      sig: string | null;
      timeline: AssistantTimelineItem[] | null;
    }>({ msgId: '', sig: null, timeline: null });

    if (timelineCacheRef.current.msgId !== msg.id) {
      timelineCacheRef.current = { msgId: msg.id, sig: null, timeline: null };
    }

    let timeline: AssistantTimelineItem[];
    try {
      const cached = timelineCacheRef.current;
      const r = buildAssistantTimelineCached(
        displayMsg,
        cached.sig,
        cached.timeline
      );
      timelineCacheRef.current = {
        msgId: msg.id,
        sig: r.sig,
        timeline: r.timeline,
      };
      timeline = r.timeline;
    } catch (err) {
      console.error('[MessageContent] timeline build error', err);
      timeline = [];
    }

    // 流式区判定：助手思考中且累积流式正文有效
    const streaming = Boolean(
      isThinkingMsg && streamText != null && streamText.length > 0
    );

    // 跟踪流式相位变更（首帧流式正文接入时微重排单次通知）
    const prevStreamingRef = useRef(false);
    const streamPhaseRef = useRef(0);
    if (prevStreamingRef.current !== streaming) {
      streamPhaseRef.current += 1;
      prevStreamingRef.current = streaming;
    }

    // 单轨交错线性时间线：去重连续的上下文状态提示，严格保持原生时序
    const linearItems = useMemo(() => {
      const deduped: AssistantTimelineItem[] = [];
      let lastStateText = '';
      for (const item of timeline) {
        if (
          item.kind === 'injection' &&
          isContextStateInjection(item.injection)
        ) {
          const currentText = formatContextStateDisplayText(item.injection);
          if (currentText === lastStateText) {
            continue;
          }
          lastStateText = currentText;
        } else {
          lastStateText = '';
        }
        deduped.push(item);
      }
      return deduped;
    }, [timeline]);

    // ── 分段唯一权威：`partitionTimelineSegments`（四铁律裁决） ──
    const hasStreamText = Boolean(streamText != null && streamText.length > 0);
    const segments: TimelineSegment[] = useMemo(
      () => partitionTimelineSegments(msg.id, linearItems, isLiveTurn, hasStreamText),
      [msg.id, linearItems, isLiveTurn, hasStreamText]
    );

    // ── 分段展开态字典（受控） ──
    const [expandedMap, setExpandedMap] = useState<SectionExpandedMap>({});

    // 初始态播种：仅在段首次出现时写入 defaultExpanded（用户后续手动操作不被覆盖）
    useEffect(() => {
      setExpandedMap((prev) => {
        let mutated = false;
        const next = { ...prev };
        for (const seg of segments) {
          if (seg.kind !== 'process_section') continue;
          if (seg.id in next) continue;
          next[seg.id] = seg.defaultExpanded;
          mutated = true;
        }
        return mutated ? next : prev;
      });
    }, [segments]);

    const handleToggleSection = useCallback(
      (sectionId: string, nextExpanded: boolean) => {
        setExpandedMap((prev) => ({ ...prev, [sectionId]: nextExpanded }));
        setMessageProcessExpanded(sectionId, nextExpanded, sessionId);
        onInvalidateActual?.(msg.id);
      },
      [sessionId, msg.id, onInvalidateActual]
    );

    const handleExpandSection = useCallback(
      (sectionId: string) => {
        setExpandedMap((prev) => ({ ...prev, [sectionId]: true }));
        setMessageProcessExpanded(sectionId, true, sessionId);
        onInvalidateActual?.(msg.id);
      },
      [sessionId, msg.id, onInvalidateActual]
    );

    // 外部检索命中命令入口：bridge 侧要求展开时，同步至对应分段
    useEffect(() => {
      const unsub = subscribeMessageProcessExpansion(msg.id, (exp) => {
        if (!exp) return;
        setExpandedMap((prev) => {
          let mutated = false;
          const next = { ...prev };
          for (const key of Object.keys(next)) {
            if (key.startsWith(`${msg.id}-`)) {
              next[key] = true;
              mutated = true;
            }
          }
          return mutated ? next : prev;
        });
        onInvalidateActual?.(msg.id);
      });
      return unsub;
    }, [msg.id, onInvalidateActual]);

    // 定位可承接流式打字的正文项（必须位于最后工具块之后）
    const streamingTextItem = useMemo(() => {
      let lastToolIdx = -1;
      for (let i = linearItems.length - 1; i >= 0; i--) {
        if (linearItems[i]!.kind === 'tools') {
          lastToolIdx = i;
          break;
        }
      }
      for (let i = linearItems.length - 1; i >= 0; i--) {
        if (linearItems[i]!.kind === 'text') {
          if (lastToolIdx === -1 || i > lastToolIdx) return linearItems[i]!;
          break;
        }
      }
      return null;
    }, [linearItems]);

    // 分段渲染项：由 `ProcessItemRenderer` 承载（唯一渲染路径）
    const renderSegmentItem = useCallback(
      (item: AssistantTimelineItem, _index: number) => (
        <ProcessItemRenderer
          item={item}
          msgId={msg.id}
          status={msg.status}
          isThinkingMsg={isThinkingMsg}
          thoughtDefaultOpen={thoughtDefaultOpen}
          renderThought={renderThought}
          renderTools={renderTools}
          toolStackProps={toolStackProps}
          streamPhase={streamPhaseRef.current}
          hasFinalAnswer={Boolean(displayMsg.text?.trim() || streamText?.trim())}
          isStreamingText={streaming && item === streamingTextItem}
          streamingTextContent={
            msg.streamTextOffset &&
            msg.streamTextOffset > 0 &&
            streamText &&
            streamText.length >= msg.streamTextOffset
              ? streamText.slice(msg.streamTextOffset)
              : streamText
          }
        />
      ),
      [
        msg.id,
        msg.status,
        msg.streamTextOffset,
        isThinkingMsg,
        thoughtDefaultOpen,
        renderThought,
        renderTools,
        toolStackProps,
        displayMsg.text,
        streamText,
        streaming,
        streamingTextItem,
      ]
    );

    // ── 渲染分支（全部位于 Hooks 之后，绝不影响 Hook 序列） ──

    const fallbackText = stripThoughtPlaceholders(displayMsg.text || streamText || '');
    const hasSegments = segments.length > 0;

    // 分支 α：无任何可渲染内容
    if (!hasSegments && !fallbackText.trim() && !streaming) {
      if (isInitialWaiting || isWorkingAfterThought || isLiveTurn) {
        return (
          <div className={`${styles.contentText} ${className || ''}`}>
            <div className={styles.topProcessHeader} data-testid="top-live-header">
              <WorkingStatusIndicator startTime={msg.timestamp} mode="initial" />
            </div>
          </div>
        );
      }
      if (isErrorMsg) {
        return (
          <div className={`${styles.contentText} ${className || ''}`}>
            <TurnErrorNode
              kind={(errorDetail?.kind as any) || ephemeralStatus?.kind}
              message={errorDetail?.message || ephemeralStatus?.message}
              technicalDetail={
                errorDetail?.technical ||
                ((errorDetail as Record<string, unknown> | undefined)?.detail as string | undefined) ||
                ephemeralStatus?.technicalDetail
              }
              onRetryTurn={handleRetryTurn}
            />
          </div>
        );
      }
      return null;
    }

    // 分支 β：时间线为空但有降级正文（首 Token 到达前 / 纯错误态）
    if (!hasSegments) {
      return (
        <div className={`${styles.contentText} ${className || ''}`}>
          {isWorkingAfterThought && (
            <div className={styles.workingSlot}>
              <WorkingStatusIndicator mode="working" />
            </div>
          )}
          <StreamingMarkdownView
            text={fallbackText}
            isStreaming={streaming}
            priority={msg.status === 'processing' ? Priority.Normal : Priority.High}
            messageId={msg.id}
          />
          {inFlowRetry && (
            <ModelRetryNode
              retryState={inFlowRetry}
              onRetryNow={handleRetryNow}
              onCancel={handleCancelRetry}
            />
          )}
          {isErrorMsg && (
            <TurnErrorNode
              kind={(errorDetail?.kind as any) || ephemeralStatus?.kind}
              message={errorDetail?.message || ephemeralStatus?.message}
              technicalDetail={
                errorDetail?.technical ||
                ((errorDetail as Record<string, unknown> | undefined)?.detail as string | undefined) ||
                ephemeralStatus?.technicalDetail
              }
              onRetryTurn={handleRetryTurn}
            />
          )}
        </div>
      );
    }

    // 分支 γ：正常交错分段渲染
    let textCursor = 0;
    return (
      <div className={`${styles.assistantTimelineStream} ${className || ''}`}>
        {/* 顶层唯一常驻态（生成中） */}
        {isLiveTurn && (
          <div className={styles.topProcessHeader} data-testid="top-live-header">
            <WorkingStatusIndicator startTime={msg.timestamp} mode="initial" />
          </div>
        )}

        {segments.map((seg) => {
          if (seg.kind === 'text_narrative') {
            const item = seg.item;
            const isThisStreaming = streaming && item === streamingTextItem;
            textCursor += 1;
            return (
              <ProcessItemRenderer
                key={seg.id}
                item={item}
                msgId={msg.id}
                status={msg.status}
                isThinkingMsg={isThinkingMsg}
                thoughtDefaultOpen={thoughtDefaultOpen}
                renderThought={renderThought}
                renderTools={renderTools}
                toolStackProps={toolStackProps}
                streamPhase={streamPhaseRef.current}
                hasFinalAnswer={seg.isFinalAnswer}
                isStreamingText={isThisStreaming}
                streamingTextContent={
                  msg.streamTextOffset &&
                  msg.streamTextOffset > 0 &&
                  streamText &&
                  streamText.length >= msg.streamTextOffset &&
                  textCursor > 1
                    ? streamText.slice(msg.streamTextOffset)
                    : streamText
                }
              />
            );
          }

          // 过程段
          const isExpanded = expandedMap[seg.id] ?? seg.defaultExpanded;
          return (
            <FoldableProcessSection
              key={seg.id}
              msgId={msg.id}
              sectionId={seg.id}
              items={seg.items}
              metrics={seg.metrics}
              isExpanded={isExpanded}
              isFoldable={seg.foldable}
              forceExpanded={seg.forceExpanded}
              onToggle={handleToggleSection}
              onExpand={handleExpandSection}
              renderItem={renderSegmentItem}
              onInvalidateActual={onInvalidateActual}
            />
          );
        })}

        {isWorkingAfterThought && (
          <div className={styles.workingSlot}>
            <WorkingStatusIndicator mode="working" />
          </div>
        )}

        {streaming && !streamingTextItem && streamText && (
          <div className={styles.contentText}>
            <StreamingMarkdownView
              text={stripThoughtPlaceholders(
                msg.streamTextOffset &&
                msg.streamTextOffset > 0 &&
                streamText.length >= msg.streamTextOffset
                  ? streamText.slice(msg.streamTextOffset)
                  : streamText
              )}
              isStreaming={true}
              priority={Priority.Normal}
              messageId={msg.id}
            />
          </div>
        )}

        {inFlowRetry && (
          <ModelRetryNode
            retryState={inFlowRetry}
            onRetryNow={handleRetryNow}
            onCancel={handleCancelRetry}
          />
        )}
        {isErrorMsg && (
          <TurnErrorNode
            kind={(errorDetail?.kind as any) || ephemeralStatus?.kind}
            message={errorDetail?.message || ephemeralStatus?.message}
            technicalDetail={
              errorDetail?.technical ||
              ((errorDetail as Record<string, unknown> | undefined)?.detail as string | undefined) ||
              ephemeralStatus?.technicalDetail
            }
            onRetryTurn={handleRetryTurn}
          />
        )}
      </div>
    );
  }
);

MessageContent.displayName = 'MessageContent';
