/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * apps/crish-desktop/src/components/chat-composer/SlashExtension.ts
 * Tiptap Slash Command Extension & Mention Chip Extension (CRM-01, FR-102, FR-103)
 * CI Guardrail: Max 400 lines of effective code
 */

import { Extension, Node, mergeAttributes } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import { TiptapSlashMenu } from './TiptapSlashMenu';
import type { SlashCommandItem } from './composerTypes';

export const DEFAULT_SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: 'heading-1',
    title: 'Heading 1',
    description: 'Large section heading',
    iconName: 'Heading1',
    keywords: ['h1', 'title', 'heading'],
    command: ({ editor, range }: { editor: any; range?: any }) => {
      if (range) {
        editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run();
      } else {
        editor.chain().focus().setNode('heading', { level: 1 }).run();
      }
    },
  },
  {
    id: 'heading-2',
    title: 'Heading 2',
    description: 'Medium section heading',
    iconName: 'Heading2',
    keywords: ['h2', 'subtitle', 'heading'],
    command: ({ editor, range }: { editor: any; range?: any }) => {
      if (range) {
        editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run();
      } else {
        editor.chain().focus().setNode('heading', { level: 2 }).run();
      }
    },
  },
  {
    id: 'heading-3',
    title: 'Heading 3',
    description: 'Small section heading',
    iconName: 'Heading3',
    keywords: ['h3', 'subheading', 'heading'],
    command: ({ editor, range }: { editor: any; range?: any }) => {
      if (range) {
        editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run();
      } else {
        editor.chain().focus().setNode('heading', { level: 3 }).run();
      }
    },
  },
  {
    id: 'bullet-list',
    title: 'Bullet List',
    description: 'Create a simple bulleted list',
    iconName: 'List',
    keywords: ['ul', 'bullet', 'list'],
    command: ({ editor, range }: { editor: any; range?: any }) => {
      if (range) {
        editor.chain().focus().deleteRange(range).toggleBulletList().run();
      } else {
        editor.chain().focus().toggleBulletList().run();
      }
    },
  },
  {
    id: 'numbered-list',
    title: 'Numbered List',
    description: 'Create a numbered list',
    iconName: 'ListOrdered',
    keywords: ['ol', 'number', 'list'],
    command: ({ editor, range }: { editor: any; range?: any }) => {
      if (range) {
        editor.chain().focus().deleteRange(range).toggleOrderedList().run();
      } else {
        editor.chain().focus().toggleOrderedList().run();
      }
    },
  },
  {
    id: 'task-list',
    title: 'Task List',
    description: 'Create a checklist with task items',
    iconName: 'CheckSquare',
    keywords: ['todo', 'task', 'checklist'],
    command: ({ editor, range }: { editor: any; range?: any }) => {
      if (range) {
        editor.chain().focus().deleteRange(range).toggleTaskList().run();
      } else {
        editor.chain().focus().toggleTaskList().run();
      }
    },
  },
  {
    id: 'code-block',
    title: 'Code Block',
    description: 'Display code with syntax highlighting',
    iconName: 'Code',
    keywords: ['code', 'pre', 'block'],
    command: ({ editor, range }: { editor: any; range?: any }) => {
      if (range) {
        editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
      } else {
        editor.chain().focus().toggleCodeBlock().run();
      }
    },
  },
  {
    id: 'blockquote',
    title: 'Blockquote',
    description: 'Capture a quote or reference text',
    iconName: 'Quote',
    keywords: ['quote', 'cite', 'blockquote'],
    command: ({ editor, range }: { editor: any; range?: any }) => {
      if (range) {
        editor.chain().focus().deleteRange(range).toggleBlockquote().run();
      } else {
        editor.chain().focus().toggleBlockquote().run();
      }
    },
  },
];

export const getSuggestionItems = (
  query: string,
  extraItems: SlashCommandItem[] = []
): SlashCommandItem[] => {
  const q = query.toLowerCase().trim();
  const all = [...DEFAULT_SLASH_COMMANDS, ...extraItems];
  if (!q) return all;
  return all.filter((item) => {
    return (
      item.title.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.keywords?.some((k) => k.toLowerCase().includes(q))
    );
  });
};

/** SlashExtension 可配置选项：宿主系统/skill 命令以引用桥接（动态更新不重建编辑器） */
export interface SlashExtensionOptions {
  extraItemsRef?: { current: SlashCommandItem[] };
}

/**
 * Slash Command Tiptap Extension triggering on '/'
 */
export const SlashExtension = Extension.create<SlashExtensionOptions>({
  name: 'slashCommands',

  addOptions() {
    return {
      // 默认 undefined：configure 时 mergeDeep 直接替换（嵌套默认值会被深合并吞掉引用）
      extraItemsRef: undefined,
      suggestion: {
        char: '/',
        command: ({ editor, range, props }: any) => {
          props.command({ editor, range });
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: '/',
        items: ({ query }: { query: string }) =>
          getSuggestionItems(query, this.options.extraItemsRef?.current ?? []),
        command: ({ editor, range, props }: any) => {
          props.command({ editor, range });
        },
        render: () => {
          let component: ReactRenderer | null = null;

          return {
            onStart: (props: any) => {
              component = new ReactRenderer(TiptapSlashMenu, {
                props: {
                  items: props.items,
                  command: (item: SlashCommandItem) => {
                    item.command({ editor: props.editor, range: props.range });
                  },
                  editor: props.editor,
                  range: props.range,
                  isOpen: true,
                  onClose: () => {
                    component?.destroy();
                    component = null;
                  },
                  clientRect: props.clientRect || (() => {
                    const view = props.editor?.view;
                    if (!view || !props.range) return null;
                    const coords = view.coordsAtPos(props.range.from);
                    return new DOMRect(coords.left, coords.bottom, 0, 0);
                  }),
                },
                editor: props.editor,
              });
            },

            onUpdate(props: any) {
              component?.updateProps({
                items: props.items,
                command: (item: SlashCommandItem) => {
                  item.command({ editor: props.editor, range: props.range });
                },
                editor: props.editor,
                range: props.range,
                isOpen: true,
                clientRect: props.clientRect || (() => {
                  const view = props.editor?.view;
                  if (!view || !props.range) return null;
                  const coords = view.coordsAtPos(props.range.from);
                  return new DOMRect(coords.left, coords.bottom, 0, 0);
                }),
              });
            },

            onKeyDown(props: any) {
              if (props.event.key === 'Escape') {
                component?.destroy();
                component = null;
                return true;
              }
              return (component?.ref as any)?.onKeyDown(props) ?? false;
            },

            onExit() {
              component?.destroy();
              component = null;
            },
          };
        },
      }),
    ];
  },
});

/**
 * Inline Entity Mention (@) Node Extension (FR-103)
 */
export const MentionExtension = Node.create({
  name: 'mention',

  group: 'inline',
  inline: true,
  selectable: false,
  atom: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-id'),
        renderHTML: (attributes: Record<string, any>) => {
          if (!attributes.id) return {};
          return { 'data-id': attributes.id };
        },
      },
      label: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-label'),
        renderHTML: (attributes: Record<string, any>) => {
          if (!attributes.label) return {};
          return { 'data-label': attributes.label };
        },
      },
      kind: {
        default: 'file',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-kind'),
        renderHTML: (attributes: Record<string, any>) => {
          if (!attributes.kind) return {};
          return { 'data-kind': attributes.kind };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="mention"]',
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }: { node: any; HTMLAttributes: Record<string, any> }) {
    const label = node.attrs.label || node.attrs.id || 'mention';
    const kind = node.attrs.kind || 'file';
    return [
      'span',
      mergeAttributes(
        {
          'data-type': 'mention',
          'data-kind': kind,
          class: `mention-chip mention-chip-${kind}`,
          contenteditable: 'false',
        },
        HTMLAttributes
      ),
      `@${label}`,
    ];
  },

  renderText({ node }: { node: any }) {
    return `@${node.attrs.label || node.attrs.id}`;
  },
});
