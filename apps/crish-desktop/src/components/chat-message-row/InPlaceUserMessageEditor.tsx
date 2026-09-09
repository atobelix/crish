import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Paperclip, X } from 'lucide-react';
import styles from './ChatMessageRow.module.css';
import { Button, Tooltip } from '../ui';
import { ComposerAttachmentBar } from '../chat-composer/ComposerAttachmentBar';
import type { ChatAttachment } from '../../hooks/useChatStream';
import { blobToImageAttachment, isImageFile } from '../../api/imageProcessing';

export interface InPlaceUserMessageEditorProps {
  initialText: string;
  initialAttachments: ChatAttachment[];
  onCancel: () => void;
  onSubmit: (text: string, attachments: ChatAttachment[]) => void;
  onHeightChange?: () => void;
  isSubmitting?: boolean;
}

export const InPlaceUserMessageEditor: React.FC<InPlaceUserMessageEditorProps> = React.memo(
  ({
    initialText,
    initialAttachments,
    onCancel,
    onSubmit,
    onHeightChange,
    isSubmitting = false,
  }) => {
    const [text, setText] = useState(initialText);
    const [attachments, setAttachments] = useState<ChatAttachment[]>(initialAttachments);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // 聚焦光标至末尾
    useEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.value.length;
      el.selectionEnd = el.value.length;
    }, []);

    // 动态调整高度并通知虚拟滚动
    useLayoutEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(260, Math.max(48, el.scrollHeight))}px`;
      onHeightChange?.();
    }, [text, attachments, onHeightChange]);

    const handleRemoveAttachment = useCallback((nameOrId: string) => {
      setAttachments((prev) =>
        prev.filter((a) => (a.id || a.name) !== nameOrId && a.name !== nameOrId)
      );
    }, []);

    const handleAddFiles = useCallback(
      async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;
        const added: ChatAttachment[] = [];
        for (const f of Array.from(files)) {
          if (isImageFile(f)) {
            try {
              const imgAtt = await blobToImageAttachment(f, f.name);
              added.push(imgAtt);
            } catch {
              added.push({ name: f.name, mime: f.type, isImage: true });
            }
          } else {
            let textContent: string | undefined;
            if (
              /\.(txt|md|json|ts|tsx|js|jsx|css|html|py|rs|go|ya?ml|toml)$/i.test(
                f.name
              )
            ) {
              try {
                textContent = await f.text();
              } catch {
                // ignore
              }
            }
            added.push({
              name: f.name,
              path: (f as { path?: string }).path,
              mime: f.type || 'application/octet-stream',
              text: textContent,
              status: 'ready',
              progress: 100,
            });
          }
        }
        if (added.length > 0) {
          setAttachments((prev) => [...prev, ...added]);
        }
        e.target.value = '';
      },
      []
    );

    const handlePaste = useCallback(
      async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const items = e.clipboardData?.items;
        if (!items?.length) return;
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) {
              e.preventDefault();
              try {
                const imgAtt = await blobToImageAttachment(file, file.name);
                setAttachments((prev) => [...prev, imgAtt]);
              } catch {
                // ignore
              }
            }
          }
        }
      },
      []
    );

    const handleSubmit = useCallback(() => {
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      if (isSubmitting) return;
      onSubmit(trimmed, attachments);
    }, [text, attachments, isSubmitting, onSubmit]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleSubmit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      },
      [handleSubmit, onCancel]
    );

    const canSubmit = (text.trim().length > 0 || attachments.length > 0) && !isSubmitting;

    return (
      <div
        className={styles.inPlaceEditor}
        data-testid="in-place-user-editor"
        role="region"
        aria-label="消息就地编辑"
      >
        {/* 附件展示栏（复用 ComposerAttachmentBar） */}
        {attachments.length > 0 ? (
          <ComposerAttachmentBar
            attachments={attachments}
            onRemoveAttachment={handleRemoveAttachment}
          />
        ) : null}

        {/* 隐藏的文件输入框 */}
        <input
          type="file"
          ref={fileInputRef}
          multiple
          style={{ display: 'none' }}
          onChange={handleAddFiles}
        />

        {/* 文本输入区 */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          className={styles.inPlaceEditorTextarea}
          placeholder="编辑消息… (Enter 发送，Shift+Enter 换行，Esc 取消)"
          rows={2}
          disabled={isSubmitting}
        />

        {/* 底部操作工具栏 */}
        <div className={styles.inPlaceEditorFooter}>
          <div className={styles.inPlaceEditorTools}>
            <Tooltip content="添加附件">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.iconBtn}
                aria-label="添加附件"
                onClick={() => fileInputRef.current?.click()}
                icon={<Paperclip size={15} />}
                disabled={isSubmitting}
              />
            </Tooltip>
          </div>

          <div className={styles.inPlaceEditorActions}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.inPlaceEditorCancelBtn}
              onClick={onCancel}
              disabled={isSubmitting}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              className={styles.inPlaceEditorSendBtn}
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              {isSubmitting ? '发送中…' : '保存并重新发送'}
            </Button>
          </div>
        </div>
      </div>
    );
  }
);

InPlaceUserMessageEditor.displayName = 'InPlaceUserMessageEditor';
