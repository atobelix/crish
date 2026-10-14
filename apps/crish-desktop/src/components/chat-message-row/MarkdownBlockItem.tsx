import React, { useLayoutEffect, useMemo, useRef } from 'react';
import styles from './ChatMessageRow.module.css';
import {
  useAsyncMarkdownHtml,
  useStreamingMarkdownHtml,
} from '../../api/markdownRenderAsync';
import {
  useWorkerMarkdownAst,
  type MarkdownAstResult,
} from '../../api/markdownWorkerHook';
import { getMarkdownHtmlCache } from '../../api/markdownCache';
import { normalizeCodeBlockIndent } from '../../api/codeBlockIndent';
import type { Priority } from '../../workers';
import type { AdaptiveAnimateTimeline } from '../../api/markdown/AdaptiveAnimateTimeline';
import type { RateSnapshot } from '../../api/markdown/SlidingWindowRateEstimator';
import { hasTableBlock } from '../../api/markdown/tableProbe';
import { toMarkdownPlainTextFallback } from '../../api/markdown/markdownPlainTextFallback';
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
  /** 预先通过 Worker 解析的 AST / Token 结果（可选） */
  ast?: MarkdownAstResult | null;
  /** 是否开启 Worker 离线化解析通道（可选） */
  enableWorkerOffload?: boolean;
  /** 超视距 DOM 回收骨架化标记（可选，Purge 态下卸载重型子树） */
  isPurged?: boolean;
}

/**
 * 判断新旧文本是否属于同一 Markdown 块的流式延续或封口收敛：
 * - 流式追加：nextText 以 prevText 为前缀；
 * - 封口收敛：prevText 末尾换行或预读行被切分后，prevText 以 nextText 为前缀。
 */
function isSameBlockContinuation(prevText: string, nextText: string): boolean {
  if (!prevText || !nextText) return false;
  if (prevText === nextText) return true;
  const normPrev = prevText.replace(/\r\n?/g, '\n');
  const normNext = nextText.replace(/\r\n?/g, '\n');
  return normNext.startsWith(normPrev) || normPrev.startsWith(normNext);
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
    prev.priority === next.priority &&
    prev.ast === next.ast &&
    prev.enableWorkerOffload === next.enableWorkerOffload &&
    prev.isPurged === next.isPurged
  );
}

/**
 * 普通 Markdown 块通过受限 DOM 协调保留已渲染节点；GFM 表格由独立的
 * React 子树逐行追加。两条路径分开拥有各自的 DOM，避免父容器清空时
 * 删除 React 仍在追踪的表格节点。
 */
export const MarkdownBlockItem = React.memo(function MarkdownBlockItem({
  text,
  virtualClosedText: _virtualClosedText,
  isSealed,
  isLast,
  isStreaming,
  priority,
  timeline: _timeline,
  rateSnapshot,
  ast,
  enableWorkerOffload,
  isPurged = false,
}: MarkdownBlockItemProps) {
  const wasStreamingGfmTableRef = useRef(false);
  const lastSafeHtmlRef = useRef<{ text: string; html: string } | null>(null);
  const streamingUnitsRef = useRef<
    readonly IncrementalMarkdownUnitSnapshot[] | null
  >(null);
  const lockedUnitsRef = useRef<{
    text: string;
    units: readonly IncrementalMarkdownUnitSnapshot[];
  } | null>(null);
  const streamingTextRef = useRef(text);
  const isContinuation = isSameBlockContinuation(
    streamingTextRef.current,
    text
  );
  const hadStaleStreamingUnits =
    !isContinuation &&
    (streamingUnitsRef.current !== null || lockedUnitsRef.current !== null);

  const effectiveLockedUnits = isContinuation ? lockedUnitsRef.current : null;
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

  if (
    isContinuation &&
    !isStreamingGfmTable &&
    streamingUnitsRef.current &&
    streamingUnitsRef.current.length > 0
  ) {
    lockedUnitsRef.current = {
      text,
      units: streamingUnitsRef.current,
    };
  }

  // 隐式封口封闭律（C2）：显式封口，或流式已中断（Abort/Stop）且持有流式单元快照
  const isEffectivelySealed =
    isSealed || (!isStreaming && Boolean(effectiveLockedUnits?.units.length));

  const isPriorTable = wasStreamingGfmTableRef.current;
  const shouldRenderStreamingTable =
    (isActiveTail && (isStreamingGfmTable || (isPriorTable && !liveHtml))) ||
    ((isEffectivelySealed || !isActiveTail) && isPriorTable);

  // Worker 离线化解析挂接：当 enableWorkerOffload 开启且处于封口态时，异步将耗时解析与高亮委托给 Worker
  const { ast: workerAst } = useWorkerMarkdownAst(
    enableWorkerOffload && isEffectivelySealed && !isPriorTable ? text : '',
    Boolean(enableWorkerOffload && isEffectivelySealed && !isPriorTable),
    priority
  );

  const effectiveAst = ast ?? workerAst;

  const { html: sealedHtml, failed: sealedFailed } = useAsyncMarkdownHtml(
    isEffectivelySealed && !isPriorTable && !effectiveAst ? text : '',
    priority
  );
  const cachedHtml = useMemo(
    () =>
      isEffectivelySealed && !isPriorTable
        ? effectiveAst?.fullHtml || getMarkdownHtmlCache(text)
        : undefined,
    [text, isEffectivelySealed, isPriorTable, effectiveAst]
  );
  const sameTextSafeHtml =
    lastSafeHtmlRef.current &&
    isSameBlockContinuation(lastSafeHtmlRef.current.text, text)
      ? lastSafeHtmlRef.current.html
      : '';

  if (isActiveTail && renderModeLockedRef.current === null) {
    renderModeLockedRef.current =
      rateSnapshot?.tier === 'TURBO' ? 'TURBO' : 'SPAN';
  } else if (isEffectivelySealed) {
    renderModeLockedRef.current = null;
  }
  const isTurboMode = renderModeLockedRef.current === 'TURBO';

  useLayoutEffect(() => {
    if (isActiveTail && isStreamingGfmTable) {
      wasStreamingGfmTableRef.current = true;
    }
  }, [isActiveTail, isStreamingGfmTable]);

  useLayoutEffect(() => {
    if (!text || !isContinuation) {
      streamingUnitsRef.current = null;
      lockedUnitsRef.current = null;
      if (!text) {
        lastSafeHtmlRef.current = null;
        wasStreamingGfmTableRef.current = false;
      }
    }
    streamingTextRef.current = text;
  }, [text, isContinuation]);

  const renderedHtml = shouldRenderStreamingTable
    ? ''
    : isActiveTail
      ? (hadStaleStreamingUnits ? '' : liveHtml) || sameTextSafeHtml
      : isEffectivelySealed
        ? effectiveAst?.fullHtml ||
          sealedHtml ||
          cachedHtml ||
          liveHtml ||
          sameTextSafeHtml
        : liveHtml || sameTextSafeHtml;

  // SEALING_PENDING 封口过渡态：离开活跃尾块且权威 HTML 尚未就绪时，继续透传锁存单元快照
  const isSealingPending =
    !isActiveTail &&
    !renderedHtml &&
    Boolean(effectiveLockedUnits?.units.length);
  const effectiveIncrementalUnits = isActiveTail
    ? isContinuation
      ? (streamingUnitsRef.current ?? effectiveLockedUnits?.units ?? null)
      : null
    : isSealingPending
      ? effectiveLockedUnits?.units
      : undefined;
  const hasIncrementalHtml =
    effectiveIncrementalUnits?.some((unit) => unit.html.length > 0) ?? false;

  useLayoutEffect(() => {
    if (liveHtml) {
      lastSafeHtmlRef.current = { text, html: liveHtml };
    } else if (
      isEffectivelySealed &&
      (effectiveAst?.fullHtml || sealedHtml || cachedHtml)
    ) {
      lastSafeHtmlRef.current = {
        text,
        html: effectiveAst?.fullHtml || sealedHtml || cachedHtml || '',
      };
      lockedUnitsRef.current = null;
    }
  }, [
    liveHtml,
    sealedHtml,
    cachedHtml,
    effectiveAst,
    isEffectivelySealed,
    text,
  ]);

  const containsTable = useMemo(
    () =>
      shouldRenderStreamingTable ||
      (isActiveTail
        ? /<table(?:\s|>)/i.test(renderedHtml)
        : (effectiveAst?.hasTable ?? hasTableBlock(text))),
    [text, isActiveTail, shouldRenderStreamingTable, renderedHtml, effectiveAst]
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

  if (isPurged) {
    return (
      <div
        {...dataAttributes}
        data-dom-purged="true"
        data-skeleton="true"
        className={`${className} md-block-purged`.trim()}
        style={{ minHeight: '24px' }}
      >
        <div
          className="dom-purge-skeleton"
          style={{ height: '100%', minHeight: '24px' }}
        />
      </div>
    );
  }

  if (shouldRenderStreamingTable) {
    return (
      <div {...dataAttributes}>
        <StreamingGfmTable markdown={text} isStreaming={isActiveTail} />
      </div>
    );
  }

  const isFailedFallback =
    isEffectivelySealed && Boolean(sealedFailed) && !cachedHtml;

  if (isFailedFallback) {
    return (
      <div {...dataAttributes} data-has-html="false" data-failed="true">
        <div
          className={`markdown-fallback-text ${styles.mdTextFallback || ''}`.trim()}
        >
          {toMarkdownPlainTextFallback(text)}
        </div>
      </div>
    );
  }

  const isPendingHtml =
    Boolean(text.trim()) && !renderedHtml && !hasIncrementalHtml;

  return (
    <ReconciledMarkdownHtml
      {...dataAttributes}
      data-has-html={renderedHtml || hasIncrementalHtml ? 'true' : undefined}
      data-md-pending={isPendingHtml ? 'true' : undefined}
      html={renderedHtml}
      incrementalUnits={effectiveIncrementalUnits}
      allowEmptyClear={!isContinuation}
      codeIndent={codeIndent}
    />
  );
}, markdownBlockItemPropsEqual);

MarkdownBlockItem.displayName = 'MarkdownBlockItem';
