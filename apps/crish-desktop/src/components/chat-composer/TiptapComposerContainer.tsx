/**
 * apps/crish-desktop/src/components/chat-composer/TiptapComposerContainer.tsx
 * Top-level UI Container & Shell Coordinator for Tiptap Chat Composer
 * CI Guardrail: UI Component <= 500 lines (Target: ~220 lines)
 */

import React, { useRef, useState, useCallback } from 'react';
import type { TiptapComposerProps, ChatAttachment } from './composerTypes';
import { TiptapEditorField } from './TiptapEditorField';
import { ComposerAttachmentBar } from './ComposerAttachmentBar';
import { ComposePlusMenu } from './ComposePlusMenu';
import { PermissionModeMenu } from './PermissionModeMenu';
import { ChatQueuePanel } from './ChatQueuePanel';
import { Tooltip } from '../Tooltip';
import { useTiptapComposerState } from './useTiptapComposerState';
import * as Lucide from 'lucide-react';
import styles from './TiptapComposerContainer.module.css';

export const TiptapComposerContainer: React.FC<TiptapComposerProps> = ({
  sessionId,
  placeholder = 'Type a message or press / for commands...',
  disabled = false,
  emptyKind = 'standard',
  onSend,
  onStop,
  className,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const plusBtnRef = useRef<HTMLButtonElement>(null);

  const composerState = useTiptapComposerState({ sessionId, onSend, onStop });
  const {
    attachments = [],
    setAttachments,
    permissionMode = 'auto',
    setPermissionMode,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isComposing = false,
    setIsComposing,
    handleSend,
    handleStopRequest,
    handleDropFiles,
    handlePasteImage,
    sendShortcut = 'enter',
    onMarkdownChange,
    content,
    queuedMessages = [],
    handleSendQueueNow = () => {},
    handleEditQueueMessage = () => {},
    handleDeleteQueueMessage = () => {},
  } = composerState;

  const handleRemoveAttachment = useCallback(
    (index: number) => {
      setAttachments((prev: ChatAttachment[]) => prev.filter((_, i) => i !== index));
    },
    [setAttachments]
  );

  const handleOpenFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        handleDropFiles(e.target.files);
        e.target.value = '';
      }
    },
    [handleDropFiles]
  );

  return (
    <div
      className={`${styles.container} ${className || ''}`}
      data-empty-kind={emptyKind}
      data-disabled={disabled}
    >
      {/* Hidden File Input for Plus Menu / Toolbar File Picker */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileInputChange}
      />

      {/* Conditionally render ChatQueuePanel if queued messages exist */}
      {queuedMessages.length > 0 && (
        <ChatQueuePanel
          queue={queuedMessages}
          onSendNow={handleSendQueueNow}
          onEdit={handleEditQueueMessage}
          onDelete={handleDeleteQueueMessage}
        />
      )}

      {/* Conditionally render ComposerAttachmentBar if attachments exist */}
      {attachments.length > 0 && (
        <ComposerAttachmentBar
          attachments={attachments}
          onRemoveAttachment={(name) => {
            const idx = attachments.findIndex((a) => a.name === name);
            if (idx >= 0) handleRemoveAttachment(idx);
          }}
        />
      )}

      {/* Main ProseMirror Editor Field */}
      <TiptapEditorField
        placeholder={placeholder}
        disabled={disabled}
        sendShortcut={sendShortcut}
        content={content}
        onSendMarkdown={handleSend}
        onMarkdownChange={onMarkdownChange}
        onCompositionChange={setIsComposing}
        onDropFiles={handleDropFiles}
        onPasteImage={handlePasteImage}
      />

      {/* Sub-box Footer Actions Bar */}
      <div className={styles.footerActions}>
        <div className={styles.leftTools}>
          <Tooltip content="添加附件与扩展">
            <button
              ref={plusBtnRef}
              type="button"
              className={styles.plusBtn}
              aria-label="添加附件与扩展"
              onClick={() => setPlusMenuOpen((prev) => !prev)}
            >
              <Lucide.Plus size={16} aria-hidden />
            </button>
          </Tooltip>

          <ComposePlusMenu
            open={plusMenuOpen}
            onClose={() => setPlusMenuOpen(false)}
            onAddFiles={handleOpenFilePicker}
            restoreFocusRef={plusBtnRef}
          />

          {/* 半成品桥接（并行域组件）：PermissionModeMenu 用 api 枚举
              （ask/deep/full/plan），容器状态用 composerTypes 枚举
              （auto/manual/plan）——两源冲突登记待并行域统一，此处
              最小侵入桥接，不改变任何运行语义 */}
          <PermissionModeMenu
            mode={permissionMode as unknown as import('../../api/permissionModes').PermissionMode}
            onChange={(m) =>
              setPermissionMode(m as unknown as Parameters<typeof setPermissionMode>[0])
            }
          />
        </div>

        <div className={styles.rightTools}>
          {disabled ? (
            <Tooltip content="停止当前生成">
              <button
                type="button"
                className={styles.stopBtn}
                aria-label="停止当前生成"
                onClick={handleStopRequest}
              >
                <Lucide.Square size={14} aria-hidden />
                <span>停止</span>
              </button>
            </Tooltip>
          ) : (
            <Tooltip content={sendShortcut === 'ctrlEnter' ? '发送消息 (Ctrl+Enter)' : '发送消息 (Enter)'}>
              <button
                type="button"
                className={styles.sendBtn}
                aria-label="发送消息"
                onClick={() => handleSend()}
              >
                <Lucide.Send size={14} aria-hidden />
                <span>发送</span>
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
};
