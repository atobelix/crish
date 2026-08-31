import React, { useMemo, useRef } from 'react';
import { useNarrativeRenderSlots } from './narrativeRenderSlots';
import { AlertCircle } from 'lucide-react';
import styles from '../chat-message-row/ChatMessageRow.module.css';
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
import { TimelineThoughtSection } from '../chat-message-row/TimelineThoughtSection';

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

const EMPTY_TIMELINE: AssistantTimelineItem[] = [];

/** 流式区图片增量扫描的尾窗长度（覆盖最长的 markdown 图片语法跨帧拆分段） */
const _IMAGE_TAIL_WINDOW = 256;
/** 流式区图片上限（与 extractImageRefs 的 8 张上限对齐） */
const STREAM_IMAGE_MAX = 8;

const ErrorMessageBanner: React.FC<{
  errorDetail?: SessionMessage['errorDetail'];
  className?: string;
}> = ({ errorDetail, className }) => (
  <div
    className={`${styles.timelineText} ${styles.errorBannerWrapper} ${className || ''}`.trim()}
  >
    <div className={styles.errorBanner}>
      <AlertCircle size={13} className={styles.errorBannerIcon} />
      <span className={styles.errorBannerText}>
        {errorDetail?.message || '服务暂时不可用，请检查网络或后端配置'}
      </span>
    </div>
  </div>
);

/**
 * Timeline 主体（08-detail D6/T1.5）：思考链 + 工具卡 + 稳定文本块。
 * memo 化 + 流式期间签名缓存命中（timeline 引用稳定）→ 纯文本帧零重渲染；
 * 流式增长的最后 text 项由调用方剔除，走 StreamingMarkdownView 渐进分块渲染。
 */
interface TimelineBodyProps {
  items: AssistantTimelineItem[];
  toolStackProps?: ChatToolStackSharedProps;
  msgId: string;
  status: SessionMessage['status'];
  isThinkingMsg?: boolean;
  hideThinkingBlock?: boolean;
}

const TimelineBody: React.FC<TimelineBodyProps> = React.memo(
  function TimelineBody({
    items,
    toolStackProps,
    msgId,
    status,
    isThinkingMsg = false,
    hideThinkingBlock = false,
  }) {
    const { renderTools, renderThought } = useNarrativeRenderSlots();
    const thoughtDefaultOpen = !hideThinkingBlock;
    return (
      <>
        {items.map((item) => {
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
            const imgs = extractImageRefs(bodyText);
            return (
              <div key={item.key} className={styles.timelineText}>
                <StreamingMarkdownView
                  text={bodyText}
                  isStreaming={false}
                  priority={
                    status === 'processing' ? Priority.Normal : Priority.High
                  }
                  messageId={msgId}
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
          if (item.kind === 'tools' && renderTools && toolStackProps) {
            return (
              <React.Fragment key={item.key}>
                {renderTools({
                  items: item.items,
                  msgId,
                  toolStackProps,
                })}
              </React.Fragment>
            );
          }
          return toolStackProps ? (
            <MessageToolCallsSection
              key={item.key}
              items={item.items}
              msgId={msgId}
              toolStackProps={toolStackProps}
            />
          ) : null;
        })}
      </>
    );
  }
);

TimelineBody.displayName = 'TimelineBody';

export const MessageContent: React.FC<MessageContentProps> = React.memo(
  ({
    msg,
    streamText,
    isThinkingMsg = false,
    hideThinkingBlock = false,
    toolStackProps,
    className,
  }) => {
    // T4 A1：热缓冲订阅与 view model 合并已上移页面壳层（useStreamMessageViewModel），
    // 本组件只收「已合并 view model」（msg）+ 流式累积正文（streamText）。
    // 防撕裂平滑三元降级公式与 live 门禁语义由壳层装配点承载——即使 msg.status
    // 已转 completed、只要热缓冲仍有条目，壳层依然返回缓冲内容，直到
    // commitStreamToSession 在微任务中安全清理（queueMicrotask clearStream 时序闭环）。
    const displayMsg = msg;

    // T1.2 签名缓存：纯文本流式帧命中（最后 text 块内容不进签名）→ 复用上次
    // timeline 引用（TimelineBody memo 全链路零重渲染）。按 msg.id 复位。
    const timelineCacheRef = useRef<{
      msgId: string;
      sig: string | null;
      timeline: AssistantTimelineItem[] | null;
    }>({ msgId: '', sig: null, timeline: null });
    if (timelineCacheRef.current.msgId !== msg.id) {
      timelineCacheRef.current = { msgId: msg.id, sig: null, timeline: null };
    }

    // 跟踪上一帧流式状态与消息状态，落实防线 2
    const prevStreamingRef = useRef(false);
    const prevStatusRef = useRef(msg.status);

    // 状态跃迁检测：流式态结束 或 processing 转为 completed/stopped/error
    if (
      (prevStreamingRef.current && !isThinkingMsg) ||
      (prevStatusRef.current === 'processing' && msg.status !== 'processing')
    ) {
      timelineCacheRef.current.sig = null;
      timelineCacheRef.current.timeline = null;
    }

    /** 主体拆分缓存：timeline 引用稳定 → 拆分数组引用稳定（TimelineBody memo 依赖） */
    const splitRef = useRef<{
      timeline: AssistantTimelineItem[];
      streamIdx: number;
      before: AssistantTimelineItem[];
      after: AssistantTimelineItem[];
    }>({
      timeline: EMPTY_TIMELINE,
      streamIdx: -1,
      before: EMPTY_TIMELINE,
      after: EMPTY_TIMELINE,
    });

    if (
      (prevStreamingRef.current && !isThinkingMsg) ||
      (prevStatusRef.current === 'processing' && msg.status !== 'processing')
    ) {
      splitRef.current.timeline = EMPTY_TIMELINE;
      splitRef.current.streamIdx = -1;
    }

    // timeline 构建（签名缓存 + 全量重建兜底）；构建失败走 catch 兜底路径
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

    const textItems = timeline.filter((i) => i.kind === 'text');
    const lastTextKey = textItems.length
      ? textItems[textItems.length - 1]!.key
      : null;
    // 流式区条件（与既有语义一致：思考中助手消息的最后 text 项）。
    // streamText 为空串时不进流式区：空内容尾块会被 timeline 排除（c.trim()
    // 判空），lastTextKey 将回落到历史 text 块——若此时抢占其位置会导致
    // 历史块重挂载（memo 击穿）与内容错位（F1-08 流式区定位回归）。
    const streaming =
      isThinkingMsg &&
      lastTextKey != null &&
      streamText != null &&
      streamText.length > 0;

    // 纯派生流式图片列表（0 render setState，StrictMode 纯净幂等）
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

    const streamIdx = streaming
      ? timeline.findIndex((i) => i.key === lastTextKey)
      : -1;
    // 主体拆分：流式区两侧的稳定项（缓存保证引用稳定 → TimelineBody memo 命中）
    if (
      splitRef.current.timeline !== timeline ||
      splitRef.current.streamIdx !== streamIdx
    ) {
      const before = streamIdx >= 0 ? timeline.slice(0, streamIdx) : timeline;
      const after =
        streamIdx >= 0 ? timeline.slice(streamIdx + 1) : EMPTY_TIMELINE;
      splitRef.current = { timeline, streamIdx, before, after };
    }
    const stableBefore = splitRef.current.before;
    const stableAfter = splitRef.current.after;

    prevStreamingRef.current = streaming;
    prevStatusRef.current = msg.status;

    if (!timeline.length) {
      if (msg.status === 'error') {
        const fallback = stripThoughtPlaceholders(displayMsg.text || '');
        return (
          <div className={className}>
            {fallback.trim() && (
              <div className={styles.timelineText}>
                <StreamingMarkdownView
                  text={fallback}
                  isStreaming={false}
                  priority={Priority.High}
                  messageId={msg.id}
                />
              </div>
            )}
            <ErrorMessageBanner
              errorDetail={msg.errorDetail}
              className={className}
            />
          </div>
        );
      }
      const fallback = stripThoughtPlaceholders(displayMsg.text || '');
      if (!fallback.trim()) {
        return null;
      }
      // 降级路径：当 timeline.length === 0 时，通过 StreamingMarkdownView 进行渐进真流式分块渲染
      return (
        <div className={`${styles.timelineText} ${className || ''}`}>
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

    return (
      <div className={className}>
        <TimelineBody
          items={stableBefore}
          toolStackProps={toolStackProps}
          msgId={msg.id}
          status={msg.status}
          isThinkingMsg={isThinkingMsg}
          hideThinkingBlock={hideThinkingBlock}
        />
        {streaming && (
          <div className={styles.timelineText}>
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
        )}
        <TimelineBody
          items={stableAfter}
          toolStackProps={toolStackProps}
          msgId={msg.id}
          status={msg.status}
          isThinkingMsg={isThinkingMsg}
          hideThinkingBlock={hideThinkingBlock}
        />
        {msg.status === 'error' && (
          <ErrorMessageBanner errorDetail={msg.errorDetail} />
        )}
      </div>
    );
  }
);

MessageContent.displayName = 'MessageContent';
