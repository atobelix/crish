/**
 * MathBlockView — 数学公式块 NodeView 组件
 *
 * Notion 风格交互：
 * - 渲染模式：使用 KaTeX 显示高质量数学排版
 * - 编辑模式：点击公式 → 弹出 LaTeX 编辑弹窗 + 实时预览
 * - 空状态：灰色占位文本 "点击输入公式"
 *
 * 组件拆分：
 * - MathBlockView (主组件，管理编辑状态)
 * - MathRenderer (KaTeX 渲染子组件)
 * - MathEditorPopover (编辑弹窗子组件)
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { Sigma, X, Check, Maximize2 } from 'lucide-react';
import { Tooltip } from '../../ui/Tooltip';

/* ────────────────────────────────────────────
 * KaTeX 动态加载器（避免阻塞首屏）
 * ──────────────────────────────────────────── */

let katexModule: typeof import('katex') | null = null;
let katexPromise: Promise<typeof import('katex')> | null = null;

/** 异步加载 KaTeX 模块 */
function loadKaTeX(): Promise<typeof import('katex')> {
  if (katexModule) return Promise.resolve(katexModule);
  if (!katexPromise) {
    katexPromise = import('katex').then((mod) => {
      katexModule = mod;
      return mod;
    });
  }
  return katexPromise;
}

/* ────────────────────────────────────────────
 * MathRenderer — KaTeX 渲染子组件
 * ──────────────────────────────────────────── */

interface MathRendererProps {
  /** LaTeX 公式源码 */
  formula: string;
  /** 是否为 display 模式（居中独立行） */
  display?: boolean;
  /** 自定义 CSS 类名 */
  className?: string;
}

const MathRenderer: React.FC<MathRendererProps> = ({ formula, display = true, className = '' }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!!katexModule);

  useEffect(() => {
    if (!formula.trim()) return;

    loadKaTeX().then((katex) => {
      setLoaded(true);
      if (!containerRef.current) return;
      try {
        katex.render(formula, containerRef.current, {
          displayMode: display,
          throwOnError: false,
          errorColor: 'var(--accent-red)',
          trust: false,
          strict: false,
        });
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }, [formula, display]);

  if (!formula.trim()) {
    return null;
  }

  if (error) {
    return (
      <div className={`math-renderer math-renderer--error ${className}`}>
        <span className="math-renderer__error-icon">⚠</span>
        <span className="math-renderer__error-text">{error}</span>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className={`math-renderer math-renderer--loading ${className}`}>
        <span className="math-renderer__loading-dot" />
        <span className="math-renderer__loading-dot" />
        <span className="math-renderer__loading-dot" />
      </div>
    );
  }

  return <div ref={containerRef} className={`math-renderer ${className}`} />;
};

/* ────────────────────────────────────────────
 * MathEditorPopover — 公式编辑弹窗
 * ──────────────────────────────────────────── */

interface MathEditorPopoverProps {
  /** 当前公式文本 */
  formula: string;
  /** 公式变更回调 */
  onChange: (formula: string) => void;
  /** 关闭弹窗 */
  onClose: () => void;
}

const MathEditorPopover: React.FC<MathEditorPopoverProps> = ({
  formula,
  onChange,
  onClose,
}) => {
  const [localFormula, setLocalFormula] = useState(formula);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 聚焦到编辑区
  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, []);

  /** 确认修改 */
  const handleConfirm = useCallback(() => {
    onChange(localFormula);
    onClose();
  }, [localFormula, onChange, onClose]);

  /** 键盘快捷键：Ctrl+Enter 确认，Escape 取消 */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [handleConfirm, onClose]);

  return (
    <div className="math-editor-popover" onKeyDown={handleKeyDown}>
      {/* 编辑区域 */}
      <div className="math-editor-popover__input-section">
        <label className="math-editor-popover__label">
          <Sigma size={14} />
          LaTeX 公式
        </label>
        <textarea
          ref={textareaRef}
          className="math-editor-popover__textarea"
          value={localFormula}
          onChange={(e) => setLocalFormula(e.target.value)}
          placeholder="输入 LaTeX 公式，如 E = mc^2"
          rows={3}
          spellCheck={false}
        />
      </div>

      {/* 实时预览 */}
      <div className="math-editor-popover__preview-section">
        <span className="math-editor-popover__preview-label">预览</span>
        <div className="math-editor-popover__preview-area">
          {localFormula.trim() ? (
            <MathRenderer formula={localFormula} display />
          ) : (
            <span className="math-editor-popover__preview-placeholder">
              输入公式后这里会显示预览
            </span>
          )}
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="math-editor-popover__actions">
        <span className="math-editor-popover__hint">Ctrl+Enter 确认</span>
        <div className="math-editor-popover__buttons">
          <Tooltip content="取消">
            <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
              <X size={14} />
            </button>
          </Tooltip>
          <Tooltip content="确认">
            <button type="button" className="btn btn--primary btn--sm" onClick={handleConfirm}>
              <Check size={14} />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
};

/* ────────────────────────────────────────────
 * MathBlockView — 主组件
 * ──────────────────────────────────────────── */

export const MathBlockView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  selected,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const formula = (node.attrs.formula as string) || '';

  /** 更新公式 */
  const handleFormulaChange = useCallback((newFormula: string) => {
    updateAttributes({ formula: newFormula });
  }, [updateAttributes]);

  /** 打开编辑弹窗 */
  const handleClick = useCallback(() => {
    setIsEditing(true);
  }, []);

  /** 关闭编辑弹窗 */
  const handleClose = useCallback(() => {
    setIsEditing(false);
  }, []);

  return (
    <NodeViewWrapper className={`math-block ${selected ? 'math-block--selected' : ''}`}>
      {/* 渲染模式 */}
      <div
        className={`math-block__display ${!formula.trim() ? 'math-block__display--empty' : ''}`}
        contentEditable={false}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        aria-label="编辑公式"
      >
        {formula.trim() ? (
          <MathRenderer formula={formula} display />
        ) : (
          <span className="math-block__placeholder">
            <Sigma size={16} />
            点击输入数学公式
          </span>
        )}
      </div>

      {/* 编辑弹窗 */}
      {isEditing && (
        <div className="math-block__editor-overlay" contentEditable={false}>
          <MathEditorPopover
            formula={formula}
            onChange={handleFormulaChange}
            onClose={handleClose}
          />
        </div>
      )}
    </NodeViewWrapper>
  );
};
