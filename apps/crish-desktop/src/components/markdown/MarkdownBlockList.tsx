/**
 * 静态 Markdown chunk 列表（文档/历史消息）。
 *
 * chat 的流式活跃块由 StreamingMarkdownView 单独渲染；这里只负责静态块。
 */
import React, { useMemo } from 'react';
import type { MarkdownVariant } from '../../api/rustCore';
import type { MarkdownChunk } from '../../api/markdown/markdownChunker';
import { MarkdownBlock } from './MarkdownBlock';

export interface MarkdownBlockListProps {
  chunks: MarkdownChunk[];
  variant?: MarkdownVariant;
  className?: string;
}

export const MarkdownBlockList = React.memo(function MarkdownBlockList({
  chunks,
  variant = 'document',
  className,
}: MarkdownBlockListProps): React.ReactElement {
  const stableDataAttributes = useMemo(
    () =>
      chunks.map((chunk, index) => ({
        'data-md-chunk-index': String(index),
      })),
    [chunks]
  );

  return (
    <div className={className}>
      {chunks.map((chunk, index) => (
        <MarkdownBlock
          key={chunk.id}
          text={chunk.text}
          variant={variant}
          dataAttributes={stableDataAttributes[index]}
        />
      ))}
    </div>
  );
});
