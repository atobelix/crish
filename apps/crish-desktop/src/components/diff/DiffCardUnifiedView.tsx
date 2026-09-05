import React, { useMemo } from 'react';
import * as Lucide from 'lucide-react';
import styles from './DiffCard.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import type { FileDiff } from '../../store/types';
import type { ChangeRenderItem, PlaceholderRenderItem } from './diffCardTypes';
import { highlightCode, langFromFilename } from '../../api/codeHighlight';
import {
  computeIntralinePair,
  type DiffWordToken,
} from '../../api/intralineDiff';

type UnifiedRenderItem = PlaceholderRenderItem | ChangeRenderItem;

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

function renderTokens(
  tokens: DiffWordToken[],
  targetType: 'added' | 'removed',
  fallbackText: string,
  lang: string
) {
  if (!tokens || tokens.length === 0) {
    return (
      <span
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
        }}
        dangerouslySetInnerHTML={{
          __html: highlightCode(fallbackText, lang),
        }}
      />
    );
  }
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-block',
        width: '100%',
        maxWidth: '100%',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        overflowWrap: 'anywhere',
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
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
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
                  targetType === 'added' ? styles.diffWordAdd : styles.diffWordDel
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
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
        }}
        dangerouslySetInnerHTML={{
          __html: highlightCode(fallbackText, lang),
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
  const rowHeight = 22;
  const totalHeight = totalItems * rowHeight;

  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 15);
  const endIndex = Math.min(
    totalItems,
    Math.ceil((scrollTop + containerHeight) / rowHeight) + 15
  );

  const visibleItems = renderItems.slice(startIndex, endIndex);
  const offsetTop = startIndex * rowHeight;

  // 真实语言推导
  const codeLang = useMemo(() => langFromFilename(f.filePath), [f.filePath]);

  return (
    <AppErrorBoundary variant="compact" title="变更对比出错">
      <div
        ref={containerRef}
        className={styles.scrollParent}
        onScroll={onScroll}
        tabIndex={0}
        style={{ position: 'relative', overflowY: 'auto', overflowX: 'hidden', outline: 'none' }}
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
                    <Lucide.Maximize2
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
              const stableKey = `${f.filePath}:${f.oldPath || ''}:${oldLineNum || 'del'}:${newLineNum || 'add'}:${globalIdx}`;

              return (
                <div
                  key={stableKey}
                  className={`${styles.line} ${lineClass}`}
                  style={{ minHeight: `${rowHeight}px` }}
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
                      renderTokens(tokens, targetType, change.content, codeLang)
                    ) : (
                      <span
                        style={{
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          overflowWrap: 'anywhere',
                        }}
                        dangerouslySetInnerHTML={{
                          __html: highlightCode(change.content, codeLang),
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
    </AppErrorBoundary>
  );
};
