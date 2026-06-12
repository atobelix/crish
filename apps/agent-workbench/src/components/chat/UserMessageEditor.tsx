/**
 * UserMessageEditor - 用户消息编辑组件
 */

import { useState, useEffect, useRef } from 'preact/hooks';

export function UserMessageEditor({
  initialText,
  onSave,
  onCancel,
}: {
  initialText: string;
  onSave: (newText: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (text.trim() && text.trim() !== initialText) onSave(text.trim());
    }
    if (e.key === 'Escape') onCancel();
  };

  const canSave = text.trim() && text.trim() !== initialText;

  return (
    <div class="repl-msg-editor">
      <textarea
        ref={textareaRef}
        class="repl-msg-editor-textarea"
        value={text}
        placeholder="编辑消息..."
        onInput={(e: Event) => {
          setText((e.target as HTMLTextAreaElement).value);
          const el = textareaRef.current;
          if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
        }}
        onKeyDown={handleKeyDown}
        rows={1}
      />
      <div class="repl-msg-editor-actions">
        <button class="repl-msg-editor-btn send" onClick={() => { if (canSave) onSave(text.trim()); }} disabled={!canSave}>发送</button>
        <button class="repl-msg-editor-btn cancel" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}