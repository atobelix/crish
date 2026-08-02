import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './DiffCard.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import type { FileDiff } from '../../store/types';
import type { SplitChangeRenderItem, PlaceholderRenderItem } from './diffCardTypes';
import { highlightCode } from '../../api/codeHighlight';

type SplitRenderItem = PlaceholderRenderItem | SplitChangeRenderItem;

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
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
  const { containerRef, scrollTop, containerHeight, onScroll } = useVirtualScroll({
    itemCount: totalItems,
    heightOnly: true,
  });
  const rowHeight = 22;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 15);
  const endIndex = Math.min(totalItems, Math.ceil((scrollTop + containerHeight) / rowHeight) + 15);

  const visibleItems = renderItems.slice(startIndex, endIndex);
  const offsetTop = startIndex * rowHeight;

  return (
    <AppErrorBoundary variant="compact" title="变更对比出错">
      <div
        ref={containerRef}
        className={styles.scrollParent}
        onScroll={onScroll}
        tabIndex={0}
        style={{ position: 'relative', overflowY: 'auto', outline: 'none' }}
      >
        <div style={{ minHeight: `${rowHeight}px`, height: 'auto', width: '100%', position: 'relative' }}>
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
                    key={`collapse-${item.startIndex}`}
                    className={styles.collapseBar}
                    onClick={() => onExpandBlock(f.filePath, item.startIndex)}
                    style={{ height: `${rowHeight}px`, minHeight: `${rowHeight}px`, maxHeight: `${rowHeight}px`, display: 'flex', alignItems: 'center' }}
                  >
                    <Lucide.Maximize2 size={12} className={styles.collapseIcon} />
                    <span>展开其余 {item.count} 行代码...</span>
                  </div>
                );
              }

              const { left, right } = item.pair;

              let leftClass = '';
              let leftMarker = ' ';
              let leftText = '';
              let leftNum = '';
              if (left) {
                if (left.change.type === 'deletion') {
                  leftClass = styles.lineDeletion ?? '';
                  leftMarker = '−';
                }
                leftText = left.change.content;
                leftNum = String(left.oldLine ?? '');
              }

              let rightClass = '';
              let rightMarker = ' ';
              let rightText = '';
              let rightNum = '';
              if (right) {
                if (right.change.type === 'addition') {
                  rightClass = styles.lineAddition ?? '';
                  rightMarker = '+';
                }
                rightText = right.change.content;
                rightNum = String(right.newLine ?? '');
              }

              return (
                <div
                  key={idx}
                  className={styles.splitLine}
                  style={{ minHeight: `${rowHeight}px` }}
                >
                  <div className={`${styles.splitColumn} ${leftClass}`} style={{ padding: 0 }}>
                    <div className={styles.gutterNum} data-num={leftNum}>
                      {leftNum}
                    </div>
                    <div className={styles.gutterMarker}>{leftMarker}</div>
                    <div className={styles.lineText} dangerouslySetInnerHTML={{ __html: highlightCode(leftText, 'diff') }} />
                  </div>
                  <div className={`${styles.splitColumn} ${rightClass}`} style={{ padding: 0 }}>
                    <div className={styles.gutterNum} data-num={rightNum}>
                      {rightNum}
                    </div>
                    <div className={styles.gutterMarker}>{rightMarker}</div>
                    <div className={styles.lineText} dangerouslySetInnerHTML={{ __html: highlightCode(rightText, 'diff') }} />
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
