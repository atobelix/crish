import React from 'react';
import styles from './MessageContent.module.css';
import type { SessionMessage } from '../../store/types';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import {
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
import { isContextStateInjection } from './contextStateUtils';
import type { useNarrativeRenderSlots } from './narrativeRenderSlots';

export interface ProcessItemRendererProps {
  item: AssistantTimelineItem;
  msgId: string;
  status: SessionMessage['status'];
  isThinkingMsg: boolean;
  thoughtDefaultOpen: boolean;
  renderThought?: ReturnType<typeof useNarrativeRenderSlots>['renderThought'];
  renderTools?: ReturnType<typeof useNarrativeRenderSlots>['renderTools'];
  toolStackProps?: ChatToolStackSharedProps;
  streamPhase?: number;
  hasFinalAnswer?: boolean;
  isStreamingText?: boolean;
  streamingTextContent?: string;
}

export const ProcessItemRenderer: React.FC<ProcessItemRendererProps> = React.memo(
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
    hasFinalAnswer: _hasFinalAnswer,
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
              startTime: item.startTime,
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
          startTime={item.startTime}
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
        <div
          key={item.key}
          className={styles.contentText}
          data-kind="text"
          data-start-time={item.startTime}
          data-duration-ms={item.durationMs}
        >
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
      const toolsContent =
        renderTools && toolStackProps ? (
          <React.Fragment key={item.key}>
            {renderTools({
              items: itemsToPass,
              msgId,
              toolStackProps,
            })}
          </React.Fragment>
        ) : toolStackProps ? (
          <MessageToolCallsSection
            key={item.key}
            items={itemsToPass}
            msgId={msgId}
            toolStackProps={toolStackProps}
          />
        ) : null;

      if (!toolsContent) return null;

      return (
        <div
          key={item.key}
          className={styles.toolsTimelineItem}
          data-kind="tools"
          data-start-time={item.startTime}
          data-duration-ms={item.durationMs}
        >
          {toolsContent}
        </div>
      );
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
