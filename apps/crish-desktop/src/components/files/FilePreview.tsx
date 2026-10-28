import React, { useCallback, useRef } from 'react';
import styles from './FilesCard.module.css';
import { Button, Tooltip } from '@/components/ui';
import { MarkdownDocumentView } from '../markdown/MarkdownDocumentView';

import { parseCsvPreview, pathBasename } from '../../api/workspaceFsApi';
import { FileEditor } from './FileEditor';
import { VirtualPlainCodeViewer } from '../diff/VirtualPlainCodeViewer';
import { FileAnnotationPopover } from './FileAnnotationPopover';
import type { ViewMode } from './hooks/useFilePreview';
import { AppIcon } from '@/components/ui/icons';

/** files 叶内预览。禁止挂 document.body 或整屏覆盖层。 */

/** 文件标识与能力域（当前选中文件 + 可编辑性 + markdown 标记）。 */
interface FilePreviewFileProps {
  selected: string | null;
  kind: string;
  isMd: boolean;
  canEdit: boolean;
}

/** 预览内容与加载/编辑态域（视图模式、内容、编辑缓冲、加载/截断/分页、markdown 渲染、资源 URL）。 */
interface FilePreviewPreviewProps {
  view: ViewMode;
  content: string;
  editBuf: string;
  editing: boolean;
  dirty: boolean;
  error: string;
  detailLoading: boolean;
  truncated: boolean;
  lineBudget: number;
  loadingMore: boolean;
  mdMode: 'render' | 'source';
  assetUrl: string | null;
  canLoadMore: boolean;
  wordWrap?: boolean;
  formattedContent?: string;
  isFormatted?: boolean;
}

/** 预览操作回调域（加载更多、编辑缓冲变更、错误清除、外部打开）。 */
interface FilePreviewActionsProps {
  onLoadMore: () => void;
  onEditBufChange: (v: string, dirty: boolean) => void;
  onError: (msg: string) => void;
  onOpenFile: () => void;
}

/** Props 分组：file（标识/能力）+ preview（内容/加载/编辑态）+ actions（回调）。 */
interface FilePreviewProps {
  targetSessionId?: string | null;
  file: FilePreviewFileProps;
  preview: FilePreviewPreviewProps;
  actions: FilePreviewActionsProps;
}

export const FilePreview = React.memo(function FilePreview({
  targetSessionId,
  file,
  preview: previewState,
  actions,
}: FilePreviewProps) {
  const { selected, kind, isMd } = file;
  const {
    content,
    editBuf,
    editing,
    dirty,
    error,
    detailLoading,
    truncated,
    lineBudget,
    loadingMore,
    mdMode,
    assetUrl,
    canLoadMore,
    wordWrap = true,
    formattedContent,
    isFormatted,
  } = previewState;
  const { onLoadMore, onEditBufChange, onError, onOpenFile } = actions;
  const previewPaneRef = useRef<HTMLDivElement>(null);

  const displayContent =
    isFormatted && formattedContent ? formattedContent : content;

  const onPreviewScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!canLoadMore) return;
      const el = e.currentTarget;
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (gap < 120) onLoadMore();
    },
    [canLoadMore, onLoadMore]
  );

  if (!selected) {
    return (
      <div className={`${styles.filesDetail} ${styles.filesDetailPane}`}>
        <div className={`${styles.filesEmpty} ${styles.filesEmptyCompact}`}>
          <div className={styles.filesEmptyTitle}>预览</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.filesDetail} ${styles.filesDetailPane}`}>
      {error && (content || assetUrl) ? (
        <div
          className={`${styles.filesInlineErr} ${styles.filesInlineErrDetail}`}
          role="alert"
          aria-live="polite"
        >
          <span className={styles.filesInlineErrText}>{error}</span>
          <Tooltip content="关闭">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.filesInlineErrDismiss}
              aria-label="关闭错误"
              onClick={() => onError('')}
              icon={<AppIcon name="x" size={11} />}
            />
          </Tooltip>
        </div>
      ) : null}
      <div
        className={styles.filesDetailBody}
        ref={previewPaneRef}
        onScroll={onPreviewScroll}
      >
        {detailLoading ? (
          <div className={`${styles.filesEmpty} ${styles.filesEmptyCompact}`}>
            读取中…
          </div>
        ) : error && !content && !assetUrl ? (
          <div
            className={`${styles.filesEmpty} ${styles.filesEmptyCompact} ${styles.filesEmptyErr}`}
            role="alert"
          >
            <div className={styles.filesEmptyTitle}>无法预览</div>
            <div className={styles.filesEmptySub}>{error}</div>
          </div>
        ) : kind === 'image' && assetUrl ? (
          <div className={styles.filesPreviewMedia}>
            <img
              src={assetUrl}
              alt={pathBasename(selected || '')}
              onError={() =>
                onError('图片无法显示（请确认桌面壳资源协议已启用）')
              }
            />
          </div>
        ) : kind === 'pdf' && assetUrl ? (
          <iframe
            aria-label="pdf"
            className={styles.filesPreviewPdf}
            src={assetUrl}
          />
        ) : kind === 'table' && !editing ? (
          <div className={styles.filesTableWrap}>
            <table className={styles.filesTable}>
              <tbody>
                {parseCsvPreview(content).map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) =>
                      i === 0 ? (
                        <th key={j}>{cell}</th>
                      ) : (
                        <td key={j}>{cell}</td>
                      )
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {canLoadMore ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className={styles.filesLoadMore}
                disabled={loadingMore}
                onClick={onLoadMore}
              >
                {loadingMore ? '加载中…' : '继续加载更多行'}
              </Button>
            ) : truncated ? (
              <div className={styles.filesTrunc}>已达预览上限</div>
            ) : null}
          </div>
        ) : kind === 'text' || kind === 'table' ? (
          editing ? (
            <FileEditor
              editBuf={editBuf}
              content={content}
              dirty={dirty}
              onChange={onEditBufChange}
            />
          ) : isMd && mdMode === 'render' ? (
            <div className={styles.filesMdWrap}>
              <MarkdownDocumentView
                content={displayContent || '（空文件）'}
                filePath={selected || ''}
                variant="document"
                wordWrap={wordWrap}
                onOpenPath={onOpenFile}
                onScroll={onPreviewScroll}
                footerSlot={
                  canLoadMore ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className={styles.filesLoadMore}
                      disabled={loadingMore}
                      onClick={onLoadMore}
                    >
                      {loadingMore ? '加载中…' : '继续加载更多'}
                    </Button>
                  ) : truncated ? (
                    <div className={styles.filesTrunc}>已达预览上限</div>
                  ) : null
                }
              />
            </div>
          ) : (
            <div className={styles.filesCodeViewerWrap}>
              <div className={styles.filesCodeViewerBody}>
                <VirtualPlainCodeViewer
                  content={displayContent || ''}
                  filePath={selected || ''}
                  wordWrap={wordWrap}
                />
              </div>
              {canLoadMore ? (
                <div className={styles.filesLoadMoreBar}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className={styles.filesLoadMore}
                    disabled={loadingMore}
                    onClick={onLoadMore}
                  >
                    {loadingMore
                      ? '加载中…'
                      : `继续加载（已 ${lineBudget} 行）`}
                  </Button>
                </div>
              ) : truncated ? (
                <div className={styles.filesTrunc}>已达预览上限</div>
              ) : null}
            </div>
          )
        ) : (
          <div className={`${styles.filesEmpty} ${styles.filesEmptyCompact}`}>
            不支持内嵌预览
            <div className={styles.filesEmptySub}>
              {selected ? pathBasename(selected) : ''}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={styles.filesSoftBtn}
              style={{ marginTop: 10 }}
              onClick={onOpenFile}
              icon={<AppIcon name="external-link" size={13} />}
            >
              用默认应用打开
            </Button>
          </div>
        )}

        {selected ? (
          <FileAnnotationPopover
            filePath={selected}
            containerRef={previewPaneRef}
            targetSessionId={targetSessionId}
            disabled={editing}
          />
        ) : null}
      </div>
    </div>
  );
});
