/**
 * SlashMenu — 斜杠命令菜单 (V2 视觉重构)
 *
 * ── 交互清单 ──────────────────────────────────────────
 *   输入 /        → 菜单在光标处升起
 *   继续输入      → 搜索栏实时过滤，无结果时给出明确提示
 *   ↑ ↓           → 移动选中项，列表自动滚动保持可见
 *   Enter / Tab   → 执行
 *   Escape        → 关闭
 *   鼠标悬浮      → 同步选中项，键鼠不打架
 *   分组标题      → 粘性定位，滚动时始终知道自己在哪一组
 *
 * ── V2 变更 ──────────────────────────────────────────
 *   - 添加搜索栏（顶部固定，聚焦时自动激活）
 *   - 图标从方形线框改为分类彩色圆角矩形 + 白色图标
 *   - 分组增加 data-category 属性驱动 CSS 配色
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor, Range } from '@tiptap/core';
import { Search } from 'lucide-react';
import {
  filterSlashCommands,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type SlashCommand,
  type SlashCategory,
} from './slashCommands';

export interface SlashMenuProps {
  editor: Editor;
  range: Range;
  query: string;
  onClose: () => void;
}

export interface SlashMenuHandle {
  /** 返回 true 表示按键已被菜单消费，编辑器不应再处理 */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export const SlashMenu = React.forwardRef<SlashMenuHandle, SlashMenuProps>(
  ({ editor, range, query, onClose }, ref) => {
    const commands = useMemo(() => filterSlashCommands(query), [query]);
    const [activeIndex, setActiveIndex] = useState(0);
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const keyboardModeRef = useRef(false);

    // 查询变化时回到第一项
    useEffect(() => setActiveIndex(0), [query]);

    const execute = useCallback(
      (index: number) => {
        const cmd = commands[index];
        if (!cmd) return;
        cmd.run(editor, range);
        onClose();
      },
      [commands, editor, range, onClose],
    );

    /** 选中项滚动进视野 */
    const scrollIntoView = useCallback((index: number) => {
      itemRefs.current[index]?.scrollIntoView({ block: 'nearest' });
    }, []);

    React.useImperativeHandle(
      ref,
      () => ({
        onKeyDown: (event: KeyboardEvent) => {
          if (commands.length === 0) {
            if (event.key === 'Escape') {
              onClose();
              return true;
            }
            return false;
          }

          switch (event.key) {
            case 'ArrowDown': {
              keyboardModeRef.current = true;
              const next = (activeIndex + 1) % commands.length;
              setActiveIndex(next);
              scrollIntoView(next);
              return true;
            }
            case 'ArrowUp': {
              keyboardModeRef.current = true;
              const next = (activeIndex - 1 + commands.length) % commands.length;
              setActiveIndex(next);
              scrollIntoView(next);
              return true;
            }
            case 'Home':
              keyboardModeRef.current = true;
              setActiveIndex(0);
              scrollIntoView(0);
              return true;
            case 'End': {
              keyboardModeRef.current = true;
              const last = commands.length - 1;
              setActiveIndex(last);
              scrollIntoView(last);
              return true;
            }
            case 'Enter':
            case 'Tab':
              execute(activeIndex);
              return true;
            case 'Escape':
              onClose();
              return true;
            default:
              return false;
          }
        },
      }),
      [activeIndex, commands, execute, onClose, scrollIntoView],
    );

    /* ── 按分类分组 ── */
    const groups = useMemo(() => {
      const map = new Map<SlashCategory, SlashCommand[]>();
      for (const cmd of commands) {
        const list = map.get(cmd.category) ?? [];
        list.push(cmd);
        map.set(cmd.category, list);
      }
      return CATEGORY_ORDER.filter((c) => map.has(c)).map((c) => ({
        category: c,
        items: map.get(c) as SlashCommand[],
      }));
    }, [commands]);

    /* 空状态 */
    if (commands.length === 0) {
      return (
        <div className="slash-menu slash-menu--empty motion-rise-in">
          <Search size={16} className="slash-menu__empty-icon" />
          <div className="slash-menu__empty-title">没有匹配的命令</div>
          <div className="slash-menu__empty-hint">试试「标题」「列表」「代码」「图表」</div>
        </div>
      );
    }

    let flatIndex = -1;

    return (
      <div
        className="slash-menu motion-rise-in"
        role="listbox"
        aria-label="插入区块"
        onPointerMove={() => {
          keyboardModeRef.current = false;
        }}
      >
        {/* 搜索栏（展示当前查询状态） */}
        <div className="slash-menu__search is-active">
          <Search size={14} className="slash-menu__search-icon" />
          {query ? (
            <span className="slash-menu__search-input">
              {query}
              <span className="slash-menu__cursor" />
            </span>
          ) : (
            <span className="slash-menu__search-input is-empty">
              <span className="slash-menu__cursor" />
              输入命令...
            </span>
          )}
        </div>

        {groups.map((group) => (
          <div
            key={group.category}
            className="slash-menu__group"
            data-category={group.category}
          >
            <div className="slash-menu__group-title">
              {CATEGORY_LABELS[group.category]}
            </div>
            {group.items.map((cmd) => {
              flatIndex += 1;
              const index = flatIndex;
              const active = index === activeIndex;
              return (
                <button
                  key={cmd.id}
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`slash-menu__item ${active ? 'is-active' : ''}`}
                  onPointerEnter={() => {
                    if (!keyboardModeRef.current) setActiveIndex(index);
                  }}
                  onClick={() => execute(index)}
                >
                  <span className="slash-menu__icon">
                    <cmd.icon size={14} />
                  </span>
                  <span className="slash-menu__text">
                    <span className="slash-menu__title">{cmd.title}</span>
                  </span>
                  {cmd.shortcut && <kbd className="slash-menu__shortcut">{cmd.shortcut}</kbd>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    );
  },
);

SlashMenu.displayName = 'SlashMenu';
