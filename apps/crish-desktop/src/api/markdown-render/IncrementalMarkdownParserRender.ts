/**
 * 增量 Markdown 解析器块渲染纯函数（从 IncrementalMarkdownParser.ts 拆出，降低 hub 行数）。
 *
 * 职责：将 fence / table / list 状态对象渲染为 HTML 字符串，无状态、无副作用。
 * closeXxx 与 buildTailBlock 共用本模块函数，避免渲染逻辑双份漂移。
 */

import { renderListItemHtml, type ListKind } from './markdownPlugins';
import { escapeHtml } from '../markdownRenderLite';
import { renderInline, highlightCodeBlock } from './IncrementalInlineRenderer';
import type {
  BlockNode,
  FenceState,
  ListState,
  TableState,
} from './IncrementalMarkdownParserTypes';

/** 渲染 table HTML（不修改状态，closeTable 与 buildTailBlock 共用）。 */
export function renderTableHtml(table: TableState): string {
  const alignments = table.alignments;
  const rows = table.rows;
  let html = '<table class="md-table"><thead><tr>';
  const header = rows[0] || [];
  header.forEach((cell, i) => {
    const align = alignments[i];
    html += `<th${align ? ` class="${align}"` : ''}>${renderInline(cell)}</th>`;
  });
  html += '</tr></thead><tbody>';
  for (let r = 1; r < rows.length; r++) {
    html += '<tr>';
    rows[r]!.forEach((cell, i) => {
      const align = alignments[i];
      html += `<td${align ? ` class="${align}"` : ''}>${renderInline(cell)}</td>`;
    });
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

/** 渲染 fence HTML（不修改状态，closeFence 与 buildTailBlock 共用）。 */
export function renderFenceHtml(fence: FenceState): string {
  const code = fence.buffer.join('\n');
  const highlighted = highlightCodeBlock(fence.lang, code);
  const lang = fence.lang;
  const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
  const langBadge = lang
    ? `<span class="md-code-lang" data-lang="${escapeHtml(lang)}">${escapeHtml(lang)}</span>`
    : '';
  return (
    `<div class="md-code-block"${langAttr}>${langBadge}` +
    `<button type="button" class="md-code-copy" aria-label="复制代码">复制</button>` +
    `<pre class="md-code-pre hljs"><code class="language-${escapeHtml(lang)}">${highlighted}</code></pre></div>`
  );
}

/**
 * 渲染 list HTML（不修改状态，closeList 与 buildTailBlock 共用）。
 * 仅渲染单个列表（简化实现中栈深度 <= 1）。
 */
export function renderListHtml(list: ListState, endLine: number, listKind?: ListKind): BlockNode {
  // listKind 参数仅为类型兼容保留；实际由 list.kind 决定（保持调用点签名稳定）
  void listKind;
  const items = list.items
    .map((item) =>
      renderListItemHtml(
        item.kind,
        renderInline(item.content),
        item.taskChecked,
      ),
    )
    .join('');
  const tag = list.kind === 'ol' ? 'ol' : 'ul';
  const cls = list.kind === 'ol' ? 'md-ol' : 'md-ul';
  const startAttr =
    list.kind === 'ol' && list.items[0]?.olStart
      ? ` start="${list.items[0].olStart}"`
      : '';
  return {
    type: list.kind === 'ol' ? 'ol' : 'ul',
    html: `<${tag} class="${cls}"${startAttr}>${items}</${tag}>`,
    startLine: list.startLine,
    endLine,
  };
}
