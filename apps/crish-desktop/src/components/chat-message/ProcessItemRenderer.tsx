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
import { ReasoningRow } from '../chat-message-row/ReasoningRow';
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
    const toolItems = item.kind === 'tools' ? item.items : null;
    const itemsToPass = React.useMemo(
      () => (toolItems && streamPhase ? [...toolItems] : toolItems || []),
      [toolItems, streamPhase]
    );

    if (item.kind === 'thought') {
      // 思考活跃态精准判定（解决思考早完成却依然显示「思考中」的缺陷）：
      // 1. 若 item 显式声明 isLive，优先遵从；
      // 2. 若 item 显式声明 isStreaming === false，必定非活跃；
      // 3. 若当前回合已有正文回答（_hasFinalAnswer），思考阶段必定早已结束；
      // 4. 若已有确定耗时 durationMs，说明思考已结算定格；
      // 5. 仅当整条消息仍处于思考期（isThinkingMsg）、且未到达正文、未定格耗时时才为 live。
      const isThoughtLive = Boolean(
        item.isLive ??
        (item.isStreaming !== undefined
          ? item.isStreaming
          : (isThinkingMsg && !_hasFinalAnswer && !item.durationMs))
      );

      if (renderThought) {
        return (
          <React.Fragment key={item.key}>
            {renderThought({
              content: item.content,
              isLive: isThoughtLive,
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
        <ReasoningRow
          key={item.key}
          content={item.content}
          isLive={isThoughtLive}
          isTurnWorking={isThinkingMsg}
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
