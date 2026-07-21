import React from 'react';
import * as Lucide from 'lucide-react';
import DOMPurify from 'dompurify';
import styles from './DiffCard.module.css';
import { AppErrorBoundary } from './AppErrorBoundary';
import { useVirtualDiffScroll } from '../hooks/useVirtualDiffScroll';
import type { FileDiff } from '../store/types';
import type { ChangeRenderItem, PlaceholderRenderItem, ComputedChange } from './diffCardTypes';
import { highlightCode } from '../api/codeHighlight';

type UnifiedRenderItem = PlaceholderRenderItem | ChangeRenderItem;

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
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
  const { containerRef, scrollTop, containerHeight, onScroll } = useVirtualDiffScroll();

  const totalItems = renderItems.length;
  const rowHeight = 22;
  const totalHeight = totalItems * rowHeight;

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
        <div style={{ height: `${totalHeight}px`, width: '100%', position: 'relative' }}>
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
              const { change, oldLine, newLine, isHeader } = item.item;
              if (isHeader) return null;

              let lineClass = styles.lineNormal;
              let marker = ' ';
              if (change.type === 'addition') {
                lineClass = styles.lineAddition;
                marker = '+';
              } else if (change.type === 'deletion') {
                lineClass = styles.lineDeletion;
                marker = '−';
              }

              const oldLineNum = oldLine !== undefined ? String(oldLine) : '';
              const newLineNum = newLine !== undefined ? String(newLine) : '';

              return (
                <div
                  key={idx}
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
                  <div className={styles.lineText} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(highlightCode(change.content, 'diff')) }} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </AppErrorBoundary>
  );
};
