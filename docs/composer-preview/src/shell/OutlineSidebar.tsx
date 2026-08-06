/**
 * OutlineSidebar — 文档大纲侧边栏
 *
 * 实时从 ProseMirror 文档中提取标题结构，
 * 点击跳转、当前可见标题高亮。
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import type { Editor } from '@tiptap/core';
import { ListTree } from 'lucide-react';

interface HeadingItem {
  id: string;
  level: number;
  text: string;
  pos: number;
}

interface OutlineSidebarProps {
  editor: Editor;
}

export const OutlineSidebar: React.FC<OutlineSidebarProps> = ({ editor }) => {
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [activeId, setActiveId] = useState<string>('');

  // 提取文档中的所有标题
  const extractHeadings = useCallback(() => {
    const items: HeadingItem[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        const level = node.attrs.level as number;
        const text = node.textContent || '无标题';
        items.push({
          id: `heading-${pos}`,
          level,
          text,
          pos,
        });
      }
    });
    setHeadings(items);
  }, [editor]);

  // 文档变更时重新提取
  useEffect(() => {
    extractHeadings();

    const handler = () => extractHeadings();
    editor.on('update', handler);
    return () => { editor.off('update', handler); };
  }, [editor, extractHeadings]);

  // 点击跳转
  const handleClick = useCallback((pos: number, id: string) => {
    // 移动选区到标题位置并滚动
    editor.chain().focus().setTextSelection(pos + 1).run();
    // 滚动到视图
    const { node } = editor.view.domAtPos(pos + 1);
    const el = node instanceof HTMLElement ? node : node.parentElement;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setActiveId(id);
  }, [editor]);

  // 使用 IntersectionObserver 追踪当前可见标题
  useEffect(() => {
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute('data-outline-id');
            if (id) setActiveId(id);
          }
        }
      },
      { rootMargin: '-20% 0px -70% 0px' },
    );

    // 为每个标题 DOM 节点添加 data-outline-id 并观察
    headings.forEach((h) => {
      try {
        const { node } = editor.view.domAtPos(h.pos + 1);
        const el = node instanceof HTMLElement ? node : node.parentElement;
        if (el) {
          el.setAttribute('data-outline-id', h.id);
          observer.observe(el);
        }
      } catch {
        // 位置可能已失效
      }
    });

    return () => observer.disconnect();
  }, [headings, editor]);

  if (headings.length === 0) {
    return (
      <aside className="outline-sidebar">
        <div className="outline-sidebar__title">大纲</div>
        <div className="outline-sidebar__empty">
          <ListTree size={24} className="outline-sidebar__empty-icon" />
          <span>添加标题以生成大纲</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="outline-sidebar">
      <div className="outline-sidebar__title">大纲</div>
      <div className="outline-sidebar__list">
        {headings.map((h) => (
          <button
            key={h.id}
            type="button"
            className={`outline-sidebar__item ${activeId === h.id ? 'is-active' : ''}`}
            data-level={h.level}
            onClick={() => handleClick(h.pos, h.id)}
            title={h.text}
          >
            {h.text}
          </button>
        ))}
      </div>
    </aside>
  );
};
