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
import { findSlashOrEnumerationMatch } from './slashTriggerAlias';
import {
  DURATION_POPOVER_EXIT_MS,
  EXIT_SETTLE_BUFFER_MS,
} from '../../utils/motionTokens';

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

    // S5b：退场延迟销毁——TiptapSlashMenu 的退场宿主（useClosingFlag）
    // 在组件内，而本文件是拥有条件渲染的父级：直接 destroy 会让组件连
    // 同退场一起死（实机：Esc 后 50ms 内已卸载，零淡出帧；且 onKeyDown
    // 的 Esc 分支先于菜单自身的 Esc 处理，菜单的 onClose 根本走不到
    // isOpen 翻 false）。关闭路径一律先把 isOpen 翻 false（触发组件
    // 内 120ms 退场 + 50ms settle），170ms 后再真正销毁；退场窗内
    // 重开则取消定时、就地复用。useExitReveal 的宿主契约第 1/2 条：
    // 保活只能发生在卸载的上一级，卸载只由宿主定时器驱动。
    let destroyTimer: ReturnType<typeof setTimeout> | null = null;

    const destroyComponent = () => {
      if (destroyTimer !== null) {
        clearTimeout(destroyTimer);
        destroyTimer = null;
      }
      if (component) {
        if (component.element?.parentNode) {
          component.element.parentNode.removeChild(component.element);
        }
        component.destroy();
        component = null;
      }
      // 引用清理统一落在此处：退场窗内 clientRect 仍需 lastCachedBox
      // 保锚，提前置空会触发菜单熔断、杀死退场。
      propsRef = null;
      lastCachedBox = null;
      lastSuggestedSide = undefined;
    };

    const scheduleDestroy = () => {
      if (!component) return;
      if (destroyTimer !== null) return; // 已在退场窗内
      if (!propsRef) {
        destroyComponent();
        return;
      }
      try {
        component.updateProps({ ...buildProps(propsRef), isOpen: false });
      } catch {
        destroyComponent();
        return;
      }
      destroyTimer = setTimeout(() => {
        destroyTimer = null;
        destroyComponent();
      }, DURATION_POPOVER_EXIT_MS + EXIT_SETTLE_BUFFER_MS);
    };

    const buildProps = (props: any) => ({
      items: props.items,
      command: (item: SlashCommandItem) => {
        item.command({ editor: props.editor, range: props.range });
      },
      editor: props.editor,
      range: props.range,
      isOpen: true,
      onClose: () => {
        scheduleDestroy();
      },
      clientRect: () => {
        const view = props.editor?.view;
        if (!view || !props.range) return lastCachedBox;

        // 组字期间已有锚点则保持静止。没有锚点时继续测量输入卡片，避免菜单退成 2px 看不见。
        if ((view.composing || (view as any).input?.composing) && lastCachedBox)
          return lastCachedBox;

        try {
          // 斜杠指令优先以主输入卡片（Composer Card）为锚定目标（对齐 ChatGPT Work 浮动卡片）
          // 强化查找：显式 containerRef (卡片 SSOT) -> view.dom 向上祖先探测 -> 外层 wrapper 兜底
          const cRef = ctx.containerRef?.current as
            HTMLElement | null | undefined;
          const cardEl =
            cRef?.closest?.('[data-composer-card]') ||
            cRef?.querySelector?.('[data-composer-card]') ||
            (view.dom?.closest?.(
              '[data-composer-card], [data-composer-wrapper]'
            ) as HTMLElement | null) ||
            cRef ||
            null;

          if (cardEl && typeof cardEl.getBoundingClientRect === 'function') {
            const cardRect = cardEl.getBoundingClientRect();
            if (cardRect.width > 0 && cardRect.height > 0) {
              const extendedRect = Object.assign(
                new DOMRect(
                  cardRect.left,
                  cardRect.top,
                  cardRect.width,
                  cardRect.height
                ),
                {
                  suggestedSide: 'top' as const,
                  nearEdge: false,
                  isFallback: false,
                  isValid: true,
                }
              );
              lastCachedBox = extendedRect;
              return lastCachedBox;
            }
          }

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
      if (component) {
        // 退场窗内重开：取消待销毁，就地复用并翻回 open（无闪烁、无重挂载）；
        // useClosingFlag 见 open 翻回 true 即取消退场。
        if (destroyTimer !== null) {
          clearTimeout(destroyTimer);
          destroyTimer = null;
        }
        component.updateProps(buildProps(props));
        return;
      }
      component = new ReactRenderer(TiptapSlashMenu, {
        props: buildProps(props),
        editor: props.editor,
      });
      if (component.element && typeof document !== 'undefined') {
        document.body.appendChild(component.element);
      }
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
          scheduleDestroy();
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

          // S5b：先退场（isOpen 翻 false）再销毁；exitSuggestion 会走
          // onExit，其内的 scheduleDestroy 因定时器已在而幂等。
          scheduleDestroy();
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
        // S5b：退场窗内引用（lastCachedBox 保锚）不得提前置空；销毁时
        // destroyComponent 统一清理。无组件时（建议未开过菜单）直接清理。
        if (component) {
          scheduleDestroy();
        } else {
          propsRef = null;
          lastCachedBox = null;
          lastSuggestedSide = undefined;
        }
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
    const makeRenderer = (pluginKey: PluginKey) =>
      createSuggestionRenderer({
        listboxId: this.options.listboxId,
        label: 'AI 会话系统指令',
        emptyMessage: '无匹配指令',
        skipEmpty: true,
        pluginKey,
        containerRef: this.options.containerRef,
      });

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
        findSuggestionMatch: findSlashOrEnumerationMatch,
        render: makeRenderer(slashSuggestionKey),
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
          allow: ({
            state,
            range,
          }: {
            state: any;
            range: { from: number; to: number };
          }) => {
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
    const text =
      kind === 'skill' || kind === 'command'
        ? String(label).replace(/^\/+/, '')
        : `@${label}`;
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
