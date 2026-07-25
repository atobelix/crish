import React, { useMemo } from 'react';
import { useVirtualDiffScroll } from '../../hooks/useVirtualDiffScroll';
import styles from '../DiffCard.module.css';

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

interface VirtualPlainCodeViewerProps {
  content: string;
  filePath: string;
}

export const VirtualPlainCodeViewer: React.FC<VirtualPlainCodeViewerProps> = React.memo(({ content, filePath }) => {
  const { containerRef, scrollTop, containerHeight, onScroll } = useVirtualDiffScroll();
  const lines = useMemo(() => content.split('\n').map((line, idx) => ({
    num: idx + 1,
    content: line,
  })), [content]);

  const totalLines = lines.length;
  const rowHeight = 20;
  const totalHeight = totalLines * rowHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 15);
  const endIndex = Math.min(totalLines, Math.ceil((scrollTop + containerHeight) / rowHeight) + 15);
  const visibleLines = lines.slice(startIndex, endIndex);
  const offsetTop = startIndex * rowHeight;

  return (
    <div ref={containerRef} className={styles.scrollParent} onScroll={onScroll} tabIndex={0}
      style={{ position: 'relative', overflowY: 'auto', outline: 'none' }}>
      <div style={{ height: `${totalHeight}px`, width: '100%', position: 'relative' }}>
        <pre className={styles.linesContainer}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${offsetTop}px)`, margin: 0, background: 'transparent' }}
          aria-label={`${basename(filePath)} 的源码`}>
          {visibleLines.map((l) => (
            <div key={l.num} className={styles.line} style={{ minHeight: `${rowHeight}px` }}>
              <div className={styles.gutterNum} data-num={l.num}>{l.num}</div>
              <div className={styles.gutterMarker}> </div>
              <div className={styles.lineText} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{l.content}</div>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
});
