/**
 * CommandPalette — 全局命令搜索面板
 *
 * Ctrl+K 唤起，可搜索所有编辑器操作。
 * 支持模糊搜索、键盘导航、分组展示。
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { Editor } from '@tiptap/core';
import {
  Search, Bold, Italic, Strikethrough, Code, Highlighter,
  Heading1, Heading2, Heading3, Type, List, ListOrdered, ListChecks,
  Quote, Minus, Table as TableIcon, Image, Video, Music, FileText,
  Globe, BarChart3, Calculator, Columns2, ToggleLeft, Bookmark,
  Moon, Sun, Download, Copy, Undo2, Redo2, Maximize,
} from 'lucide-react';

interface CommandPaletteProps {
  editor: Editor;
  theme: string;
  onClose: () => void;
  onToggleTheme: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onToggleFocusMode?: () => void;
  onOpenSearch?: (mode: 'find' | 'replace') => void;
  onToggleOutline?: () => void;
}

interface CommandItem {
  id: string;
  label: string;
  group: string;
  shortcut?: string;
  icon: React.FC<{ size?: number }>;
  action: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  editor, theme, onClose, onToggleTheme, onCopy, onDownload,
  onToggleFocusMode, onOpenSearch, onToggleOutline,
}) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 定义所有命令
  const allCommands: CommandItem[] = useMemo(() => [
    // 文本格式
    { id: 'bold', label: '加粗', group: '文本格式', shortcut: 'Ctrl+B', icon: Bold,
      action: () => { editor.chain().focus().toggleBold().run(); onClose(); } },
    { id: 'italic', label: '斜体', group: '文本格式', shortcut: 'Ctrl+I', icon: Italic,
      action: () => { editor.chain().focus().toggleItalic().run(); onClose(); } },
    { id: 'strike', label: '删除线', group: '文本格式', shortcut: 'Ctrl+Shift+S', icon: Strikethrough,
      action: () => { editor.chain().focus().toggleStrike().run(); onClose(); } },
    { id: 'code', label: '行内代码', group: '文本格式', shortcut: 'Ctrl+E', icon: Code,
      action: () => { editor.chain().focus().toggleCode().run(); onClose(); } },
    { id: 'highlight', label: '高亮', group: '文本格式', shortcut: 'Ctrl+Shift+H', icon: Highlighter,
      action: () => { editor.chain().focus().toggleHighlight().run(); onClose(); } },

    // 块类型
    { id: 'paragraph', label: '正文', group: '块类型', shortcut: 'Ctrl+Alt+0', icon: Type,
      action: () => { editor.chain().focus().setParagraph().run(); onClose(); } },
    { id: 'h1', label: '标题 1', group: '块类型', shortcut: 'Ctrl+Alt+1', icon: Heading1,
      action: () => { editor.chain().focus().toggleHeading({ level: 1 }).run(); onClose(); } },
    { id: 'h2', label: '标题 2', group: '块类型', shortcut: 'Ctrl+Alt+2', icon: Heading2,
      action: () => { editor.chain().focus().toggleHeading({ level: 2 }).run(); onClose(); } },
    { id: 'h3', label: '标题 3', group: '块类型', shortcut: 'Ctrl+Alt+3', icon: Heading3,
      action: () => { editor.chain().focus().toggleHeading({ level: 3 }).run(); onClose(); } },
    { id: 'bullet', label: '无序列表', group: '块类型', icon: List,
      action: () => { editor.chain().focus().toggleBulletList().run(); onClose(); } },
    { id: 'ordered', label: '有序列表', group: '块类型', icon: ListOrdered,
      action: () => { editor.chain().focus().toggleOrderedList().run(); onClose(); } },
    { id: 'taskList', label: '任务列表', group: '块类型', icon: ListChecks,
      action: () => { editor.chain().focus().toggleTaskList().run(); onClose(); } },
    { id: 'blockquote', label: '引用', group: '块类型', icon: Quote,
      action: () => { editor.chain().focus().toggleBlockquote().run(); onClose(); } },
    { id: 'divider', label: '分割线', group: '块类型', icon: Minus,
      action: () => { editor.chain().focus().setHorizontalRule().run(); onClose(); } },

    // 插入块
    { id: 'codeblock', label: '代码块', group: '插入', icon: Code,
      action: () => { editor.chain().focus().toggleCodeBlock().run(); onClose(); } },
    { id: 'table', label: '表格', group: '插入', icon: TableIcon,
      action: () => { editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); onClose(); } },
    { id: 'image', label: '图片', group: '插入', icon: Image,
      action: () => { editor.chain().focus().insertContent({ type: 'imageBlock' }).run(); onClose(); } },
    { id: 'video', label: '视频', group: '插入', icon: Video,
      action: () => { editor.chain().focus().insertContent({ type: 'videoBlock' }).run(); onClose(); } },
    { id: 'audio', label: '音频', group: '插入', icon: Music,
      action: () => { editor.chain().focus().insertContent({ type: 'audioBlock' }).run(); onClose(); } },
    { id: 'file', label: '文件', group: '插入', icon: FileText,
      action: () => { editor.chain().focus().insertContent({ type: 'fileBlock' }).run(); onClose(); } },
    { id: 'bookmark', label: '网页书签', group: '插入', icon: Bookmark,
      action: () => { editor.chain().focus().insertContent({ type: 'bookmarkBlock' }).run(); onClose(); } },
    { id: 'embed', label: '嵌入', group: '插入', icon: Globe,
      action: () => { editor.chain().focus().insertContent({ type: 'embedBlock' }).run(); onClose(); } },
    { id: 'chart', label: '图表', group: '插入', icon: BarChart3,
      action: () => { editor.chain().focus().insertContent({ type: 'chartBlock' }).run(); onClose(); } },
    { id: 'math', label: '公式块', group: '插入', icon: Calculator,
      action: () => { editor.chain().focus().insertContent({ type: 'mathBlock' }).run(); onClose(); } },
    { id: 'columns', label: '多列布局', group: '插入', icon: Columns2,
      action: () => { editor.chain().focus().insertContent({ type: 'columnLayout', content: [{ type: 'column', content: [{ type: 'paragraph' }] }, { type: 'column', content: [{ type: 'paragraph' }] }] }).run(); onClose(); } },

    // 编辑器操作
    { id: 'undo', label: '撤销', group: '编辑', shortcut: 'Ctrl+Z', icon: Undo2,
      action: () => { editor.chain().focus().undo().run(); onClose(); } },
    { id: 'redo', label: '重做', group: '编辑', shortcut: 'Ctrl+Shift+Z', icon: Redo2,
      action: () => { editor.chain().focus().redo().run(); onClose(); } },
    { id: 'find', label: '搜索', group: '编辑', shortcut: 'Ctrl+F', icon: Search,
      action: () => { onClose(); onOpenSearch?.('find'); } },
    { id: 'replace', label: '搜索替换', group: '编辑', shortcut: 'Ctrl+H', icon: Search,
      action: () => { onClose(); onOpenSearch?.('replace'); } },

    // 视图
    { id: 'theme', label: theme === 'dark' ? '切换为亮色' : '切换为暗色', group: '视图',
      icon: theme === 'dark' ? Sun : Moon,
      action: () => { onToggleTheme(); onClose(); } },
    { id: 'outline', label: '切换大纲侧边栏', group: '视图',
      icon: ListOrdered,
      action: () => { onToggleOutline?.(); onClose(); } },
    { id: 'focus', label: '专注模式', group: '视图', shortcut: 'F11', icon: Maximize,
      action: () => { onToggleFocusMode?.(); onClose(); } },

    // 导出
    { id: 'copy-md', label: '复制为 Markdown', group: '导出', shortcut: 'Ctrl+Shift+C', icon: Copy,
      action: () => { onCopy(); onClose(); } },
    { id: 'download-md', label: '下载 .md 文件', group: '导出', icon: Download,
      action: () => { onDownload(); onClose(); } },
  ], [editor, theme, onClose, onToggleTheme, onCopy, onDownload, onOpenSearch, onToggleOutline, onToggleFocusMode]);

  // 模糊搜索
  const filtered = useMemo(() => {
    if (!query.trim()) return allCommands;
    const q = query.toLowerCase();
    return allCommands.filter(cmd =>
      cmd.label.toLowerCase().includes(q) ||
      cmd.id.toLowerCase().includes(q) ||
      cmd.group.toLowerCase().includes(q),
    );
  }, [query, allCommands]);

  // 按组分组
  const grouped = useMemo(() => {
    const groups: Record<string, CommandItem[]> = {};
    for (const cmd of filtered) {
      (groups[cmd.group] ??= []).push(cmd);
    }
    return groups;
  }, [filtered]);

  // 扁平列表（用于键盘导航）
  const flatList = useMemo(() => filtered, [filtered]);

  // 重置索引
  useEffect(() => { setActiveIndex(0); }, [query]);

  // 键盘导航
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, flatList.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      flatList[activeIndex]?.action();
    }
  }, [flatList, activeIndex, onClose]);

  // 滚动活动项到可见区域
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector('.is-active');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  let itemIdx = 0;

  return (
    <>
      <div className="command-palette-overlay" onClick={onClose} />
      <div className="command-palette" onKeyDown={handleKeyDown}>
        {/* 搜索栏 */}
        <div className="command-palette__search">
          <Search size={16} className="command-palette__search-icon" />
          <input
            ref={inputRef}
            className="command-palette__input"
            placeholder="输入命令…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {/* 命令列表 */}
        <div className="command-palette__list" ref={listRef}>
          {flatList.length === 0 ? (
            <div className="command-palette__empty">
              <span>没有匹配的命令</span>
            </div>
          ) : (
            Object.entries(grouped).map(([group, items]) => (
              <div key={group}>
                <div className="command-palette__group-title">{group}</div>
                {items.map(cmd => {
                  const idx = itemIdx++;
                  return (
                    <button
                      key={cmd.id}
                      type="button"
                      className={`command-palette__item ${idx === activeIndex ? 'is-active' : ''}`}
                      onClick={cmd.action}
                      onMouseEnter={() => setActiveIndex(idx)}
                    >
                      <span className="command-palette__item-icon">
                        <cmd.icon size={14} />
                      </span>
                      <span className="command-palette__item-label">{cmd.label}</span>
                      {cmd.shortcut && (
                        <span className="command-palette__item-shortcut">{cmd.shortcut}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* 底部提示 */}
        <div className="command-palette__footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> 导航</span>
          <span><kbd>Enter</kbd> 执行</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </>
  );
};
