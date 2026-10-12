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
  /**
   * 是否允许在 `incrementalUnits` 未激活且 `html === ""` 时清空容器已有 DOM 节点。
   * 默认 `false`（启用零坍塌硬防御盾 Zero-Collapse Guard）。
   */
  allowEmptyClear?: boolean;
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
  allowEmptyClear = false,
  ...attributes
}: ReconciledMarkdownHtmlProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const incrementalModeRef = useRef(false);
  const unitNodesRef = useRef(new Map<number, Node>());
  const unitHtmlRef = useRef(new Map<number, string>());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const hasIncrementalUnits = Boolean(
      incrementalUnits && incrementalUnits.length > 0
    );

    if (hasIncrementalUnits && incrementalUnits) {
      const seedElements = !incrementalModeRef.current
        ? Array.from(container.children)
        : [];
      let seedIndex = 0;
      if (!incrementalModeRef.current) {
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

      let cursor: ChildNode | null = container.firstChild;
      for (const unit of incrementalUnits) {
        const previousHtml = unitHtmlRef.current.get(unit.id);
        const previousNode = unitNodesRef.current.get(unit.id) ?? null;
        let node = previousNode;
        if (previousHtml !== unit.html || !node) {
          const parsed = splitHtmlIntoUnits(unit.html);
          if (!parsed.length) {
            if (previousNode?.parentNode === container) {
              if (cursor === previousNode) cursor = previousNode.nextSibling;
              container.removeChild(previousNode);
            }
            unitNodesRef.current.delete(unit.id);
            unitHtmlRef.current.set(unit.id, unit.html);
            continue;
          }
          const targetNode =
            node ??
            (seedIndex < seedElements.length
              ? seedElements[seedIndex++]!
              : null);
          node = reconcileUnitNode(targetNode, parsed[0]!);
          if (
            previousNode &&
            previousNode !== node &&
            previousNode.parentNode === container
          ) {
            if (cursor === previousNode) cursor = previousNode.nextSibling;
            container.removeChild(previousNode);
          }
          unitNodesRef.current.set(unit.id, node);
          unitHtmlRef.current.set(unit.id, unit.html);
        }
        if (node === cursor) {
          cursor = cursor.nextSibling;
        } else {
          container.insertBefore(node, cursor);
        }
      }

      const mountedNodes = new Set(unitNodesRef.current.values());
      for (const child of Array.from(container.childNodes)) {
        if (!mountedNodes.has(child)) container.removeChild(child);
      }
    } else {
      // 【零坍塌硬防御盾（Zero-Collapse Guard）】：
      // 当从增量单元模式（或容器已有已渲染子节点）切换到 incrementalUnits 未激活且 html 为空串时，
      // 除非显式声明 allowEmptyClear=true，否则严禁调用 reconcileUnits(container, []) 清空已有 DOM 树。
      if (
        !allowEmptyClear &&
        !html.trim() &&
        (incrementalModeRef.current || container.childNodes.length > 0)
      ) {
        return;
      }

      incrementalModeRef.current = false;
      unitNodesRef.current.clear();
      unitHtmlRef.current.clear();
      reconcileUnits(container, splitHtmlIntoUnits(html));
    }
    if (codeIndent !== undefined) {
      applyCodeIndentToRenderedRoot(container, codeIndent);
    }
  }, [html, codeIndent, incrementalUnits, allowEmptyClear]);

  return React.createElement(as, { ...attributes, ref: containerRef });
}
