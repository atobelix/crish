/**
 * MermaidBlockView — Mermaid 图表
 *
 * ── 交互清单 ──────────────────────────────────────────
 *   默认         → 渲染后的 SVG
 *   点击图表      → 切到「源码 + 预览」分栏，实时同步
 *   悬浮块        → 右上角出现「编辑 / 复制源码 / 下载 SVG」
 *   源码有语法错  → 保留上一次成功渲染的图，在下方以红条提示错误，
 *                  而不是把已画好的图换成一片报错——用户边打字边渲染时
 *                  中间态必然是非法的，闪烁报错会非常烦躁
 *   加载渲染器中  → 骨架微光
 *
 * ── 性能 ──────────────────────────────────────────────
 *   mermaid 体积很大，走动态 import 且全局只加载一次；
 *   源码变更做 300ms 防抖，避免每次击键都跑一遍图形布局算法。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { NodeViewContent } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { Workflow, Pencil, Copy, Check, Download } from 'lucide-react';
import { BlockShell } from '../_shared/BlockShell';
import { useBlockEditing } from '../../hooks/useBlockEditing';
import { renderMermaid } from '../../utils/mermaidLoader';

const DEBOUNCE_MS = 300;

export const MermaidBlockView: React.FC<NodeViewProps> = ({
  node,
  editor,
  getPos,
  selected,
}) => {
  const { isEditing, focusNode } = useBlockEditing(editor, getPos);
  const source = node.textContent;

  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(0);

  /* ── 防抖渲染 ── */
  useEffect(() => {
    if (!source.trim()) {
      setSvg('');
      setError(null);
      setLoading(false);
      return;
    }

    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      let cancelled = false;
      renderMermaid(source)
        .then((result) => {
          if (cancelled) return;
          setSvg(result);
          setError(null);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // 关键：不清空 svg。保留上一张成功的图，只在下方提示错误。
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timerRef.current);
  }, [source]);

  const copySource = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 忽略 */
    }
  }, [source]);

  const downloadSvg = useCallback(() => {
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'diagram.svg';
    a.click();
    URL.revokeObjectURL(url);
  }, [svg]);

  return (
    <BlockShell
      kind="mermaid"
      selected={selected}
      badge={
        <span className="block-badge">
          <Workflow size={12} />
          Mermaid
        </span>
      }
      actions={[
        {
          id: 'edit',
          label: isEditing ? '收起源码' : '编辑源码',
          icon: Pencil,
          active: isEditing,
          onClick: focusNode,
        },
        {
          id: 'copy',
          label: copied ? '已复制' : '复制源码',
          icon: copied ? Check : Copy,
          active: copied,
          onClick: copySource,
        },
        { id: 'download', label: '下载 SVG', icon: Download, onClick: downloadSvg },
      ]}
    >
      <div className={`mermaid-block ${isEditing ? 'is-editing' : ''}`}>
        {/* 源码区：编辑态才展开 */}
        <div className="mermaid-block__source">
          {/* NodeViewContent 的 as 类型只声明了 'div'，这里需要 <pre> 以保留空白 */}
          <NodeViewContent as={'pre' as 'div'} className="mermaid-block__code" />
        </div>

        {/* 预览区 */}
        <div className="mermaid-block__preview" contentEditable={false} onClick={focusNode}>
          {loading && !svg ? (
            <div className="mermaid-block__skeleton" aria-label="正在渲染图表" />
          ) : svg ? (
            // mermaid 自身会对输出做转义；此处仅渲染其产物
            <div className="mermaid-block__svg" dangerouslySetInnerHTML={{ __html: svg }} />
          ) : (
            <div className="mermaid-block__placeholder">
              输入 Mermaid 语法，例如 <code>graph TD; A--&gt;B;</code>
            </div>
          )}
        </div>

        {error && (
          <div className="mermaid-block__error motion-fade-in" contentEditable={false}>
            <span className="mermaid-block__error-tag">语法错误</span>
            <span className="mermaid-block__error-text">{error}</span>
          </div>
        )}
      </div>
    </BlockShell>
  );
};
