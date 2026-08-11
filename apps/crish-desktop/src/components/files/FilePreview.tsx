import React, { useCallback, useRef, useState } from 'react';
import styles from './FilesCard.module.css';
import { Button, Tooltip } from '../ui';
import { ExternalLink, X } from 'lucide-react';
import { pathBasename } from '../../api/workspaceFsApi';
import { highlightCode, langFromFilename } from '../../api/codeHighlight';
import { useAsyncMarkdownHtml } from '../../api/markdownRenderAsync';
import {
  addPendingFileAnnotation,
  parseCsvPreview,
} from '../../api/workspaceFsApi';
import { FileEditor } from './FileEditor';
import type { ViewMode } from './hooks/useFilePreview';

interface FilePreviewProps {
  selected: string | null;
  view: ViewMode;
  kind: string;
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
  isMd: boolean;
  canLoadMore: boolean;
  canEdit: boolean;
  onLoadMore: () => void;
  onEditBufChange: (v: string, dirty: boolean) => void;
  onError: (msg: string) => void;
  onOpenFile: () => void;
}

export const FilePreview = React.memo(function FilePreview({
  selected,
  kind,
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
  isMd,
  canLoadMore,
  onLoadMore,
  onEditBufChange,
  onError,
  onOpenFile,
}: FilePreviewProps) {
  const previewPaneRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLPreElement>(null);
  const [selText, setSelText] = useState('');
  const [commentDraft, setCommentDraft] = useState('');
  const [selAnchor, setSelAnchor] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const { html: mdHtml } = useAsyncMarkdownHtml(
    isMd && mdMode === 'render' ? content || '（空文件）' : ''
  );

  const onPreviewScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!canLoadMore) return;
      const el = e.currentTarget;
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (gap < 120) onLoadMore();
    },
    [canLoadMore, onLoadMore]
  );

  const onTextSelect = useCallback(() => {
    requestAnimationFrame(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() || '';
      if (!text.length) {
        setSelText('');
        setSelAnchor(null);
        return;
      }
      setSelText(text.slice(0, 2000));
      try {
        if (!selection || selection.rangeCount === 0) {
          setSelAnchor(null);
          return;
        }
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const pane = previewPaneRef.current;
        if (!pane || !rect || (rect.width === 0 && rect.height === 0)) {
          setSelAnchor(null);
          return;
        }
        const paneRect = pane.getBoundingClientRect();
        const top = Math.min(
          Math.max(rect.bottom - paneRect.top + pane.scrollTop + 6, 8),
          Math.max(pane.scrollHeight - 120, 8)
        );
        const left = Math.min(
          Math.max(rect.left - paneRect.left + pane.scrollLeft, 8),
          Math.max(pane.clientWidth - 280, 8)
        );
        setSelAnchor({ top, left });
      } catch {
        setSelAnchor(null);
      }
    });
  }, []);

  const submitSelectionComment = useCallback(() => {
    if (!selected || !selText.trim() || !commentDraft.trim()) return;
    addPendingFileAnnotation({
      path: selected,
      selectedText: selText.trim(),
      text: commentDraft.trim(),
    });
    setSelText('');
    setCommentDraft('');
    setSelAnchor(null);
  }, [selected, selText, commentDraft]);

  if (!selected) {
    return (
      <div className={`${styles.filesDetail} ${styles.filesDetailPane}`}>
        <div className={`${styles.filesEmpty} ${styles.filesEmptyCompact}`}>
          <div className={styles.filesEmptyTitle}>预览</div>
          <div className={styles.filesEmptySub}>在左侧选择文件</div>
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
              icon={<X size={11} />}
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
              <div
                className={`${styles.filesMdBody} md-rendered msg-assistant-text`}
                dangerouslySetInnerHTML={{ __html: mdHtml }}
              />
              {canLoadMore ? (
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
              ) : null}
            </div>
          ) : (
            <>
              <pre
                ref={textRef}
                className={`${styles.filesTextPre} hljs`}
                onMouseUp={onTextSelect}
                onKeyUp={onTextSelect}
                dangerouslySetInnerHTML={{
                  __html:
                    highlightCode(
                      content || '（空文件）',
                      langFromFilename(selected || '')
                    ) || '',
                }}
              />
              {canLoadMore ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className={styles.filesLoadMore}
                  disabled={loadingMore}
                  onClick={onLoadMore}
                >
                  {loadingMore ? '加载中…' : `继续加载（已 ${lineBudget} 行）`}
                </Button>
              ) : truncated ? (
                <div className={styles.filesTrunc}>已达预览上限</div>
              ) : null}
            </>
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
              icon={<ExternalLink size={13} />}
            >
              用默认应用打开
            </Button>
          </div>
        )}
      </div>

      {selText && !editing ? (
        <div
          className={`${styles.filesSelBar} ${selAnchor ? styles.isAnchored : ''}`}
          role="region"
          aria-label="选区批注"
          style={
            selAnchor ? { top: selAnchor.top, left: selAnchor.left } : undefined
          }
        >
          <div className={styles.filesSelPreview}>
            {selText.length > 80 ? `${selText.slice(0, 80)}…` : selText}
          </div>
          <div className={styles.filesSelForm}>
            <input
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              placeholder="批注…"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSelectionComment();
                if (e.key === 'Escape') {
                  setSelText('');
                  setCommentDraft('');
                  setSelAnchor(null);
                }
              }}
            />
            <Button
              type="button"
              variant="primary"
              size="sm"
              className={`${styles.filesSoftBtn} ${styles.filesSoftBtnEmphasis}`}
              disabled={!commentDraft.trim()}
              onClick={submitSelectionComment}
            >
              添加
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={styles.filesSoftBtn}
              onClick={() => {
                setSelText('');
                setCommentDraft('');
                setSelAnchor(null);
              }}
            >
              取消
            </Button>
          </div>
          <div className={styles.filesSelHint}>随下一条消息发送 · Esc</div>
        </div>
      ) : null}
    </div>
  );
});
