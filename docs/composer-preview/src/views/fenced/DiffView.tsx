/**
 * DiffView — Diff 对比块 NodeView 组件 (v2)
 *
 * 编辑模式显示围栏标记 + 原始 diff 代码
 * 渲染模式显示着色的 diff 对比表格
 */

import React, { useMemo, useCallback, useState } from 'react';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { Check, Copy } from 'lucide-react';
import { useBlockEditing } from '../../hooks/useBlockEditing';
import { FenceMarker } from '../_shared/FenceMarker';
import { Tooltip } from '../../ui/Tooltip';
import { parseDiff, getDiffStats } from '../../utils/diffParser';
import { copyToClipboard } from '../../utils';

export const DiffView: React.FC<NodeViewProps> = ({
  node,
  editor,
  getPos,
}) => {
  const { isEditing, focusNode } = useBlockEditing(editor, getPos);
  const [copied, setCopied] = useState(false);

  const rawCode = node.textContent;
  const diffLines = useMemo(() => parseDiff(rawCode), [rawCode]);
  const stats = useMemo(() => getDiffStats(diffLines), [diffLines]);

  const handleCopy = useCallback(async () => {
    const success = await copyToClipboard(rawCode);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [rawCode]);

  if (isEditing) {
    return (
      <NodeViewWrapper className="diff-block-wrapper is-editing">
        <FenceMarker text="```diff" position="top" />
        <div className="code-block__content">
          <NodeViewContent as={"pre" as any} />
        </div>
        <FenceMarker text="```" position="bottom" />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className="diff-block-wrapper" onClick={focusNode}>
      <div className="diff-block__header" contentEditable={false}>
        <div className="diff-block__stats">
          <span className="diff-block__stat--add">+{stats.additions}</span>
          <span className="diff-block__stat--del">-{stats.deletions}</span>
        </div>
        <Tooltip content={copied ? '已复制' : '复制'}>
          <button
            type="button"
            className={`code-block__action-btn ${copied ? 'code-block__action-btn--copied' : ''}`}
            onClick={handleCopy}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </Tooltip>
      </div>
      <table className="diff-block__table" contentEditable={false}>
        <tbody>
          {diffLines.map((line, i) => (
            <tr
              key={i}
              className={`diff-block__line diff-block__line--${line.type}`}
            >
              <td className="diff-block__line-num">
                {line.oldLineNum ?? ''}
              </td>
              <td className="diff-block__line-num">
                {line.newLineNum ?? ''}
              </td>
              <td className="diff-block__line-content">
                {line.text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </NodeViewWrapper>
  );
};
