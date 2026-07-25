import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import DOMPurify from 'dompurify';
import { AlertCircle } from 'lucide-react';
import styles from '../ChatMessageRow.module.css';
import { stripThoughtPlaceholders } from '../../api/markdownRenderLite';
import { parseMarkdownToHtmlAsync } from '../../api/markdownRenderAsync';
import { getMarkdownHtmlCache } from '../../api/markdownCache';
import type { IncrementalMarkdownBridge } from '../../api/incrementalMarkdownBridge';
import { chunkUpdatesToDomPatches, applyDomPatches } from '../../api/domPatch';
import { Priority } from '../../workers';
import { extractImageRefs } from '../../api/toolPresentation';
import { buildPretextFontForUiSize } from '../../utils/pretextFontBridge';
import { useBubbleShrinkWidth, usePreparedText } from '../../hooks/useTextMeasure';
import { MessageImages } from './MessageImages';

function useAsyncMarkdownHtml(
  markdown: string,
  priority: Priority,
): { html: string; loading: boolean } {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!markdown) {
      setHtml('');
      setLoading(false);
      return;
    }
    const cached = getMarkdownHtmlCache(markdown);
    if (cached !== undefined) {
      setHtml(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    cancelledRef.current = false;
    parseMarkdownToHtmlAsync(markdown, priority)
      .then((result) => {
        if (!cancelledRef.current) { setHtml(result); setLoading(false); }
      })
      .catch(() => {
        if (!cancelledRef.current) setLoading(false);
      });
    return () => { cancelledRef.current = true; };
  }, [markdown, priority]);

  return { html, loading };
}

interface AsyncMarkdownBlockProps {
  text: string;
  priority: Priority;
}

const AsyncMarkdownBlock: React.FC<AsyncMarkdownBlockProps> = ({ text, priority }) => {
  const { html, loading } = useAsyncMarkdownHtml(text, priority);
  const skeletonRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<IncrementalMarkdownBridge | null>(null);
  const initializedRef = useRef(false);
  const font = useMemo(() => buildPretextFontForUiSize('medium', 'sans', 'normal'), []);
  const { measureHeight } = usePreparedText({ text, font });
  const [skeletonMinH, setSkeletonMinH] = useState<number | undefined>(undefined);

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
    if (!initializedRef.current) {
      initializedRef.current = true;
      requestIdleCallback(() => {
        if (!containerRef.current) return;
        containerRef.current.innerHTML = DOMPurify.sanitize(html);
      }, { timeout: 100 });
      return;
    }
    let cancelled = false;
    void import('../../api/incrementalMarkdownBridge').then(
      async ({ IncrementalMarkdownBridge }) => {
        if (cancelled || !containerRef.current) return;
        const bridge = bridgeRef.current ?? (bridgeRef.current = new IncrementalMarkdownBridge());
        const result = await bridge.push(text);
        if (result.updates.length > 0) {
          requestIdleCallback(() => {
            if (cancelled || !containerRef.current) return;
            const patches = chunkUpdatesToDomPatches(containerRef.current, result.updates, false);
            applyDomPatches(containerRef.current, patches);
          }, { timeout: 200 });
        }
      },
    );
    return () => { cancelled = true; };
  }, [html, loading, text]);

  if (!text) return null;
  if (loading) {
    return (
      <div
        ref={skeletonRef}
        className={styles.assistantText}
        style={{ whiteSpace: 'pre-wrap', minHeight: skeletonMinH }}
      >
        {text}
      </div>
    );
  }
  return <div ref={containerRef} className={`${styles.assistantText} md-rendered`} />;
};

const MemoizedAsyncMarkdownBlock = React.memo(AsyncMarkdownBlock);

interface TimelineTextItem {
  key: string;
  content: string;
  items?: { id: string; name?: string; status?: string; output?: string }[];
  kind: 'text' | 'tool';
}

interface MessageContentProps {
  timeline: TimelineTextItem[];
  isThinkingMsg: boolean;
  msgStatus: string;
  msgId: string;
  assistantBodyStyle?: React.CSSProperties;
  renderDegraded?: boolean;
}

export const MessageContent: React.FC<MessageContentProps> = React.memo(({
  timeline,
  isThinkingMsg,
  msgStatus,
  msgId,
  assistantBodyStyle,
  renderDegraded,
}) => {
  return (
    <div className={styles.assistantBody} style={assistantBodyStyle}>
      {renderDegraded && (
        <div style={{
          fontSize: 'var(--font-size-xxs)',
          color: 'var(--text-tertiary)',
          padding: '2px 0 4px',
          lineHeight: 1.4,
        }}>
          加速中…
        </div>
      )}
      {(() => {
        try {
          if (!timeline.length) {
            const fallback = stripThoughtPlaceholders('');
            if (!fallback.trim()) return null;
            if (isThinkingMsg) {
              return (
                <div className={styles.timelineText}>
                  <div className={`${styles.assistantText} ${styles.isStreaming}`} style={{ whiteSpace: 'pre-wrap' }}>
                    {fallback}
                  </div>
                </div>
              );
            }
            return (
              <div className={styles.timelineText}>
                <MemoizedAsyncMarkdownBlock text={fallback} priority={msgStatus === 'processing' ? Priority.Normal : Priority.High} />
              </div>
            );
          }

          const textItems = timeline.filter((i) => i.kind === 'text');
          const lastTextKey = textItems.length ? textItems[textItems.length - 1].key : null;

          return timeline.map((item) => {
            if (item.kind === 'text') {
              const bodyText = stripThoughtPlaceholders(item.content || '');
              if (!bodyText.trim()) return null;
              const imgs = extractImageRefs(bodyText);
              const streaming = isThinkingMsg && item.key === lastTextKey;
              if (streaming) {
                return (
                  <div key={item.key} className={styles.timelineText}>
                    <div className={`${styles.assistantText} ${styles.isStreaming}`} style={{ whiteSpace: 'pre-wrap' }}>
                      {bodyText}
                    </div>
                  </div>
                );
              }
              return (
                <div key={item.key} className={styles.timelineText}>
                  <MemoizedAsyncMarkdownBlock text={bodyText} priority={msgStatus === 'processing' ? Priority.Normal : Priority.High} />
                  <MessageImages sources={imgs} />
                </div>
              );
            }
            return null;
          });
        } catch {
          return null;
        }
      })()}
    </div>
  );
});

MessageContent.displayName = 'MessageContent';
