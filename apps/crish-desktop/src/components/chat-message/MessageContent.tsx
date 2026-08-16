import React, { useMemo, useRef } from 'react';
import { AlertCircle } from 'lucide-react';
import styles from '../chat-message-row/ChatMessageRow.module.css';
import type { SessionMessage } from '../../store/types';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import {
  buildAssistantTimelineCached,
  extractImageRefs,
  type AssistantTimelineItem,
} from '../../api/toolPresentation';
import {
  IncrementalThoughtStripper,
  stripThoughtPlaceholders,
} from '../../api/markdownRenderLite';
import { Priority } from '../../workers';
import { AsyncMarkdownBlock } from '../chat-message-row/AsyncMarkdownBlock';
import { MessageToolCallsSection } from '../chat-message-row/MessageToolCallsSection';
import { StreamingTextBlock } from '../chat-message-row/StreamingTextBlock';
import { TimelineThoughtSection } from '../chat-message-row/TimelineThoughtSection';
import { useShallow } from '../../api/store-access/componentAccess';
import {
  streamStoreKey,
  useStreamingStore,
  type StreamToolLive,
} from '../../api/store-access/componentAccess';
import {
  applyStreamTextToMessage,
  applyStreamToolsToMessage,
} from './streamMessageViewModel';

export interface MessageContentProps {
  msg: SessionMessage;
  isThinkingMsg?: boolean;
  toolStackProps?: ChatToolStackSharedProps;
  className?: string;
}

/** Stable empty slice so non-live rows never re-render on byKey ticks. */
const EMPTY_STREAM_BODY: {
  text: string | undefined;
  tools: Record<string, StreamToolLive> | undefined;
} = { text: undefined, tools: undefined };

const EMPTY_TIMELINE: AssistantTimelineItem[] = [];

/** 流式区图片增量扫描的尾窗长度（覆盖最长的 markdown 图片语法跨帧拆分段） */
const _IMAGE_TAIL_WINDOW = 256;
/** 流式区图片上限（与 extractImageRefs 的 8 张上限对齐） */
const STREAM_IMAGE_MAX = 8;

/**
 * Timeline 主体（08-detail D6/T1.5）：思考链 + 工具卡 + 稳定文本块。
 * memo 化 + 流式期间签名缓存命中（timeline 引用稳定）→ 纯文本帧零重渲染；
 * 流式增长的最后 text 项由调用方剔除，走独立 StreamingTextBlock 增量区。
 */
interface TimelineBodyProps {
  items: AssistantTimelineItem[];
  toolStackProps?: ChatToolStackSharedProps;
  msgId: string;
  status: SessionMessage['status'];
  isThinkingMsg?: boolean;
}

const TimelineBody: React.FC<TimelineBodyProps> = React.memo(
  function TimelineBody({
    items,
    toolStackProps,
    msgId,
    status,
    isThinkingMsg = false,
  }) {
    return (
      <>
        {items.map((item) => {
          if (item.kind === 'thought') {
            return (
              <TimelineThoughtSection
                key={item.key}
                content={item.content}
                isLive={item.isLive ?? isThinkingMsg}
                durationMs={item.durationMs}
                turnIndex={item.turnIndex}
                messageId={msgId}
              />
            );
          }
          if (item.kind === 'text') {
            const bodyText = stripThoughtPlaceholders(item.content || '');
            if (!bodyText.trim()) return null;
            const imgs = extractImageRefs(bodyText);
            return (
              <div key={item.key} className={styles.timelineText}>
                <AsyncMarkdownBlock
                  text={bodyText}
                  isStreaming={false}
                  priority={
                    status === 'processing' ? Priority.Normal : Priority.High
                  }
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
  ({ msg, isThinkingMsg = false, toolStackProps, className }) => {
    const sessionId = toolStackProps?.activeSessionId;
    // 关键防御 1：移除 live 门禁对 selector 的硬阻断。
    // 即使 msg.status 已转为 completed，只要 streamingStore 中仍有条目，selector 依然返回缓冲内容，
    // 直到 commitStreamToSession 在微任务中安全清理 streamingStore。
    const { text: streamText, tools: streamTools } = useStreamingStore(
      useShallow((s) => {
        if (!sessionId) return EMPTY_STREAM_BODY;
        const e = s.byKey[streamStoreKey(sessionId, msg.id)];
        if (!e) return EMPTY_STREAM_BODY;
        return { text: e.text, tools: e.tools };
      })
    );

    const displayMsg = useMemo(() => {
      let next: SessionMessage = msg;
      // 关键防御 2：防撕裂平滑三元降级公式
      // 1. 只有当 sessionStore 中的 msg.text 已经非空且状态已为 completed 时，才完全信任持久化 text；
      // 2. 否则，只要 streamText 存在，无条件优先使用 streamText；
      // 3. 兜底才使用 msg.text。
      const hasCommittedText = Boolean(msg.text && msg.text.trim().length > 0);
      const activeText =
        hasCommittedText && msg.status === 'completed'
          ? msg.text
          : (streamText ?? msg.text);

      if (activeText != null && activeText !== msg.text) {
        next = applyStreamTextToMessage(next, activeText) as SessionMessage;
      }
      if (streamTools) {
        next = applyStreamToolsToMessage(next, streamTools);
      }
      return next;
    }, [msg, streamText, streamTools]);

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

    // T1.1 增量 stripper：ref 持有完成行窗口状态，按 (sessionId, msgId) 复位；
    // 文本收缩/流重启 → resynced，调用方重挂载 StreamingTextBlock。
    const stripperRef = useRef<IncrementalThoughtStripper | null>(null);
    if (!stripperRef.current) {
      stripperRef.current = new IncrementalThoughtStripper();
    }
    /** 流式帧单调序号（R2-4 N1 修复）：同值新帧（delta 相同）也能被 StreamingTextBlock
     * 区分（seq+1）照常 append；StrictMode 双执行（同 seq）仍被拦截 */
    const streamSeqRef = useRef(0);

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

    // 增量文本计算与单调序号生成（纯计算隔离，0 render setState）
    const { streamDelta, streamSeq, isResynced } = useMemo(() => {
      const stripper = stripperRef.current;
      if (!streaming || !streamText) {
        if (stripper && stripper.getRawLen() > 0) {
          stripper.reset();
        }
        return { streamDelta: '', streamSeq: 0, isResynced: false };
      }
      if (!stripper) {
        return { streamDelta: '', streamSeq: 0, isResynced: false };
      }
      const frame = stripper.next(streamText);
      if (frame.resynced) {
        streamSeqRef.current += 1;
        return {
          streamDelta: frame.appended,
          streamSeq: streamSeqRef.current,
          isResynced: true,
        };
      }
      if (frame.appended) {
        streamSeqRef.current += 1;
      }
      return {
        streamDelta: frame.appended,
        streamSeq: streamSeqRef.current,
        isResynced: false,
      };
    }, [streaming, streamText]);

    const activeStreamKey = `${msg.id}-${isResynced ? streamSeq : 0}`;

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
      const fallback = stripThoughtPlaceholders(displayMsg.text || '');
      if (msg.status === 'error') {
        const errorDetail = msg.errorDetail;
        return (
          <div
            className={`${styles.timelineText} ${className || ''}`}
            style={{ width: '100%' }}
          >
            <div
              style={{
                padding: '10px 14px',
                background: 'var(--bg-error-subtle, rgba(239, 68, 68, 0.04))',
                border: '1px solid var(--border-color)',
                borderRadius: 6,
                fontSize: 13,
                color: 'var(--text-secondary)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <AlertCircle size={13} style={{ color: 'var(--color-error)' }} />
              <span>
                {errorDetail?.message || '服务暂时不可用，请检查网络或后端配置'}
              </span>
            </div>
          </div>
        );
      }
      if (!fallback.trim()) {
        return null;
      }
      // T1.5-⑤：fallback/error/empty 路径不复用流式节点（走 AsyncMarkdownBlock 全量）
      return (
        <div className={`${styles.timelineText} ${className || ''}`}>
          <AsyncMarkdownBlock
            text={fallback}
            isStreaming={isThinkingMsg}
            priority={
              msg.status === 'processing' ? Priority.Normal : Priority.High
            }
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
        />
        {streaming && (
          <div className={styles.timelineText}>
            <StreamingTextBlock
              key={activeStreamKey}
              delta={streamDelta}
              seq={streamSeq}
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
        />
      </div>
    );
  }
);

MessageContent.displayName = 'MessageContent';
