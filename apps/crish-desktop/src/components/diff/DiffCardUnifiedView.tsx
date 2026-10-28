import React, { useMemo } from 'react';
import styles from './DiffCard.module.css';
import { DiffErrorBoundary } from './DiffErrorBoundary';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import type { FileDiff } from '../../store/types';
import type { ChangeRenderItem, PlaceholderRenderItem } from './diffCardTypes';
import {
  escapeHtml,
  highlightCode,
  langFromFilename,
} from '../../api/codeHighlight';
import {
  useDiffHighlightMap,
  type DiffHighlightItem,
} from '../../api/codeHighlightBatch';
import {
  computeIntralinePair,
  type DiffWordToken,
} from '../../api/intralineDiff';
import {
  computeFixedRowViewport,
  DIFF_FIXED_ROW_HEIGHT,
} from './fixedRowViewport';
import { AppIcon } from '@/components/ui/icons';

type UnifiedRenderItem = PlaceholderRenderItem | ChangeRenderItem;

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

function renderTokens(
  tokens: DiffWordToken[],
  targetType: 'added' | 'removed',
  fallbackText: string,
  lang: string,
  hlHtml: string | undefined
) {
  const html = hlHtml ?? highlightCode(fallbackText, lang);
  if (!tokens || tokens.length === 0) {
    return (
      <span
        style={{
          whiteSpace: 'pre',
          overflow: 'hidden',
        }}
        dangerouslySetInnerHTML={{
          __html: html,
        }}
      />
    );
  }
  return (
    <span
      style={{
        position: 'relative',
        display: 'block',
        width: '100%',
        maxWidth: '100%',
        whiteSpace: 'pre',
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          pointerEvents: 'none',
          whiteSpace: 'pre',
          color: 'transparent',
          userSelect: 'none',
        }}
        aria-hidden="true"
      >
        {tokens.map((tok, i) => {
          const isTarget = tok.type === targetType;
          if (isTarget) {
            return (
              <span
                key={i}
                className={
                  targetType === 'added'
                    ? styles.diffWordAdd
                    : styles.diffWordDel
                }
              >
                {tok.text}
              </span>
            );
          }
          return <span key={i}>{tok.text}</span>;
        })}
      </span>
      <span
        style={{
          position: 'relative',
          background: 'transparent',
          whiteSpace: 'pre',
        }}
        dangerouslySetInnerHTML={{
          __html: html,
        }}
      />
    </span>
  );
}

interface DiffCardUnifiedViewProps {
  f: FileDiff;
  renderItems: UnifiedRenderItem[];
  onExpandBlock: (filePath: string, startIndex: number) => void;
}

function unifiedRowKey(
  f: FileDiff,
  oldLine: number | undefined,
  newLine: number | undefined,
  globalIdx: number
): string {
  const oldLineNum = oldLine !== undefined ? String(oldLine) : '';
  const newLineNum = newLine !== undefined ? String(newLine) : '';
  return `${f.filePath}:${f.oldPath || ''}:${oldLineNum || 'del'}:${newLineNum || 'add'}:${globalIdx}`;
}

function collectUnifiedHighlightItems(
  f: FileDiff,
  renderItems: UnifiedRenderItem[],
  startIndex: number,
  endIndex: number,
  codeLang: string
): DiffHighlightItem[] {
  const items: DiffHighlightItem[] = [];
  for (let globalIdx = startIndex; globalIdx < endIndex; globalIdx++) {
    const item = renderItems[globalIdx];
    if (!item || item.isCollapsedPlaceholder) continue;
    const { change, oldLine, newLine, isHeader } = item.item;
    if (isHeader) continue;
    items.push({
      id: unifiedRowKey(f, oldLine, newLine, globalIdx),
      code: change.content,
      language: codeLang,
    });
  }
  return items;
}

export const DiffCardUnifiedView: React.FC<DiffCardUnifiedViewProps> = ({
  f,
  renderItems,
  onExpandBlock,
}) => {
  const totalItems = renderItems.length;
  const { containerRef, scrollTop, containerHeight, onScroll } =
    useVirtualScroll({
      itemCount: totalItems,
      heightOnly: true,
    });
  const rowHeight = DIFF_FIXED_ROW_HEIGHT;
  const { startIndex, endIndex, offsetTop, totalHeight } =
    computeFixedRowViewport(
      scrollTop,
      containerHeight,
      totalItems,
      rowHeight,
      15
    );

  const visibleItems = renderItems.slice(startIndex, endIndex);

  // 真实语言推导
  const codeLang = useMemo(() => langFromFilename(f.filePath), [f.filePath]);

  // D8.3：可见行批高亮（短 sync / 长 worker highlight.batch）
  const hlItems = useMemo(
    () =>
      collectUnifiedHighlightItems(
        f,
        renderItems,
        startIndex,
        endIndex,
        codeLang
      ),
    [f, renderItems, startIndex, endIndex, codeLang]
  );
  const hlMap = useDiffHighlightMap(hlItems);

  return (
    <DiffErrorBoundary title="变更对比出错">
      <div
        ref={containerRef}
        className={styles.scrollParent}
        onScroll={onScroll}
        tabIndex={0}
        style={{
          position: 'relative',
          overflowY: 'auto',
          overflowX: 'auto',
          outline: 'none',
          overflowAnchor: 'none',
        }}
      >
        <div
          style={{
            height: `${totalHeight}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          <div
            className={styles.linesContainer}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${offsetTop}px)`,
              background: 'transparent',
            }}
            aria-label={`${basename(f.filePath)} 的变更内容`}
          >
            {visibleItems.map((item, localIdx) => {
              const globalIdx = startIndex + localIdx;
              if (item.isCollapsedPlaceholder) {
                return (
                  <div
                    key={`${f.filePath}-collapse-${item.startIndex}`}
                    className={styles.collapseBar}
                    onClick={() => onExpandBlock(f.filePath, item.startIndex)}
                  >
                    <AppIcon
                      name="maximize"
                      size={12}
                      className={styles.collapseIcon}
                    />
                    <span>展开其余 {item.count} 行代码...</span>
                  </div>
                );
              }
              const { change, oldLine, newLine, isHeader } = item.item;
              if (isHeader) return null;

              let lineClass = styles.lineNormal;
              let marker = ' ';
              let tokens: DiffWordToken[] | null = null;
              let targetType: 'added' | 'removed' = 'added';

              if (change.type === 'addition') {
                lineClass = styles.lineAddition;
                marker = '+';
                targetType = 'added';

                const prevItem =
                  globalIdx > 0 ? renderItems[globalIdx - 1] : null;
                if (
                  prevItem &&
                  !prevItem.isCollapsedPlaceholder &&
                  prevItem.item.change.type === 'deletion'
                ) {
                  const pairResult = computeIntralinePair(
                    prevItem.item.change.content,
                    change.content
                  );
                  tokens = pairResult.newTokens;
                }
              } else if (change.type === 'deletion') {
                lineClass = styles.lineDeletion;
                marker = '−';
                targetType = 'removed';

                const nextItem =
                  globalIdx + 1 < renderItems.length
                    ? renderItems[globalIdx + 1]
                    : null;
                if (
                  nextItem &&
                  !nextItem.isCollapsedPlaceholder &&
                  nextItem.item.change.type === 'addition'
                ) {
                  const pairResult = computeIntralinePair(
                    change.content,
                    nextItem.item.change.content
                  );
                  tokens = pairResult.oldTokens;
                }
              }

              const oldLineNum = oldLine !== undefined ? String(oldLine) : '';
              const newLineNum = newLine !== undefined ? String(newLine) : '';
              const stableKey = unifiedRowKey(f, oldLine, newLine, globalIdx);
              const hlHtml = hlMap.get(stableKey);

              return (
                <div
                  key={stableKey}
                  className={`${styles.line} ${lineClass}`}
                  style={{
                    height: `${rowHeight}px`,
                    minHeight: `${rowHeight}px`,
                    overflow: 'hidden',
                  }}
                >
                  <div className={styles.gutterNum} data-num={oldLineNum}>
                    {oldLineNum}
                  </div>
                  <div className={styles.gutterNum} data-num={newLineNum}>
                    {newLineNum}
                  </div>
                  <div className={styles.gutterMarker}>{marker}</div>
                  <div className={styles.lineText}>
                    {tokens ? (
                      renderTokens(
                        tokens,
                        targetType,
                        change.content,
                        codeLang,
                        hlHtml
                      )
                    ) : (
                      <span
                        style={{
                          whiteSpace: 'pre',
                          overflow: 'hidden',
                        }}
                        dangerouslySetInnerHTML={{
                          __html: hlHtml ?? escapeHtml(change.content),
                        }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </DiffErrorBoundary>
  );
};
