/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * apps/crish-desktop/src/components/chat-composer/AiCommandSlashExtension.ts
 * 纯净化 AI 会话系统指令与技能斜杠扩展 (DIM-06, CRM-01)。
 * 彻底清除富文本编辑器残留的博客排版指令（如 H1/H2/H3、列表、代码块等），
 * 专注于 AI 会话、系统控制与工作台能力调度。
 *
 * CI Guardrail: Max 400 lines of effective code, UTF-8 无 BOM.
 */

import { Extension } from '@tiptap/core';
import Suggestion, { exitSuggestion } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import { TiptapSlashMenu } from './TiptapSlashMenu';
import type { SlashCommandItem } from './composerTypes';
import {
  calculateSafeCursorAnchor,
  measureCursorLineBox,
} from './safeCursorAnchor';

export interface AiSlashExtensionOptions {
  extraCommandsRef?: { current: SlashCommandItem[] };
  onExecuteCommand?: (cmd: SlashCommandItem) => void;
  listboxId?: string;
}

export const AI_SYSTEM_COMMANDS: SlashCommandItem[] = [
  {
    id: 'goal',
    title: '/goal',
    description: '开启长程自主推进模式，直到彻底达成目标',
    iconName: 'Target',
    keywords: ['goal', '目标', '长程', '推进', 'autonomous'],
    command: ({ editor, range }: any) => {
      editor.chain().focus().deleteRange(range).insertContent('/goal ').run();
    },
  },
  {
    id: 'clear',
    title: '/clear',
    description: '清空当前会话上下文并重置状态',
    iconName: 'Eraser',
    keywords: ['clear', '清空', '重置', 'reset', 'cls'],
    command: ({ editor, range }: any) => {
      editor.chain().focus().deleteRange(range).run();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('crish:chat-clear'));
      }
    },
  },
  {
    id: 'stop',
    title: '/stop',
    description: '停止当前正在生成的回答或运行中的任务',
    iconName: 'Square',
    keywords: ['stop', '停止', '终止', 'cancel', 'abort'],
    command: ({ editor, range }: any) => {
      editor.chain().focus().deleteRange(range).run();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('crish:chat-stop'));
      }
    },
  },
  {
    id: 'mode',
    title: '/mode',
    description: '切换智能体权限与执行模式 (Auto/Approval/ReadOnly)',
    iconName: 'Sliders',
    keywords: ['mode', '模式', '权限', 'permission'],
    command: ({ editor, range }: any) => {
      editor.chain().focus().deleteRange(range).insertContent('/mode ').run();
    },
  },
  {
    id: 'prompt',
    title: '/prompt',
    description: '插入常用系统提示词或自定义指令模板',
    iconName: 'FileCode',
    keywords: ['prompt', '提示词', '指令', 'template'],
    command: ({ editor, range }: any) => {
      editor.chain().focus().deleteRange(range).insertContent('/prompt ').run();
    },
  },
  {
    id: 'compact',
    title: '/compact',
    description: '手动压缩会话历史，释放 Token 空间 (/compact [tokens])',
    iconName: 'Shrink',
    keywords: ['compact', '压缩', 'compress', 'token', '瘦身'],
    command: ({ editor, range }: any) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent('/compact ')
        .run();
    },
  },
  {
    id: 'schedule',
    title: '/schedule',
    description: '设置一次性定时提醒或周期性自动化 Cron 任务',
    iconName: 'Calendar',
    keywords: ['schedule', '定时', 'cron', 'timer', '计划'],
    command: ({ editor, range }: any) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent('/schedule ')
        .run();
    },
  },
  {
    id: 'grill-me',
    title: '/grill-me',
    description: '启动深度需求访谈与方案对齐，澄清设计决策',
    iconName: 'HelpCircle',
    keywords: ['grill-me', '访谈', '对齐', '需求', 'interview'],
    command: ({ editor, range }: any) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent('/grill-me ')
        .run();
    },
  },
  {
    id: 'teamwork',
    title: '/teamwork-preview',
    description: '唤起多 Agent 团队协同架构与运行拓扑预览',
    iconName: 'Users',
    keywords: ['teamwork', '团队', '多agent', 'subagent', 'preview'],
    command: ({ editor, range }: any) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent('/teamwork-preview ')
        .run();
    },
  },
  {
    id: 'browser',
    title: '/browser',
    description: '启动受管浏览器自动化能力（打开网页/提取/交互）',
    iconName: 'Globe',
    keywords: ['browser', '浏览器', 'web', '网页', 'chrome'],
    command: ({ editor, range }: any) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent('/browser ')
        .run();
    },
  },
  {
    id: 'learn',
    title: '/learn',
    description: '沉淀当前会话的踩坑经验与自定义规则至技能库',
    iconName: 'BookOpen',
    keywords: ['learn', '学习', '经验', '规则', 'persist'],
    command: ({ editor, range }: any) => {
      editor.chain().focus().deleteRange(range).insertContent('/learn ').run();
    },
  },
  {
    id: 'settings',
    title: '/settings',
    description: '打开全局系统设置中心（模型/外观/扩展/权限）',
    iconName: 'Sparkles',
    keywords: ['settings', '设置', '偏好', 'config', 'preferences'],
    command: ({ editor, range }: any) => {
      editor.chain().focus().deleteRange(range).run();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('crish:open-settings'));
      }
    },
  },
  {
    id: 'help',
    title: '/help',
    description: '查看系统所有可用斜杠指令与快捷键说明',
    iconName: 'HelpCircle',
    keywords: ['help', '帮助', '说明', 'shortcuts'],
    command: ({ editor, range }: any) => {
      editor.chain().focus().deleteRange(range).insertContent('/help').run();
    },
  },
];

export const aiCommandSlashPluginKey = new PluginKey('crishAiCommandSlash');

export const AiCommandSlashExtension =
  Extension.create<AiSlashExtensionOptions>({
    name: 'aiCommandSlash',

    addOptions() {
      return {
        extraCommandsRef: undefined,
        onExecuteCommand: undefined,
        listboxId: 'crish-ai-composer-slash-listbox',
      };
    },

    addProseMirrorPlugins() {
      return [
        Suggestion({
          pluginKey: aiCommandSlashPluginKey,
          editor: this.editor,
          char: '/',
          allowSpaces: false,
          startOfLine: false,

          items: ({ query }: { query: string }): SlashCommandItem[] => {
            const q = query.trim().toLowerCase();
            const extras = this.options.extraCommandsRef?.current || [];
            const seen = new Set<string>();
            const pool: SlashCommandItem[] = [];

            for (const item of [...extras, ...AI_SYSTEM_COMMANDS]) {
              const key = item.title.toLowerCase().trim();
              if (!seen.has(key)) {
                seen.add(key);
                pool.push(item);
              }
            }

            if (!q) return pool;

            return pool.filter((item) => {
              if (item.title.toLowerCase().includes(q)) return true;
              if (item.id.toLowerCase().includes(q)) return true;
              if (item.description?.toLowerCase().includes(q)) return true;
              return item.keywords?.some((k) => k.toLowerCase().includes(q));
            });
          },

          render: () => {
            let component: ReactRenderer<any> | null = null;
            let propsRef: any = null;
            let lastCachedBox: DOMRect | null = null;

            const buildProps = (props: any) => ({
              items: props.items,
              command: (item: SlashCommandItem) => {
                item.command({ editor: props.editor, range: props.range });
                this.options.onExecuteCommand?.(item);
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

                // CJK 组合态坐标保持静止
                if (view.composing || (view as any).input?.composing) {
                  return lastCachedBox;
                }

                try {
                  const rawBox = measureCursorLineBox(
                    view,
                    props.range.from,
                    1
                  );
                  const safeAnchor = calculateSafeCursorAnchor({
                    rawCursorRect: rawBox,
                    editorViewDom: view.dom,
                  });
                  if (safeAnchor) {
                    lastCachedBox = new DOMRect(
                      safeAnchor.left,
                      safeAnchor.top,
                      safeAnchor.width,
                      safeAnchor.height
                    );
                    return lastCachedBox;
                  }
                  return lastCachedBox;
                } catch {
                  return lastCachedBox;
                }
              },
              label: 'AI 会话系统指令',
              emptyMessage: '未找到匹配的 AI 指令或技能',
              listboxId: this.options.listboxId,
            });

            return {
              onStart: (props: any) => {
                propsRef = props;
                const dom = props.editor?.view?.dom;
                if (dom) {
                  if (this.options.listboxId) {
                    dom.setAttribute('aria-controls', this.options.listboxId);
                  }
                  dom.setAttribute('aria-expanded', 'true');
                }
                component = new ReactRenderer(TiptapSlashMenu, {
                  props: buildProps(props),
                  editor: props.editor,
                });
              },

              onUpdate: (props: any) => {
                propsRef = props;
                if (component) {
                  component.updateProps(buildProps(props));
                }
              },

              onKeyDown: (props: any) => {
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
                  if (props.view) {
                    exitSuggestion(props.view, aiCommandSlashPluginKey);
                  }
                  return true;
                }
                return (component?.ref as any)?.onKeyDown(props) ?? false;
              },

              onExit: () => {
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
          },
        }),
      ];
    },
  });
