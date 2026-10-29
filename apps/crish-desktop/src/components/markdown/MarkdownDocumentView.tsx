/**
 * 文档 Markdown 视图：块切分 + 批量 Rust 渲染 + 可选窗口化。
 *
 * 旧的 256KB 纯文本熔断已删除；大文档通过 VirtualMarkdownBlockList
 * 只挂载视口附近 chunk，仍是完整富文本。
 */
import React, { useCallback, useMemo, useRef } from 'react';
import { ScrollArea } from '@/components/ui';
import { Priority } from '../../workers';
import { useI18n } from '../../i18n';
import { useToast } from '../../services/toast';
import { chunkMarkdown } from '../../api/markdown/markdownChunker';
import { MarkdownBlockList } from './MarkdownBlockList';
import { VirtualMarkdownBlockList } from './VirtualMarkdownBlockList';
import { handleMarkdownEvent } from './markdownInteractions';

const VIRTUALIZE_THRESHOLD_CHARS = 128 * 1024;

export interface MarkdownDocumentViewProps {
  content?: string;
  filePath?: string;
  variant?: 'document' | 'chat';
  className?: string;
  priority?: Priority;
  wordWrap?: boolean;
  onOpenPath?: (path: string) => void;
  emptyPlaceholder?: string;
  onCopyFeedback?: (status: 'success' | 'error', text?: string) => void;
  scrollable?: boolean;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  footerSlot?: React.ReactNode;
}

export const MarkdownDocumentView: React.FC<MarkdownDocumentViewProps> =
  React.memo(
    function MarkdownDocumentView({
      content,
      filePath,
      variant = 'document',
      className = '',
      wordWrap = true,
      onOpenPath,
      emptyPlaceholder,
      onCopyFeedback,
      scrollable = variant === 'document',
      onScroll,
      footerSlot,
    }: MarkdownDocumentViewProps) {
      const viewportRef = useRef<HTMLDivElement | null>(null);
      const { t } = useI18n();
      const toast = useToast();

      const chunks = useMemo(() => chunkMarkdown(content ?? ''), [content]);
      const shouldVirtualize =
        (content?.length ?? 0) > VIRTUALIZE_THRESHOLD_CHARS;

      const handleClick = useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
          handleMarkdownEvent(event, {
            t,
            ...(onOpenPath
              ? { onOpenPath: (path: string) => onOpenPath(path) }
              : {}),
            ...(onCopyFeedback
              ? {
                  onCopyFeedback: (kind: 'success' | 'error', text?: string) =>
                    onCopyFeedback(kind, text),
                }
              : {}),
            onBlockedPath: () =>
              toast.error(t('common.markdownBlockedExecutable')),
          });
        },
        [t, onOpenPath, onCopyFeedback, toast]
      );

      if (!content || !content.trim()) {
        return (
          <div
            className={`md-document-root md-document-empty ${className}`.trim()}
            data-md-variant={variant}
          >
            {emptyPlaceholder ?? null}
          </div>
        );
      }

      const contentNode = (
        <div
          className={`md-document-root ${className}`.trim()}
          data-md-variant={variant}
          data-file-path={filePath || undefined}
          data-code-wrap={wordWrap ? 'true' : 'false'}
          onClick={handleClick}
          style={
            {
              tabSize: 'var(--md-code-tab-size, 2)',
              MozTabSize: 'var(--md-code-tab-size, 2)',
            } as React.CSSProperties
          }
        >
          {shouldVirtualize ? (
            <VirtualMarkdownBlockList
              chunks={chunks}
              variant={variant}
              viewportRef={viewportRef}
            />
          ) : (
            <MarkdownBlockList chunks={chunks} variant={variant} />
          )}
        </div>
      );

      if (scrollable) {
        return (
          <ScrollArea
            size="sm"
            type="auto"
            orientation="both"
            viewportRef={viewportRef}
            onScroll={onScroll}
            className="md-document-scroll-root"
            style={{ width: '100%', height: '100%', flex: 1, minHeight: 0 }}
            contentStyle={{
              minHeight: '100%',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {contentNode}
            {footerSlot ? (
              <div
                className="md-document-footer"
                style={{
                  padding: '0 var(--space-3, 12px) var(--space-3, 12px)',
                }}
              >
                {footerSlot}
              </div>
            ) : null}
          </ScrollArea>
        );
      }

      return (
        <>
          {contentNode}
          {footerSlot}
        </>
      );
    },
    (prev, next) =>
      prev.content === next.content &&
      prev.filePath === next.filePath &&
      prev.variant === next.variant &&
      prev.className === next.className &&
      prev.priority === next.priority &&
      prev.wordWrap === next.wordWrap &&
      prev.onOpenPath === next.onOpenPath &&
      prev.emptyPlaceholder === next.emptyPlaceholder &&
      prev.onCopyFeedback === next.onCopyFeedback &&
      prev.scrollable === next.scrollable &&
      prev.onScroll === next.onScroll &&
      prev.footerSlot === next.footerSlot
  );

MarkdownDocumentView.displayName = 'MarkdownDocumentView';
