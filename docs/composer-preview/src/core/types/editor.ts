/**
 * Conex Composer — Editor Type Definitions
 *
 * 编辑器层面的通用类型：菜单项、命令、事件等。
 */

import type { Editor, Range } from '@tiptap/core';
import type { CalloutType } from './blocks';

/* ================================================================
 * Slash Command 菜单
 * ================================================================ */

/** Slash 命令项的分类 */
export type SlashCommandCategory =
  | 'basic'        // 基础区块
  | 'lists'        // 列表
  | 'callouts'     // 提示框
  | 'formatting'   // 文本格式化
  | 'media'        // 媒体
  | 'data'         // 数据 & 代码
  | 'advanced'     // 高级区块
  | 'inline'       // 行内元素
  | 'embeds'       // 嵌入
  | 'ai'           // AI 功能
  | 'layout';      // 布局

/** Slash 命令项 */
export interface SlashCommandItem {
  /** 唯一标识 */
  id: string;
  /** 显示标题 */
  title: string;
  /** 描述文字 */
  description: string;
  /** 搜索关键词（中文拼音、英文缩写等） */
  searchTerms: string[];
  /** Lucide 图标名称 */
  iconName: string;
  /** 所属分类 */
  category: SlashCommandCategory;
  /** 执行命令 */
  command: (params: { editor: Editor; range: Range }) => void;
  /** 键盘快捷键提示（仅用于显示） */
  shortcut?: string;
}

/* ================================================================
 * Bubble Menu（选区浮动菜单）
 * ================================================================ */

export interface BubbleMenuItem {
  id: string;
  label: string;
  iconName: string;
  action: (editor: Editor) => void;
  isActive: (editor: Editor) => boolean;
  shortcut?: string;
}

/* ================================================================
 * Block Menu（块级右键菜单）
 * ================================================================ */

export type BlockMenuAction =
  | 'delete'
  | 'duplicate'
  | 'copy'
  | 'cut'
  | 'move_up'
  | 'move_down'
  | 'turn_into'    // 转换区块类型
  | 'color'        // 设置颜色
  | 'comment';     // 添加评论

export interface BlockMenuItem {
  id: string;
  label: string;
  iconName: string;
  action: BlockMenuAction;
  shortcut?: string;
  disabled?: boolean;
  dividerAfter?: boolean;
  children?: BlockMenuItem[]; // 子菜单
}

/* ================================================================
 * Callout 配置
 * ================================================================ */

export interface CalloutConfig {
  type: CalloutType;
  icon: string;
  label: string;
  fgColor: string;
  bgColor: string;
}

export const CALLOUT_CONFIGS: Record<CalloutType, CalloutConfig> = {
  note: {
    type: 'note',
    icon: 'ℹ️',
    label: 'Note',
    fgColor: 'var(--callout-border-note)',
    bgColor: 'var(--callout-bg-note)',
  },
  tip: {
    type: 'tip',
    icon: '💡',
    label: 'Tip',
    fgColor: 'var(--callout-border-tip)',
    bgColor: 'var(--callout-bg-tip)',
  },
  important: {
    type: 'important',
    icon: '🔮',
    label: 'Important',
    fgColor: 'var(--callout-border-important)',
    bgColor: 'var(--callout-bg-important)',
  },
  warning: {
    type: 'warning',
    icon: '⚠️',
    label: 'Warning',
    fgColor: 'var(--callout-border-warning)',
    bgColor: 'var(--callout-bg-warning)',
  },
  caution: {
    type: 'caution',
    icon: '🛑',
    label: 'Caution',
    fgColor: 'var(--callout-border-caution)',
    bgColor: 'var(--callout-bg-caution)',
  },
};

/* ================================================================
 * TOC（目录大纲）
 * ================================================================ */

export interface HeadingItem {
  id: string;
  text: string;
  level: number;
  pos: number;
}

/* ================================================================
 * 标签索引
 * ================================================================ */

export interface TagIndexItem {
  tag: string;
  count: number;
  sectionNames: string[];
}

/* ================================================================
 * 编辑器事件
 * ================================================================ */

export interface EditorEventMap {
  'block:select': { pos: number; nodeType: string };
  'block:hover': { pos: number; nodeType: string };
  'block:delete': { pos: number; nodeType: string };
  'slash:open': { pos: number };
  'slash:close': void;
  'mention:search': { query: string; type: string };
  'database:update': { databaseId: string };
}
