import React, { useLayoutEffect, useRef } from 'react';
import { splitHtmlIntoUnits } from '../../api/markdown/unitSplitter';
import {
  reconcileUnitNode,
  reconcileUnits,
} from '../../api/markdown/unitReconciler';
import { applyCodeIndentToRenderedRoot } from '../../api/codeBlockIndent';
import type { IncrementalMarkdownUnitSnapshot } from '../../api/markdown/IncrementalMarkdownSession';

type ReconciledMarkdownHtmlProps = Omit<
  React.HTMLAttributes<HTMLElement>,
  'children' | 'dangerouslySetInnerHTML'
> & {
  as?: 'div' | 'span';
  /** 仅传入 Markdown 渲染器输出的安全 HTML，不接受 Markdown 原文。 */
  html: string;
  /** 可选的代码块缩进样式，沿用聊天 Markdown 设置。 */
  codeIndent?: string;
  /**
   * 活跃流式块的根单元快照。传入后只解析发生变化的单元 HTML；稳定
   * 单元直接复用原 DOM 节点，不再每帧 split 累计 HTML。
   */
  incrementalUnits?: readonly IncrementalMarkdownUnitSnapshot[] | null;
};

/**
 * 将安全 Markdown HTML 按结构单元协调到原有 DOM 上。
 * 组件独占其子树，调用方不得同时传入 React children。
 */
export function ReconciledMarkdownHtml({
  as = 'div',
  html,
  codeIndent,
  incrementalUnits,
  ...attributes
}: ReconciledMarkdownHtmlProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const incrementalModeRef = useRef(false);
  const unitNodesRef = useRef(new Map<number, Node>());
  const unitHtmlRef = useRef(new Map<number, string>());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (incrementalUnits) {
      if (!incrementalModeRef.current) {
        while (container.firstChild) container.removeChild(container.firstChild);
        unitNodesRef.current.clear();
        unitHtmlRef.current.clear();
        incrementalModeRef.current = true;
      }

      const activeIds = new Set(incrementalUnits.map((unit) => unit.id));
      for (const [id, node] of unitNodesRef.current) {
        if (activeIds.has(id)) continue;
        if (node.parentNode === container) container.removeChild(node);
        unitNodesRef.current.delete(id);
        unitHtmlRef.current.delete(id);
      }

      for (const unit of incrementalUnits) {
        const previousHtml = unitHtmlRef.current.get(unit.id);
        let node = unitNodesRef.current.get(unit.id) ?? null;
        if (previousHtml !== unit.html || !node) {
          const parsed = splitHtmlIntoUnits(unit.html);
          if (!parsed.length) {
            if (node?.parentNode === container) container.removeChild(node);
            unitNodesRef.current.delete(unit.id);
            unitHtmlRef.current.set(unit.id, unit.html);
            continue;
          }
          node = reconcileUnitNode(node, parsed[0]!);
          unitNodesRef.current.set(unit.id, node);
          unitHtmlRef.current.set(unit.id, unit.html);
        }
        // appendChild 只会调整顺序，已有节点本身保持不变。
        if (node.parentNode !== container) container.appendChild(node);
        else container.appendChild(node);
      }

      const mountedNodes = new Set(unitNodesRef.current.values());
      for (const child of Array.from(container.childNodes)) {
        if (!mountedNodes.has(child)) container.removeChild(child);
      }
    } else {
      incrementalModeRef.current = false;
      unitNodesRef.current.clear();
      unitHtmlRef.current.clear();
      reconcileUnits(container, splitHtmlIntoUnits(html));
    }
    if (codeIndent !== undefined) {
      applyCodeIndentToRenderedRoot(container, codeIndent);
    }
  }, [html, codeIndent, incrementalUnits]);

  return React.createElement(as, { ...attributes, ref: containerRef });
}
