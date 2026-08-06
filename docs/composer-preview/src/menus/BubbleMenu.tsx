/**
 * BubbleMenu — 选区浮动格式化工具栏
 *
 * 分四段：块类型切换 · 行内格式 · 链接 · 颜色。
 * 所有格式按钮走 LivePreviewInline 的命令层，
 * 也就是说点击按钮和手打 `**` 产生的文档完全一致。
 *
 * 交互细节：
 *   - 按钮激活态用 `editor.isActive()` 实时反映，光标一动就更新
 *   - 悬浮/按下反馈统一走 .motion-tap，时长取自动效令牌
 *   - 链接面板用 Escape 关闭、Enter 提交，焦点自动落到输入框
 *   - 已是链接时才显示「取消链接」，避免恒定占位造成的按钮抖动
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { Editor } from '@tiptap/core';
import { BubbleMenu as TiptapBubbleMenu } from '@tiptap/react/menus';
import {
  Bold, Italic, Strikethrough, Underline as UnderlineIcon,
  Code, Link as LinkIcon, Unlink, Highlighter,
  Type, Heading1, Heading2, Heading3, ChevronDown, Palette, Check,
} from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { TEXT_COLORS, BACKGROUND_COLORS } from './colorPalette';

interface BubbleMenuBarProps {
  editor: Editor;
}

/* ────────────────────────────────────────────
 * 块类型选项
 * ──────────────────────────────────────────── */

interface BlockOption {
  id: string;
  label: string;
  hint: string;
  level: number;
  icon: React.FC<{ size?: number }>;
}

const BLOCK_OPTIONS: BlockOption[] = [
  { id: 'p',  label: '正文',   hint: 'Ctrl+Alt+0', level: 0, icon: Type },
  { id: 'h1', label: '标题 1', hint: 'Ctrl+Alt+1', level: 1, icon: Heading1 },
  { id: 'h2', label: '标题 2', hint: 'Ctrl+Alt+2', level: 2, icon: Heading2 },
  { id: 'h3', label: '标题 3', hint: 'Ctrl+Alt+3', level: 3, icon: Heading3 },
];

/* ────────────────────────────────────────────
 * 行内格式按钮配置
 * ──────────────────────────────────────────── */

interface FormatButton {
  id: string;
  label: string;
  hint: string;
  markName: string;
  icon: React.FC<{ size?: number }>;
  run: (editor: Editor) => void;
}

const FORMAT_BUTTONS: FormatButton[] = [
  {
    id: 'bold', label: '加粗', hint: 'Ctrl+B', markName: 'bold', icon: Bold,
    run: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    id: 'italic', label: '斜体', hint: 'Ctrl+I', markName: 'italic', icon: Italic,
    run: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    id: 'underline', label: '下划线', hint: 'Ctrl+U', markName: 'underline', icon: UnderlineIcon,
    run: (e) => e.chain().focus().toggleUnderline().run(),
  },
  {
    id: 'strike', label: '删除线', hint: 'Ctrl+Shift+S', markName: 'strike', icon: Strikethrough,
    run: (e) => e.chain().focus().toggleStrike().run(),
  },
  {
    id: 'code', label: '行内代码', hint: 'Ctrl+E', markName: 'code', icon: Code,
    run: (e) => e.chain().focus().toggleCode().run(),
  },
  {
    id: 'highlight', label: '高亮', hint: 'Ctrl+Shift+H', markName: 'highlight', icon: Highlighter,
    run: (e) => e.chain().focus().toggleHighlight().run(),
  },
];

/* ────────────────────────────────────────────
 * 主组件
 * ──────────────────────────────────────────── */

type PanelKind = 'none' | 'link' | 'color' | 'turnInto';

export const BubbleMenuBar: React.FC<BubbleMenuBarProps> = ({ editor }) => {
  const [panel, setPanel] = useState<PanelKind>('none');
  const [linkUrl, setLinkUrl] = useState('');
  const linkInputRef = useRef<HTMLInputElement>(null);

  const closePanel = useCallback(() => setPanel('none'), []);

  // 选区一变就收起所有二级面板，避免面板停在过期的上下文上
  useEffect(() => {
    const onSelection = () => setPanel('none');
    editor.on('selectionUpdate', onSelection);
    return () => {
      editor.off('selectionUpdate', onSelection);
    };
  }, [editor]);

  useEffect(() => {
    if (panel === 'link') linkInputRef.current?.focus();
  }, [panel]);

  const openLinkPanel = useCallback(() => {
    setLinkUrl((editor.getAttributes('link').href as string) || '');
    setPanel((p) => (p === 'link' ? 'none' : 'link'));
  }, [editor]);

  const submitLink = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const href = linkUrl.trim();
      if (href) editor.chain().focus().setMarkdownLink(href).run();
      setPanel('none');
      setLinkUrl('');
    },
    [editor, linkUrl],
  );

  const removeLink = useCallback(() => {
    editor.chain().focus().unsetMarkdownLink().run();
    setPanel('none');
  }, [editor]);

  const currentLevel = editor.isActive('heading')
    ? (editor.getAttributes('heading').level as number)
    : 0;
  const currentBlock =
    BLOCK_OPTIONS.find((o) => o.level === currentLevel) ?? BLOCK_OPTIONS[0];

  return (
    <TiptapBubbleMenu
      editor={editor}
      updateDelay={80}
      options={{ placement: 'top' }}
      className="bubble-menu-anchor"
    >
      <div className="bubble-menu motion-rise-in" role="toolbar" aria-label="文本格式">
        {/* ── 块类型 ── */}
        <button
          type="button"
          className={`bubble-menu__turn ${panel === 'turnInto' ? 'is-open' : ''}`}
          onClick={() => setPanel((p) => (p === 'turnInto' ? 'none' : 'turnInto'))}
          aria-haspopup="menu"
          aria-expanded={panel === 'turnInto'}
        >
          <currentBlock.icon size={14} />
          <span className="bubble-menu__turn-label">{currentBlock.label}</span>
          <ChevronDown size={12} className="bubble-menu__turn-caret" />
        </button>

        <div className="bubble-menu__divider" />

        {/* ── 行内格式 ── */}
        {FORMAT_BUTTONS.map((btn) => (
          <Tooltip key={btn.id} content={`${btn.label} · ${btn.hint}`}>
            <button
              type="button"
              className={`bubble-menu__btn motion-tap ${
                editor.isActive(btn.markName) ? 'is-active' : ''
              }`}
              onClick={() => btn.run(editor)}
              aria-label={btn.label}
              aria-pressed={editor.isActive(btn.markName)}
            >
              <btn.icon size={15} />
            </button>
          </Tooltip>
        ))}

        <div className="bubble-menu__divider" />

        {/* ── 颜色 ── */}
        <Tooltip content="文字与背景颜色">
          <button
            type="button"
            className={`bubble-menu__btn motion-tap ${panel === 'color' ? 'is-active' : ''}`}
            onClick={() => setPanel((p) => (p === 'color' ? 'none' : 'color'))}
            aria-label="颜色"
          >
            <Palette size={15} />
          </button>
        </Tooltip>

        {/* ── 链接 ── */}
        <Tooltip content="添加链接 · Ctrl+K">
          <button
            type="button"
            className={`bubble-menu__btn motion-tap ${
              editor.isActive('link') ? 'is-active' : ''
            }`}
            onClick={openLinkPanel}
            aria-label="链接"
          >
            <LinkIcon size={15} />
          </button>
        </Tooltip>

        {editor.isActive('link') && (
          <Tooltip content="取消链接">
            <button
              type="button"
              className="bubble-menu__btn motion-tap"
              onClick={removeLink}
              aria-label="取消链接"
            >
              <Unlink size={15} />
            </button>
          </Tooltip>
        )}
      </div>

      {/* ── 二级面板：块类型 ── */}
      {panel === 'turnInto' && (
        <div className="bubble-panel motion-rise-in" role="menu">
          <div className="bubble-panel__title">转换为</div>
          <div className="motion-stagger">
            {BLOCK_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="menuitem"
                className={`bubble-panel__item motion-tap ${
                  opt.level === currentLevel ? 'is-active' : ''
                }`}
                onClick={() => {
                  editor.chain().focus().setHeadingLevel(opt.level).run();
                  closePanel();
                }}
              >
                <opt.icon size={15} />
                <span className="bubble-panel__item-label">{opt.label}</span>
                <kbd className="bubble-panel__item-hint">{opt.hint}</kbd>
                {opt.level === currentLevel && <Check size={13} className="bubble-panel__check" />}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── 二级面板：颜色 ── */}
      {panel === 'color' && (
        <div className="bubble-panel bubble-panel--color motion-rise-in">
          <div className="bubble-panel__title">文字颜色</div>
          <div className="color-grid">
            {TEXT_COLORS.map((c) => (
              <Tooltip key={c.id} content={c.label}>
                <button
                  type="button"
                  className="color-swatch motion-tap"
                  style={{ color: c.value }}
                  onClick={() => {
                    editor.chain().focus().setColor(c.value).run();
                    closePanel();
                  }}
                  aria-label={`文字颜色 ${c.label}`}
                >
                  A
                </button>
              </Tooltip>
            ))}
          </div>

          <div className="bubble-panel__title">背景颜色</div>
          <div className="color-grid">
            {BACKGROUND_COLORS.map((c) => (
              <Tooltip key={c.id} content={c.label}>
                <button
                  type="button"
                  className="color-swatch color-swatch--bg motion-tap"
                  style={{ background: c.value }}
                  onClick={() => {
                    editor.chain().focus().toggleHighlight().run();
                    closePanel();
                  }}
                  aria-label={`背景颜色 ${c.label}`}
                />
              </Tooltip>
            ))}
          </div>
        </div>
      )}

      {/* ── 二级面板：链接 ── */}
      {panel === 'link' && (
        <form className="bubble-panel bubble-panel--link motion-rise-in" onSubmit={submitLink}>
          <input
            ref={linkInputRef}
            type="url"
            className="bubble-panel__input"
            placeholder="粘贴或输入链接地址…"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                closePanel();
                editor.commands.focus();
              }
            }}
          />
          <button type="submit" className="btn btn--primary btn--sm motion-tap">
            确认
          </button>
        </form>
      )}
    </TiptapBubbleMenu>
  );
};
