// @vitest-environment jsdom
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMarkdownHtmlCache } from '../../api/markdownCache';

const { renderMarkdown } = vi.hoisted(() => ({
  renderMarkdown: vi.fn(async (_markdown: string): Promise<string | null> => ''),
}));

vi.mock('../../api/rustCore', () => ({ renderMarkdown }));

vi.mock('./StreamingTableContainer', () => ({
  StreamingTableContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="streaming-table-container">{children}</div>
  ),
}));

import { StreamingGfmTable } from './StreamingGfmTable';

function renderInlineMarkdown(markdown: string): string {
  const escaped = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return `<p class="md-p">${escaped}</p>`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('StreamingGfmTable', () => {
  beforeEach(() => {
    clearMarkdownHtmlCache();
    renderMarkdown.mockReset();
    renderMarkdown.mockImplementation(async (markdown) => renderInlineMarkdown(markdown));
  });

  it('publishes a real table as soon as the delimiter is valid without waiting for LF', async () => {
    const header = '| Task | Name |\n';
    const delimiter = '| --- | --- |';
    const { container } = render(
      <StreamingGfmTable markdown={`${header}${delimiter}`} />
    );

    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll('thead th')).toHaveLength(2);
    expect(table?.querySelector('tbody')).not.toBeNull();
    expect(container.textContent).not.toContain('| Task | Name |');
    expect(container.textContent).not.toContain('| --- | --- |');

    await waitFor(() => {
      expect(container.querySelectorAll('thead th').length).toBe(2);
      expect(renderMarkdown.mock.calls.map(([source]) => source).join('')).toBe(
        'TaskName'
      );
    });
  });

  it('streams only new cell fragments and retains committed row and cell DOM', async () => {
    const header = '| Task | Name |\n| --- | --- |\n';
    const firstRow = '| TASK-001 | **Research** |\n';
    const { container, rerender } = render(
      <StreamingGfmTable markdown={`${header}${firstRow}`} />
    );

    await waitFor(() => {
      expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
      expect(container.textContent).toContain('Research');
    });
    const firstRowNode = container.querySelector('tbody tr[data-stream-row="0"]');
    const stableCellNode = firstRowNode?.querySelector('td:nth-child(2)');
    expect(
      Array.from(firstRowNode?.querySelectorAll('td') ?? [], (cell) => cell.textContent)
    ).toEqual(['TASK-001', 'Research']);
    expect(firstRowNode?.querySelector('strong')?.textContent).toBe('Research');

    clearMarkdownHtmlCache();
    renderMarkdown.mockClear();
    rerender(
      <StreamingGfmTable markdown={`${header}${firstRow}| TASK-002 | Dra`} />
    );
    await waitFor(() => {
      expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
      expect(
        container.querySelector('tbody tr[data-stream-row="1"]')?.textContent
      ).toContain('Dra');
    });
    const secondRowNode = container.querySelector('tbody tr[data-stream-row="1"]');
    const activeCellNode = secondRowNode?.querySelector('td:nth-child(2)');
    const activeCellContent = activeCellNode?.querySelector(
      '.md-streaming-table-cell-content'
    );
    const activeCellTextNode = activeCellContent?.firstChild;
    expect(activeCellTextNode?.nodeType).toBe(Node.TEXT_NODE);

    const firstDeltaCalls = renderMarkdown.mock.calls.map(([source]) => source).join('');
    expect(firstDeltaCalls).toContain('TASK-002');
    expect(firstDeltaCalls).toContain('Dra');
    expect(firstDeltaCalls).not.toContain('Task');
    expect(firstDeltaCalls).not.toContain('Name');
    expect(firstDeltaCalls).not.toContain('TASK-001');
    expect(firstDeltaCalls).not.toContain('Research');
    expect(container.querySelector('tbody tr[data-stream-row="0"]')).toBe(firstRowNode);
    expect(firstRowNode?.querySelector('td:nth-child(2)')).toBe(stableCellNode);

    clearMarkdownHtmlCache();
    renderMarkdown.mockClear();
    rerender(
      <StreamingGfmTable markdown={`${header}${firstRow}| TASK-002 | Draft`} />
    );
    await waitFor(() =>
      expect(
        container.querySelector('tbody tr[data-stream-row="1"] td:nth-child(2)')
          ?.textContent
      ).toContain('Draft')
    );

    expect(renderMarkdown.mock.calls.map(([source]) => source)).toEqual(['ft']);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.querySelector('tbody tr[data-stream-row="1"]')).toBe(
      secondRowNode
    );
    expect(
      container.querySelector('tbody tr[data-stream-row="1"] td:nth-child(2)')
    ).toBe(activeCellNode);
    expect(
      container
        .querySelector('tbody tr[data-stream-row="1"] td:nth-child(2)')
        ?.querySelector('.md-streaming-table-cell-content')?.firstChild
    ).toBe(activeCellTextNode);
    expect(activeCellTextNode?.textContent).toBe('Draft');
    expect(container.querySelector('table')?.innerHTML).not.toContain('| TASK-001 |');
    expect(container.querySelector('table')?.innerHTML).not.toContain('**Research**');
    expect(container.textContent).not.toContain('**');
  });

  it('renders adjacent Markdown through compiled HTML and retains its paragraph while growing', async () => {
    const header = '| Task | Name |\n| --- | --- |\n| TASK-001 | Research |\n';
    const { container, rerender } = render(
      <StreamingGfmTable markdown={`${header}After **the table**`} />
    );

    await waitFor(() => {
      expect(
        container.querySelector('[data-streaming-table-trailing] strong')?.textContent
      ).toBe('the table');
      expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    });
    const paragraph = container.querySelector('[data-streaming-table-trailing] p');
    const strong = container.querySelector('[data-streaming-table-trailing] strong');

    clearMarkdownHtmlCache();
    renderMarkdown.mockClear();
    rerender(
      <StreamingGfmTable markdown={`${header}After **the table** keeps growing`} />
    );

    await waitFor(() =>
      expect(container.querySelector('[data-streaming-table-trailing]')?.textContent)
        .toContain('keeps growing')
    );
    expect(renderMarkdown.mock.calls.map(([source]) => source)).toEqual([
      ' keeps growing',
    ]);
    expect(container.querySelector('[data-streaming-table-trailing] p')).toBe(paragraph);
    expect(container.querySelector('[data-streaming-table-trailing] strong')).toBe(strong);
    expect(container.innerHTML).toContain('After <strong>the table</strong> keeps growing');
    expect(container.innerHTML).not.toContain('After **the table');
    expect(container.innerHTML).not.toContain('| TASK-001 |');
  });

  it('renders a trailing thematic break without replacing the committed table', async () => {
    const tableMarkdown =
      '| Key | Value |\n| --- | --- |\n| TASK-001 | stable |\n';
    const { container } = render(
      <StreamingGfmTable markdown={`${tableMarkdown}---\n`} />
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-streaming-table-trailing] hr.md-hr')
      ).not.toBeNull()
    );

    const table = container.querySelector('table');
    const row = container.querySelector('tbody tr[data-stream-row="0"]');
    expect(table).not.toBeNull();
    expect(row?.textContent).toBe('TASK-001stable');
    expect(container.querySelector('table')).toBe(table);
    expect(container.querySelector('tbody tr[data-stream-row="0"]')).toBe(row);
    expect(container.textContent).not.toContain('| Key | Value |');
    expect(container.textContent).not.toContain('---');
  });

  it('streams trailing units and discards a pending tail after parser reset', async () => {
    const oldTail = deferred<string | null>();
    renderMarkdown.mockImplementation(async (markdown) => {
      if (markdown === '**OLD_PENDING_TRAILING**') return oldTail.promise;
      return renderInlineMarkdown(markdown);
    });
    const oldTable = '| Old | Name |\n| --- | --- |\n| old | row |\n';
    const { container, rerender } = render(
      <StreamingGfmTable
        markdown={`${oldTable}After **OLD_PENDING_TRAILING**`}
      />
    );

    await waitFor(() =>
      expect(renderMarkdown).toHaveBeenCalledWith('**OLD_PENDING_TRAILING**')
    );
    expect(
      container.querySelector('[data-streaming-table-trailing]')?.textContent
    ).toContain('After');
    expect(container.textContent).not.toContain('OLD_PENDING_TRAILING');
    expect(container.innerHTML).not.toContain('**OLD_PENDING_TRAILING**');

    rerender(<StreamingGfmTable markdown="| New" />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('[data-streaming-table-trailing]')).toBeNull();
    expect(container.textContent).not.toContain('OLD_PENDING_TRAILING');

    const newTable =
      '| New | Name |\n| --- | --- |\n| value | safe |\nAfter **NEW_TRAILING**';
    rerender(<StreamingGfmTable markdown={newTable} />);
    await waitFor(() =>
      expect(
        container.querySelector('[data-streaming-table-trailing] strong')?.textContent
      ).toBe('NEW_TRAILING')
    );
    const newTailStrong = container.querySelector(
      '[data-streaming-table-trailing] strong'
    );

    await act(async () => {
      oldTail.resolve(renderInlineMarkdown('**OLD_PENDING_TRAILING**'));
      await oldTail.promise;
    });
    expect(
      container.querySelector('[data-streaming-table-trailing] strong')
    ).toBe(newTailStrong);
    expect(container.textContent).toContain('NEW_TRAILING');
    expect(container.textContent).not.toContain('OLD_PENDING_TRAILING');
    expect(container.innerHTML).not.toContain('**');
    expect(container.innerHTML).not.toContain('| New | Name |');
  });

  it('keeps pending and rejected cell renders blank without exposing Markdown source', async () => {
    const pending = deferred<string | null>();
    renderMarkdown.mockImplementation(async (markdown) => {
      if (markdown === '**SensitiveCell**') return pending.promise;
      return renderInlineMarkdown(markdown);
    });
    const markdown = '| A | B |\n| --- | --- |\n| **SensitiveCell** | safe |';
    const { container } = render(<StreamingGfmTable markdown={markdown} />);

    await waitFor(() => {
      expect(renderMarkdown).toHaveBeenCalledWith('**SensitiveCell**');
    });
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.textContent).not.toContain('SensitiveCell');
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('| A | B |');

    await act(async () => {
      pending.reject(new Error('renderer failed'));
      await pending.promise.catch(() => undefined);
    });

    await waitFor(() => {
      expect(container.querySelector('tbody tr')).not.toBeNull();
      expect(container.querySelector('tbody tr')?.textContent).toBe('safe');
    });
    expect(container.textContent).not.toContain('SensitiveCell');
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('| A | B |');
  });

  it('drops a pending old cell after input shrink/reset, even if its renderer resolves later', async () => {
    const oldCell = deferred<string | null>();
    renderMarkdown.mockImplementation(async (markdown) => {
      if (markdown === '**OLD_PENDING_CELL**') return oldCell.promise;
      return renderInlineMarkdown(markdown);
    });
    const oldMarkdown =
      '| Old | Name |\n| --- | --- |\n| **OLD_PENDING_CELL** | old row |';
    const { container, rerender } = render(
      <StreamingGfmTable markdown={oldMarkdown} />
    );

    await waitFor(() => {
      expect(renderMarkdown).toHaveBeenCalledWith('**OLD_PENDING_CELL**');
    });
    expect(container.textContent).not.toContain('OLD_PENDING_CELL');

    const shrunk = '| New';
    rerender(<StreamingGfmTable markdown={shrunk} />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).not.toContain('Old');
    expect(container.textContent).not.toContain('OLD_PENDING_CELL');
    expect(container.textContent).not.toContain(shrunk);

    const newMarkdown = '| New | Name |\n| --- | --- |\n| NEW_SAFE_CELL | new row |';
    rerender(<StreamingGfmTable markdown={newMarkdown} />);
    await waitFor(() => expect(container.textContent).toContain('NEW_SAFE_CELL'));

    await act(async () => {
      oldCell.resolve('<p class="md-p"><strong>OLD_PENDING_CELL</strong></p>');
      await oldCell.promise;
    });
    expect(container.textContent).toContain('NEW_SAFE_CELL');
    expect(container.textContent).not.toContain('OLD_PENDING_CELL');
    expect(container.textContent).not.toContain('old row');
  });

  it('preserves a row through sealing while a cell renderer is pending', async () => {
    const pending = deferred<string | null>();
    renderMarkdown.mockImplementation(async (markdown) => {
      if (markdown === '**PENDING_AT_SEAL**') return pending.promise;
      return renderInlineMarkdown(markdown);
    });
    const markdown = '| A | B |\n| --- | --- |\n| **PENDING_AT_SEAL** | stable |';
    const { container, rerender } = render(
      <StreamingGfmTable markdown={markdown} isStreaming />
    );

    await waitFor(() => expect(renderMarkdown).toHaveBeenCalledWith('**PENDING_AT_SEAL**'));
    const row = container.querySelector('tbody tr');
    expect(row).not.toBeNull();
    expect(container.textContent).not.toContain('PENDING_AT_SEAL');

    rerender(<StreamingGfmTable markdown={markdown} isStreaming={false} />);
    expect(container.querySelector('tbody tr')).toBe(row);
    expect(container.textContent).not.toContain('PENDING_AT_SEAL');

    await act(async () => {
      pending.resolve(renderInlineMarkdown('**PENDING_AT_SEAL**'));
      await pending.promise;
    });
    await waitFor(() => expect(container.textContent).toContain('PENDING_AT_SEAL'));
    expect(container.querySelector('tbody tr')).toBe(row);
    expect(container.textContent).not.toContain('| A | B |');
  });

  it('keeps a pending cell bound to its row when the parser hands off trailing Markdown', async () => {
    const pending = deferred<string | null>();
    renderMarkdown.mockImplementation(async (markdown) => {
      if (markdown === '**PENDING_AT_HANDOFF**') return pending.promise;
      return renderInlineMarkdown(markdown);
    });
    const table =
      '| A | B |\n| --- | --- |\n| **PENDING_AT_HANDOFF** | stable |';
    const { container, rerender } = render(
      <StreamingGfmTable markdown={table} isStreaming />
    );

    await waitFor(() =>
      expect(renderMarkdown).toHaveBeenCalledWith('**PENDING_AT_HANDOFF**')
    );
    const row = container.querySelector('tbody tr');
    expect(row).not.toBeNull();
    expect(container.textContent).not.toContain('PENDING_AT_HANDOFF');

    rerender(
      <StreamingGfmTable
        markdown={`${table}\nAfter **the table**\n`}
        isStreaming={false}
      />
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-streaming-table-trailing] strong')?.textContent
      ).toBe('the table')
    );
    expect(container.querySelector('tbody tr')).toBe(row);
    expect(container.textContent).not.toContain('PENDING_AT_HANDOFF');
    expect(container.innerHTML).not.toContain('| A | B |');
    expect(container.innerHTML).not.toContain('**PENDING_AT_HANDOFF**');

    await act(async () => {
      pending.resolve(renderInlineMarkdown('**PENDING_AT_HANDOFF**'));
      await pending.promise;
    });
    await waitFor(() =>
      expect(row?.querySelector('strong')?.textContent).toBe('PENDING_AT_HANDOFF')
    );
    expect(container.querySelector('tbody tr')).toBe(row);
    expect(
      container.querySelector('[data-streaming-table-trailing] strong')?.textContent
    ).toBe('the table');
    expect(container.textContent).not.toContain('**');
    expect(container.innerHTML).not.toContain('| A | B |');
  });

  it('discards a pending cell render when a split escape changes the cell source', async () => {
    const oldRender = deferred<string | null>();
    const escapedRender = deferred<string | null>();
    renderMarkdown.mockImplementation(async (markdown) => {
      if (markdown === 'alue\\') return oldRender.promise;
      if (markdown === 'alue|right') return escapedRender.promise;
      return renderInlineMarkdown(markdown);
    });
    const prefix = '| Key | Value |\n| --- | --- |\n| id | value\\';
    const { container, rerender } = render(
      <StreamingGfmTable markdown={prefix} />
    );

    await waitFor(() => expect(renderMarkdown).toHaveBeenCalledWith('alue\\'));
    const row = container.querySelector('tbody tr[data-stream-row="0"]');
    const valueCell = row?.querySelector('td:nth-child(2)');
    expect(valueCell?.textContent).toBe('v');
    expect(valueCell?.textContent).not.toContain('alue');
    expect(container.textContent).not.toContain('alue\\');
    expect(container.textContent).not.toContain('\\');

    const escapedPipeAtChunkEnd = `${prefix}|right`;
    rerender(<StreamingGfmTable markdown={escapedPipeAtChunkEnd} />);
    await waitFor(() =>
      expect(renderMarkdown).toHaveBeenCalledWith('alue|right')
    );
    expect(container.querySelector('tbody tr[data-stream-row="0"]')).toBe(row);
    expect(row?.querySelector('td:nth-child(2)')).toBe(valueCell);
    expect(valueCell?.textContent).toBe('v');
    expect(container.textContent).not.toContain('value\\');
    expect(container.innerHTML).not.toContain('| Key | Value |');

    await act(async () => {
      oldRender.resolve(renderInlineMarkdown('alue\\'));
      await oldRender.promise;
    });
    expect(valueCell?.textContent).toBe('v');
    expect(container.textContent).not.toContain('alue\\');

    await act(async () => {
      escapedRender.resolve(renderInlineMarkdown('alue|right'));
      await escapedRender.promise;
    });
    await waitFor(() => expect(valueCell?.textContent).toBe('value|right'));

    const callsBeforeClosingPipe = renderMarkdown.mock.calls.length;
    rerender(
      <StreamingGfmTable markdown={`${escapedPipeAtChunkEnd}|`} />
    );
    expect(valueCell?.textContent).toBe('value|right');
    expect(renderMarkdown).toHaveBeenCalledTimes(callsBeforeClosingPipe);
    expect(container.querySelector('tbody tr[data-stream-row="0"]')).toBe(row);
    expect(row?.querySelector('td:nth-child(2)')).toBe(valueCell);
    expect(container.textContent).not.toContain('value\\');
    expect(container.innerHTML).not.toContain('| Key | Value |');
  });

  it('keeps escaped-pipe and even-parity columns aligned as backslashes stream in', async () => {
    const header = '| Kind | First | Second |\n| --- | --- | --- |\n';
    const escapedRow = '| odd | left\\|inside | stable |\n';
    const oddRow = `${header}${escapedRow}`;
    const { container, rerender } = render(
      <StreamingGfmTable markdown={oddRow} />
    );

    await waitFor(() => {
      expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
      expect(
        Array.from(
          container.querySelectorAll('tbody tr[data-stream-row="0"] td'),
          (cell) => cell.textContent
        )
      ).toEqual(['odd', 'left|inside', 'stable']);
    });
    const stableRow = container.querySelector('tbody tr[data-stream-row="0"]');
    const stableCell = stableRow?.querySelector('td:nth-child(3)');

    const firstSlashChunk = `${oddRow}| even | left\\`;
    rerender(<StreamingGfmTable markdown={firstSlashChunk} />);
    await waitFor(() => expect(container.querySelectorAll('tbody tr')).toHaveLength(2));
    const evenRow = container.querySelector('tbody tr[data-stream-row="1"]');
    const evenCell = evenRow?.querySelector('td:nth-child(2)');
    const nextColumn = evenRow?.querySelector('td:nth-child(3)');

    rerender(<StreamingGfmTable markdown={`${firstSlashChunk}\\`} />);
    await waitFor(() => expect(evenCell?.textContent).toBe('left\\\\'));

    const evenPipeChunk = `${firstSlashChunk}\\|right|discarded`;
    rerender(<StreamingGfmTable markdown={evenPipeChunk} />);
    await waitFor(() => expect(nextColumn?.textContent).toBe('right'));

    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.querySelector('tbody tr[data-stream-row="0"]')).toBe(stableRow);
    expect(stableRow?.querySelector('td:nth-child(3)')).toBe(stableCell);
    expect(container.querySelector('tbody tr[data-stream-row="1"]')).toBe(evenRow);
    expect(evenRow?.querySelector('td:nth-child(2)')).toBe(evenCell);
    expect(evenRow?.querySelector('td:nth-child(3)')).toBe(nextColumn);
    expect(
      Array.from(
        evenRow?.querySelectorAll('td') ?? [],
        (cell) => cell.textContent
      )
    ).toEqual(['even', 'left\\', 'right']);
    expect(container.innerHTML).not.toContain('left\\\\|right');
    expect(container.innerHTML).not.toContain('discarded');
    expect(container.innerHTML).not.toContain('| Kind | First | Second |');
  });
});
