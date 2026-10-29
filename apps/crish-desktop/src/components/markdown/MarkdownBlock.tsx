/**
 * 通用静态 Markdown 块：文本 → 调度器/缓存 → MarkdownSurface。
 *
 * 用于文档 chunk、历史消息、推理摘要等非流式场景。加载中/失败时显示
 * 去语法的纯文本兜底，绝不让消息区域变成空白。
 */
import React, { useMemo } from 'react';
import type { MarkdownVariant } from '../../api/rustCore';
import { useMarkdownResult } from '../../api/markdown/useMarkdownRender';
import { toMarkdownPlainTextFallback } from '../../api/markdown/markdownPlainTextFallback';
import { MarkdownSurface } from './MarkdownSurface';

export interface MarkdownBlockProps {
  text: string;
  variant?: MarkdownVariant;
  className?: string;
  as?: 'div' | 'span';
  style?: React.CSSProperties;
  dataAttributes?: Record<string, string | undefined>;
  enabled?: boolean;
}

export const MarkdownBlock = React.memo(function MarkdownBlock({
  text,
  variant = 'chat',
  className,
  as = 'div',
  style,
  dataAttributes,
  enabled = true,
}: MarkdownBlockProps): React.ReactElement | null {
  const { html, truncated, loading, failed } = useMarkdownResult(
    text,
    variant,
    enabled
  );
  const fallbackText = useMemo(() => toMarkdownPlainTextFallback(text), [text]);

  if (!text) return null;

  const attrs: Record<string, string | undefined> = {
    ...dataAttributes,
    'data-md-pending': loading && !html ? 'true' : undefined,
    'data-md-failed': failed && !html ? 'true' : undefined,
    'data-md-truncated': truncated ? 'true' : undefined,
  };

  if (!html) {
    const Tag = as;
    return React.createElement(
      Tag,
      {
        className: ['markdown-fallback-text', className]
          .filter(Boolean)
          .join(' '),
        style,
        ...attrs,
      },
      fallbackText
    );
  }

  return (
    <MarkdownSurface
      html={html}
      variant={variant}
      className={className}
      as={as}
      style={style}
      dataAttributes={attrs}
    />
  );
}, areMarkdownBlockPropsEqual);

function areMarkdownBlockPropsEqual(
  prev: MarkdownBlockProps,
  next: MarkdownBlockProps
): boolean {
  return (
    prev.text === next.text &&
    prev.variant === next.variant &&
    prev.className === next.className &&
    prev.as === next.as &&
    prev.style === next.style &&
    prev.enabled === next.enabled &&
    prev.dataAttributes === next.dataAttributes
  );
}
