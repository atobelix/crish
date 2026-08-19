/**
 * 思考预览行：默认 48–64 字 + fade；展开才挂全文。
 * live 计时 ≤ 1Hz；查阅器仍走 thoughtInspector。
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Maximize2 } from 'lucide-react';
import { Tooltip } from '../../components/ui/Tooltip/Tooltip';
import { openThoughtInspector } from '../../store/thoughtInspectorStore';
import { TOOL_OUTPUT_PIXEL_CAP } from '../../workers';
import { clipThinkingPreview } from './narrativeModel';
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
  messageId,
  turnIndex,
  defaultOpen = false,
}: ThinkingBlockProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const [liveSec, setLiveSec] = useState(0);
  const shownPreview = preview?.trim() || clipThinkingPreview(content);

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

  const outputMax = {
    ['--flow-output-max' as string]: `${TOOL_OUTPUT_PIXEL_CAP}px`,
    maxHeight: TOOL_OUTPUT_PIXEL_CAP,
  };

  return (
    <div
      className={styles.thinking}
      data-flow-thinking=""
      data-live={isLive ? 'true' : undefined}
      data-flow-expanded={open ? 'true' : 'false'}
    >
      <div className={styles.actionHeadRow}>
        <button
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
        </button>
        <Tooltip content="在查阅器中查看完整思维链">
          <button
            type="button"
            className={styles.inspectorBtn}
            aria-label="查看完整思考链"
            onClick={(e) => {
              e.stopPropagation();
              openThoughtInspector({
                messageId: messageId || '',
                content,
                turnIndex,
                durationSec: durationMs ? durationMs / 1000 : undefined,
              });
            }}
          >
            <Maximize2 size={12} />
          </button>
        </Tooltip>
      </div>
      {open ? (
        <div
          className={styles.thinkingFull}
          style={outputMax}
          data-flow-thinking-full=""
        >
          {content}
        </div>
      ) : (
        <div className={styles.previewWrap} data-flow-thinking-preview="">
          <span className={styles.previewText}>{shownPreview}</span>
          <span className={styles.previewFade} aria-hidden />
        </div>
      )}
    </div>
  );
}
