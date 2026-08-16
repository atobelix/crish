/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * apps/crish-desktop/src/components/chat-composer/AiCommandSlashExtension.ts
 * 纯净化 AI 会话系统指令集定义 (DIM-06, CRM-01)。
 * 彻底清除富文本编辑器残留的博客排版指令（如 H1/H2/H3、列表、代码块等），
 * 专注于 AI 会话、系统控制与工作台能力调度。
 */

import type { SlashCommandItem } from './composerTypes';

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
    description: '切换权限模式（只读审查 / 工作区修改 / 完全访问）',
    iconName: 'Shield',
    keywords: ['mode', '权限', '模式', 'permission', 'safe'],
    command: ({ editor, range }: any) => {
      editor.chain().focus().deleteRange(range).insertContent('/mode ').run();
    },
  },
  {
    id: 'prompt',
    title: '/prompt',
    description: '插入系统提示词或预设指令模板',
    iconName: 'FileCode',
    keywords: ['prompt', '提示词', '模板', 'template'],
    command: ({ editor, range }: any) => {
      editor.chain().focus().deleteRange(range).insertContent('/prompt ').run();
    },
  },
  {
    id: 'compact',
    title: '/compact',
    description: '手动触发会话上下文摘要压缩，释放 Token 预算',
    iconName: 'Sliders',
    keywords: ['compact', '压缩', '摘要', 'summarize', 'budget'],
    command: ({ editor, range }: any) => {
      editor.chain().focus().deleteRange(range).run();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('crish:chat-compact'));
      }
    },
  },
  {
    id: 'schedule',
    title: '/schedule',
    description: '安排一次性定时提醒或周期性 Cron 任务',
    iconName: 'Clock',
    keywords: ['schedule', '定时', '计划', 'cron', 'timer'],
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
    description: '进入深度交互式方案推演模式，对设计决策进行严格拷问',
    iconName: 'Flame',
    keywords: ['grill', '拷问', '推演', 'interview', 'review'],
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
    id: 'teamwork-preview',
    title: '/teamwork-preview',
    description: '预览多 Agent 团队并行协同分工与执行流水线',
    iconName: 'Users',
    keywords: ['teamwork', '协同', '多Agent', 'pipeline', 'preview'],
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
    description: '唤起内置受管浏览器自动化插件并导航至指定 URL',
    iconName: 'Compass',
    keywords: ['browser', '浏览器', 'web', '网页', 'navigate'],
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
    description: '从当前会话与调试经验中提取长期模式记忆',
    iconName: 'BookOpen',
    keywords: ['learn', '记忆', '学习', 'persist', 'memory'],
    command: ({ editor, range }: any) => {
      editor.chain().focus().deleteRange(range).insertContent('/learn ').run();
    },
  },
  {
    id: 'settings',
    title: '/settings',
    description: '打开工作台设置中心（模型、快捷键、插件与通用偏好）',
    iconName: 'Settings',
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
