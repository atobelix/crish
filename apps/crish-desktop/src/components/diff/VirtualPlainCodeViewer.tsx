import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import { highlightCode, langFromFilename } from '../../api/codeHighlight';
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

/**
 * 计算字符串的视觉显示宽度（以等宽半角字符为 1 个基准单位，全角/CJK 字符为 2 个单位）
 */
function calcDisplayWidth(text: string): number {
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK 汉字与全角标点符号占 2 字符宽
    width += code > 255 ? 2 : 1;
  }
  return width;
}

/**
 * 在前缀和数组中二分查找目标滚动位置对应的行下标 (O(log N))
 */
function findLineIndex(prefixSums: Float64Array, targetOffset: number, totalCount: number): number {
  if (totalCount <= 0 || targetOffset <= 0) return 0;
  let low = 0;
  let high = totalCount - 1;
  let ans = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (prefixSums[mid]! <= targetOffset) {
      ans = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return ans;
}

export const VirtualPlainCodeViewer: React.FC<VirtualPlainCodeViewerProps> = React.memo(
  ({ content, filePath, wordWrap = true }) => {
    const lines = useMemo(() => {
      return content.split('\n').map((line, idx) => ({
        num: idx + 1,
        content: line,
      }));
    }, [content]);

    const totalLines = lines.length;

    const { containerRef, scrollTop, containerHeight, onScroll } = useVirtualScroll({
      itemCount: totalLines,
      heightOnly: true,
    });

    const [rowHeight, setRowHeight] = useState(FALLBACK_ROW_HEIGHT);
    const [charWidth, setCharWidth] = useState(FALLBACK_CHAR_WIDTH);
    const [containerWidth, setContainerWidth] = useState(800);

    const firstLineRef = useRef<HTMLDivElement | null>(null);
    const measureSpanRef = useRef<HTMLSpanElement | null>(null);

    // 动态行号宽度（支持 5 位数以上行号，确保不溢出不折行）
    const gutterDigits = Math.max(2, String(totalLines).length);
    const gutterWidth = Math.max(40, gutterDigits * 8 + 16);

    // 监听容器宽度变化（以便动态推算每行折行数）
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const updateWidth = () => {
        if (el.clientWidth > 0) {
          setContainerWidth(el.clientWidth);
        }
      };
      updateWidth();
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const w = entry.contentRect.width;
          if (w > 0) {
            setContainerWidth(w);
          }
        }
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, [containerRef]);

    // 动态实测真实行高与单字符宽度（自适应系统 ui-size 缩放）
    useLayoutEffect(() => {
      const lineEl = firstLineRef.current;
      if (lineEl) {
        const measured = lineEl.offsetHeight;
        if (measured > 0 && measured !== rowHeight) {
          setRowHeight(measured);
        }
      }

      const spanEl = measureSpanRef.current;
      if (spanEl) {
        const measuredW = spanEl.getBoundingClientRect().width;
        if (measuredW > 0) {
          const cw = measuredW / 36;
          if (Math.abs(cw - charWidth) > 0.05) {
            setCharWidth(cw);
          }
        }
      }
    }, [content, rowHeight, charWidth]);

    // 计算每行的高度（非换行模式恒定 rowHeight；换行模式按字符宽度动态估算折行数）
    const lineHeights = useMemo(() => {
      const heights = new Float64Array(totalLines);
      if (!wordWrap) {
        heights.fill(rowHeight);
        return heights;
      }

      // 可用内容宽度 = 容器宽 - 行号区宽 - padding
      const availableWidth = Math.max(80, containerWidth - gutterWidth - 24);
      const charsPerLine = Math.max(8, Math.floor(availableWidth / charWidth));

      for (let i = 0; i < totalLines; i++) {
        const text = lines[i]!.content;
        if (!text) {
          heights[i] = rowHeight;
        } else {
          const dw = calcDisplayWidth(text);
          const visualLines = Math.max(1, Math.ceil(dw / charsPerLine));
          heights[i] = visualLines * rowHeight;
        }
      }
      return heights;
    }, [lines, totalLines, wordWrap, rowHeight, containerWidth, gutterWidth, charWidth]);

    // 构建前缀和数组 (Prefix Sums)，支持 O(1) 查总高与 O(log N) 查视口行范围
    const prefixSums = useMemo(() => {
      const p = new Float64Array(totalLines + 1);
      p[0] = 0;
      for (let i = 0; i < totalLines; i++) {
        p[i + 1] = p[i]! + lineHeights[i]!;
      }
      return p;
    }, [totalLines, lineHeights]);

    const totalHeight = prefixSums[totalLines] || 0;

    // 二分查找可视窗口
    const { startIndex, endIndex, offsetTop } = useMemo(() => {
      if (totalLines === 0) {
        return { startIndex: 0, endIndex: 0, offsetTop: 0 };
      }
      const rawStart = findLineIndex(prefixSums, scrollTop, totalLines);
      const s = Math.max(0, rawStart - OVERSCAN);

      const targetEndOffset = scrollTop + (containerHeight || 600);
      const rawEnd = findLineIndex(prefixSums, targetEndOffset, totalLines) + 1;
      const e = Math.min(totalLines, rawEnd + OVERSCAN);

      const offTop = prefixSums[s] || 0;
      return { startIndex: s, endIndex: e, offsetTop: offTop };
    }, [prefixSums, scrollTop, containerHeight, totalLines]);

    const visibleLines = useMemo(() => {
      return lines.slice(startIndex, endIndex);
    }, [lines, startIndex, endIndex]);

    // 纯源码推导真实语言高亮
    const codeLang = useMemo(() => langFromFilename(filePath), [filePath]);

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
        }}
      >
        <div
          style={{
            height: `${totalHeight}px`,
            width: wordWrap ? '100%' : 'max-content',
            minWidth: '100%',
            position: 'relative',
            flex: 1,
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
                }}
              >
                <div
                  className={styles.gutterNum}
                  data-num={l.num}
                  style={{
                    width: `${gutterWidth}px`,
                    minWidth: `${gutterWidth}px`,
                    textAlign: 'right',
                    paddingRight: '8px',
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
                  }}
                  dangerouslySetInnerHTML={{ __html: highlightCode(l.content, codeLang) }}
                />
              </div>
            ))}
          </pre>
        </div>

        {/* 隐藏的等宽字符测量探针（36 字符基准样本） */}
        <span
          ref={measureSpanRef}
          aria-hidden="true"
          style={{
            position: 'absolute',
            visibility: 'hidden',
            pointerEvents: 'none',
            top: -9999,
            left: -9999,
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--font-size-xs)',
            whiteSpace: 'pre',
          }}
        >
          0123456789abcdefghijklmnopqrstuvwxyz
        </span>
      </div>
    );
  }
);

VirtualPlainCodeViewer.displayName = 'VirtualPlainCodeViewer';
