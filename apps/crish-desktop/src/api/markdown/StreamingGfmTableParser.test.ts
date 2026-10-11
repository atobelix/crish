import { describe, expect, it } from 'vitest';
import {
  looksLikeStreamingGfmTable,
  StreamingGfmTableParser,
} from './StreamingGfmTableParser';

describe('StreamingGfmTableParser', () => {
  it('emits the header once and only the newly completed or changing row', () => {
    const parser = new StreamingGfmTableParser();
    const header = '| 任务编号 | 任务名称 |\n';
    const first = parser.advance(header);
    expect(first.header).toBeNull();
    expect(first.addedRows).toEqual([]);

    const withSeparator = `${header}| --- | --- |\n`;
    const second = parser.advance(withSeparator);
    expect(second.headerChanged).toBe(true);
    expect(second.header?.cells).toEqual(['任务编号', '任务名称']);
    expect(second.header?.alignments).toEqual(['left', 'left']);
    expect(second.addedRows).toEqual([]);

    const partialFirst = `${withSeparator}| TASK-001 | 需求调研 |`;
    const third = parser.advance(partialFirst);
    expect(third.partialChanged).toBe(true);
    expect(third.partialRow).toEqual({
      index: 0,
      line: '| TASK-001 | 需求调研 |',
    });

    const partialSecond = `${partialFirst}\n| TASK-002 | 原型设计 |`;
    const fourth = parser.advance(partialSecond);
    expect(fourth.addedRows).toEqual([
      { index: 0, line: '| TASK-001 | 需求调研 |' },
    ]);
    expect(fourth.partialRow).toEqual({
      index: 1,
      line: '| TASK-002 | 原型设计 |',
    });
    expect(fourth.headerChanged).toBe(false);
  });

  it('publishes the header as soon as an unterminated delimiter is valid', () => {
    const parser = new StreamingGfmTableParser();
    const header = '| A | B |\n';
    const delimiter = '| :--- | ---: |';

    const preview = parser.advance(`${header}${delimiter}`);
    expect(preview.headerChanged).toBe(true);
    expect(preview.header?.cells).toEqual(['A', 'B']);
    expect(preview.header?.alignments).toEqual(['left', 'right']);
    expect(preview.partialRow).toBeNull();
    expect(preview.trailingMarkdown).toBe('');
    expect(preview.closed).toBe(false);

    const body = parser.advance(`${header}${delimiter}\n| 1 | 2 |`);
    expect(body.header?.cells).toEqual(['A', 'B']);
    expect(body.headerChanged).toBe(false);
    expect(body.partialRow).toEqual({ index: 0, line: '| 1 | 2 |' });
    expect(body.trailingMarkdown).toBe('');
  });

  it('withdraws a provisional header if the delimiter becomes invalid', () => {
    const parser = new StreamingGfmTableParser();
    const header = '| A | B |\n';
    const preview = `${header}| --- | --- |`;
    expect(parser.advance(preview).header).not.toBeNull();

    const invalid = `${preview}x`;
    const update = parser.advance(invalid);
    expect(update.reset).toBe(true);
    expect(update.header).toBeNull();
    expect(update.addedRows).toEqual([]);
    expect(update.partialRow).toBeNull();
    expect(update.trailingMarkdown).toBe(invalid);
    expect(update.closed).toBe(true);
  });

  it('stops at the first blank or non-table line', () => {
    const parser = new StreamingGfmTableParser();
    const markdown =
      '| A | B |\n| --- | --- |\n| 1 | 2 |\n\ntrailing text';
    const update = parser.advance(markdown);
    expect(update.addedRows).toEqual([{ index: 0, line: '| 1 | 2 |' }]);
    expect(update.closed).toBe(true);
    expect(update.partialRow).toBeNull();
    expect(update.trailingMarkdown).toBe('trailing text');
  });

  it('exposes adjacent trailing Markdown without treating its source as a table row', () => {
    const parser = new StreamingGfmTableParser();
    const table = '| A | B |\n| --- | --- |\n| 1 | 2 |\n';

    const preview = parser.advance(`${table}After **the table**`);
    expect(preview.addedRows).toEqual([{ index: 0, line: '| 1 | 2 |' }]);
    expect(preview.partialRow).toBeNull();
    expect(preview.trailingMarkdown).toBe('After **the table**');
    expect(preview.closed).toBe(false);

    const closed = parser.advance(`${table}After **the table**\nmore prose`);
    expect(closed.closed).toBe(true);
    expect(closed.trailingMarkdown).toBe('After **the table**\nmore prose');
  });

  it('hands off prose whose only pipe is escaped instead of appending a table row', () => {
    const parser = new StreamingGfmTableParser();
    const table = '| A | B |\n| --- | --- |\n| 1 | 2 |\n';
    const prose = `literal \\| pipe\n`;
    parser.advance(table);

    const update = parser.advance(`${table}${prose}`);

    expect(update.addedRows).toEqual([]);
    expect(update.partialRow).toBeNull();
    expect(update.closed).toBe(true);
    expect(update.trailingMarkdown).toBe(prose);
  });

  it('withdraws a prose preview if the unfinished line becomes a table row', () => {
    const parser = new StreamingGfmTableParser();
    const table = '| A | B |\n| --- | --- |\n';

    const preview = parser.advance(`${table}new`);
    expect(preview.trailingMarkdown).toBe('new');

    const row = parser.advance(`${table}new | row`);
    expect(row.partialRow?.line).toBe('new | row');
    expect(row.trailingMarkdown).toBe('');
  });

  it('resets its cursor when the cumulative source is replaced', () => {
    const parser = new StreamingGfmTableParser();
    parser.advance('| A | B |\n| --- | --- |\n| old | row |\n');

    const update = parser.advance(
      '| C | D |\n| --- | --- |\n| new | row |\n'
    );

    expect(update.reset).toBe(true);
    expect(update.header?.cells).toEqual(['C', 'D']);
    expect(update.addedRows).toEqual([{ index: 0, line: '| new | row |' }]);
  });

  it('resets all parsed rows when cumulative input shrinks to an incomplete prefix', () => {
    const parser = new StreamingGfmTableParser();
    parser.advance('| A | B |\n| --- | --- |\n| old | row |\n');

    const update = parser.advance('| New');
    expect(update.reset).toBe(true);
    expect(update.header).toBeNull();
    expect(update.addedRows).toEqual([]);
    expect(update.partialRow).toBeNull();
    expect(update.trailingMarkdown).toBe('');
    expect(update.closed).toBe(false);
  });

  it('recognizes incomplete table prefixes without treating unrelated prose as a table', () => {
    expect(looksLikeStreamingGfmTable('| A | B |')).toBe(true);
    expect(looksLikeStreamingGfmTable('| A | B |\n')).toBe(true);
    expect(looksLikeStreamingGfmTable('| A | B |\n| --- |')).toBe(true);
    expect(looksLikeStreamingGfmTable('plain prose')).toBe(false);
    expect(looksLikeStreamingGfmTable('| literal | text |\nnext prose')).toBe(false);
  });
});
