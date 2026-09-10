import React, { useMemo, useRef, useCallback } from 'react';
import { useNarrativeRenderSlots } from './narrativeRenderSlots';
import styles from './MessageContent.module.css';
import type { SessionMessage } from '../../store/types';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import {
  buildAssistantTimelineCached,
  extractImageRefs,
  type AssistantTimelineItem,
} from '../../api/toolPresentation';
import { stripThoughtPlaceholders } from '../../api/markdownRenderLite';
import { Priority } from '../../workers';
import { MessageToolCallsSection } from '../chat-message-row/MessageToolCallsSection';
import { StreamingMarkdownView } from '../chat-message-row/StreamingMarkdownView';
import { WorkflowConfirmCard } from '../workflow-confirm/WorkflowConfirmCard';
import {
  extractWorkflowConfirmPayload,
  stripWorkflowConfirmFence,
} from '../../api/workflow-api/workflowConfirm';
import { TimelineThoughtSection } from '../chat-message-row/TimelineThoughtSection';
import { ContextStateNotice } from './ContextStateNotice';
import {
  isContextStateInjection,
  formatContextStateDisplayText,
} from './contextStateUtils';
import { WorkingStatusIndicator } from '../chat-message-row/WorkingStatusIndicator';
import { ModelRetryNode } from '../chat-message-row/ModelRetryNode';
import { TurnErrorNode } from '../chat-message-row/TurnErrorNode';
import { useEphemeralChatStore } from '../../store/ephemeralChatStore';
import { useSessionStore } from '../../store/sessionStore';


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

const STREAM_IMAGE_MAX = 8;

interface ProcessItemRendererProps {
  item: AssistantTimelineItem;
  msgId: string;
  status: SessionMessage['status'];
  isThinkingMsg: boolean;
  thoughtDefaultOpen: boolean;
  renderThought?: ReturnType<typeof useNarrativeRenderSlots>['renderThought'];
  renderTools?: ReturnType<typeof useNarrativeRenderSlots>['renderTools'];
  toolStackProps?: ChatToolStackSharedProps;
  streamPhase?: number;
  isStreamingText?: boolean;
  streamingTextContent?: string;
}

const ProcessItemRenderer: React.FC<ProcessItemRendererProps> = React.memo(
  function ProcessItemRenderer({
    item,
    msgId,
    status,
    isThinkingMsg,
    thoughtDefaultOpen,
    renderThought,
    renderTools,
    toolStackProps,
    streamPhase,
    isStreamingText,
    streamingTextContent,
  }) {
    if (item.kind === 'thought') {
      if (renderThought) {
        return (
          <React.Fragment key={item.key}>
            {renderThought({
              content: item.content,
              isLive: item.isLive ?? isThinkingMsg,
              durationMs: item.durationMs,
              turnIndex: item.turnIndex,
              messageId: msgId,
              defaultOpen: thoughtDefaultOpen,
            })}
          </React.Fragment>
        );
      }
      return (
        <TimelineThoughtSection
          key={item.key}
          content={item.content}
          isLive={item.isLive ?? isThinkingMsg}
          durationMs={item.durationMs}
          turnIndex={item.turnIndex}
          messageId={msgId}
          defaultExpanded={thoughtDefaultOpen}
        />
      );
    }
    if (item.kind === 'text') {
      const rawText =
        isStreamingText && streamingTextContent != null
          ? streamingTextContent
          : item.content || '';
      const bodyText = stripThoughtPlaceholders(rawText);
      if (!bodyText.trim() && !isStreamingText) return null;
      const confirmPayload = extractWorkflowConfirmPayload(bodyText);
      const displayText = confirmPayload
        ? stripWorkflowConfirmFence(bodyText)
        : bodyText;
      const imgs = extractImageRefs(bodyText);
      return (
        <div key={item.key} className={styles.contentText}>
          <StreamingMarkdownView
            text={displayText}
            isStreaming={Boolean(isStreamingText)}
            priority={status === 'processing' ? Priority.Normal : Priority.High}
            messageId={msgId}
          />
          {confirmPayload ? (
            <WorkflowConfirmCard payload={confirmPayload} />
          ) : null}
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
    if (item.kind === 'tools') {
      const itemsToPass = streamPhase ? [...item.items] : item.items;
      if (renderTools && toolStackProps) {
        return (
          <React.Fragment key={item.key}>
            {renderTools({
              items: itemsToPass,
              msgId,
              toolStackProps,
            })}
          </React.Fragment>
        );
      }
      return toolStackProps ? (
        <MessageToolCallsSection
          key={item.key}
          items={itemsToPass}
          msgId={msgId}
          toolStackProps={toolStackProps}
        />
      ) : null;
    }
    if (item.kind === 'injection') {
      if (isContextStateInjection(item.injection)) {
        return (
          <ContextStateNotice
            key={item.key}
            rowKey={item.key}
            injection={item.injection}
          />
        );
      }
      return null;
    }
    return null;
  }
);
ProcessItemRenderer.displayName = 'ProcessItemRenderer';

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

    const isWorking = Boolean(
      msg.status === 'processing' &&
      !displayMsg.text?.trim() &&
      !streamText?.trim() &&
      !displayMsg.thinking?.trim() &&
      (!displayMsg.toolCalls || displayMsg.toolCalls.length === 0)
    );

    const inFlowRetry = ephemeralStatus?.retryState;
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
        if (isWorking) {
          return (
            <div className={`${styles.contentText} ${className || ''}`}>
              <WorkingStatusIndicator startTime={msg.timestamp} />
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

    return (
      <div className={`${styles.assistantTimelineStream} ${className || ''}`}>
        {linearItems.map((item, idx) => (
          <ProcessItemRenderer
            key={item.key}
            item={item}
            msgId={msg.id}
            status={msg.status}
            isThinkingMsg={isThinkingMsg}
            thoughtDefaultOpen={thoughtDefaultOpen}
            renderThought={renderThought}
            renderTools={renderTools}
            toolStackProps={toolStackProps}
            streamPhase={streamPhaseRef.current}
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
        ))}
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
        {isWorking && <WorkingStatusIndicator startTime={msg.timestamp} />}
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
