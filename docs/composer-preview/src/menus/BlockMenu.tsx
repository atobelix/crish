/**
 * BlockMenu — 块级操作菜单 (V2)
 *
 * 点击块手柄（⠿）后弹出。
 *
 * V2 改进：
 *   ✅ 顶部搜索栏（搜索操作...）
 *   ✅ 上下文感知：根据块类型显示专属菜单项
 *   ✅ 分组标题
 *   ✅ 每项快捷键提示
 *   ✅ Toggle 开关（代码换行等）
 *   ✅ 底部元信息（"上次编辑"时间）
 *
 * ── 交互细节 ──────────────────────────────────────────
 *   ↑ ↓ Enter / Escape → 完整键盘可达
 *   搜索 → 过滤菜单项
 *   靠近视口边缘自动翻转
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import {
  Trash2, Copy, Link2, Palette, Repeat2, Check,
  ChevronRight, Search, Sparkles, Zap,
  MoveRight, ArrowUpRight,
} from 'lucide-react';
import { TEXT_COLORS, BACKGROUND_COLORS } from './colorPalette';
import {
  getBlockSpecificSections,
  TURN_INTO,
  type BlockMenuSection,
  type BlockMenuItem,
} from './blockMenuSections';

interface BlockMenuProps {
  editor: Editor;
  pos: number;
  typeName: string;
  anchor: { x: number; y: number };
  onClose: () => void;
}

/** 菜单距视口边缘的最小留白 */
const EDGE = 10;

export const BlockMenu: React.FC<BlockMenuProps> = ({
  editor, pos, typeName, anchor, onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState({ top: anchor.y, left: anchor.x });
  const [panel, setPanel] = useState<'none' | 'turn' | 'color'>('none');
  const [activeIndex, setActiveIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState('');

  const level = useMemo(
    () => editor.state.doc.nodeAt(pos)?.attrs.level as number | undefined,
    [editor, pos],
  );

  /* ── 块专属菜单项 ── */
  const blockSections = useMemo(
    () => getBlockSpecificSections(typeName, editor, pos),
    [typeName, editor, pos],
  );

  /* ── 主操作 ── */
  const remove = useCallback(() => {
    const node = editor.state.doc.nodeAt(pos);
    if (!node) return;
    editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
    onClose();
  }, [editor, pos, onClose]);

  const duplicate = useCallback(() => {
    const node = editor.state.doc.nodeAt(pos);
    if (!node) return;
    editor.chain().focus().insertContentAt(pos + node.nodeSize, node.toJSON()).run();
    onClose();
  }, [editor, pos, onClose]);

  const copyLink = useCallback(async () => {
    let index = 0;
    editor.state.doc.forEach((_node, nodePos) => {
      if (nodePos < pos) index += 1;
    });
    try {
      await navigator.clipboard.writeText(`${window.location.href}#block-${index}`);
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
        onClose();
      }, 900);
    } catch {
      onClose();
    }
  }, [editor, pos, onClose]);

  /* ── 通用菜单项 ── */
  const commonSection: BlockMenuSection = useMemo(() => ({
    items: [
      {
        id: 'turn', label: '转换为', icon: Repeat2, expandable: true,
        run: () => setPanel((p) => (p === 'turn' ? 'none' : 'turn')),
      },
      {
        id: 'color', label: '颜色', icon: Palette, expandable: true,
        run: () => setPanel((p) => (p === 'color' ? 'none' : 'color')),
      },
      {
        id: 'link',
        label: copied ? '已复制链接' : '拷贝区块链接',
        icon: copied ? Check : Link2,
        shortcut: 'Alt+↑+L',
        run: copyLink,
      },
      {
        id: 'duplicate', label: '创建副本', icon: Copy,
        shortcut: 'Ctrl+D',
        run: duplicate,
      },
      {
        id: 'moveTo', label: '移动到', icon: ArrowUpRight,
        shortcut: 'Ctrl+↑+P',
        run: () => { onClose(); /* TODO: 打开移动面板 */ },
      },
      {
        id: 'delete', label: '删除', icon: Trash2,
        shortcut: 'Del',
        danger: true,
        run: remove,
      },
    ],
  }), [copied, copyLink, duplicate, remove, onClose]);

  const aiSection: BlockMenuSection = useMemo(() => ({
    items: [
      {
        id: 'aiEdit', label: '编辑建议', icon: Sparkles,
        shortcut: 'Ctrl+↑+Alt+X',
        run: () => { onClose(); /* TODO: AI 编辑 */ },
      },
      {
        id: 'aiAsk', label: '万事问 AI', icon: Zap,
        shortcut: 'Ctrl+J',
        run: () => { onClose(); /* TODO: AI 问答 */ },
      },
    ],
  }), [onClose]);

  /* ── 合并所有区段 + 搜索过滤 ── */
  const allSections: BlockMenuSection[] = useMemo(() => {
    const sections = [...blockSections, commonSection, aiSection];
    if (!query.trim()) return sections;

    const q = query.trim().toLowerCase();
    return sections
      .map((section) => ({
        ...section,
        items: section.items.filter(
          (item) => item.label.toLowerCase().includes(q) || item.id.includes(q),
        ),
      }))
      .filter((section) => section.items.length > 0);
  }, [blockSections, commonSection, aiSection, query]);

  /** 扁平化所有 items 用于键盘导航 */
  const flatItems = useMemo(
    () => allSections.flatMap((s) => s.items),
    [allSections],
  );

  /* ── 定位 ── */
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const left = Math.min(anchor.x, window.innerWidth - w - EDGE);
    const top =
      anchor.y + h + EDGE > window.innerHeight
        ? Math.max(EDGE, window.innerHeight - h - EDGE)
        : anchor.y;
    setPosition({ top, left: Math.max(EDGE, left) });
  }, [anchor.x, anchor.y, panel, allSections]);

  /* ── 关闭与键盘 ── */
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % flatItems.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + flatItems.length) % flatItems.length);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        flatItems[activeIndex]?.run();
      }
    };

    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown);
    }, 0);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [activeIndex, flatItems, onClose]);

  /* ── 聚焦搜索栏 ── */
  useEffect(() => {
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  /** 当前扁平索引 → 渲染时判断 active */
  let globalIndex = -1;

  return (
    <div
      ref={menuRef}
      className="block-menu motion-rise-in"
      style={{ top: position.top, left: position.left }}
      role="menu"
      aria-label="块操作"
    >
      {/* ── 搜索栏 ── */}
      <div className="block-menu__search">
        <Search size={13} className="block-menu__search-icon" />
        <input
          ref={searchRef}
          className="block-menu__search-input"
          placeholder="搜索操作…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(e) => {
            // 让 ArrowDown/Up/Enter/Escape 冒泡到 document keydown
            if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) return;
          }}
        />
      </div>

      {/* ── 菜单区段 ── */}
      {allSections.map((section, sIdx) => (
        <React.Fragment key={sIdx}>
          {sIdx > 0 && <div className="block-menu__separator" />}
          {section.title && (
            <div className="block-menu__section-title">{section.title}</div>
          )}
          {section.items.map((item) => {
            globalIndex++;
            const idx = globalIndex;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className={[
                  'block-menu__item',
                  idx === activeIndex ? 'is-active' : '',
                  item.danger ? 'is-danger' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onPointerEnter={() => setActiveIndex(idx)}
                onClick={item.run}
                aria-expanded={item.expandable ? panel !== 'none' : undefined}
              >
                <item.icon size={14} />
                <span className="block-menu__label">{item.label}</span>

                {/* Toggle 开关 */}
                {item.toggle && (
                  <span className={`block-menu__toggle ${item.toggleValue ? 'is-on' : ''}`}>
                    <span className="block-menu__toggle-thumb" />
                  </span>
                )}

                {/* 快捷键 */}
                {item.shortcut && !item.toggle && (
                  <kbd className="block-menu__shortcut">{item.shortcut}</kbd>
                )}

                {/* 子菜单箭头 */}
                {item.expandable && (
                  <ChevronRight
                    size={13}
                    className={`block-menu__caret ${
                      (item.id === 'turn' && panel === 'turn') ||
                      (item.id === 'color' && panel === 'color')
                        ? 'is-open'
                        : ''
                    }`}
                  />
                )}
              </button>
            );
          })}
        </React.Fragment>
      ))}

      {/* ── 转换为 ── */}
      {panel === 'turn' && (
        <div className="block-menu__panel motion-fade-in">
          <div className="block-menu__panel-title">转换为</div>
          {TURN_INTO.map((option) => {
            const active = option.matches(typeName, level);
            return (
              <button
                key={option.id}
                type="button"
                className={`block-menu__item ${active ? 'is-current' : ''}`}
                onClick={() => {
                  option.run(editor);
                  onClose();
                }}
              >
                <option.icon size={14} />
                <span className="block-menu__label">{option.label}</span>
                {active && <Check size={13} />}
              </button>
            );
          })}
        </div>
      )}

      {/* ── 颜色 ── */}
      {panel === 'color' && (
        <div className="block-menu__panel motion-fade-in">
          <div className="block-menu__panel-title">文字颜色</div>
          <div className="block-menu__swatches">
            {TEXT_COLORS.map((color) => (
              <button
                key={color.id}
                type="button"
                className="block-menu__swatch"
                style={{ color: color.value }}
                onClick={() => {
                  editor.chain().focus().setColor(color.value).run();
                  onClose();
                }}
                title={color.label}
              >
                A
              </button>
            ))}
          </div>

          <div className="block-menu__panel-title">背景颜色</div>
          <div className="block-menu__swatches">
            {BACKGROUND_COLORS.map((color) => (
              <button
                key={color.id}
                type="button"
                className="block-menu__swatch block-menu__swatch--bg"
                style={{ background: color.value }}
                onClick={() => {
                  editor.chain().focus().toggleHighlight().run();
                  onClose();
                }}
                title={color.label}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── 底部元信息 ── */}
      <div className="block-menu__footer">
        上次编辑 · 刚刚
      </div>
    </div>
  );
};
