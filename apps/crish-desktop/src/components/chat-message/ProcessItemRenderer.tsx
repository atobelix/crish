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
import { useEntranceReveal } from '../motion/useEntranceReveal';
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
  /**
   * 【R9】组内叙述行标记：text 项作为过程组内的中间正文渲染时为 true，
   * 以过程排版（过程色、无答复间距）呈现；组外最终答复恒为 false。
   * 叙述行恒为已封口静态文本，永不注入流式正文。
   */
  isNarration?: boolean;
}

export const ProcessItemRenderer: React.FC<ProcessItemRendererProps> =
  React.memo(function ProcessItemRenderer({
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
    isNarration = false,
  }) {
    const toolItems = item.kind === 'tools' ? item.items : null;
    // 稳定引用传透：直接传递 toolItems，杜绝无谓的 [...toolItems] 浅拷贝破坏 downstream React.memo 浅比较
    const itemsToPass = toolItems || [];

    // 统一入场通道（文本段）：段容器 fade 入场；段内文字揭示仍归
    // RevealPacer，本钩子只管容器。非 text 项 disabled 空转（本组件
    // 按 item.key 挂载、kind 终身不变，钩子序稳定）。
    const textEntrance = useEntranceReveal({
      key: item.kind === 'text' ? `seg:${msgId}:${item.key}` : '',
      eventTs: item.startTime,
      variant: 'fade',
      disabled: item.kind !== 'text',
    });

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
          : isThinkingMsg && !_hasFinalAnswer && !item.durationMs)
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
          startTime={item.startTime}
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
          ref={textEntrance.rootRef}
          className={`${
            isNarration
              ? `${styles.contentText} ${styles.narrationText}`
              : styles.contentText
          }${textEntrance.entering ? ' crish-entrance-fade' : ''}`}
          style={
            textEntrance.entering
              ? ({
                  '--reveal-delay': `${textEntrance.delayMs}ms`,
                } as React.CSSProperties)
              : undefined
          }
          data-kind="text"
          data-narration={isNarration ? 'true' : undefined}
          data-start-time={item.startTime}
          data-duration-ms={item.durationMs}
          data-entering={textEntrance.entering ? 'true' : undefined}
          onAnimationEnd={textEntrance.handleAnimationEnd}
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
            eventTs={item.startTime}
          />
        );
      }
      return null;
    }
    return null;
  });
ProcessItemRenderer.displayName = 'ProcessItemRenderer';
