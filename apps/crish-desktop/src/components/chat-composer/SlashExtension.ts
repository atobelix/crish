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

function runEditorCommand(
  editor: any,
  range: any,
  action: (chain: any) => any
) {
  const chain = editor.chain().focus();
  if (range) chain.deleteRange(range);
  action(chain).run();
}

const DEFAULT_SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: 'heading-1',
    title: 'Heading 1',
    description: 'Large section heading',
    iconName: 'Heading1',
    keywords: ['h1', 'title', 'heading'],
    command: ({ editor, range }: any) =>
      runEditorCommand(editor, range, (c) =>
        c.setNode('heading', { level: 1 })
      ),
  },
  {
    id: 'heading-2',
    title: 'Heading 2',
    description: 'Medium section heading',
    iconName: 'Heading2',
    keywords: ['h2', 'subtitle', 'heading'],
    command: ({ editor, range }: any) =>
      runEditorCommand(editor, range, (c) =>
        c.setNode('heading', { level: 2 })
      ),
  },
  {
    id: 'heading-3',
    title: 'Heading 3',
    description: 'Small section heading',
    iconName: 'Heading3',
    keywords: ['h3', 'subheading', 'heading'],
    command: ({ editor, range }: any) =>
      runEditorCommand(editor, range, (c) =>
        c.setNode('heading', { level: 3 })
      ),
  },
  {
    id: 'bullet-list',
    title: 'Bullet List',
    description: 'Create a simple bulleted list',
    iconName: 'List',
    keywords: ['ul', 'bullet', 'list'],
    command: ({ editor, range }: any) =>
      runEditorCommand(editor, range, (c) => c.toggleBulletList()),
  },
  {
    id: 'ordered-list',
    title: 'Numbered List',
    description: 'Create a numbered list',
    iconName: 'ListOrdered',
    keywords: ['ol', 'number', 'list'],
    command: ({ editor, range }: any) =>
      runEditorCommand(editor, range, (c) => c.toggleOrderedList()),
  },
  {
    id: 'task-list',
    title: 'Task List',
    description: 'Create a to-do list with checkboxes',
    iconName: 'ListTodo',
    keywords: ['todo', 'task', 'checklist'],
    command: ({ editor, range }: any) =>
      runEditorCommand(editor, range, (c) => c.toggleTaskList()),
  },
  {
    id: 'code-block',
    title: 'Code Block',
    description: 'Insert a preformatted code snippet',
    iconName: 'Code',
    keywords: ['code', 'pre', 'snippet'],
    command: ({ editor, range }: any) =>
      runEditorCommand(editor, range, (c) => c.toggleCodeBlock()),
  },
  {
    id: 'blockquote',
    title: 'Blockquote',
    description: 'Capture a quote or reference text',
    iconName: 'Quote',
    keywords: ['quote', 'cite', 'blockquote'],
    command: ({ editor, range }: any) =>
      runEditorCommand(editor, range, (c) => c.toggleBlockquote()),
  },
  {
    id: 'compact',
    title: 'Compact',
    description: '手动压缩上下文（/compact [目标 token 数]）',
    iconName: 'Compress',
    keywords: ['compact', '压缩', 'compress', '压缩上下文'],
    command: ({ editor, range }: any) =>
      runEditorCommand(editor, range, (c) => c.insertContent('/compact ')),
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
          {
            type: 'mention',
            attrs: { id: c.id, label: c.label, kind: c.kind ?? 'file' },
          },
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
 * 测量指定 ProseMirror 文档位置处的真实物理 LineBox 包围盒。
 * 恢复真实高度、宽度与视口顶/底/左/右坐标，彻底消除 0D 点矩形坍缩。
 *
 * @param view ProseMirror EditorView 或具备 coordsAtPos 的视图对象
 * @param pos 文档绝对位置索引
 * @param side 亲和性：1 表示向后（下一字形左侧），-1 表示向前（上一字形右侧）
 * @returns 包含真实行高的 DOMRect 视口包围盒
 */
export function measureCursorLineBox(
  view:
    | {
        coordsAtPos: (
          pos: number,
          side?: number
        ) => { top: number; bottom: number; left: number; right?: number };
      }
    | null
    | undefined,
  pos: number,
  side: number = 1
): DOMRect {
  if (!view || typeof view.coordsAtPos !== 'function') {
    return new DOMRect(0, 0, 0, 0);
  }

  try {
    const coords = view.coordsAtPos(pos, side);
    const top = coords.top;
    const bottom = coords.bottom;

    // 物理行高守卫：兜底最小行高 16px（防止空文档测量未就绪）
    const measuredHeight = bottom - top;
    const height = Math.max(
      16,
      Number.isFinite(measuredHeight) ? measuredHeight : 20
    );

    // 水平坐标与光标宽度（Caret 宽度至少 2px，保证包围盒有物理体积）
    const left = coords.left;
    const measuredWidth = (coords.right ?? coords.left) - coords.left;
    const width = Math.max(
      2,
      Number.isFinite(measuredWidth) ? measuredWidth : 2
    );

    return new DOMRect(left, top, width, height);
  } catch {
    return new DOMRect(0, 0, 0, 0);
  }
}

/**
 * Suggestion render 生命周期工厂：两个 suggestion 实例共用同一套
 * ReactRenderer 创建/更新/销毁与编辑器 combobox aria 同步（T8），
 * 避免生命周期逻辑双份漂移。
 */
function createSuggestionRenderer(ctx: SuggestionRenderCtx) {
  return () => {
    let component: ReactRenderer | null = null;
    let propsRef: any = null;
    let lastCachedBox: DOMRect | null = null;

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
      clientRect: () => {
        const view = props.editor?.view;
        if (!view || !props.range) return lastCachedBox;

        // CJK 合成态下坐标保持静止，返回稳定缓存
        if (view.composing || (view as any).input?.composing) {
          return lastCachedBox;
        }

        try {
          const box = measureCursorLineBox(view, props.range.from, 1);
          lastCachedBox = box;
          return box;
        } catch {
          return lastCachedBox;
        }
      },
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
          // IME 合成态下绝不拦截 Esc（Tri-Shield 防护）
          if (
            props.event.isComposing ||
            (props.event as any).nativeEvent?.isComposing ||
            props.event.keyCode === 229 ||
            props.event.key === 'Process'
          ) {
            return false;
          }

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
        lastCachedBox = null;
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
export const MentionSuggestionExtension =
  Extension.create<MentionSuggestionOptions>({
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

  renderHTML({
    node,
    HTMLAttributes,
  }: {
    node: any;
    HTMLAttributes: Record<string, any>;
  }) {
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
