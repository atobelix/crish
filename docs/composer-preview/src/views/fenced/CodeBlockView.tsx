/**
 * CodeBlockView — 代码块 (V2 卡片化重做)
 *
 * ── 设计稿要求 ──────────────────────────────────────────
 *   默认：干净的代码卡片，无 Header，只有代码 + 微弱边框
 *   Hover：工具栏从顶部淡入（语言标签 + 换行/行号/复制图标）
 *   语言选择器：点击展开 More 面板（搜索 + 文件名 + 语言列表）
 *   工具按钮：极克制的灰色，hover 时才加淡灰背景
 *
 * ── 与 V1 的区别 ──────────────────────────────────────────
 *   - 不再使用 BlockShell 包装（自管工具栏）
 *   - Header 默认隐藏，hover 时 opacity + translateY 淡入
 *   - 工具栏布局：左侧语言 label + chevron；右侧 3 个图标按钮
 *   - 文件名从 Header 移到语言选择器的 More 面板中
 *   - 行号默认隐藏，通过工具栏 # 按钮切换
 *
 * ── 性能 ──────────────────────────────────────────────
 *   高亮由 CodeBlockLowlight 的装饰层完成，本组件不参与；
 *   行数只在文本长度变化时重算，不是每次渲染都数一遍。
 */

import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import {
  Check, Copy, ChevronRight, Hash, WrapText, MoreHorizontal, Search, MessageSquare, History, Trash2
} from 'lucide-react';
import { Tooltip } from '../../ui/Tooltip';
import { SUPPORTED_LANGUAGES } from '../../extensions/CodeBlockExtension';

export const CodeBlockView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  deleteNode,
  selected,
}) => {
  const [copied, setCopied] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [langQuery, setLangQuery] = useState('');
  const [wrap, setWrap] = useState(false);
  
  const langRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const language = (node.attrs.language as string) || 'plaintext';
  const filename = (node.attrs.filename as string) || '';
  const showLineNumbers = node.attrs.showLineNumbers !== false;

  const code = node.textContent;
  const lineCount = useMemo(() => code.split('\n').length, [code]);

  const langLabel =
    SUPPORTED_LANGUAGES.find((l) => l.id === language)?.label ?? language;

  const filteredLangs = useMemo(() => {
    const q = langQuery.trim().toLowerCase();
    if (!q) return SUPPORTED_LANGUAGES;
    return SUPPORTED_LANGUAGES.filter(
      (l) => l.label.toLowerCase().includes(q) || l.id.includes(q),
    );
  }, [langQuery]);

  /** 复制代码 */
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用时静默降级 */
    }
  }, [code]);

  /** 打开/关闭 语言面板 */
  const toggleLang = useCallback(() => {
    setLangOpen((v) => {
      if (!v) setSettingsOpen(false); // 关闭另一个
      return !v;
    });
    setLangQuery('');
  }, []);

  /** 打开/关闭 设置面板 */
  const toggleSettings = useCallback(() => {
    setSettingsOpen((v) => {
      if (!v) setLangOpen(false); // 关闭另一个
      return !v;
    });
  }, []);

  /** 语言面板打开时聚焦搜索框 */
  useEffect(() => {
    if (langOpen) {
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [langOpen]);

  /** 点击外部关闭面板 */
  useEffect(() => {
    if (!langOpen && !settingsOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (langOpen && !langRef.current?.contains(target)) {
        setLangOpen(false);
      }
      if (settingsOpen && !settingsRef.current?.contains(target)) {
        setSettingsOpen(false);
      }
    };
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [langOpen, settingsOpen]);

  return (
    <NodeViewWrapper
      className={[
        'code-block-view',
        showLineNumbers ? 'has-line-numbers' : '',
        wrap ? 'is-wrapped' : '',
        selected ? 'is-selected' : '',
        (langOpen || settingsOpen) ? 'is-panel-open' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-lines={lineCount}
    >
      <div className="code-block-header" contentEditable={false}>
        {/* ── 默认状态：只显示极其克制的语言文本 ── */}
        <div className={`code-block__lang-label ${(langOpen || settingsOpen) ? 'is-hidden' : ''}`}>
          {langLabel}
        </div>

        {/* ── 工具栏：hover 时淡入 ── */}
        <div className="code-block__toolbar">
          {/* 左侧：语言标签及下拉菜单 */}
          <div className="code-block__lang-wrapper" ref={langRef}>
            <button
              type="button"
              className={`code-block__lang-trigger ${langOpen ? 'is-open' : ''}`}
            onClick={toggleLang}
            aria-haspopup="listbox"
            aria-expanded={langOpen}
          >
            <span>{langLabel}</span>
            <ChevronRight size={12} className="code-block__lang-caret" />
          </button>

          {/* 语言选择下拉菜单（悬浮） */}
          {langOpen && (
            <div className="code-block__dropdown-panel code-block__lang-dropdown motion-drop-in">
              <div className="code-block__search-box">
                <Search size={14} strokeWidth={2.5} />
                <input
                  ref={searchRef}
                  className="code-block__search-input"
                  placeholder="搜索语言…"
                  value={langQuery}
                  onChange={(e) => setLangQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setLangOpen(false);
                    if (e.key === 'Enter' && filteredLangs[0]) {
                      updateAttributes({ language: filteredLangs[0].id });
                      setLangOpen(false);
                    }
                  }}
                />
              </div>

              <div className="code-block__scroll-container">
                <div className="code-block__lang-list">
                  {filteredLangs.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      role="option"
                      aria-selected={l.id === language}
                      className={`code-block__list-item ${
                        l.id === language ? 'is-active' : ''
                      }`}
                      onClick={() => {
                        updateAttributes({ language: l.id });
                        setLangOpen(false);
                      }}
                    >
                      {l.label}
                      {l.id === language && <Check size={14} strokeWidth={2.5} className="code-block__item-check" />}
                    </button>
                  ))}
                  {filteredLangs.length === 0 && (
                    <div className="code-block__lang-empty">无匹配语言</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>



        {/* 中间弹性空间 */}
        <div style={{ flex: 1 }} />

        {/* 右侧：工具按钮 */}
        <div className="code-block__actions-group" ref={settingsRef}>
          <Tooltip content={wrap ? '取消换行' : '自动换行'}>
            <button
              type="button"
              className={`code-block__toolbar-btn ${wrap ? 'is-active' : ''}`}
              onClick={() => setWrap((v) => !v)}
            >
              <WrapText size={14} />
            </button>
          </Tooltip>

          <Tooltip content={showLineNumbers ? '隐藏行号' : '显示行号'}>
            <button
              type="button"
              className={`code-block__toolbar-btn ${showLineNumbers ? 'is-active' : ''}`}
              onClick={() => updateAttributes({ showLineNumbers: !showLineNumbers })}
            >
              <Hash size={14} />
            </button>
          </Tooltip>

          <Tooltip content={copied ? '已复制' : '复制代码'}>
            <button
              type="button"
              className={`code-block__toolbar-btn ${copied ? 'is-copied' : ''}`}
              onClick={copy}
            >
              {copied ? <Check size={14} strokeWidth={2.5} /> : <Copy size={14} />}
            </button>
          </Tooltip>

          {/* More Settings */}
          <Tooltip content="更多选项">
            <button
              type="button"
              className={`code-block__toolbar-btn ${settingsOpen ? 'is-active' : ''}`}
              onClick={toggleSettings}
            >
              <MoreHorizontal size={14} />
            </button>
          </Tooltip>

          {/* 设置下拉面板 */}
          {settingsOpen && (
            <div className="code-block__dropdown-panel code-block__more-dropdown motion-drop-in">
              <div className="code-block__dropdown-section">
                <div className="code-block__dropdown-label">文件名称</div>
                <input
                  type="text"
                  className="code-block__filename-input"
                  placeholder="添加文件名..."
                  value={filename}
                  onChange={(e) => updateAttributes({ filename: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Escape') {
                      setSettingsOpen(false);
                    }
                  }}
                />
              </div>
              <div className="code-block__dropdown-divider" />
              
              <button 
                className="code-block__list-item" 
                onClick={() => {
                  navigator.clipboard.writeText(window.location.href);
                  setSettingsOpen(false);
                }}
              >
                <Copy size={14} className="code-block__item-icon" />
                <span>拷贝区块链接</span>
              </button>

              <button 
                className="code-block__list-item" 
                onClick={() => {
                  // Duplicate node logic would go here
                  console.log('Duplicate node');
                  setSettingsOpen(false);
                }}
              >
                <Copy size={14} className="code-block__item-icon" />
                <span>创建副本</span>
              </button>

              <button 
                className="code-block__list-item" 
                onClick={() => {
                  console.log('Comment');
                  setSettingsOpen(false);
                }}
              >
                <MessageSquare size={14} className="code-block__item-icon" />
                <span>添加评论</span>
              </button>

              <button 
                className="code-block__list-item" 
                onClick={() => {
                  console.log('History');
                  setSettingsOpen(false);
                }}
              >
                <History size={14} className="code-block__item-icon" />
                <span>编辑记录</span>
              </button>

              <div className="code-block__dropdown-divider" />
              
              <button 
                className="code-block__list-item is-danger" 
                onClick={() => {
                  deleteNode();
                  setSettingsOpen(false);
                }}
              >
                <Trash2 size={14} className="code-block__item-icon" />
                <span>删除区块</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>

      {/* ── 代码正文 ── */}
      <div className="code-block-view__body">
        {showLineNumbers && (
          <div className="code-block-view__line-numbers" aria-hidden="true" contentEditable={false}>
            {Array.from({ length: Math.max(1, lineCount) }).map((_, i) => (
              <div key={i} className="code-block__line-number">{i + 1}</div>
            ))}
          </div>
        )}
        <NodeViewContent as={'pre' as 'div'} className="code-block-view__pre" />
      </div>
    </NodeViewWrapper>
  );
};
