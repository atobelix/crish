/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * apps/crish-desktop/src/components/chat-composer/AiCommandSlashExtension.ts
 * 纯净化 AI 会话系统指令集定义 (DIM-06, CRM-01)。
 * 彻底清除富文本编辑器残留的博客排版指令（如 H1/H2/H3、列表、代码块等），
 * 专注于 AI 会话、系统控制与工作台能力调度。
 */

import type { SlashCommandItem } from './composerTypes';
import { dispatchUiEvent } from '../../api/uiEvents';
import { openSettings } from '../../store/storeAccess';

export function extractEditorScopeTarget(editor: any): {
  sessionId?: string;
  leafId?: string;
} {
  try {
    const dom = editor?.view?.dom as HTMLElement | null | undefined;
    if (!dom || typeof dom.closest !== 'function') return {};
    const leafEl = dom.closest<HTMLElement>('[data-leaf-id]');
    const sessionEl = dom.closest<HTMLElement>('[data-session-id]');
    const leafId = leafEl?.getAttribute('data-leaf-id') || undefined;
    const sessionId = sessionEl?.getAttribute('data-session-id') || undefined;
    return { sessionId, leafId };
  } catch {
    return {};
  }
}

export const AI_SYSTEM_COMMANDS: SlashCommandItem[] = [
  {
    id: 'goal',
    title: '/goal',
    description: '开启长程自主推进模式，直到彻底达成目标',
    iconName: 'target',
    keywords: ['goal', '目标', '长程', '推进', 'autonomous'],
    command: ({ editor, range }: any) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent([
          {
            type: 'mention',
            attrs: {
              id: '/goal',
              label: '/goal',
              kind: 'command',
              iconName: 'target',
            },
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    },
  },
  {
    id: 'compact',
    title: '/compact',
    description: '手动触发会话上下文摘要压缩，释放 Token 预算',
    iconName: 'sliders',
    keywords: ['compact', '压缩', '摘要', 'summarize', 'budget'],
    command: ({ editor, range }: any) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent([
          {
            type: 'mention',
            attrs: {
              id: '/compact',
              label: '/compact',
              kind: 'command',
              iconName: 'sliders',
            },
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    },
  },
  {
    id: 'schedule',
    title: '/schedule',
    description: '安排一次性定时提醒或周期性 Cron 任务',
    iconName: 'clock',
    keywords: ['schedule', '定时', '计划', 'cron', 'timer'],
    command: ({ editor, range }: any) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent([
          {
            type: 'mention',
            attrs: {
              id: '/schedule',
              label: '/schedule',
              kind: 'command',
              iconName: 'clock',
            },
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    },
  },
  {
    id: 'browser',
    title: '/browser',
    description: '唤起内置受管浏览器自动化插件并导航至指定 URL',
    iconName: 'compass',
    keywords: ['browser', '浏览器', 'web', '网页', 'navigate'],
    command: ({ editor, range }: any) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent([
          {
            type: 'mention',
            attrs: {
              id: '/browser',
              label: '/browser',
              kind: 'command',
              iconName: 'compass',
            },
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    },
  },
  {
    id: 'teamwork',
    title: '/teamwork',
    description: '预览多 Agent 团队并行协同分工与执行流水线',
    iconName: 'users',
    keywords: ['teamwork', '协同', '多Agent', 'pipeline', 'preview'],
    command: ({ editor, range }: any) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent([
          {
            type: 'mention',
            attrs: {
              id: '/teamwork',
              label: '/teamwork',
              kind: 'command',
              iconName: 'users',
            },
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    },
  },
  {
    id: 'learn',
    title: '/learn',
    description: '从当前会话与调试经验中提取长期模式记忆',
    iconName: 'book-open',
    keywords: ['learn', '记忆', '学习', 'persist', 'memory'],
    command: ({ editor, range }: any) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent([
          {
            type: 'mention',
            attrs: {
              id: '/learn',
              label: '/learn',
              kind: 'command',
              iconName: 'book-open',
            },
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    },
  },
  {
    id: 'grill-me',
    title: '/grill-me',
    description: '进入深度交互式方案推演模式，对设计决策进行严格拷问',
    iconName: 'flame',
    keywords: ['grill', '拷问', '推演', 'interview', 'review'],
    command: ({ editor, range }: any) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent([
          {
            type: 'mention',
            attrs: {
              id: '/grill-me',
              label: '/grill-me',
              kind: 'command',
              iconName: 'flame',
            },
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    },
  },
  {
    id: 'clear',
    title: '/clear',
    description: '清空当前会话上下文并重置状态',
    iconName: 'eraser',
    keywords: ['clear', '清空', '重置', 'reset', 'cls'],
    command: ({ editor, range }: any) => {
      editor.chain().focus().deleteRange(range).run();
      const target = extractEditorScopeTarget(editor);
      dispatchUiEvent('clear-current-session', target);
    },
  },
  {
    id: 'stop',
    title: '/stop',
    description: '停止当前正在生成的回答或运行中的任务',
    iconName: 'cancel-circle',
    keywords: ['stop', '停止', '终止', 'cancel', 'abort'],
    command: ({ editor, range }: any) => {
      editor.chain().focus().deleteRange(range).run();
      const target = extractEditorScopeTarget(editor);
      dispatchUiEvent('stop-generation', target);
    },
  },
  {
    id: 'settings',
    title: '/settings',
    description: '打开工作台设置中心（模型、快捷键、插件与通用偏好）',
    iconName: 'settings',
    keywords: ['settings', '设置', '偏好', 'config', 'preferences'],
    command: ({ editor, range }: any) => {
      editor.chain().focus().deleteRange(range).run();
      openSettings();
    },
  },
];
