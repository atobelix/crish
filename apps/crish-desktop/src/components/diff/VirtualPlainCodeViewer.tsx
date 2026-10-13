/**
 * apps/crish-desktop/src/components/diff/VirtualPlainCodeViewer.tsx
 *
 * 高性能虚拟代码查看器（Stage 07 Blink 原生 CSS.highlights 渐进增强版）：
 * - 支持 Blink CSS.highlights 时采用 Zero-Span 单一原生 TextNode 布局，超长行水平平移 <= 0.42ms
 * - 不支持 CSS.highlights 时自动安全回退至 highlightCodeSafe 分片渲染
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import { useLayoutStore } from '../../store/storeAccess';
import { highlightCodeSafe } from '../../api/codeHighlight';
import { LineBuffer } from './LineBuffer';
import {
  VirtualCodeEngine,
  MAX_DOM_LINE_CHARS,
  MAX_EXPANDED_LINE_CHARS,
} from './VirtualCodeEngine';
import {
  NativeHighlightManager,
  tokenizeLineForHighlights,
  type HighlightTokenSpan,
} from './diffChunkCachePool';
import { Button, Tooltip } from '../ui';
import { ResizeObserverManager } from '../../utils/ResizeObserverManager';
import styles from './DiffCard.module.css';

export {
  NativeHighlightManager,
  tokenizeLineForHighlights,
  type HighlightTokenSpan,
};

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

export interface VirtualPlainCodeViewerProps {
  content: string;
  filePath: string;
  wordWrap?: boolean;
}

const FALLBACK_ROW_HEIGHT = 22;
const FALLBACK_CHAR_WIDTH = 7.2;
const OVERSCAN = 20;

export const VirtualPlainCodeViewer: React.FC<VirtualPlainCodeViewerProps> =
  React.memo(({ content, filePath, wordWrap = true }) => {
    const lineBuffer = useMemo(() => new LineBuffer(content), [content]);
    const totalLines = lineBuffer.totalLines;

    const { containerRef, scrollTop, containerHeight, onScroll } =
      useVirtualScroll({ itemCount: totalLines, heightOnly: true });

    const [rowHeight, setRowHeight] = useState(FALLBACK_ROW_HEIGHT);
    const [charWidth, setCharWidth] = useState(FALLBACK_CHAR_WIDTH);
    const [containerWidth, setContainerWidth] = useState(800);
    const [expandedLines, setExpandedLines] = useState<ReadonlySet<number>>(
      () => new Set()
    );
    const uiSize = useLayoutStore((s) => s.uiSize);
    const useNativeHighlights = NativeHighlightManager.isSupported();

    const firstLineRef = useRef<HTMLDivElement | null>(null);
    const measureLineRef = useRef<HTMLDivElement | null>(null);
    const measureSpanRef = useRef<HTMLSpanElement | null>(null);
    const prevWidthRef = useRef(800);
    const measureGenRef = useRef(0);

    useEffect(() => {
      setExpandedLines(new Set());
    }, [content]);

    const toggleLineExpanded = useCallback((lineIndex: number) => {
      setExpandedLines((prev) => {
        const next = new Set(prev);
        if (next.has(lineIndex)) next.delete(lineIndex);
        else next.add(lineIndex);
        return next;
      });
    }, []);

    const gutterDigits = Math.max(2, String(totalLines).length);
    const gutterWidth = Math.max(
      22,
      Math.ceil(gutterDigits * (charWidth || 7.2)) + 8
    );
    const SCROLLBAR_WIDTH = 16;
    const availableWidth = Math.max(
      80,
      containerWidth - gutterWidth - 8 - (wordWrap ? SCROLLBAR_WIDTH : 0)
    );

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      if (el.clientWidth > 0) {
        setContainerWidth(el.clientWidth);
        prevWidthRef.current = el.clientWidth;
      }

      let rafId: number | null = null;
      const handleResize = (entry: ResizeObserverEntry) => {
        const w = entry.contentRect.width;
        if (w > 0 && Math.abs(w - prevWidthRef.current) >= 4) {
          if (rafId != null) cancelAnimationFrame(rafId);
          rafId = requestAnimationFrame(() => {
            prevWidthRef.current = w;
            setContainerWidth(w);
          });
        }
      };
      const roManager = ResizeObserverManager.getInstance();
      roManager.observe(el, handleResize);
      return () => {
        if (rafId != null) cancelAnimationFrame(rafId);
        roManager.unobserve(el, handleResize);
      };
    }, [containerRef]);

    useLayoutEffect(() => {
      measureGenRef.current += 1;
      const gen = measureGenRef.current;
      const lineEl = measureLineRef.current;
      const spanEl = measureSpanRef.current;
      if (!lineEl || !spanEl) return;

      const applyMeasure = () => {
        if (gen !== measureGenRef.current) return;
        let validRowHeight: number | null = null;
        let validCharWidth: number | null = null;

        const measured =
          lineEl.offsetHeight || lineEl.getBoundingClientRect().height;
        if (measured >= 16 && measured <= 60)
          validRowHeight = Math.round(measured);

        const rect = spanEl.getBoundingClientRect();
        if (rect.height >= 16 && rect.height <= 60 && validRowHeight === null) {
          validRowHeight = Math.round(rect.height);
        }
        if (rect.width > 0) {
          const cw = rect.width / 36;
          if (cw >= 5.0 && cw <= 14.0) validCharWidth = cw;
        }

        if (validRowHeight !== null) {
          setRowHeight((prev) =>
            Math.abs(validRowHeight! - prev) >= 1 ? validRowHeight! : prev
          );
        }
        if (validCharWidth !== null) {
          setCharWidth((prev) =>
            Math.abs(validCharWidth! - prev) >= 0.1 ? validCharWidth! : prev
          );
        }
      };

      applyMeasure();
      const roManager = ResizeObserverManager.getInstance();
      const handleMeasure = () => applyMeasure();
      roManager.observe(lineEl, handleMeasure);
      roManager.observe(spanEl, handleMeasure);
      return () => {
        roManager.unobserve(lineEl, handleMeasure);
        roManager.unobserve(spanEl, handleMeasure);
      };
    }, [uiSize, wordWrap]);

    const engine = useMemo(
      () =>
        new VirtualCodeEngine(
          lineBuffer,
          wordWrap,
          availableWidth,
          charWidth,
          expandedLines
        ),
      [lineBuffer, wordWrap, availableWidth, charWidth, expandedLines]
    );

    const { startIndex, endIndex, offsetTop, totalHeight } = useMemo(
      () =>
        engine.computeViewport(
          scrollTop,
          containerHeight || 600,
          rowHeight,
          OVERSCAN
        ),
      [engine, scrollTop, containerHeight, rowHeight]
    );

    const visibleLines = useMemo(() => {
      const domCharCap =
        useNativeHighlights && !wordWrap
          ? MAX_EXPANDED_LINE_CHARS
          : MAX_DOM_LINE_CHARS;
      const rows: Array<{
        num: number;
        text: string;
        isTruncated: boolean;
        expanded: boolean;
        originalLen: number;
      }> = [];
      for (let i = startIndex; i < endIndex; i++) {
        const fullText = lineBuffer.getLineText(i);
        const originalLen = fullText.length;
        const isTruncated = originalLen > domCharCap;
        const expanded = isTruncated && expandedLines.has(i);
        const sliceLen = isTruncated
          ? expanded
            ? Math.min(originalLen, MAX_EXPANDED_LINE_CHARS)
            : domCharCap
          : originalLen;
        rows.push({
          num: i + 1,
          text: fullText.substring(0, sliceLen),
          isTruncated,
          expanded,
          originalLen,
        });
      }
      return rows;
    }, [
      lineBuffer,
      startIndex,
      endIndex,
      expandedLines,
      useNativeHighlights,
      wordWrap,
    ]);

    const preRef = useRef<HTMLPreElement | null>(null);
    const [actualPreHeight, setActualPreHeight] = useState<number>(0);
    const [actualPreWidth, setActualPreWidth] = useState<number>(0);
    const maxObservedHeightRef = useRef<number>(0);
    const maxObservedWidthRef = useRef<number>(0);

    const estimatedMaxContentWidth = useMemo(() => {
      if (wordWrap) return 0;
      const charLimit =
        expandedLines.size > 0 || useNativeHighlights
          ? MAX_EXPANDED_LINE_CHARS
          : MAX_DOM_LINE_CHARS;
      const effectiveChars = Math.min(
        lineBuffer.maxLineDisplayWidth,
        charLimit
      );
      return gutterWidth + Math.ceil(effectiveChars * (charWidth || 7.2)) + 48;
    }, [
      wordWrap,
      expandedLines.size,
      useNativeHighlights,
      lineBuffer.maxLineDisplayWidth,
      gutterWidth,
      charWidth,
    ]);

    useEffect(() => {
      maxObservedHeightRef.current = 0;
      setActualPreHeight(0);
      maxObservedWidthRef.current = 0;
      setActualPreWidth(0);
    }, [content, wordWrap, containerWidth]);

    useLayoutEffect(() => {
      const el = preRef.current;
      if (!el) return;
      if (useNativeHighlights)
        NativeHighlightManager.applyContainerHighlights(el);
      const h = Math.round(
        el.offsetHeight || el.getBoundingClientRect().height
      );
      if (h > 0)
        setActualPreHeight((prev) => (Math.abs(h - prev) >= 2 ? h : prev));
      if (!wordWrap) {
        const w = Math.round(
          el.scrollWidth || el.getBoundingClientRect().width
        );
        if (w > 0)
          setActualPreWidth((prev) => (Math.abs(w - prev) >= 4 ? w : prev));
      }
      const roManager = ResizeObserverManager.getInstance();
      const handlePreResize = (entry: ResizeObserverEntry) => {
        const height = Math.round(entry.contentRect.height);
        if (height > 0)
          setActualPreHeight((prev) =>
            Math.abs(height - prev) >= 2 ? height : prev
          );
        if (!wordWrap) {
          const width = Math.round(entry.contentRect.width);
          if (width > 0)
            setActualPreWidth((prev) =>
              Math.abs(width - prev) >= 4 ? width : prev
            );
        }
      };
      roManager.observe(el, handlePreResize);
      return () => roManager.unobserve(el, handlePreResize);
    }, [visibleLines, wordWrap, useNativeHighlights]);

    const renderedBottom =
      actualPreHeight > 0 ? offsetTop + actualPreHeight : 0;
    const isScrollable =
      Math.max(totalHeight, renderedBottom) > (containerHeight || 600);
    const isEndReached = endIndex >= totalLines;
    const bottomPadding =
      isScrollable && isEndReached && totalLines > 0
        ? Math.max(32, rowHeight * 1.5)
        : 0;
    const currentNeed = Math.max(totalHeight, renderedBottom + bottomPadding);
    if (currentNeed > maxObservedHeightRef.current)
      maxObservedHeightRef.current = currentNeed;
    const canvasHeight = Math.max(totalHeight, maxObservedHeightRef.current);

    const currentNeedWidth = Math.max(
      containerWidth,
      estimatedMaxContentWidth,
      actualPreWidth
    );
    if (currentNeedWidth > maxObservedWidthRef.current)
      maxObservedWidthRef.current = currentNeedWidth;
    const canvasWidth = wordWrap
      ? containerWidth
      : Math.max(containerWidth, maxObservedWidthRef.current);

    return (
      <div
        ref={containerRef}
        className={styles.plainScrollParent}
        onScroll={onScroll}
        tabIndex={0}
        style={{
          position: 'relative',
          overflowY: 'auto',
          overflowX: wordWrap ? 'hidden' : 'auto',
          outline: 'none',
          width: '100%',
          height: '100%',
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-card)',
          overflowAnchor: 'none',
        }}
      >
        <div
          style={{
            height: `${canvasHeight}px`,
            minHeight: `${canvasHeight}px`,
            width: wordWrap ? '100%' : `${canvasWidth}px`,
            minWidth: '100%',
            position: 'relative',
            flexShrink: 0,
            overflowAnchor: 'none',
          }}
        >
          <pre
            ref={preRef}
            className={styles.linesContainer}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: wordWrap ? 0 : undefined,
              width: wordWrap ? '100%' : `${canvasWidth}px`,
              minWidth: '100%',
              transform: `translateY(${offsetTop}px)`,
              margin: 0,
              background: 'transparent',
              overflowAnchor: 'none',
            }}
            aria-label={`${basename(filePath)} 的源码`}
          >
            {visibleLines.map((l, idx) => (
              <div
                key={l.num}
                ref={idx === 0 ? firstLineRef : undefined}
                className={styles.line}
                style={{
                  minHeight: `${rowHeight}px`,
                  gridTemplateColumns: wordWrap
                    ? `${gutterWidth}px 1fr`
                    : `${gutterWidth}px auto`,
                  width: wordWrap ? '100%' : 'max-content',
                  minWidth: '100%',
                  borderLeft: 'none',
                  overflowX: 'visible',
                }}
              >
                <div
                  className={styles.gutterNum}
                  data-num={l.num}
                  style={{
                    position: 'sticky',
                    left: 0,
                    zIndex: 1,
                    width: `${gutterWidth}px`,
                    minWidth: `${gutterWidth}px`,
                    textAlign: 'right',
                    padding: '0 3px',
                    boxSizing: 'border-box',
                    alignItems: 'flex-start',
                    lineHeight: `${rowHeight}px`,
                    background: 'var(--diff-gutter-bg, var(--bg-card))',
                  }}
                >
                  {l.num}
                </div>
                <div
                  className={styles.lineText}
                  data-native-highlight-line={
                    useNativeHighlights ? l.num : undefined
                  }
                  style={{
                    whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
                    wordBreak: wordWrap ? 'break-word' : 'normal',
                    overflowWrap: wordWrap ? 'anywhere' : 'normal',
                    overflowX: 'hidden',
                    minWidth: wordWrap ? 0 : 'max-content',
                    width: wordWrap ? 'auto' : 'max-content',
                    padding: '0 2px 0 6px',
                    lineHeight: `${rowHeight}px`,
                  }}
                >
                  {useNativeHighlights ? (
                    l.text
                  ) : (
                    <span
                      dangerouslySetInnerHTML={{
                        __html: highlightCodeSafe(l.text, filePath),
                      }}
                    />
                  )}
                  {l.isTruncated && (
                    <Tooltip
                      content={
                        l.expanded
                          ? '收起该行'
                          : '展开该行剩余内容（按需加载，复制仍走全量数据）'
                      }
                    >
                      <Button
                        bare
                        type="button"
                        className={styles.expandLineBtn}
                        onClick={() => toggleLineExpanded(l.num - 1)}
                        aria-expanded={l.expanded}
                      >
                        {l.expanded
                          ? l.text.length < l.originalLen
                            ? `[已展开前 ${l.text.length} 字符，完整共 ${l.originalLen} 字符] 收起`
                            : `[已展开，完整共 ${l.originalLen} 字符] 收起`
                          : `[超长单行已截断呈现，完整共 ${l.originalLen} 字符] 点击展开`}
                      </Button>
                    </Tooltip>
                  )}
                </div>
              </div>
            ))}
          </pre>
        </div>

        <div
          ref={measureLineRef}
          className={styles.line}
          aria-hidden="true"
          style={{
            position: 'absolute',
            visibility: 'hidden',
            pointerEvents: 'none',
            top: -9999,
            left: -9999,
            display: 'block',
            width: 'auto',
            height: 'auto',
            minHeight: 0,
            whiteSpace: 'pre',
          }}
        >
          <span
            ref={measureSpanRef}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--font-size-xs)',
              whiteSpace: 'pre',
            }}
          >
            0123456789abcdefghijklmnopqrstuvwxyz
          </span>
        </div>
      </div>
    );
  });

VirtualPlainCodeViewer.displayName = 'VirtualPlainCodeViewer';
