/**
 * BlockMenu — 区块右键/转换菜单
 *
 * 参考 Notion 截图中的右键菜单：
 * - 转换成（子菜单展示所有区块类型）
 * - 颜色（文字/背景颜色选择）
 * - 拷贝区块链接
 * - 创建副本
 * - 移动到
 * - 删除
 * - 评论
 * - 编辑建议
 * - 万事问 AI
 * - 技能
 *
 * 参考 Notion 截图中"转换成"子菜单的图标 + 文字排列。
 */

import React, { useCallback, useState } from 'react';
import type { Editor } from '@tiptap/core';
import {
  ArrowUpDown, Copy, Link2, Trash2, MessageSquare,
  Pencil, Bot, Zap, MoveHorizontal, Palette,
  Type, Heading1, Heading2, Heading3, Heading4,
  List, ListOrdered, CheckSquare, ChevronRight,
  Quote, Code, AlertCircle, Sigma,
  Link, RefreshCw,
} from 'lucide-react';
import { ContextMenu, useContextMenu } from '../ui/ContextMenu';
import type { ContextMenuItem } from '../ui/ContextMenu';

interface BlockMenuProps {
  editor: Editor;
  /** 当前块的 ProseMirror 位置 */
  blockPos: number;
}

/**
 * 构建区块右键菜单项列表（参考 Notion 截图）
 */
function buildBlockMenuItems(editor: Editor): ContextMenuItem[] {
  return [
    {
      id: 'turn_into',
      label: '转换成',
      icon: <RefreshCw size={15} />,
      children: [
        { id: 'turn_text', label: '文本', icon: <Type size={15} /> },
        { id: 'turn_h1', label: '标题 1', icon: <Heading1 size={15} /> },
        { id: 'turn_h2', label: '标题 2', icon: <Heading2 size={15} /> },
        { id: 'turn_h3', label: '标题 3', icon: <Heading3 size={15} /> },
        { id: 'turn_h4', label: '标题 4', icon: <Heading4 size={15} /> },
        { id: 'turn_bullet', label: '项目符号列表', icon: <List size={15} /> },
        { id: 'turn_ordered', label: '有序列表', icon: <ListOrdered size={15} /> },
        { id: 'turn_task', label: '待办事项', icon: <CheckSquare size={15} /> },
        { id: 'turn_toggle', label: '折叠列表', icon: <ChevronRight size={15} /> },
        { id: 'turn_code', label: '代码', icon: <Code size={15} /> },
        { id: 'turn_quote', label: '引用', icon: <Quote size={15} /> },
        { id: 'turn_callout', label: '标注', icon: <AlertCircle size={15} /> },
        { id: 'turn_math', label: '公式区块', icon: <Sigma size={15} /> },
        { id: 'turn_synced', label: '同步区块', icon: <Link size={15} /> },
        { id: 'turn_toggle_h1', label: '折叠标题 1', icon: <Heading1 size={15} /> },
        { id: 'turn_toggle_h2', label: '折叠标题 2', icon: <Heading2 size={15} /> },
        { id: 'turn_toggle_h3', label: '折叠标题 3', icon: <Heading3 size={15} /> },
      ],
    },
    {
      id: 'color',
      label: '颜色',
      icon: <Palette size={15} />,
      dividerAfter: true,
      children: buildColorMenuItems(),
    },
    {
      id: 'copy_link',
      label: '拷贝区块链接',
      icon: <Link2 size={15} />,
      shortcut: 'Alt+Shift+L',
    },
    {
      id: 'duplicate',
      label: '创建副本',
      icon: <Copy size={15} />,
      shortcut: 'Ctrl+D',
    },
    {
      id: 'move_to',
      label: '移动到',
      icon: <MoveHorizontal size={15} />,
      shortcut: 'Ctrl+Shift+P',
      dividerAfter: true,
    },
    {
      id: 'delete',
      label: '删除',
      icon: <Trash2 size={15} />,
      shortcut: 'Del',
      danger: true,
      dividerAfter: true,
    },
    {
      id: 'comment',
      label: '评论',
      icon: <MessageSquare size={15} />,
      shortcut: 'Ctrl+Shift+M',
    },
    {
      id: 'suggest_edit',
      label: '编辑建议',
      icon: <Pencil size={15} />,
      shortcut: 'Ctrl+Alt+X',
      dividerAfter: true,
    },
    {
      id: 'ask_ai',
      label: '万事问 AI',
      icon: <Bot size={15} />,
      shortcut: 'Ctrl+J',
    },
    {
      id: 'skills',
      label: '技能',
      icon: <Zap size={15} />,
      children: [
        { id: 'skill_summarize', label: '总结' },
        { id: 'skill_translate', label: '翻译' },
        { id: 'skill_expand', label: '扩展' },
        { id: 'skill_simplify', label: '简化' },
      ],
    },
  ];
}

/**
 * 构建颜色子菜单（文字和背景）
 */
function buildColorMenuItems(): ContextMenuItem[] {
  const colors = [
    { id: 'default', label: '默认' },
    { id: 'gray', label: '灰色' },
    { id: 'brown', label: '棕色' },
    { id: 'orange', label: '橙色' },
    { id: 'yellow', label: '黄色' },
    { id: 'green', label: '绿色' },
    { id: 'blue', label: '蓝色' },
    { id: 'purple', label: '紫色' },
    { id: 'pink', label: '粉色' },
    { id: 'red', label: '红色' },
  ];

  return [
    ...colors.map(c => ({
      id: `fg_${c.id}`,
      label: `${c.label}文字`,
      icon: <span style={{ color: `var(--color-${c.id})`, fontWeight: 700 }}>A</span>,
    })),
    { id: 'color_divider', label: '背景', disabled: true },
    ...colors.map(c => ({
      id: `bg_${c.id}`,
      label: `${c.label}背景`,
      icon: <span style={{
        backgroundColor: `var(--bg-color-${c.id})`,
        width: 16, height: 16,
        borderRadius: 3,
        display: 'inline-block',
      }} />,
    })),
  ];
}

/**
 * BlockMenu 组件
 *
 * 使用方式：
 * ```tsx
 * <BlockMenu editor={editor} blockPos={pos} />
 * ```
 */
export const BlockMenu: React.FC<BlockMenuProps> = ({ editor, blockPos }) => {
  const { state, handleContextMenu, close } = useContextMenu();

  const handleSelect = useCallback((actionId: string) => {
    // 转换成
    if (actionId.startsWith('turn_')) {
      const type = actionId.replace('turn_', '');
      switch (type) {
        case 'text': editor.chain().focus().setParagraph().run(); break;
        case 'h1': editor.chain().focus().toggleHeading({ level: 1 }).run(); break;
        case 'h2': editor.chain().focus().toggleHeading({ level: 2 }).run(); break;
        case 'h3': editor.chain().focus().toggleHeading({ level: 3 }).run(); break;
        case 'h4': editor.chain().focus().toggleHeading({ level: 4 }).run(); break;
        case 'bullet': editor.chain().focus().toggleBulletList().run(); break;
        case 'ordered': editor.chain().focus().toggleOrderedList().run(); break;
        case 'task': editor.chain().focus().toggleTaskList().run(); break;
        case 'code': editor.chain().focus().toggleCodeBlock().run(); break;
        case 'quote': editor.chain().focus().toggleBlockquote().run(); break;
      }
      return;
    }

    // 颜色
    if (actionId.startsWith('fg_')) {
      const color = actionId.replace('fg_', '');
      if (color === 'default') {
        editor.chain().focus().unsetColor().run();
      } else {
        editor.chain().focus().setColor(`var(--color-${color})`).run();
      }
      return;
    }

    // 其他操作
    switch (actionId) {
      case 'delete':
        editor.chain().focus().deleteNode(editor.state.doc.nodeAt(blockPos)?.type.name ?? 'paragraph').run();
        break;
      case 'duplicate':
        // TODO: implement duplication
        break;
      case 'copy_link':
        // TODO: copy block link
        break;
    }
  }, [editor, blockPos]);

  const items = buildBlockMenuItems(editor);

  return (
    <>
      {/* 右键触发区域由父组件提供 */}
      {state.open && (
        <ContextMenu
          items={items}
          position={state.position}
          onSelect={handleSelect}
          onClose={close}
        />
      )}
    </>
  );
};

export { useContextMenu };
