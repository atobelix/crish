import React, { useState, useMemo, useRef, useCallback } from 'react';
import { useNarrativeRenderSlots } from './narrativeRenderSlots';
import styles from './MessageContent.module.css';
import type { SessionMessage } from '../../store/types';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import {
  buildAssistantTimelineCached,
  type AssistantTimelineItem,
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
import { TurnProcessNodeView, countProcessMetrics } from './TurnProcessNodeView';
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
}

export const MessageContent: React.FC<MessageContentProps> = React.memo(
  ({
    msg,
    streamText,
    isThinkingMsg = false,
    hideThinkingBlock = false,
    toolStackProps,
    className,
  }) => {
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

    // 定位最后工具块索引，判断当前时间线是否存在已渲染工具
    const lastToolIndex = useMemo(() => {
      for (let i = linearItems.length - 1; i >= 0; i--) {
        if (linearItems[i]!.kind === 'tools') return i;
      }
      return -1;
    }, [linearItems]);

    // 定位最后思考块索引，用于将正文流式输出期的工作中指示器精准锚定在思考下方
    const lastThoughtIndex = useMemo(() => {
      for (let i = linearItems.length - 1; i >= 0; i--) {
        if (linearItems[i]!.kind === 'thought') return i;
      }
      return -1;
    }, [linearItems]);

    // 定位可承接流式打字的正文块索引：
    // 必须位于工具调用之后（或全时间线无工具调用），严禁将后置流式总结反向注入到工具调用之前的历史前置文本块中
    const streamingTextIndex = useMemo(() => {
      for (let i = linearItems.length - 1; i >= 0; i--) {
        if (linearItems[i]!.kind === 'text') {
          if (lastToolIndex === -1 || i > lastToolIndex) {
            return i;
          }
          break;
        }
      }
      return -1;
    }, [linearItems, lastToolIndex]);

    // Timeline 为空时的降级平铺渲染（如首 Token 到达前，或纯错误态）
    if (!linearItems.length) {
      const fallback = stripThoughtPlaceholders(displayMsg.text || streamText || '');
      if (!fallback.trim() && !streaming) {
        if (isInitialWaiting || isWorkingAfterThought || isLiveTurn) {
          return (
            <div className={`${styles.contentText} ${className || ''}`}>
              <div className={styles.topProcessHeader} data-testid="top-live-header">
                <WorkingStatusIndicator
                  startTime={msg.timestamp}
                  mode="initial"
                />
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
      return (
        <div className={`${styles.contentText} ${className || ''}`}>
          {isWorkingAfterThought && (
            <div className={styles.workingSlot}>
              <WorkingStatusIndicator mode="working" />
            </div>
          )}
          <StreamingMarkdownView
            text={fallback}
            isStreaming={streaming}
            priority={
              msg.status === 'processing' ? Priority.Normal : Priority.High
            }
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

    const [isProcessExpanded, setIsProcessExpanded] = useState(true);
    const processMetrics = useMemo(
      () => countProcessMetrics(linearItems),
      [linearItems]
    );
    const hasProcessMetrics = Boolean(
      processMetrics.toolCount > 0 ||
      (processMetrics.subagentCount ?? 0) > 0 ||
      (processMetrics.thoughtCount ?? 0) > 0
    );

    return (
      <div className={`${styles.assistantTimelineStream} ${className || ''}`}>
        {/* 顶层唯一常驻态与全轮次唯一分割线 */}
        {isLiveTurn ? (
          <div className={styles.topProcessHeader} data-testid="top-live-header">
            <WorkingStatusIndicator
              startTime={msg.timestamp}
              mode="initial"
            />
          </div>
        ) : hasProcessMetrics ? (
          <div className={styles.topProcessHeader} data-testid="top-summary-header">
            <TurnProcessNodeView
              msgId={msg.id}
              items={linearItems}
              isTurnLive={false}
              hasFinalAnswer={Boolean(displayMsg.text?.trim() || streamText?.trim())}
              turnStatus={msg.status}
              isExpanded={isProcessExpanded}
              onToggleExpand={() => setIsProcessExpanded((prev) => !prev)}
              renderChildren={() => null}
            />
          </div>
        ) : null}

        {isWorkingAfterThought && lastThoughtIndex === -1 && (
          <div className={styles.workingSlot}>
            <WorkingStatusIndicator mode="working" />
          </div>
        )}
        {linearItems.map((item, idx) => {
          if (!isProcessExpanded && (item.kind === 'tools' || item.kind === 'thought')) {
            return null;
          }
          return (
            <React.Fragment key={item.key}>
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
              isStreamingText={streaming && idx === streamingTextIndex}
              streamingTextContent={
                msg.streamTextOffset &&
                msg.streamTextOffset > 0 &&
                streamText &&
                streamText.length >= msg.streamTextOffset &&
                streamingTextIndex > 0
                  ? streamText.slice(msg.streamTextOffset)
                  : streamText
              }
            />
            {isWorkingAfterThought && item.kind === 'thought' && idx === lastThoughtIndex && (
              <div className={styles.workingSlot}>
                <WorkingStatusIndicator mode="working" />
              </div>
            )}
          </React.Fragment>
        );
      })}
        {streaming && streamingTextIndex === -1 && streamText && (
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
