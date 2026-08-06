/**
 * MathInlineView — 行内数学公式 NodeView 组件
 *
 * 行内显示 KaTeX 渲染结果。
 * 点击弹出紧凑型编辑弹窗。
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { Sigma } from 'lucide-react';

/* KaTeX 动态加载（与 MathBlockView 共享同一个 promise） */
let katexModule: typeof import('katex') | null = null;
let katexPromise: Promise<typeof import('katex')> | null = null;

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
 * InlineMathRenderer — 行内公式渲染
 * ──────────────────────────────────────────── */

const InlineMathRenderer: React.FC<{ formula: string }> = ({ formula }) => {
  const spanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!formula.trim() || !spanRef.current) return;
    loadKaTeX().then((katex) => {
      if (!spanRef.current) return;
      try {
        katex.render(formula, spanRef.current, {
          displayMode: false,
          throwOnError: false,
          errorColor: 'var(--accent-red)',
        });
      } catch {
        if (spanRef.current) {
          spanRef.current.textContent = formula;
        }
      }
    });
  }, [formula]);

  return <span ref={spanRef} className="math-inline__rendered" />;
};

/* ────────────────────────────────────────────
 * InlineMathEditor — 紧凑型编辑弹窗
 * ──────────────────────────────────────────── */

interface InlineMathEditorProps {
  formula: string;
  onChange: (formula: string) => void;
  onClose: () => void;
}

const InlineMathEditor: React.FC<InlineMathEditorProps> = ({
  formula,
  onChange,
  onClose,
}) => {
  const [localFormula, setLocalFormula] = useState(formula);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleConfirm = useCallback(() => {
    onChange(localFormula);
    onClose();
  }, [localFormula, onChange, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [handleConfirm, onClose]);

  return (
    <div className="math-inline-editor" onKeyDown={handleKeyDown}>
      <div className="math-inline-editor__row">
        <Sigma size={13} className="math-inline-editor__icon" />
        <input
          ref={inputRef}
          type="text"
          className="math-inline-editor__input"
          value={localFormula}
          onChange={(e) => setLocalFormula(e.target.value)}
          placeholder="LaTeX 公式"
          spellCheck={false}
        />
      </div>
      {localFormula.trim() && (
        <div className="math-inline-editor__preview">
          <InlineMathRenderer formula={localFormula} />
        </div>
      )}
    </div>
  );
};

/* ────────────────────────────────────────────
 * MathInlineView — 主组件
 * ──────────────────────────────────────────── */

export const MathInlineView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  selected,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const formula = (node.attrs.formula as string) || '';

  const handleClick = useCallback(() => {
    setIsEditing(true);
  }, []);

  const handleChange = useCallback((newFormula: string) => {
    updateAttributes({ formula: newFormula });
  }, [updateAttributes]);

  const handleClose = useCallback(() => {
    setIsEditing(false);
  }, []);

  return (
    <NodeViewWrapper
      as="span"
      className={`math-inline ${selected ? 'math-inline--selected' : ''}`}
    >
      <span
        className="math-inline__display"
        contentEditable={false}
        onClick={handleClick}
        role="button"
        tabIndex={0}
      >
        {formula.trim() ? (
          <InlineMathRenderer formula={formula} />
        ) : (
          <span className="math-inline__placeholder">
            <Sigma size={12} />
            公式
          </span>
        )}
      </span>

      {isEditing && (
        <span className="math-inline__editor-anchor" contentEditable={false}>
          <InlineMathEditor
            formula={formula}
            onChange={handleChange}
            onClose={handleClose}
          />
        </span>
      )}
    </NodeViewWrapper>
  );
};
