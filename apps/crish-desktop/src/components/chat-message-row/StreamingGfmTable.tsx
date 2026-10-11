import React, { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStreamingMarkdownHtml } from '../../api/markdownRenderAsync';
import { splitTableCells } from '../../api/markdown-render/markdownTable';
import type { IncrementalMarkdownUnitSnapshot } from '../../api/markdown/IncrementalMarkdownSession';
import {
  StreamingGfmTableParser,
  type StreamingGfmTableHeader,
} from '../../api/markdown/StreamingGfmTableParser';
import { StreamingTableContainer } from './StreamingTableContainer';
import { ReconciledMarkdownHtml } from '../markdown/ReconciledMarkdownHtml';

interface SourceRow {
  index: number;
  cells: string[];
}

function normalizeCells(line: string, columnCount: number): string[] {
  const cells = splitTableCells(line).slice(0, columnCount);
  while (cells.length < columnCount) cells.push('');
  return cells;
}

function updateSourceRow(current: SourceRow[], next: SourceRow): SourceRow[] {
  const rows = current.slice();
  while (rows.length <= next.index) {
    rows.push({ index: rows.length, cells: [] });
  }
  rows[next.index] = next;
  return rows;
}

function unwrapCellParagraph(html: string): string {
  const open = '<p class="md-p">';
  return html.startsWith(open) && html.endsWith('</p>')
    ? html.slice(open.length, -'</p>'.length)
    : html;
}

function useStreamingMarkdownUnits(markdown: string, enabled: boolean): {
  html: string;
  units: readonly IncrementalMarkdownUnitSnapshot[] | null;
} {
  const unitsRef = useRef<readonly IncrementalMarkdownUnitSnapshot[] | null>(null);
  const sourceRef = useRef(markdown);
  const sourceChanged = sourceRef.current !== markdown;
  const sourceReset = sourceChanged && !markdown.startsWith(sourceRef.current);
  if (sourceChanged) sourceRef.current = markdown;
  if (sourceReset) unitsRef.current = null;

  const html = useStreamingMarkdownHtml(markdown, enabled, undefined, unitsRef);
  return { html, units: sourceReset ? null : unitsRef.current };
}

/** 每个格子独立消费 Markdown 增量；稳定行的 session 不接收重复源文本。 */
const StreamingTableCell = memo(function StreamingTableCell({
  markdown,
  align,
  header = false,
}: {
  markdown: string;
  align: 'left' | 'center' | 'right';
  header?: boolean;
}) {
  const { html: rendered, units: snapshots } = useStreamingMarkdownUnits(markdown, true);
  const cellUnits = useMemo(
    () => snapshots?.map((unit) => ({
      ...unit,
      html: unwrapCellParagraph(unit.html),
    })) ?? null,
    [snapshots]
  );
  const Cell = header ? 'th' : 'td';
  return (
    <Cell
      className={header ? 'md-th' : 'md-td'}
      {...(header ? { scope: 'col' as const } : {})}
      style={{ textAlign: align }}
    >
      <ReconciledMarkdownHtml
        className="md-streaming-table-cell-content"
        html={rendered}
        incrementalUnits={cellUnits}
      />
    </Cell>
  );
});

/** 表头尽早成为真实表格；活动行逐格增量编译，不重编译稳定行。 */
export function StreamingGfmTable({
  markdown,
  isStreaming = true,
}: {
  markdown: string;
  isStreaming?: boolean;
}) {
  const parserRef = useRef(new StreamingGfmTableParser());
  const [header, setHeader] = useState<StreamingGfmTableHeader | null>(null);
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [trailingMarkdown, setTrailingMarkdown] = useState('');
  const { html: trailingHtml, units: trailingUnits } = useStreamingMarkdownUnits(
    trailingMarkdown,
    trailingMarkdown.trim().length > 0
  );

  useLayoutEffect(() => {
    const update = parserRef.current.advance(markdown);
    if (update.reset) {
      setHeader(null);
      setRows([]);
    }
    setTrailingMarkdown(update.trailingMarkdown);

    if (update.header) setHeader(update.header);
    const currentHeader = update.header;
    if (!currentHeader) return;

    for (const row of update.addedRows) {
      setRows((current) => updateSourceRow(current, {
        index: row.index,
        cells: normalizeCells(row.line, currentHeader.cells.length),
      }));
    }
    if (update.partialChanged && update.partialRow) {
      setRows((current) => updateSourceRow(current, {
        index: update.partialRow!.index,
        cells: normalizeCells(update.partialRow!.line, currentHeader.cells.length),
      }));
    }
  }, [markdown]);

  const trailingContent = trailingMarkdown.trim() ? (
    <ReconciledMarkdownHtml
      className="md-streaming-table-trailing"
      data-streaming-table-trailing="true"
      html={trailingHtml}
      incrementalUnits={trailingUnits}
    />
  ) : null;

  return (
    <>
      {header ? (
        <StreamingTableContainer isStreaming={isStreaming}>
          <table className="md-table" aria-label="流式生成的表格">
            <thead>
              <tr className="md-tr">
                {header.cells.map((cell, index) => (
                  <StreamingTableCell
                    key={index}
                    markdown={cell}
                    align={header.alignments[index] ?? 'left'}
                    header
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  className={`md-tr${row.index % 2 === 1 ? ' md-tr-alt' : ''}`}
                  key={row.index}
                  data-stream-row={row.index}
                >
                  {row.cells.map((cell, index) => (
                    <StreamingTableCell
                      key={index}
                      markdown={cell}
                      align={header.alignments[index] ?? 'left'}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </StreamingTableContainer>
      ) : null}
      {trailingContent}
    </>
  );
}
