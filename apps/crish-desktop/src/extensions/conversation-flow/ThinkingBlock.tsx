/**
 * 思考预览行：默认 48–64 字 + fade；展开才挂全文。
 * live 计时 ≤ 1Hz；查阅器仍走 thoughtInspector。
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui';
import { FLOW_OUTPUT_STYLE } from './flowOutputStyle';
import { clipThinkingPreview } from './narrativeModel';
import { MarkdownSurface } from '../../components/markdown/MarkdownSurface';
import {
  useMarkdownResult,
  useStreamingMarkdownResult,
} from '../../api/markdown/useMarkdownRender';
import { handleMarkdownEvent } from '../../components/markdown/markdownInteractions';
import { useI18n } from '../../i18n';
import styles from './narrative.module.css';

export interface ThinkingBlockProps {
  content: string;
  preview?: string;
  isLive?: boolean;
  durationMs?: number;
  messageId?: string;
  turnIndex?: number;
  defaultOpen?: boolean;
  onLinkClick?: (href: string) => void;
}

export function ThinkingBlock({
  content,
  preview,
  isLive = false,
  durationMs,
  defaultOpen = false,
  onLinkClick,
}: ThinkingBlockProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const [liveSec, setLiveSec] = useState(0);
  const { t } = useI18n();
  const shownPreview = preview?.trim() || clipThinkingPreview(content);

  const previewResult = useMarkdownResult(
    shownPreview,
    'chat',
    !isLive && !open
  );
  const livePreview = useStreamingMarkdownResult(
    shownPreview,
    'chat',
    isLive && !open
  );
  const fullResult = useMarkdownResult(content, 'chat', !isLive && open);
  const liveFull = useStreamingMarkdownResult(content, 'chat', isLive && open);

  const previewHtml = isLive ? livePreview.html : previewResult.html;
  const fullHtml = isLive ? liveFull.html : fullResult.html;

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

  const handleContentClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;

      if (onLinkClick) {
        const anchor = target.closest('a');
        if (anchor instanceof HTMLAnchorElement) {
          const href = anchor.getAttribute('href');
          if (href) {
            e.preventDefault();
            e.stopPropagation();
            onLinkClick(href);
            return;
          }
        }
      }
      handleMarkdownEvent(e, { t });
    },
    [onLinkClick, t]
  );

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
        <MarkdownSurface
          className={styles.thinkingFull}
          variant="chat"
          isActive={isLive && open}
          style={outputMax}
          html={fullHtml}
          onClick={handleContentClick}
          dataAttributes={{ 'data-flow-thinking-full': '' }}
        />
      ) : (
        <div className={styles.previewWrap} data-flow-thinking-preview="">
          <MarkdownSurface
            className={styles.previewText}
            variant="chat"
            isActive={isLive && !open}
            html={previewHtml}
            onClick={handleContentClick}
            dataAttributes={{ 'data-flow-thinking-preview-content': '' }}
          />
          <span className={styles.previewFade} aria-hidden />
        </div>
      )}
    </div>
  );
}
