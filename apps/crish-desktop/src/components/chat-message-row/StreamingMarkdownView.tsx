import React, { useLayoutEffect, useMemo, useRef } from 'react';
import styles from './ChatMessageRow.module.css';
import './streaming-animation.css';
import { useStreamingBlocks } from './useStreamingBlocks';
import { MarkdownBlockItem } from './MarkdownBlockItem';
import { Priority } from '../../workers';
import { AdaptiveAnimateTimeline } from '../../api/markdown/AdaptiveAnimateTimeline';
import {
  SlidingWindowRateEstimator,
  type RateSnapshot,
} from '../../api/markdown/SlidingWindowRateEstimator';

export interface StreamingMarkdownViewProps {
  /** 累积正文（已剥离思考链噪音） */
  content?: string;
  /** 兼容别名 text */
  text?: string;
  /** 是否处于流式传输中 */
  isStreaming?: boolean;
  /** 所属消息唯一 ID */
  messageId?: string;
  /** 渲染优先级 */
  priority?: Priority;
  /** 外层附加样式类 */
  className?: string;
}

/**
 * 真流式 Markdown 分块渲染视图
 *
 * 核心架构：
 * 1. 挂载 AdaptiveAnimateTimeline 与 SlidingWindowRateEstimator 实现速率自适应调度；
 * 2. 双轨渐进分块：将累积正文实时切分为独立的 AST 语法块；
 * 3. 已封口块（Sealed）：由 MarkdownBlockItem 调用 Rust 异步编译并通过 React.memo 锁定；
 * 4. 活跃末尾块（Active Tail）：保持轻量级流式打字机态或 TURBO 宏块直出；
 * 5. 双缓冲无缝晋升：封口晋升过渡期保留纯文本 DOM 垫片，消除视口跳变与高度坍塌。
 */
export const StreamingMarkdownView: React.FC<StreamingMarkdownViewProps> = React.memo(
  function StreamingMarkdownView({
    content,
    text,
    isStreaming = false,
    messageId = 'stream-msg',
    priority = Priority.High,
    className,
  }) {
    const rawContent = content ?? text ?? '';

    const timelineRef = useRef<AdaptiveAnimateTimeline | null>(null);
    if (!timelineRef.current) {
      timelineRef.current = new AdaptiveAnimateTimeline();
    }

    const estimatorRef = useRef<SlidingWindowRateEstimator | null>(null);
    if (!estimatorRef.current) {
      estimatorRef.current = new SlidingWindowRateEstimator(500);
    }

    const prevLenRef = useRef(0);
    const rateSnapshotRef = useRef<RateSnapshot | null>(null);

    // 1. 计算速率快照
    const now = performance.now();
    const deltaChars = Math.max(0, rawContent.length - prevLenRef.current);
    prevLenRef.current = rawContent.length;

    if (isStreaming && deltaChars > 0) {
      rateSnapshotRef.current = estimatorRef.current.push(deltaChars, now);
    } else if (!isStreaming) {
      estimatorRef.current.reset();
      rateSnapshotRef.current = null;
    }

    const timeline = timelineRef.current;
    // 2. 开启渲染 Pass
    timeline.beginPass(now);

    // 3. 分块派生
    const { blocks: rawBlocks } = useStreamingBlocks(rawContent, isStreaming, messageId);
    const blocks = useMemo(() => {
      return rawBlocks.filter((b) => b.text.trim().length > 0);
    }, [rawBlocks]);

    // 4. Commit 阶段提交时间轴
    useLayoutEffect(() => {
      timeline.commitPass();
    });

    if (blocks.length === 0) {
      return null;
    }

    const currentTier = rateSnapshotRef.current?.tier ?? 'NORMAL';

    return (
      <div
        className={`conex-streaming-root ${styles.streamingMarkdownRoot || ''} ${className || ''}`.trim()}
        data-streaming={isStreaming ? 'true' : 'false'}
        data-tier={currentTier}
        data-md-variant="chat"
      >
        {blocks.map((blk, idx) => {
          const isLast = idx === blocks.length - 1;
          return (
            <MarkdownBlockItem
              key={blk.key}
              text={blk.text}
              virtualClosedText={blk.virtualClosedText}
              isSealed={blk.isSealed}
              isLast={isLast}
              isStreaming={isStreaming}
              priority={priority}
              timeline={timeline}
              rateSnapshot={rateSnapshotRef.current}
            />
          );
        })}
      </div>
    );
  },
  (prev, next) =>
    (prev.content ?? prev.text) === (next.content ?? next.text) &&
    prev.isStreaming === next.isStreaming &&
    prev.messageId === next.messageId &&
    prev.priority === next.priority &&
    prev.className === next.className
);

StreamingMarkdownView.displayName = 'StreamingMarkdownView';
