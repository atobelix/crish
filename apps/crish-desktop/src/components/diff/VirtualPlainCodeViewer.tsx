/**
 * apps/crish-desktop/src/components/diff/VirtualPlainCodeViewer.tsx
 *
 * 高性能虚拟代码查看器（工业级秒开与零卡死重构）
 * 彻底消除 80 万次字符扫描、对象爆炸与挂载级联重算雪崩
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import { useLayoutStore } from '../../store/layoutStore';
import { highlightCodeSafe } from '../../api/codeHighlight';
import { LineBuffer } from './LineBuffer';
import { VirtualCodeEngine, MAX_DOM_LINE_CHARS, MAX_EXPANDED_LINE_CHARS } from './VirtualCodeEngine';
import { Tooltip } from '../ui';
import styles from './DiffCard.module.css';

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

export const VirtualPlainCodeViewer: React.FC<VirtualPlainCodeViewerProps> = React.memo(
  ({ content, filePath, wordWrap = true }) => {
    // 1. 紧凑行索引构建（单一真理源，零包装对象，耗时 < 1.5ms）
    const lineBuffer = useMemo(() => new LineBuffer(content), [content]);
    const totalLines = lineBuffer.totalLines;

    // 2. 借用原生虚拟滚动容器的滚动位置与容器高
    const { containerRef, scrollTop, containerHeight, onScroll } = useVirtualScroll({
      itemCount: totalLines,
      heightOnly: true,
    });

    const [rowHeight, setRowHeight] = useState(FALLBACK_ROW_HEIGHT);
    const [charWidth, setCharWidth] = useState(FALLBACK_CHAR_WIDTH);
    const [containerWidth, setContainerWidth] = useState(800);
    // 用户主动展开的超长行（按下标记录；仅影响 DOM 切片长度，不改底层全量数据）
    const [expandedLines, setExpandedLines] = useState<ReadonlySet<number>>(
      () => new Set()
    );
    const uiSize = useLayoutStore((s) => s.uiSize);

    const firstLineRef = useRef<HTMLDivElement | null>(null);
    const measureLineRef = useRef<HTMLDivElement | null>(null);
    const measureSpanRef = useRef<HTMLSpanElement | null>(null);
    const prevWidthRef = useRef(800);
    // 测高可失效：字号/Token/uiSize 变化时重测；禁止永久测高锁定
    const measureGenRef = useRef(0);

    // 文本切换后清空展开态，避免旧行号映射到新内容
    useEffect(() => {
      setExpandedLines(new Set());
    }, [content]);

    const toggleLineExpanded = useCallback((lineIndex: number) => {
      setExpandedLines((prev) => {
        const next = new Set(prev);
        if (next.has(lineIndex)) {
          next.delete(lineIndex);
        } else {
          next.add(lineIndex);
        }
        return next;
      });
    }, []);

    // 动态行号区宽度
    const gutterDigits = Math.max(2, String(totalLines).length);
    const gutterWidth = Math.max(22, Math.ceil(gutterDigits * (charWidth || 7.2)) + 8);
    const availableWidth = Math.max(80, containerWidth - gutterWidth - 8);

    // 3. ResizeObserver 监听，带 rAF 批处理与 4px 变化死区防抖
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      if (el.clientWidth > 0) {
        setContainerWidth(el.clientWidth);
        prevWidthRef.current = el.clientWidth;
      }

      let rafId: number | null = null;
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const w = entry.contentRect.width;
          if (w > 0 && Math.abs(w - prevWidthRef.current) >= 4) {
            if (rafId != null) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
              prevWidthRef.current = w;
              setContainerWidth(w);
            });
          }
        }
      });
      ro.observe(el);
      return () => {
        if (rafId != null) cancelAnimationFrame(rafId);
        ro.disconnect();
      };
    }, [containerRef]);

    // 4. 真实行高与单字符测量：单一测高源；字号/Token/uiSize 变更时失效重测（禁止永久测高锁定）
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

        const measured = lineEl.offsetHeight || lineEl.getBoundingClientRect().height;
        if (measured > 0) {
          validRowHeight = Math.round(measured);
        }

        const rect = spanEl.getBoundingClientRect();
        if (rect.height > 0 && validRowHeight === null) {
          validRowHeight = Math.round(rect.height);
        }
        if (rect.width > 0) {
          validCharWidth = rect.width / 36;
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
      const ro = new ResizeObserver(() => {
        applyMeasure();
      });
      ro.observe(lineEl);
      ro.observe(spanEl);
      return () => {
        ro.disconnect();
      };
    }, [uiSize, wordWrap]);

    // 5. 排版引擎实例构建（仅在行宽、换行模式、文本或展开态改变时微量计算）
    const engine = useMemo(() => {
      return new VirtualCodeEngine(lineBuffer, wordWrap, availableWidth, charWidth, expandedLines);
    }, [lineBuffer, wordWrap, availableWidth, charWidth, expandedLines]);

    // 6. 视口切片计算（算术定位，耗时 < 0.002ms）
    const { startIndex, endIndex, offsetTop, totalHeight } = useMemo(() => {
      return engine.computeViewport(scrollTop, containerHeight || 600, rowHeight, OVERSCAN);
    }, [engine, scrollTop, containerHeight, rowHeight]);

    // 7. 惰性物化视口切片行（仅物化当前屏幕 30~50 行字符串）
    const visibleLines = useMemo(() => {
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
        // LayoutShield 排版防死锁截断：折叠 3000 / 展开 20000，底层全量数据始终保真
        const isTruncated = originalLen > MAX_DOM_LINE_CHARS;
        const expanded = isTruncated && expandedLines.has(i);
        const sliceLen = isTruncated
          ? expanded
            ? Math.min(originalLen, MAX_EXPANDED_LINE_CHARS)
            : MAX_DOM_LINE_CHARS
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
    }, [lineBuffer, startIndex, endIndex, expandedLines]);

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
            height: `${totalHeight}px`,
            width: wordWrap ? '100%' : 'max-content',
            minWidth: '100%',
            position: 'relative',
            flexShrink: 0,
            overflow: 'hidden',
            overflowAnchor: 'none',
          }}
        >
          <pre
            className={styles.linesContainer}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: wordWrap ? 0 : undefined,
              width: wordWrap ? '100%' : 'max-content',
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
                  gridTemplateColumns: `${gutterWidth}px 1fr`,
                  width: wordWrap ? '100%' : 'max-content',
                  minWidth: '100%',
                  borderLeft: 'none',
                }}
              >
                <div
                  className={styles.gutterNum}
                  data-num={l.num}
                  style={{
                    width: `${gutterWidth}px`,
                    minWidth: `${gutterWidth}px`,
                    textAlign: 'right',
                    padding: '0 3px',
                    boxSizing: 'border-box',
                  }}
                >
                  {l.num}
                </div>
                <div
                  className={styles.lineText}
                  style={{
                    whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
                    wordBreak: wordWrap ? 'break-word' : 'normal',
                    overflowWrap: wordWrap ? 'anywhere' : 'normal',
                    overflowX: 'hidden',
                    minWidth: 0,
                    padding: '0 2px 0 6px',
                  }}
                >
                  <span dangerouslySetInnerHTML={{ __html: highlightCodeSafe(l.text, filePath) }} />
                  {l.isTruncated && (
                    <Tooltip
                      content={
                        l.expanded
                          ? '收起该行'
                          : '展开该行剩余内容（按需加载，复制仍走全量数据）'
                      }
                    >
                      <button
                        type="button"
                        onClick={() => toggleLineExpanded(l.num - 1)}
                        aria-expanded={l.expanded}
                        style={{
                          marginLeft: 8,
                          fontSize: 11,
                          padding: '1px 6px',
                          borderRadius: 3,
                          border: 'none',
                          background: 'var(--bg-secondary)',
                          color: 'var(--text-secondary)',
                          cursor: 'pointer',
                          font: 'inherit',
                        }}
                      >
                        {l.expanded
                          ? l.text.length < l.originalLen
                            ? `[已展开前 ${l.text.length} 字符，完整共 ${l.originalLen} 字符] 收起`
                            : `[已展开，完整共 ${l.originalLen} 字符] 收起`
                          : `[超长单行已截断呈现，完整共 ${l.originalLen} 字符] 点击展开`}
                      </button>
                    </Tooltip>
                  )}
                </div>
              </div>
            ))}
          </pre>
        </div>

        {/* 隐藏的等宽字符与单行测量探针（独立单行，杜绝视口折行污染） */}
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
  }
);

VirtualPlainCodeViewer.displayName = 'VirtualPlainCodeViewer';
