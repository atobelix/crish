/**
 * blockMenuSections — 上下文感知菜单项注册表
 *
 * 根据块类型（typeName）返回该块专属的菜单区段。
 * 通用项在 BlockMenu.tsx 中硬编码，此文件只管「按块类型动态插入」的部分。
 *
 * ── 设计原则 ──────────────────────────────────────────
 *   每个区段有可选标题（分组标题）。
 *   每项可以是 action / toggle / expandable 三种类型：
 *     action:     点击执行，关闭菜单
 *     toggle:     开关，不关闭菜单
 *     expandable: 右侧箭头，展开子面板
 */

import type { Editor } from '@tiptap/core';
import type { LucideIcon } from 'lucide-react';
import {
  Type, Heading1, Heading2, Heading3,
  List, ListOrdered, CheckSquare, Quote, Code,
  WrapText, Hash, FileCode2, Layers,
  AlignLeft, AlignCenter, AlignRight,
  ImageIcon, Replace, CaptionsIcon,
  MoreHorizontal,
} from 'lucide-react';

/* ════════════════════════════════════════════
 * 公共类型
 * ════════════════════════════════════════════ */

export interface BlockMenuSection {
  title?: string;
  items: BlockMenuItem[];
}

export interface BlockMenuItem {
  id: string;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  danger?: boolean;
  /** 子菜单箭头 */
  expandable?: boolean;
  /** 开关类型 */
  toggle?: boolean;
  toggleValue?: boolean;
  /** 执行动作 */
  run: () => void;
}

/* ════════════════════════════════════════════
 * 转换为选项（所有块共享）
 * ════════════════════════════════════════════ */

export interface TurnIntoOption {
  id: string;
  label: string;
  icon: LucideIcon;
  matches: (typeName: string, level?: number) => boolean;
  run: (editor: Editor) => void;
}

export const TURN_INTO: TurnIntoOption[] = [
  {
    id: 'p', label: '正文', icon: Type,
    matches: (t) => t === 'paragraph',
    run: (e) => e.chain().focus().setHeadingLevel(0).run(),
  },
  {
    id: 'h1', label: '标题 1', icon: Heading1,
    matches: (t, l) => t === 'heading' && l === 1,
    run: (e) => e.chain().focus().setHeadingLevel(1).run(),
  },
  {
    id: 'h2', label: '标题 2', icon: Heading2,
    matches: (t, l) => t === 'heading' && l === 2,
    run: (e) => e.chain().focus().setHeadingLevel(2).run(),
  },
  {
    id: 'h3', label: '标题 3', icon: Heading3,
    matches: (t, l) => t === 'heading' && l === 3,
    run: (e) => e.chain().focus().setHeadingLevel(3).run(),
  },
  {
    id: 'bullet', label: '项目符号列表', icon: List,
    matches: (t) => t === 'bulletList',
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'ordered', label: '编号列表', icon: ListOrdered,
    matches: (t) => t === 'orderedList',
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    id: 'task', label: '待办事项', icon: CheckSquare,
    matches: (t) => t === 'taskList',
    run: (e) => e.chain().focus().toggleTaskList().run(),
  },
  {
    id: 'quote', label: '引用', icon: Quote,
    matches: (t) => t === 'blockquote',
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    id: 'code', label: '代码块', icon: Code,
    matches: (t) => t === 'codeBlock',
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
];

/* ════════════════════════════════════════════
 * 按块类型返回专属菜单区段
 * ════════════════════════════════════════════ */

export function getBlockSpecificSections(
  typeName: string,
  editor: Editor,
  pos: number,
): BlockMenuSection[] {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return [];

  switch (typeName) {
    case 'codeBlock': {
      const wrap = node.attrs.wordWrap ?? false;
      const lineNumbers = node.attrs.showLineNumbers !== false;
      return [{
        title: '代码',
        items: [
          {
            id: 'codeTitle', label: '标题', icon: FileCode2,
            shortcut: 'Ctrl+Alt+M',
            run: () => { /* 标题编辑由代码块内部 More 面板处理 */ },
          },
          {
            id: 'copyCode', label: '拷贝代码', icon: Layers,
            run: () => {
              navigator.clipboard.writeText(node.textContent).catch(() => {});
            },
          },
          {
            id: 'wordWrap', label: '代码换行', icon: WrapText,
            toggle: true,
            toggleValue: wrap,
            run: () => {
              const tr = editor.state.tr;
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, wordWrap: !wrap });
              editor.view.dispatch(tr);
            },
          },
          {
            id: 'lineNumbers', label: '行号', icon: Hash,
            toggle: true,
            toggleValue: lineNumbers,
            run: () => {
              const tr = editor.state.tr;
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, showLineNumbers: !lineNumbers });
              editor.view.dispatch(tr);
            },
          },
          {
            id: 'language', label: '语言', icon: Code,
            expandable: true,
            run: () => { /* 展开子面板 */ },
          },
          {
            id: 'moreOptions', label: '更多选项', icon: MoreHorizontal,
            expandable: true,
            run: () => { /* 展开子面板 */ },
          },
        ],
      }];
    }

    case 'imageBlock': {
      return [{
        title: '图片',
        items: [
          {
            id: 'alignLeft', label: '左对齐', icon: AlignLeft,
            run: () => {
              const tr = editor.state.tr;
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, align: 'left' });
              editor.view.dispatch(tr);
            },
          },
          {
            id: 'alignCenter', label: '居中', icon: AlignCenter,
            run: () => {
              const tr = editor.state.tr;
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, align: 'center' });
              editor.view.dispatch(tr);
            },
          },
          {
            id: 'alignRight', label: '右对齐', icon: AlignRight,
            run: () => {
              const tr = editor.state.tr;
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, align: 'right' });
              editor.view.dispatch(tr);
            },
          },
          {
            id: 'caption', label: '说明文字', icon: CaptionsIcon,
            run: () => { /* 聚焦到 caption 输入框 */ },
          },
          {
            id: 'replace', label: '替换图片', icon: Replace,
            run: () => { /* 打开文件选择器 */ },
          },
        ],
      }];
    }

    case 'videoBlock':
    case 'embedBlock': {
      return [{
        title: '嵌入',
        items: [
          {
            id: 'replace', label: '替换 URL', icon: Replace,
            run: () => { /* 打开 URL 输入 */ },
          },
        ],
      }];
    }

    case 'audioBlock': {
      return [{
        title: '音频',
        items: [
          {
            id: 'replace', label: '替换文件', icon: Replace,
            run: () => { /* 打开文件选择器 */ },
          },
        ],
      }];
    }

    default:
      return [];
  }
}
