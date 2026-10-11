/**
 * 思考预览行：默认 48–64 字 + fade；展开才挂全文。
 * live 计时 ≤ 1Hz；查阅器仍走 thoughtInspector。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Button } from '../../components/ui';
import {
  useAsyncMarkdownHtml,
  useStreamingMarkdownHtml,
} from '../../api/markdownRenderAsync';
import { Priority } from '../../workers';
import { FLOW_OUTPUT_STYLE } from './flowOutputStyle';
import { clipThinkingPreview } from './narrativeModel';
import { ReconciledMarkdownHtml } from '../../components/markdown/ReconciledMarkdownHtml';
import type { IncrementalMarkdownUnitSnapshot } from '../../api/markdown/IncrementalMarkdownSession';
import styles from './narrative.module.css';

export interface ThinkingBlockProps {
  content: string;
  preview?: string;
  isLive?: boolean;
  durationMs?: number;
  messageId?: string;
  turnIndex?: number;
  defaultOpen?: boolean;
}

export function ThinkingBlock({
  content,
  preview,
  isLive = false,
  durationMs,
  defaultOpen = false,
}: ThinkingBlockProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const [liveSec, setLiveSec] = useState(0);
  const shownPreview = preview?.trim() || clipThinkingPreview(content);
  const previewRender = useAsyncMarkdownHtml(
    !isLive && !open ? shownPreview : '',
    Priority.Low
  );
  const previewUnitsRef = useRef<readonly IncrementalMarkdownUnitSnapshot[] | null>(null);
  const fullUnitsRef = useRef<readonly IncrementalMarkdownUnitSnapshot[] | null>(null);
  const livePreviewHtml = useStreamingMarkdownHtml(
    shownPreview,
    isLive && !open,
    Priority.Low,
    previewUnitsRef
  );
  const fullRender = useAsyncMarkdownHtml(
    !isLive && open ? content : '',
    Priority.Low
  );
  const liveFullHtml = useStreamingMarkdownHtml(
    content,
    isLive && open,
    Priority.Low,
    fullUnitsRef
  );
  const previewHtml = isLive ? livePreviewHtml : previewRender.html;
  const fullHtml = isLive ? liveFullHtml : fullRender.html;

  useEffect(() => {
    if (!isLive) {
      setLiveSec(0);
      return;
    }
    const started = Date.now();
    const id = window.setInterval(() => {
      setLiveSec(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [isLive]);

  const durationLabel =
    isLive && liveSec > 0
      ? `${liveSec}s`
      : durationMs != null && durationMs > 0
        ? `${(durationMs / 1000).toFixed(1)}s`
        : '';

  const outputMax = FLOW_OUTPUT_STYLE;

  return (
    <div
      className={styles.thinking}
      data-flow-thinking=""
      data-live={isLive ? 'true' : undefined}
      data-flow-expanded={open ? 'true' : 'false'}
    >
      <div className={styles.actionHeadRow}>
        <Button
          variant="ghost"
          type="button"
          className={styles.head}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {isLive ? <span className={styles.pulse} aria-hidden /> : null}
          <span className={styles.primary}>
            {isLive ? '正在思考' : '思考过程'}
          </span>
          {durationLabel ? (
            <span className={styles.meta}>{durationLabel}</span>
          ) : null}
        </Button>
      </div>
      {open ? (
          <ReconciledMarkdownHtml
            className={styles.thinkingFull}
            style={outputMax}
            data-flow-thinking-full=""
            html={fullHtml}
            incrementalUnits={isLive && open ? fullUnitsRef.current : undefined}
          />
      ) : (
        <div className={styles.previewWrap} data-flow-thinking-preview="">
          <ReconciledMarkdownHtml
            className={styles.previewText}
            data-flow-thinking-preview-content=""
            html={previewHtml}
            incrementalUnits={isLive && !open ? previewUnitsRef.current : undefined}
          />
          <span className={styles.previewFade} aria-hidden />
        </div>
      )}
    </div>
  );
}
