import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';
import GlobalDragHandle from 'tiptap-extension-global-drag-handle';

export function createTestEditor(initialContent: string = ''): Editor {
  const container = document.createElement('div');
  document.body.appendChild(container);

  const editor = new Editor({
    element: container,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
      }),
      Placeholder.configure({
        placeholder: 'Input content...',
      }),
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      Markdown.configure({
        html: false, // Security: disable raw HTML to prevent XSS
        transformPastedText: true,
      }),
      GlobalDragHandle.configure({
        dragHandleWidth: 24,
        scrollTreshold: 100,
      }),
    ],
    content: initialContent,
  });

  return editor;
}

export function destroyTestEditor(editor: Editor): void {
  const element = editor.options.element;
  editor.destroy();
  if (element && element.parentNode) {
    element.parentNode.removeChild(element);
  }
}
