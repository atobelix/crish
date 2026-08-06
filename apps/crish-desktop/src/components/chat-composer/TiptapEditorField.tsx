/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx
 * Tiptap ProseMirror field for chat composer with IME protection (CRM-03), keymaps, drop & paste handlers.
 * CI Guardrail: UI Component (Max 500 lines of effective code, Max 12 useState)
 */

import React, { useEffect, useRef } from 'react';

import { useEditor, EditorContent } from '@tiptap/react';

import StarterKit from '@tiptap/starter-kit';

import Placeholder from '@tiptap/extension-placeholder';

import TaskList from '@tiptap/extension-task-list';

import TaskItem from '@tiptap/extension-task-item';
import { SlashExtension } from './SlashExtension';
import { serializeToMarkdown } from './serialization/markdownSerializer';
import { parseFromMarkdown } from './serialization/markdownDeserializer';
import type { TiptapEditorFieldProps } from './composerTypes';
import styles from './TiptapEditorField.module.css';

export const TiptapEditorField: React.FC<TiptapEditorFieldProps> = ({
  placeholder = 'Type a message or press / for commands...',
  disabled = false,
  sendShortcut = 'enter',
  content,
  onSendMarkdown,
  onMarkdownChange,
  onCompositionChange,
  onDropFiles,
  onPasteImage,
}) => {
  const isComposingRef = useRef<boolean>(false);
  const lastContentRef = useRef<string | undefined>(content);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const editor = useEditor({
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: {},
      }),
      Placeholder.configure({
        placeholder: placeholder ?? '',
      }),
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      SlashExtension,
    ],
    onUpdate: ({ editor }) => {
      // 性能优化：防抖处理海量节点下的 serializeToMarkdown 计算，避免主线程卡顿
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        const json = editor.getJSON();
        const markdown = serializeToMarkdown(json);
        lastContentRef.current = markdown;
        if (onMarkdownChange) {
          onMarkdownChange(markdown);
        }
      }, 150);
    },
    editorProps: {
      attributes: {
        class: styles.proseMirrorField ?? '',
      },
      handleKeyDown: (view: any, event: KeyboardEvent | any) => {
        // CRM-03: IME Composition Protection Gate
        if (view.composing || event.isComposing || isComposingRef.current) {
          if (onCompositionChange) {
            onCompositionChange(true);
          }
          return false; // Pass through to browser native CJK IME candidate selection
        }

        const isShift = event.shiftKey;
        const isCtrlOrCmd = event.ctrlKey || event.metaKey;

        // Shift+Enter inserts hard break
        if (event.key === 'Enter' && isShift) {
          return false;
        }

        // Send Keymaps
        if (event.key === 'Enter') {
          let shouldSend = false;

          if (sendShortcut === 'enter' && !isShift && !isCtrlOrCmd) {
            shouldSend = true;
          } else if (sendShortcut === 'ctrlEnter' && isCtrlOrCmd) {
            shouldSend = true;
          }

          if (shouldSend) {
            event.preventDefault();
            if (!editor) return true;

            // 强制立即执行一次同步转换以保证发送内容最新
            const json = editor.getJSON();
            const markdown = serializeToMarkdown(json).trim() || editor.getText().trim();

            if (markdown && onSendMarkdown) {
              onSendMarkdown(markdown);
              editor.commands.clearContent();
              lastContentRef.current = '';
              if (onMarkdownChange) {
                onMarkdownChange('');
              }
            }
            return true;
          }
        }

        return false;
      },
      handleDrop: (view: any, event: DragEvent | any, _slice: any, moved: boolean) => {
        if (!moved && event.dataTransfer && event.dataTransfer.files.length > 0) {
          event.preventDefault();
          if (onDropFiles) {
            onDropFiles(Array.from(event.dataTransfer.files));
          }
          return true;
        }
        return false;
      },
      handlePaste: (view: any, event: ClipboardEvent | any) => {
        const items = event.clipboardData?.items;
        if (items && items.length > 0) {
          for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
              const file = items[i].getAsFile();
              if (file && onPasteImage) {
                event.preventDefault();
                onPasteImage(file);
                return true;
              }
            }
          }
        }
        return false;
      },
    },
  });

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Keep editable state synced with disabled prop
  useEffect(() => {
    if (editor) {
      editor.setEditable(!disabled);
    }
  }, [editor, disabled]);

  // Sync editor DOM content with content prop (CRM-02 Session Draft Hydration)
  // 性能优化：流式输出与海量节点场景下，移除 O(N) 的 currentMarkdown 序列化
  // 添加内存截断防爆策略
  useEffect(() => {
    if (!editor || content === undefined) return;
    
    const COMPOSER_MAX_LENGTH = 100000;
    let safeContent = content;
    
    // 防爆内存截断策略（安全红线兜底：严格视口防 OOM）
    if (safeContent.length > COMPOSER_MAX_LENGTH) {
      safeContent = safeContent.slice(0, COMPOSER_MAX_LENGTH) + '\n\n>[!WARNING]\n>内容过长已被防爆截断，请清理后继续。';
    }

    if (safeContent === lastContentRef.current) return;

    // 采用 requestAnimationFrame 调度渲染，确保 120Hz/60Hz 不掉帧
    requestAnimationFrame(() => {
      const doc = parseFromMarkdown(safeContent);
      editor.commands.setContent(doc);
      lastContentRef.current = safeContent;
    });
  }, [editor, content]);

  // Track composition events directly on the editor DOM node for CJK protection
  useEffect(() => {
    if (!editor || !editor.view || !editor.view.dom) return;

    const dom = editor.view.dom;

    const handleCompositionStart = () => {
      isComposingRef.current = true;
      if (onCompositionChange) {
        onCompositionChange(true);
      }
    };

    const handleCompositionEnd = () => {
      isComposingRef.current = false;
      if (onCompositionChange) {
        onCompositionChange(false);
      }
    };

    dom.addEventListener('compositionstart', handleCompositionStart);
    dom.addEventListener('compositionend', handleCompositionEnd);

    return () => {
      dom.removeEventListener('compositionstart', handleCompositionStart);
      dom.removeEventListener('compositionend', handleCompositionEnd);
    };
  }, [editor, onCompositionChange]);

  return (
    <div
      className={`${styles.fieldWrapper} ${disabled ? styles.disabled : ''}`}
      onClick={() => {
        if (!disabled && editor) {
          editor.commands.focus();
        }
      }}
    >
      <EditorContent editor={editor} />
    </div>
  );
};
