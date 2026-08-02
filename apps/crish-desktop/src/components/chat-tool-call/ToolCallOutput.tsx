import React, { useState, useMemo, useRef, useLayoutEffect } from 'react';
import styles from './ChatToolCallBlock.module.css';
import type { FileDiff, MessageToolCall } from '../../store/layoutStore';
import {
  extractImageRefs,
  fullToolOutput,
  isShellToolName,
  toolCommandPreview,
} from '../../api/toolPresentation';
import { TOOL_OUTPUT_PIXEL_CAP } from '../../api/messageWindow';
import { usePreparedText } from '../../hooks/useTextMeasure';
import {
  buildPretextFont,
  getResolvedFontSizePx,
} from '../../utils/pretextFontBridge';
import {
  prepareWithSegments,
  walkLineRanges,
  materializeLineRange,
  layout,
} from '@chenglou/pretext';
import type { LayoutLineRange } from '@chenglou/pretext';
import { ToolCallDiffPreview } from './ToolCallDiffPreview';
import { toolStatusZh, TOOL_EMPTY_OUTPUT_ZH } from './chatToolCallUtils';

export interface ToolCallOutputProps {
  tc: {
    id?: string;
    output?: string | undefined;
    diffs?: FileDiff[] | undefined;
    name?: string;
    status?: string;
    arguments?: string;
  };
  bodyId: string;
  onOpenDiff?: ((diff: FileDiff) => void) | undefined;
  onOpenTerminal?: (() => void) | undefined;
}

/**
 * 展开体：默认折叠时整段不挂载；展开后仍做字符预算，
 * 超长需二次「显示全部」，避免单工具输出撑爆 DOM。
 * 空正文 →「（无输出）」中文占位（不复用「完成/失败」伪输出）。
 */
export const ToolCallOutput: React.FC<ToolCallOutputProps> = ({
  tc,
  bodyId,
  onOpenDiff,
  onOpenTerminal,
}) => {
  const [showFullOutput, setShowFullOutput] = useState(false);
  const raw = tc.output || '';
  const images = useMemo(() => extractImageRefs(raw), [raw]);
  const full = useMemo(() => fullToolOutput(raw), [raw]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setContainerWidth(el.clientWidth - 24);
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fontConfig = useMemo(() => {
    const fontSizePx = getResolvedFontSizePx('--font-size-xs');
    const fontStr = buildPretextFont('mono', 'normal', fontSizePx);
    const lineHeightPx = Math.round(fontSizePx * 1.45);
    return { fontStr, lineHeightPx };
  }, []);

  const { prepared } = usePreparedText({
    text: full || '',
    font: fontConfig.fontStr,
    whiteSpace: 'pre-wrap',
  });

  const budget = useMemo(() => {
    if (showFullOutput) {
      return { text: full, truncated: false, originalLength: full.length };
    }
    if (!full || !containerWidth || containerWidth <= 16) {
      return { text: full, truncated: false, originalLength: full.length };
    }
    try {
      const totalHeight = layout(
        prepared!,
        containerWidth,
        fontConfig.lineHeightPx
      ).height;
      if (totalHeight <= TOOL_OUTPUT_PIXEL_CAP) {
        return { text: full, truncated: false, originalLength: full.length };
      }
      const pws = prepareWithSegments(full, fontConfig.fontStr, {
        whiteSpace: 'pre-wrap',
      });
      const lineRanges: LayoutLineRange[] = [];
      walkLineRanges(pws, containerWidth, (line) => {
        lineRanges.push(line);
      });
      let accumulated = 0;
      const parts: string[] = [];
      for (const lr of lineRanges) {
        if (accumulated + fontConfig.lineHeightPx > TOOL_OUTPUT_PIXEL_CAP)
          break;
        parts.push(materializeLineRange(pws, lr).text);
        accumulated += fontConfig.lineHeightPx;
      }
      return {
        text: parts.join('\n') + '\n…（已截断）',
        truncated: true,
        originalLength: full.length,
      };
    } catch {
      return { text: full, truncated: false, originalLength: full.length };
    }
  }, [showFullOutput, full, containerWidth, fontConfig, prepared]);

  const out = budget.text;
  const hasDiffs = Boolean(tc.diffs && tc.diffs.length);
  const shellTool = isShellToolName(tc.name || '');
  const longShell =
    shellTool && (raw.length > 2000 || raw.split('\n').length > 80);
  const statusZh = toolStatusZh(
    tc.status as MessageToolCall['status'] | undefined
  );
  const emptyBody = !full && images.length === 0 && !hasDiffs;
  const cmdLine = useMemo(
    () =>
      shellTool
        ? toolCommandPreview(
            {
              id: tc.id || 'x',
              name: tc.name || 'shell',
              arguments: tc.arguments || '',
              status: (tc.status as MessageToolCall['status']) || 'success',
            },
            200
          )
        : '',
    [shellTool, tc.id, tc.name, tc.arguments, tc.status]
  );

  const truncatedStyle: React.CSSProperties | undefined = budget.truncated
    ? { maxHeight: TOOL_OUTPUT_PIXEL_CAP, overflowY: 'hidden' }
    : undefined;

  return (
    <div
      id={bodyId}
      ref={bodyRef}
      className={styles.toolResultBody}
      role="region"
      aria-label={`${statusZh}的工具输出`}
      data-empty={emptyBody ? 'true' : undefined}
    >
      {cmdLine ? (
        <pre
          className={`${styles.toolResultPre} ${styles.toolResultPreCmd}`}
          aria-label="命令"
        >
          {cmdLine}
        </pre>
      ) : null}
      {emptyBody ? (
        <pre className={styles.toolResultPre} aria-label="无输出">
          {TOOL_EMPTY_OUTPUT_ZH}
        </pre>
      ) : null}
      {!emptyBody && out ? (
        <pre className={styles.toolResultPre} style={truncatedStyle}>
          {out}
        </pre>
      ) : null}
      {budget.truncated ? (
        <div className={styles.toolResultLongHint}>
          <button
            type="button"
            className={styles.toolResultHintBtn}
            onClick={(e) => {
              e.stopPropagation();
              setShowFullOutput(true);
            }}
          >
            显示全部输出（{budget.originalLength.toLocaleString()} 字符）
          </button>
        </div>
      ) : null}
      {longShell ? (
        <div className={styles.toolResultLongHint}>
          <button
            type="button"
            className={styles.toolResultHintBtn}
            onClick={(e) => {
              e.stopPropagation();
              onOpenTerminal?.();
            }}
          >
            在终端查看
          </button>
        </div>
      ) : null}
      {images.length > 0 && (
        <div className={styles.toolResultImages}>
          {images.map((src, i) => (
            <img
              key={src}
              src={src}
              alt={`工具输出图片 ${i + 1}`}
              className={styles.toolResultImg}
              loading="lazy"
            />
          ))}
        </div>
      )}
      {tc.diffs?.map((d) => (
        <ToolCallDiffPreview key={d.filePath} diff={d} onOpenDiff={onOpenDiff} />
      ))}
    </div>
  );
};
