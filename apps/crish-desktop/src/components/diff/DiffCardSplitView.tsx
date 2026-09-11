import React, { useMemo } from 'react';
import styles from './DiffCard.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import type { FileDiff } from '../../store/types';
import type {
  SplitChangeRenderItem,
  PlaceholderRenderItem,
} from './diffCardTypes';
import { highlightCode, langFromFilename } from '../../api/codeHighlight';
import {
  computeIntralinePair,
  type DiffWordToken,
} from '../../api/intralineDiff';
import { computeFixedRowViewport, DIFF_FIXED_ROW_HEIGHT } from './fixedRowViewport';
import { AppIcon } from '../ui/icons/index';

type SplitRenderItem = PlaceholderRenderItem | SplitChangeRenderItem;

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
          whiteSpace: 'pre',
          overflow: 'hidden',
          textOverflow: 'clip',
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
          whiteSpace: 'pre',
        }}
        dangerouslySetInnerHTML={{
          __html: highlightCode(fallbackText, lang),
        }}
      />
    </span>
  );
}

interface DiffCardSplitViewProps {
  f: FileDiff;
  renderItems: SplitRenderItem[];
  onExpandBlock: (filePath: string, startIndex: number) => void;
}

export const DiffCardSplitView: React.FC<DiffCardSplitViewProps> = ({
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
  // Mode-FIXED：行高与 CSS 契约锁定 22px；禁用折行保证 scrollHeight ≡ n×22
  const rowHeight = DIFF_FIXED_ROW_HEIGHT;
  const { startIndex, endIndex, offsetTop, totalHeight } = computeFixedRowViewport(
    scrollTop,
    containerHeight,
    totalItems,
    rowHeight,
    15,
  );

  const visibleItems = renderItems.slice(startIndex, endIndex);

  const codeLang = useMemo(() => langFromFilename(f.filePath), [f.filePath]);

  return (
    <AppErrorBoundary variant="compact" title="变更对比出错">
      <div
        ref={containerRef}
        className={styles.scrollParent}
        onScroll={onScroll}
        tabIndex={0}
        style={{ position: 'relative', overflowY: 'auto', overflowX: 'auto', outline: 'none', overflowAnchor: 'none' }}
      >
        <div
          style={{
            height: `${totalHeight}px`,
            width: '100%',
            position: 'relative',
            overflow: 'hidden',
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
            aria-label={`${basename(f.filePath)} 的变更分栏内容`}
          >
            {visibleItems.map((item, localIdx) => {
              const idx = startIndex + localIdx;
              if (item.isCollapsedPlaceholder) {
                return (
                  <div
                    key={`${f.filePath}-collapse-${item.startIndex}`}
                    className={styles.collapseBar}
                    onClick={() => onExpandBlock(f.filePath, item.startIndex)}
                  >
                    <AppIcon name="maximize" size={12}
                      className={styles.collapseIcon} />
                    <span>展开其余 {item.count} 行代码...</span>
                  </div>
                );
              }

              const { left, right } = item.pair;

              let leftClass = '';
              let leftMarker = ' ';
              let leftText = '';
              let leftNum = '';
              let isLeftDel = false;
              if (left) {
                if (left.change.type === 'deletion') {
                  leftClass = styles.lineDeletion ?? '';
                  leftMarker = '−';
                  isLeftDel = true;
                }
                leftText = left.change.content;
                leftNum = String(left.oldLine ?? '');
              }

              let rightClass = '';
              let rightMarker = ' ';
              let rightText = '';
              let rightNum = '';
              let isRightAdd = false;
              if (right) {
                if (right.change.type === 'addition') {
                  rightClass = styles.lineAddition ?? '';
                  rightMarker = '+';
                  isRightAdd = true;
                }
                rightText = right.change.content;
                rightNum = String(right.newLine ?? '');
              }

              let leftTokens: DiffWordToken[] | null = null;
              let rightTokens: DiffWordToken[] | null = null;
              if (isLeftDel && isRightAdd) {
                const pairResult = computeIntralinePair(leftText, rightText);
                leftTokens = pairResult.oldTokens;
                rightTokens = pairResult.newTokens;
              }

              const oldLine =
                left?.oldLine !== undefined ? String(left.oldLine) : '';
              const newLine =
                right?.newLine !== undefined ? String(right.newLine) : '';
              const stableKey = `${f.filePath}:${f.oldPath || ''}:${oldLine || 'del'}:${newLine || 'add'}:${idx}`;

              return (
                <div
                  key={stableKey}
                  className={styles.splitLine}
                  style={{ height: `${rowHeight}px`, minHeight: `${rowHeight}px`, overflow: 'hidden' }}
                >
                  {/* 左栏 */}
                  <div
                    className={`${styles.splitColumn} ${leftClass} ${!left ? styles.diffLineEmpty : ''}`}
                    style={{ padding: 0 }}
                  >
                    <div className={styles.gutterNum} data-num={leftNum}>
                      {leftNum}
                    </div>
                    <div className={styles.gutterMarker}>{leftMarker}</div>
                    <div className={styles.lineText}>
                      {left ? (
                        leftTokens ? (
                          renderTokens(leftTokens, 'removed', leftText, codeLang)
                        ) : (
                          <span
                            style={{
                              whiteSpace: 'pre',
                              overflow: 'hidden',
                            }}
                            dangerouslySetInnerHTML={{
                              __html: highlightCode(leftText, codeLang),
                            }}
                          />
                        )
                      ) : null}
                    </div>
                  </div>

                  {/* 右栏 */}
                  <div
                    className={`${styles.splitColumn} ${rightClass} ${!right ? styles.diffLineEmpty : ''}`}
                    style={{ padding: 0 }}
                  >
                    <div className={styles.gutterNum} data-num={rightNum}>
                      {rightNum}
                    </div>
                    <div className={styles.gutterMarker}>{rightMarker}</div>
                    <div className={styles.lineText}>
                      {right ? (
                        rightTokens ? (
                          renderTokens(rightTokens, 'added', rightText, codeLang)
                        ) : (
                          <span
                            style={{
                              whiteSpace: 'pre',
                              overflow: 'hidden',
                            }}
                            dangerouslySetInnerHTML={{
                              __html: highlightCode(rightText, codeLang),
                            }}
                          />
                        )
                      ) : null}
                    </div>
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
