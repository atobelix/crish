/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * apps/crish-desktop/src/components/chat-composer/SlashExtension.ts
 * Tiptap Slash Command Extension & Mention Chip Node (CRM-01, FR-102, FR-103)。
 * 40 方案 T6/T8 扩展：
 * - 斜杠命令并入宿主系统/skill 命令（extraItemsRef 引用桥接）；
 * - Mention 用户提及 UI：@ 触发第二 suggestion 实例，候选人以引用桥接注入，
 *   空列表兜底（不弹面板、不崩溃）；
 * - 弹层 aria 全链：编辑器 combobox 的 aria-expanded/controls/activedescendant 随生命周期同步。
 * CI Guardrail: Max 400 lines of effective code
 */

import { Extension, Node, mergeAttributes } from '@tiptap/core';
import Suggestion, { exitSuggestion } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import { TiptapSlashMenu } from './TiptapSlashMenu';
import type { SlashCommandItem, MentionCandidate } from './composerTypes';

const DEFAULT_SLASH_COMMANDS: SlashCommandItem[] = [
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

const getSuggestionItems = (
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

/** 提及候选人 → 菜单项（选中后插入 mention 节点 + 尾随空格，序列化 @[label](id:kind)） */
const getMentionItems = (
  query: string,
  candidates: MentionCandidate[] = []
): SlashCommandItem[] => {
  const q = query.toLowerCase().trim();
  const filtered = !q
    ? candidates
    : candidates.filter(
        (c) =>
          c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
      );
  return filtered.map<SlashCommandItem>((c) => ({
    id: `mention-${c.id}`,
    title: c.label,
    description: c.kind === 'agent' ? '智能体' : '文件',
    iconName: 'AtSign',
    keywords: [c.id, c.label],
    command: ({ editor, range }: { editor: any; range?: any }) => {
      const chain = editor.chain().focus();
      if (range) chain.deleteRange(range);
      chain
        .insertContent([
          { type: 'mention', attrs: { id: c.id, label: c.label, kind: c.kind ?? 'file' } },
          { type: 'text', text: ' ' },
        ])
        .run();
    },
  }));
};

/** SlashExtension 可配置选项：宿主系统/skill 命令与弹层 listbox id（引用桥接，动态更新不重建编辑器） */
export interface SlashExtensionOptions {
  extraItemsRef?: { current: SlashCommandItem[] };
  listboxId?: string;
}

/** MentionSuggestionExtension 可配置选项：候选人源 + 弹层 listbox id */
export interface MentionSuggestionOptions {
  candidatesRef?: { current: MentionCandidate[] };
  listboxId?: string;
}

/** 斜杠 suggestion 独立 keyed plugin（与提及实例共存，防 RangeError: keyed plugin 冲突） */
export const slashSuggestionKey = new PluginKey('crishSlashSuggestion');

/** 提及 suggestion 独立 keyed plugin（与斜杠实例共存） */
export const mentionSuggestionKey = new PluginKey('crishMentionSuggestion');

type SuggestionRenderCtx = {
  listboxId?: string;
  label?: string;
  emptyMessage?: string;
  /** 无匹配时不弹面板（提及空候选人兜底；斜杠保留空态面板） */
  skipEmpty?: boolean;
  /** Esc 退出建议状态用（exitSuggestion 事务，走 onExit 清理 aria 链） */
  pluginKey?: PluginKey;
};

/**
 * Suggestion render 生命周期工厂：两个 suggestion 实例共用同一套
 * ReactRenderer 创建/更新/销毁与编辑器 combobox aria 同步（T8），
 * 避免生命周期逻辑双份漂移。
 */
function createSuggestionRenderer(ctx: SuggestionRenderCtx) {
  return () => {
    let component: ReactRenderer | null = null;
    let propsRef: any = null;

    const buildProps = (props: any) => ({
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
      label: ctx.label,
      emptyMessage: ctx.emptyMessage,
      listboxId: ctx.listboxId,
    });

    const create = (props: any) => {
      propsRef = props;
      // 弹层打开：编辑器 combobox aria-expanded/controls 置位（T8 全链）
      const dom = props.editor?.view?.dom;
      if (dom) {
        if (ctx.listboxId) dom.setAttribute('aria-controls', ctx.listboxId);
        dom.setAttribute('aria-expanded', 'true');
      }
      component = new ReactRenderer(TiptapSlashMenu, {
        props: buildProps(props),
        editor: props.editor,
      });
    };

    return {
      onStart(props: any) {
        if (ctx.skipEmpty && (!props.items || props.items.length === 0)) {
          return; // 空候选人兜底：不弹面板（提及场景）
        }
        create(props);
      },

      onUpdate(props: any) {
        propsRef = props;
        const empty = !props.items || props.items.length === 0;
        if (empty && ctx.skipEmpty) {
          component?.destroy();
          component = null;
          return;
        }
        if (component) {
          component.updateProps(buildProps(props));
        } else if (!empty) {
          create(props);
        }
      },

      onKeyDown(props: any) {
        if (props.event.key === 'Escape') {
          // 兜底退出建议状态（Radix 弹层 preventDefault 时 PM 链被跳过，
          // 主路径在 TiptapEditorField 的 capture 监听；此处保证非 Radix 环境一致）
          if (component) {
            component.destroy();
            component = null;
          }
          if (props.view && ctx.pluginKey) {
            exitSuggestion(props.view, ctx.pluginKey);
          }
          return true;
        }
        return (component?.ref as any)?.onKeyDown(props) ?? false;
      },

      onExit() {
        // 弹层关闭：清理编辑器 combobox aria 链（expanded/controls/activedescendant）
        const dom = propsRef?.editor?.view?.dom;
        if (dom) {
          dom.removeAttribute('aria-expanded');
          dom.removeAttribute('aria-controls');
          dom.removeAttribute('aria-activedescendant');
        }
        component?.destroy();
        component = null;
        propsRef = null;
      },
    };
  };
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
      listboxId: undefined,
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
        // 与提及 suggestion 实例区分 keyed plugin（同编辑器双 suggestion 必需）
        pluginKey: slashSuggestionKey,
        items: ({ query }: { query: string }) =>
          getSuggestionItems(query, this.options.extraItemsRef?.current ?? []),
        command: ({ editor, range, props }: any) => {
          props.command({ editor, range });
        },
        render: createSuggestionRenderer({
          listboxId: this.options.listboxId,
          label: '斜杠命令',
          emptyMessage: '无匹配命令',
          pluginKey: slashSuggestionKey,
        }),
      }),
    ];
  },
});

/** 提及建议插件：@ 触发第二 suggestion 实例（T8，候选人引用桥接） */
export const MentionSuggestionExtension = Extension.create<MentionSuggestionOptions>({
  name: 'mentionSuggestion',

  addOptions() {
    return {
      candidatesRef: undefined,
      listboxId: undefined,
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: '@',
        allowSpaces: true,
        // 提及允许任意前缀（含中文相邻无空格场景，如「请分析@」）；
        // tiptap v3 默认仅允许空白前缀，CJK 聊天语境下过于苛刻
        allowedPrefixes: null,
        // 独立 keyed plugin：与斜杠实例共存（同编辑器双 suggestion）
        pluginKey: mentionSuggestionKey,
        items: ({ query }: { query: string }) =>
          getMentionItems(query, this.options.candidatesRef?.current ?? []),
        command: ({ editor, range, props }: any) => {
          props.command({ editor, range });
        },
        render: createSuggestionRenderer({
          listboxId: this.options.listboxId,
          label: '提及候选人',
          emptyMessage: '无匹配项',
          skipEmpty: true,
          pluginKey: mentionSuggestionKey,
        }),
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
