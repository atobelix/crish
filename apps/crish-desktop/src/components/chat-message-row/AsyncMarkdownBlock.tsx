import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import styles from '../ChatMessageRow.module.css';
import { useAsyncMarkdownHtml } from '../../api/markdownRenderAsync';
import type { IncrementalMarkdownBridge } from '../../api/incrementalMarkdownBridge';
import { chunkUpdatesToDomPatches, applyDomPatches } from '../../api/domPatch';
import { Priority } from '../../workers';
import { escapeHtml } from '../../api/markdownRenderLite';
import { usePreparedText } from '../../hooks/useTextMeasure';
import { buildPretextFontForUiSize } from '../../utils/pretextFontBridge';

export interface AsyncMarkdownBlockProps {
  text: string;
  priority: Priority;
}

export function AsyncMarkdownBlock({ text, priority }: AsyncMarkdownBlockProps) {
  const { html, loading } = useAsyncMarkdownHtml(text, priority);
  const skeletonRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<IncrementalMarkdownBridge | null>(null);
  const initializedRef = useRef(false);
  const font = useMemo(
    () => buildPretextFontForUiSize('medium', 'sans', 'normal'),
    []
  );
  const { measureHeight } = usePreparedText({ text, font });
  const [skeletonMinH, setSkeletonMinH] = useState<number | undefined>(
    undefined
  );

  useLayoutEffect(() => {
    if (!loading || !skeletonRef.current || !text) {
      setSkeletonMinH(undefined);
      return;
    }
    const parentW = skeletonRef.current.parentElement?.clientWidth ?? 0;
    const fontSize = parseFloat(font.match(/([\d.]+)px/)?.[0] ?? '14');
    const lineHeightPx = fontSize * 1.65;
    const h = measureHeight(Math.max(1, parentW), lineHeightPx);
    setSkeletonMinH(h > 0 ? Math.ceil(h * 1.15) : undefined);
  }, [loading, measureHeight, font, text]);

  useLayoutEffect(() => {
    if (!containerRef.current || loading || !html) return;
    let cancelled = false;

    void import('../../api/incrementalMarkdownBridge').then(
      ({ IncrementalMarkdownBridge }) => {
        if (cancelled || !containerRef.current) return;
        const bridge =
          bridgeRef.current ??
          (bridgeRef.current = new IncrementalMarkdownBridge());
        const result = bridge.push(text);

        if (!initializedRef.current) {
          initializedRef.current = true;
          const wrappedHtml = result.updates
            .map((u) => `<span data-chunk-id="${u.id}">${u.html}</span>`)
            .join('');
          containerRef.current.innerHTML = wrappedHtml;
        } else if (result.updates.length > 0) {
          const patches = chunkUpdatesToDomPatches(
            containerRef.current,
            result.updates,
            false
          );
          applyDomPatches(containerRef.current, patches);
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [html, loading, text]);

  if (!text) return null;
  if (loading) {
    return (
      <div
        ref={skeletonRef}
        className={styles.assistantText}
        style={{ whiteSpace: 'pre-wrap', minHeight: skeletonMinH }}
      >
        {escapeHtml(text)}
      </div>
    );
  }
  return (
    <div ref={containerRef} className={`${styles.assistantText} md-rendered`} />
  );
}
