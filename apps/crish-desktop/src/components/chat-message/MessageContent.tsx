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
import { WorkflowConfirmCard } from '../chat-injection/WorkflowConfirmCard';
import {
  extractWorkflowConfirmPayload,
  stripWorkflowConfirmFence,
} from '../../api/workflow-api/workflowConfirm';
import { TimelineThoughtSection } from '../chat-message-row/TimelineThoughtSection';
import { CompactInjectionRow } from '../chat-injection/CompactInjectionRow';
import { TurnProcessNodeView } from './TurnProcessNodeView';
import { deriveTurnProcessState, countProcessMetrics } from './turnProcessState';
import {
  useMessageProcessExpanded,
  toggleMessageProcessExpanded,
} from './searchExpandBridge';

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
      const bodyText = stripThoughtPlaceholders(item.content || '');
      if (!bodyText.trim()) return null;
      const confirmPayload = extractWorkflowConfirmPayload(bodyText);
      const displayText = confirmPayload
        ? stripWorkflowConfirmFence(bodyText)
        : bodyText;
      const imgs = extractImageRefs(bodyText);
      return (
        <div key={item.key} className={styles.contentText}>
          <StreamingMarkdownView
            text={displayText}
            isStreaming={false}
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
      if (item.injection?.kind === 'file_context') {
        return null;
      }
      return (
        <CompactInjectionRow
          key={item.key}
          rowKey={item.key}
          injection={item.injection}
          activeSessionId={toolStackProps?.activeSessionId ?? ''}
          msgId={msgId}
          {...(toolStackProps?.actions?.onOpenDiff
            ? { onOpenDiff: toolStackProps.actions.onOpenDiff }
            : {})}
          {...(toolStackProps?.actions?.onOpenPath
            ? { onOpenPath: toolStackProps.actions.onOpenPath }
            : {})}
        />
      );
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
    const thoughtDefaultOpen = !hideThinkingBlock;

    const isExpanded = useMessageProcessExpanded(msg.id);
    const onToggleExpand = useCallback((targetMsgId: string) => {
      toggleMessageProcessExpanded(targetMsgId);
    }, []);

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

    // 识别最终答案项与过程项：
    // 若时间线末尾为 text 项，该末尾项为最终答案；若末尾为工具调用，则为纯工具轮次或过程轮次
    const lastItem = timeline.length > 0 ? timeline[timeline.length - 1] : null;
    const endsWithText = lastItem?.kind === 'text';

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

    const hasFinalAnswer = Boolean(streaming || endsWithText);
    const lastTextIndex = endsWithText ? timeline.length - 1 : -1;
    const finalAnswerItem = endsWithText ? lastItem : null;

    const processItems = useMemo(
      () =>
        lastTextIndex >= 0
          ? timeline.filter((_, idx) => idx !== lastTextIndex)
          : timeline,
      [timeline, lastTextIndex]
    );

    const isTurnLive = Boolean(isThinkingMsg || msg.status === 'processing');

    const { toolCount, thoughtCount } = useMemo(
      () => countProcessMetrics(processItems),
      [processItems]
    );

    const hasToolsOrThinking = toolCount > 0 || thoughtCount > 0;

    const foldingState = useMemo(
      () =>
        deriveTurnProcessState({
          isTurnLive,
          msgStatus: msg.status,
          itemKind: hasFinalAnswer ? 'text' : 'tools',
          isFinalAnswer: hasFinalAnswer,
          hasToolsOrThinking,
          toolCount,
          userExpanded: isExpanded,
        }),
      [
        isTurnLive,
        msg.status,
        hasFinalAnswer,
        hasToolsOrThinking,
        toolCount,
        isExpanded,
      ]
    );

    const currentStreamImages = useMemo(() => {
      if (!streaming || !streamText) return [];
      const found: string[] = [];
      for (const src of extractImageRefs(streamText)) {
        if (!found.includes(src)) {
          found.push(src);
          if (found.length >= STREAM_IMAGE_MAX) break;
        }
      }
      return found;
    }, [streaming, streamText]);

    const renderProcessChildren = useCallback(
      () => (
        <>
          {processItems.map((item) => (
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
            />
          ))}
        </>
      ),
      [
        processItems,
        msg.id,
        msg.status,
        isThinkingMsg,
        thoughtDefaultOpen,
        renderThought,
        renderTools,
        toolStackProps,
      ]
    );

    // Timeline 为空时的降级渲染
    if (!timeline.length) {
      if (msg.status === 'error') {
        const fallback = stripThoughtPlaceholders(displayMsg.text || '');
        if (!fallback.trim()) return null;
        return (
          <div className={className}>
            <div className={styles.contentText}>
              <StreamingMarkdownView
                text={fallback}
                isStreaming={false}
                priority={Priority.High}
                messageId={msg.id}
              />
            </div>
          </div>
        );
      }
      const fallback = stripThoughtPlaceholders(displayMsg.text || '');
      if (!fallback.trim()) {
        return null;
      }
      return (
        <div className={`${styles.contentText} ${className || ''}`}>
          <StreamingMarkdownView
            text={fallback}
            isStreaming={isThinkingMsg}
            priority={
              msg.status === 'processing' ? Priority.Normal : Priority.High
            }
            messageId={msg.id}
          />
        </div>
      );
    }

    // 最终答案节点
    let finalAnswerNode: React.ReactNode = null;
    if (streaming) {
      finalAnswerNode = (
        <div
          className={`${styles.contentText} ${
            foldingState.compactAnswer ? styles.compactAnswer : ''
          }`}
        >
          <StreamingMarkdownView
            text={stripThoughtPlaceholders(streamText || '')}
            isStreaming={true}
            priority={Priority.Normal}
            messageId={msg.id}
          />
          {currentStreamImages.length > 0 && (
            <div className={styles.inlineImages}>
              {currentStreamImages.map((src) => (
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
    } else if (finalAnswerItem && finalAnswerItem.kind === 'text') {
      const bodyText = stripThoughtPlaceholders(finalAnswerItem.content || '');
      if (bodyText.trim()) {
        const confirmPayload = extractWorkflowConfirmPayload(bodyText);
        const displayText = confirmPayload
          ? stripWorkflowConfirmFence(bodyText)
          : bodyText;
        const imgs = extractImageRefs(bodyText);
        finalAnswerNode = (
          <div
            key={finalAnswerItem.key}
            className={`${styles.contentText} ${
              foldingState.compactAnswer ? styles.compactAnswer : ''
            }`}
          >
            <StreamingMarkdownView
              text={displayText}
              isStreaming={false}
              priority={
                msg.status === 'processing' ? Priority.Normal : Priority.High
              }
              messageId={msg.id}
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
    }

    return (
      <div className={className}>
        {processItems.length > 0 && (
          <TurnProcessNodeView
            msgId={msg.id}
            items={processItems}
            isTurnLive={isTurnLive}
            hasFinalAnswer={hasFinalAnswer}
            turnStatus={msg.status}
            isExpanded={isExpanded}
            onToggleExpand={onToggleExpand}
            renderChildren={renderProcessChildren}
            streamPhase={streamPhaseRef.current}
          />
        )}
        {finalAnswerNode}
      </div>
    );
  }
);

MessageContent.displayName = 'MessageContent';
