/**
 * 文档 Markdown 窗口化列表。
 *
 * 只复用 `@crish/editor-kit` 的通用测量原语（HeightMap + queryViewport），
 * 不接入块编辑器的 store/权威层。块 HTML 仍由 Rust 渲染。
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { HeightMap, queryViewport } from '@crish/editor-kit';
import { ResizeObserverManager } from '../../utils/ResizeObserverManager';
import type { ResizeCallback } from '../../utils/ResizeObserverManager';
import type { MarkdownVariant } from '../../api/rustCore';
import type { MarkdownChunk } from '../../api/markdown/markdownChunker';
import { MarkdownBlock } from './MarkdownBlock';

export interface VirtualMarkdownBlockListProps {
  chunks: MarkdownChunk[];
  variant?: MarkdownVariant;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  overscan?: number;
}

const DEFAULT_VIEWPORT_HEIGHT = 800;

function estimateChunkHeight(text: string): number {
  return Math.max(80, Math.min(2400, Math.round(text.length * 0.55)));
}

export function VirtualMarkdownBlockList({
  chunks,
  variant = 'document',
  viewportRef,
  overscan = 4,
}: VirtualMarkdownBlockListProps): React.ReactElement | null {
  const heightMapRef = useRef<HeightMap | null>(null);
  const [, setRevision] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const observersRef = useRef<
    Map<number, { node: HTMLElement; callback: ResizeCallback }>
  >(new Map());

  const chunkSignature = useMemo(
    () => chunks.map((chunk) => chunk.id).join('|'),
    [chunks]
  );

  useEffect(() => {
    const map = new HeightMap(chunks.length);
    chunks.forEach((chunk, index) => {
      map.setEstimate(index, estimateChunkHeight(chunk.text));
    });
    heightMapRef.current = map;
    setRevision((revision) => revision + 1);
  }, [chunkSignature, chunks]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const updateScroll = () => setScrollTop(element.scrollTop);
    const updateHeight = () => setViewportHeight(element.clientHeight);
    updateScroll();
    updateHeight();

    element.addEventListener('scroll', updateScroll, { passive: true });
    // 复用 ResizeObserverManager 单例（G-03：与布局动画冻结状态机共用同一 RO 实例）
    const roManager = ResizeObserverManager.getInstance();
    if (typeof ResizeObserver !== 'undefined') {
      roManager.observe(element, updateHeight);
    }
    return () => {
      element.removeEventListener('scroll', updateScroll);
      if (typeof ResizeObserver !== 'undefined') {
        roManager.unobserve(element, updateHeight);
      }
    };
  }, [viewportRef, chunkSignature]);

  const measureChunk = useCallback((index: number, height: number) => {
    if (height <= 0) return;
    if (heightMapRef.current?.measure(index, height)) {
      setRevision((revision) => revision + 1);
    }
  }, []);

  const measureCallbacks = useMemo(
    () =>
      chunks.map((_, index) => (node: HTMLElement | null) => {
        const roManager = ResizeObserverManager.getInstance();
        const previous = observersRef.current.get(index);
        if (previous) {
          roManager.unobserve(previous.node, previous.callback);
          observersRef.current.delete(index);
        }
        if (!node) return;

        if (typeof ResizeObserver === 'undefined') {
          measureChunk(index, node.offsetHeight);
          return;
        }
        const onResize: ResizeCallback = () => {
          measureChunk(index, node.getBoundingClientRect().height);
        };
        roManager.observe(node, onResize);
        observersRef.current.set(index, { node, callback: onResize });
        measureChunk(index, node.getBoundingClientRect().height);
      }),
    [chunks, measureChunk]
  );

  useEffect(
    () => () => {
      const roManager = ResizeObserverManager.getInstance();
      observersRef.current.forEach(({ node, callback }) => {
        roManager.unobserve(node, callback);
      });
      observersRef.current.clear();
    },
    [chunkSignature]
  );

  const map = heightMapRef.current;
  if (!map || chunks.length === 0) return null;

  const effectiveHeight = viewportHeight || DEFAULT_VIEWPORT_HEIGHT;
  const startIndex = map.indexAt(scrollTop);
  const endIndex = map.indexAt(scrollTop + effectiveHeight) + 1;
  const window = queryViewport({
    totalCount: chunks.length,
    window: { startIndex, endIndex },
    overscan,
  });

  return (
    <div
      className="md-virtual-list"
      style={{ height: map.totalHeight(), position: 'relative' }}
    >
      {window.indices.map((index) => {
        const chunk = chunks[index];
        if (!chunk) return null;
        return (
          <div
            key={chunk.id}
            ref={measureCallbacks[index]}
            className="md-virtual-chunk"
            data-md-chunk-index={index}
            style={{
              position: 'absolute',
              top: map.offsetOf(index),
              left: 0,
              right: 0,
            }}
          >
            <MarkdownBlock
              text={chunk.text}
              variant={variant}
              dataAttributes={{ 'data-md-chunk-index': String(index) }}
            />
          </div>
        );
      })}
    </div>
  );
}
