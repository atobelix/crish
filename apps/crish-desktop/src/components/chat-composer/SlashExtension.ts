/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * apps/crish-desktop/src/components/chat-composer/SlashExtension.ts
 * Tiptap Slash Command Extension & Mention Chip Node (CRM-01, FR-102, FR-103, DIM-06)。
 * 提示框纯净化重构：
 * - 拔除 H1/H2/H3、列表、代码块等博客排版命令；
 * - 收拢为 AI 会话与系统控制指令（/clear, /stop, /mode, /prompt, /compact, /goal, /schedule 等）；
 * - 接入 safeCursorAnchor 四级几何安全探测器防 (0,0) 坍塌与漂移；
 * - 保留 @ 提及候选人建议 (MentionSuggestionExtension) 与 Mention 行内节点。
 *
 * CI Guardrail: Max 400 lines of effective code, UTF-8 无 BOM.
 */

import { Extension, Node, mergeAttributes } from '@tiptap/core';
import Suggestion, { exitSuggestion } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer, ReactNodeViewRenderer } from '@tiptap/react';
import { TiptapSlashMenu } from './TiptapSlashMenu';
import { ComposerInlineTag } from './ComposerInlineTag';
import type { SlashCommandItem, MentionCandidate } from './composerTypes';
import {
  calculateSafeCursorAnchor,
  measureCursorLineBox,
} from './safeCursorAnchor';
import { AI_SYSTEM_COMMANDS } from './AiCommandSlashExtension';

export { AI_SYSTEM_COMMANDS } from './AiCommandSlashExtension';

export const DEFAULT_SLASH_COMMANDS: SlashCommandItem[] = AI_SYSTEM_COMMANDS;

const getSuggestionItems = (
  query: string,
  extraItems: SlashCommandItem[] = []
): SlashCommandItem[] => {
  const q = query.toLowerCase().trim();
  const seen = new Set<string>();
  const all: SlashCommandItem[] = [];

  for (const item of [...extraItems, ...DEFAULT_SLASH_COMMANDS]) {
    const key = item.title.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      all.push(item);
    }
  }

  if (!q) return all;
  return all.filter((item) => {
    return (
      item.title.toLowerCase().includes(q) ||
      item.id.toLowerCase().includes(q) ||
      item.description?.toLowerCase().includes(q) ||
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
    description:
      c.kind === 'agent' ? '智能体' : c.kind === 'skill' ? '技能' : '文件',
    iconName:
      c.kind === 'agent' ? 'Bot' : c.kind === 'skill' ? 'Sparkles' : 'FileText',
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

/** SlashExtension 可配置选项：宿主系统/skill 命令与弹层 listbox id 及 Level 4 容器引用 */
export interface SlashExtensionOptions {
  extraItemsRef?: { current: SlashCommandItem[] };
  listboxId?: string;
  containerRef?: { current: HTMLElement | null };
}

/** MentionSuggestionExtension 可配置选项：候选人源 + 弹层 listbox id 及 Level 4 容器引用 */
export interface MentionSuggestionOptions {
  candidatesRef?: { current: MentionCandidate[] };
  listboxId?: string;
  containerRef?: { current: HTMLElement | null };
}

/** 斜杠 suggestion 独立 keyed plugin */
export const slashSuggestionKey = new PluginKey('crishSlashSuggestion');

/** 提及 suggestion 独立 keyed plugin */
export const mentionSuggestionKey = new PluginKey('crishMentionSuggestion');

type SuggestionRenderCtx = {
  listboxId?: string;
  label?: string;
  emptyMessage?: string;
  skipEmpty?: boolean;
  pluginKey?: PluginKey;
  containerRef?: { current: HTMLElement | null };
};

/**
 * Suggestion render 生命周期工厂：两个 suggestion 实例共用同一套
 * ReactRenderer 创建/更新/销毁与编辑器 combobox aria 同步
 */
function createSuggestionRenderer(ctx: SuggestionRenderCtx) {
  return () => {
    let component: ReactRenderer | null = null;
    let propsRef: any = null;
    let lastCachedBox:
      | (DOMRect & {
          suggestedSide?: 'top' | 'bottom';
          nearEdge?: boolean;
          isFallback?: boolean;
          isValid?: boolean;
        })
      | null = null;
    let lastSuggestedSide: 'top' | 'bottom' | undefined = undefined;

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
          const rawBox = measureCursorLineBox(view, props.range.from, 1);
          const safeAnchor = calculateSafeCursorAnchor({
            rawCursorRect: rawBox,
            editorViewDom: view.dom,
            composerContainer: ctx.containerRef?.current ?? undefined,
            previousSide: lastSuggestedSide,
            hysteresis: 24,
          });
          if (safeAnchor) {
            lastSuggestedSide = safeAnchor.suggestedSide;
            // 关键修复 (DEC-06 / Task 4.1): 保全 suggestedSide 与 nearEdge 扩展属性
            const extendedRect = Object.assign(
              new DOMRect(
                safeAnchor.left,
                safeAnchor.top,
                safeAnchor.width,
                safeAnchor.height
              ),
              {
                suggestedSide: safeAnchor.suggestedSide,
                nearEdge: safeAnchor.nearEdge,
                isFallback: safeAnchor.isFallback,
                isValid: safeAnchor.isValid,
              }
            );
            lastCachedBox = extendedRect;
            return lastCachedBox;
          }
          return lastCachedBox;
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
          return;
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
          // IME 合成态下绝不拦截 Esc
          if (
            props.event.isComposing ||
            (props.event as any).nativeEvent?.isComposing ||
            props.event.keyCode === 229 ||
            props.event.key === 'Process'
          ) {
            return false;
          }

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
        lastSuggestedSide = undefined;
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
      extraItemsRef: undefined,
      listboxId: undefined,
      containerRef: undefined,
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
        pluginKey: slashSuggestionKey,
        items: ({ query }: { query: string }) =>
          getSuggestionItems(query, this.options.extraItemsRef?.current ?? []),
        command: ({ editor, range, props }: any) => {
          props.command({ editor, range });
        },
        render: createSuggestionRenderer({
          listboxId: this.options.listboxId,
          label: 'AI 会话系统指令',
          emptyMessage: '无匹配指令',
          pluginKey: slashSuggestionKey,
          containerRef: this.options.containerRef,
        }),
      }),
    ];
  },
});

/** 提及建议插件：@ 触发第二 suggestion 实例 */
export const MentionSuggestionExtension =
  Extension.create<MentionSuggestionOptions>({
    name: 'mentionSuggestion',

    addOptions() {
      return {
        candidatesRef: undefined,
        listboxId: undefined,
        containerRef: undefined,
      };
    },

    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          char: '@',
          allowSpaces: true,
          allowedPrefixes: null,
          pluginKey: mentionSuggestionKey,
          allow: ({ state, range }: { state: any; range: { from: number; to: number } }) => {
            try {
              const text = state.doc.textBetween(range.from, range.to, '');
              if (text.startsWith('@@')) return false;
            } catch {
              /* swallow-ok: 范围失效则仍允许 @ */
            }
            return true;
          },
          items: ({ query }: { query: string }) => {
            if (query.startsWith('@')) return [];
            return getMentionItems(
              query,
              this.options.candidatesRef?.current ?? []
            );
          },
          command: ({ editor, range, props }: any) => {
            props.command({ editor, range });
          },
          render: createSuggestionRenderer({
            listboxId: this.options.listboxId,
            label: '提及候选人',
            emptyMessage: '无匹配项',
            skipEmpty: true,
            pluginKey: mentionSuggestionKey,
            containerRef: this.options.containerRef,
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
    const filePath =
      kind === 'file'
        ? String(node.attrs.id || node.attrs.label || '').trim()
        : '';
    const text = kind === 'skill' ? String(label) : `@${label}`;
    return [
      'span',
      mergeAttributes(
        {
          'data-type': 'mention',
          'data-kind': kind,
          class: `mention-chip mention-chip-${kind}`,
          contenteditable: 'false',
          ...(filePath ? { 'data-file-open-path': filePath } : {}),
        },
        HTMLAttributes
      ),
      ['span', { class: 'mention-icon-box', 'aria-hidden': 'true' }],
      text,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ComposerInlineTag);
  },

  renderText({ node }: { node: any }) {
    return `@${node.attrs.label || node.attrs.id}`;
  },
});
