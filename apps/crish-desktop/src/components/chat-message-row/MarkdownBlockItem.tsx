import React, { useLayoutEffect, useMemo, useRef } from 'react';
import styles from './ChatMessageRow.module.css';
import {
  useAsyncMarkdownHtml,
  useStreamingMarkdownHtml,
} from '../../api/markdownRenderAsync';
import { getMarkdownHtmlCache } from '../../api/markdownCache';
import {
  normalizeCodeBlockIndent,
} from '../../api/codeBlockIndent';
import type { Priority } from '../../workers';
import type { AdaptiveAnimateTimeline } from '../../api/markdown/AdaptiveAnimateTimeline';
import type { RateSnapshot } from '../../api/markdown/SlidingWindowRateEstimator';
import { hasTableBlock } from '../../api/markdown/tableProbe';
import { looksLikeStreamingGfmTable } from '../../api/markdown/StreamingGfmTableParser';
import { StreamingGfmTable } from './StreamingGfmTable';
import { ReconciledMarkdownHtml } from '../markdown/ReconciledMarkdownHtml';
import { useSettingsField } from '../../store/storeAccess';
import type { IncrementalMarkdownUnitSnapshot } from '../../api/markdown/IncrementalMarkdownSession';

export interface MarkdownBlockItemProps {
  /** 块的 Markdown 内容 */
  text: string;
  /** 纯内存投机虚拟补全后的渲染内容（可选） */
  virtualClosedText?: string;
  /** 该块是否已封口 */
  isSealed: boolean;
  /** 是否是文档最后一个块 */
  isLast: boolean;
  /** 全局流式状态 */
  isStreaming: boolean;
  /** 渲染优先级 */
  priority?: Priority;
  /** GPU 挂钟时间轴 */
  timeline?: AdaptiveAnimateTimeline;
  /** 当前速率快照 */
  rateSnapshot?: RateSnapshot | null;
}

/**
 * 块级 React.memo 比较契约：
 * - 历史已封口块在后续流式帧中，text、virtualClosedText、isSealed、isLast、isStreaming、priority 完全恒定；
 * - 比较器返回 true，协调阶段跳过，实现封口块 0 重渲染。
 */
export function markdownBlockItemPropsEqual(
  prev: MarkdownBlockItemProps,
  next: MarkdownBlockItemProps
): boolean {
  return (
    prev.text === next.text &&
    prev.virtualClosedText === next.virtualClosedText &&
    prev.isSealed === next.isSealed &&
    prev.isLast === next.isLast &&
    prev.isStreaming === next.isStreaming &&
    prev.priority === next.priority
  );
}

/**
 * 普通 Markdown 块通过受限 DOM 协调保留已渲染节点；GFM 表格由独立的
 * React 子树逐行追加。两条路径分开拥有各自的 DOM，避免父容器清空时
 * 删除 React 仍在追踪的表格节点。
 */
export const MarkdownBlockItem = React.memo(function MarkdownBlockItem({
  text,
  virtualClosedText,
  isSealed,
  isLast,
  isStreaming,
  priority,
  timeline: _timeline,
  rateSnapshot,
}: MarkdownBlockItemProps) {
  const wasStreamingGfmTableRef = useRef(false);
  const lastSafeHtmlRef = useRef<{ text: string; html: string } | null>(null);
  const streamingUnitsRef = useRef<readonly IncrementalMarkdownUnitSnapshot[] | null>(null);
  const streamingTextRef = useRef(text);
  const streamingTextMatches = streamingTextRef.current === text;
  const hadStaleStreamingUnits =
    !streamingTextMatches && streamingUnitsRef.current !== null;
  if (!streamingTextMatches) {
    // React 在 effect 前仍会先完成一次新 props 的 render；清掉旧快照，
    // 让协调器在这一次 render 就移除旧块，避免旧 HTML 短暂错投。
    streamingTextRef.current = text;
    streamingUnitsRef.current = null;
  }
  const renderModeLockedRef = useRef<'SPAN' | 'TURBO' | null>(null);

  const codeIndent = useSettingsField((s) =>
    normalizeCodeBlockIndent(s.appSettings?.markdown?.codeBlockIndent)
  );

  const isActiveTail = isStreaming && isLast && !isSealed;
  const isStreamingGfmTable = isActiveTail && looksLikeStreamingGfmTable(text);
  const liveHtml = useStreamingMarkdownHtml(
    text,
    isActiveTail && !isStreamingGfmTable,
    priority,
    streamingUnitsRef
  );
  const isPriorTable = wasStreamingGfmTableRef.current;
  const shouldRenderStreamingTable =
    (isActiveTail &&
      (isStreamingGfmTable || (isPriorTable && !liveHtml))) ||
    (isSealed && isPriorTable);
  const { html: sealedHtml } = useAsyncMarkdownHtml(
    isSealed && !isPriorTable ? text : '',
    priority
  );
  const cachedHtml = useMemo(
    () => isSealed && !isPriorTable ? getMarkdownHtmlCache(text) : undefined,
    [text, isSealed, isPriorTable]
  );
  const sameTextSafeHtml =
    lastSafeHtmlRef.current?.text === text
      ? lastSafeHtmlRef.current.html
      : '';

  if (isActiveTail && renderModeLockedRef.current === null) {
    renderModeLockedRef.current = rateSnapshot?.tier === 'TURBO' ? 'TURBO' : 'SPAN';
  } else if (isSealed) {
    renderModeLockedRef.current = null;
  }
  const isTurboMode = renderModeLockedRef.current === 'TURBO';

  useLayoutEffect(() => {
    if (isActiveTail && isStreamingGfmTable) {
      wasStreamingGfmTableRef.current = true;
    }
  }, [isActiveTail, isStreamingGfmTable]);

  const renderedHtml = shouldRenderStreamingTable
    ? ''
    : isActiveTail
      ? (hadStaleStreamingUnits ? '' : liveHtml) || sameTextSafeHtml
      : isSealed
        ? sealedHtml || cachedHtml || liveHtml || sameTextSafeHtml
        : liveHtml || sameTextSafeHtml;
  const hasIncrementalHtml = isActiveTail &&
    streamingTextMatches &&
    (streamingUnitsRef.current?.some((unit) => unit.html.length > 0) ?? false);

  useLayoutEffect(() => {
    if (liveHtml) lastSafeHtmlRef.current = { text, html: liveHtml };
    else if (isSealed && sealedHtml) {
      lastSafeHtmlRef.current = { text, html: sealedHtml };
    }
  }, [liveHtml, sealedHtml, isSealed, text]);

  const containsTable = useMemo(
    () => shouldRenderStreamingTable ||
      (isActiveTail
        ? /<table(?:\s|>)/i.test(renderedHtml)
        : hasTableBlock(text)),
    [text, isActiveTail, shouldRenderStreamingTable, renderedHtml]
  );
  const hideCaret = isActiveTail && containsTable;

  if (!text) return null;

  const className = isActiveTail
    ? `${styles.assistantText} md-rendered ${styles.isStreaming} ${
      hideCaret ? `${styles.suppressCaret || ''} suppressCaret` : ''
    } md-block-active`.trim()
    : `${styles.assistantText} md-rendered md-block-sealed`;
  const dataAttributes = {
    className,
    'data-streaming': isActiveTail ? 'true' : 'false',
    'data-sealed': String(isSealed),
    'data-turbo': isActiveTail && isTurboMode ? 'true' : 'false',
    'data-contains-table': containsTable ? 'true' : 'false',
    'data-md-variant': 'chat',
  } as const;

  if (shouldRenderStreamingTable) {
    return (
      <div {...dataAttributes}>
        <StreamingGfmTable markdown={text} isStreaming={isActiveTail} />
      </div>
    );
  }

  return (
    <ReconciledMarkdownHtml
      {...dataAttributes}
      data-has-html={renderedHtml || hasIncrementalHtml ? 'true' : undefined}
      html={renderedHtml}
      incrementalUnits={isActiveTail
        ? (streamingTextMatches ? streamingUnitsRef.current : null)
        : undefined}
      codeIndent={codeIndent}
    />
  );
}, markdownBlockItemPropsEqual);

MarkdownBlockItem.displayName = 'MarkdownBlockItem';
