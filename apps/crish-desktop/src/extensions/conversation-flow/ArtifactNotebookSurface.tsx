/**
 * 产物轻阅读面：现 AsyncMarkdownBlock。不是参考仓编辑器，不注册第二套 view。
 * 浮层只挂本组件树（对话叶内），不挂 document.body。
 */
import type { ReactElement } from 'react';
import { AsyncMarkdownBlock } from '../../components/chat-message-row/AsyncMarkdownBlock';
import styles from './narrative.module.css';

export interface ArtifactNotebookSurfaceProps {
  title: string;
  content: string;
  mime: 'markdown' | 'text';
  pinned: boolean;
  docId?: string;
  onPin: () => void;
  onClose: () => void;
  onOpenNote?: (docId: string) => void;
}

export function ArtifactNotebookSurface({
  title,
  content,
  mime,
  pinned,
  docId,
  onPin,
  onClose,
  onOpenNote,
}: ArtifactNotebookSurfaceProps): ReactElement {
  const canEdit = Boolean(docId && onOpenNote);

  return (
    <div
      className={styles.notebook}
      data-flow-artifact-notebook="reading"
      data-notebook-pinned={pinned ? 'true' : 'false'}
      data-notebook-host="leaf-body"
      data-artifact-mime={mime}
      role="dialog"
      aria-label={title || '文档阅读'}
    >
      <div className={styles.notebookHead}>
        <span className={styles.notebookTitle}>{title || '文档'}</span>
        <button
          type="button"
          className={styles.nbBtn}
          aria-pressed={pinned}
          onClick={(e) => {
            e.stopPropagation();
            onPin();
          }}
        >
          {pinned ? '取消钉住' : '钉住'}
        </button>
        {canEdit ? (
          <button
            type="button"
            className={styles.nbBtn}
            data-artifact-edit="note"
            onClick={(e) => {
              e.stopPropagation();
              if (docId) onOpenNote?.(docId);
            }}
          >
            编辑
          </button>
        ) : null}
        <button
          type="button"
          className={styles.nbBtn}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          关闭
        </button>
      </div>
      <div
        className={styles.notebookBody}
        data-artifact-md="async-markdown-block"
      >
        {content.trim() ? (
          <AsyncMarkdownBlock text={content} isStreaming={false} />
        ) : (
          <p className={styles.notebookEmpty}>暂无正文</p>
        )}
      </div>
    </div>
  );
}
