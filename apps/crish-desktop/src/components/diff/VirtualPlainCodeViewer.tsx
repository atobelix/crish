import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import { highlightCode, langFromFilename } from '../../api/codeHighlight';
import styles from './DiffCard.module.css';

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

interface VirtualPlainCodeViewerProps {
  content: string;
  filePath: string;
}

const FALLBACK_ROW_HEIGHT = 22;

export const VirtualPlainCodeViewer: React.FC<VirtualPlainCodeViewerProps> = React.memo(({ content, filePath }) => {
  const lines = useMemo(() => content.split('\n').map((line, idx) => ({
    num: idx + 1,
    content: line,
  })), [content]);

  const totalLines = lines.length;
  const { containerRef, scrollTop, containerHeight, onScroll } = useVirtualScroll({
    itemCount: totalLines,
    heightOnly: true,
  });

  const [rowHeight, setRowHeight] = useState(FALLBACK_ROW_HEIGHT);
  const firstLineRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = firstLineRef.current;
    if (!el) return;
    const measured = el.offsetHeight;
    if (measured > 0 && measured !== rowHeight) {
      setRowHeight(measured);
    }
  }, [content, rowHeight]);

  const totalHeight = totalLines * rowHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 15);
  const endIndex = Math.min(totalLines, Math.ceil((scrollTop + containerHeight) / rowHeight) + 15);
  const visibleLines = lines.slice(startIndex, endIndex);
  const offsetTop = startIndex * rowHeight;

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
        outline: 'none',
        width: '100%',
        height: '100%',
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--diff-bg-pane, #ffffff)',
      }}
    >
      <div style={{ height: `${totalHeight}px`, width: '100%', position: 'relative', flex: 1 }}>
        <pre
          className={styles.linesContainer}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
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
              style={{ minHeight: `${rowHeight}px`, gridTemplateColumns: '40px 1fr' }}
            >
              <div
                className={styles.gutterNum}
                data-num={l.num}
                style={{ width: '40px', minWidth: '40px', textAlign: 'right', paddingRight: '8px', boxSizing: 'border-box' }}
              >
                {l.num}
              </div>
              <div
                className={styles.lineText}
                style={{ whiteSpace: 'pre', overflowX: 'auto', minWidth: 0 }}
                dangerouslySetInnerHTML={{ __html: highlightCode(l.content, codeLang) }}
              />
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
});
