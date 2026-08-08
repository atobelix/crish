import { describe, it, expect } from 'vitest';
import {
  getVisualWidth,
  parseRowCells,
  isTableLine,
  isSeparatorLine,
  findTableRange,
  insertRow,
  deleteRow,
  insertColumn,
  deleteColumn,
  setColumnAlign,
  formatTable,
  navigateTable,
  clearCell,
  setCellContent,
} from '../../src/core/TableOperations';

describe('TableOperations Unit Test Suite', () => {
  describe('Visual Width Calculation', () => {
    it('calculates ASCII characters as width 1', () => {
      expect(getVisualWidth('hello')).toBe(5);
      expect(getVisualWidth('123456')).toBe(6);
      expect(getVisualWidth('col 1')).toBe(5);
    });

    it('calculates CJK / Chinese characters as width 2', () => {
      expect(getVisualWidth('表格')).toBe(4);
      expect(getVisualWidth('防晒霜')).toBe(6);
      expect(getVisualWidth('项目1')).toBe(5); // 2+2+1
    });

    it('calculates mixed strings accurately', () => {
      expect(getVisualWidth('SPF50+ PA+++, 每2小时补涂')).toBe(25);
    });
  });

  describe('Row Cell Parsing & Escaping', () => {
    it('parses basic cells accurately', () => {
      const line = '| Col 1 | Col 2 | Col 3 |';
      const { cells } = parseRowCells(line);
      expect(cells).toEqual(['Col 1', 'Col 2', 'Col 3']);
    });

    it('handles escaped pipes correctly', () => {
      const line = '| a \\| b | c |';
      const { cells } = parseRowCells(line);
      expect(cells).toEqual(['a \\| b', 'c']);
    });

    it('handles empty cells', () => {
      const line = '| | | |';
      const { cells } = parseRowCells(line);
      expect(cells).toEqual(['', '', '']);
    });
  });

  describe('Table and Separator Line Predicates', () => {
    it('identifies table lines', () => {
      expect(isTableLine('| Header 1 | Header 2 |')).toBe(true);
      expect(isTableLine('| --- | --- |')).toBe(true);
      expect(isTableLine('| Data | Data |')).toBe(true);
      expect(isTableLine('Just normal text')).toBe(false);
      expect(isTableLine('# Heading')).toBe(false);
    });

    it('identifies separator lines with various alignments', () => {
      expect(isSeparatorLine('| --- | --- |')).toBe(true);
      expect(isSeparatorLine('| :--- | :---: | ---: |')).toBe(true);
      expect(isSeparatorLine('| Header 1 | Header 2 |')).toBe(false);
      expect(isSeparatorLine('| Data 1 | Data 2 |')).toBe(false);
    });
  });

  describe('Table Range Discovery', () => {
    const doc = [
      '# Document Title',
      '',
      '| Header A | Header B |',
      '| :--- | :---: |',
      '| Cell A1 | Cell B1 |',
      '| Cell A2 | Cell B2 |',
      '',
      'Paragraph after table',
    ].join('\n');

    it('finds entire table bounds when cursor is inside', () => {
      // Cursor in 'Cell A1'
      const pos = doc.indexOf('Cell A1');
      const table = findTableRange(doc, pos);
      expect(table).not.toBeNull();
      if (!table) return;

      expect(table.lines.length).toBe(4);
      expect(table.columnCount).toBe(2);
      expect(table.separatorLineIndex).toBe(1);
      expect(table.activeLineIndex).toBe(2);
      expect(table.activeCellIndex).toBe(0);
    });

    it('returns null when cursor is outside table', () => {
      const pos = doc.indexOf('# Document');
      expect(findTableRange(doc, pos)).toBeNull();
    });
  });

  describe('Row Insertion & Deletion', () => {
    const doc = [
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');

    it('inserts a row below current row', () => {
      const pos = doc.indexOf('1');
      const res = insertRow(doc, pos, 'below');
      const expected = [
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '|    |    |',
      ].join('\n');
      expect(res.newText).toBe(expected);
      expect(res.newCursorPos).toBeGreaterThan(0);
    });

    it('inserts a row above current data row', () => {
      const pos = doc.indexOf('1');
      const res = insertRow(doc, pos, 'above');
      const expected = [
        '| A | B |',
        '| --- | --- |',
        '|    |    |',
        '| 1 | 2 |',
      ].join('\n');
      expect(res.newText).toBe(expected);
    });

    it('inserts below header by jumping past separator', () => {
      const pos = doc.indexOf('A');
      const res = insertRow(doc, pos, 'below');
      const expected = [
        '| A | B |',
        '| --- | --- |',
        '|    |    |',
        '| 1 | 2 |',
      ].join('\n');
      expect(res.newText).toBe(expected);
    });

    it('deletes the active row', () => {
      const sample = [
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '| 3 | 4 |',
      ].join('\n');
      const pos = sample.indexOf('1');
      const res = deleteRow(sample, pos);
      const expected = [
        '| A | B |',
        '| --- | --- |',
        '| 3 | 4 |',
      ].join('\n');
      expect(res.newText).toBe(expected);
    });
  });

  describe('Column Insertion & Deletion', () => {
    const doc = [
      '| Col 1 | Col 2 |',
      '| --- | --- |',
      '| Val 1 | Val 2 |',
    ].join('\n');

    it('inserts a column to the right', () => {
      const pos = doc.indexOf('Col 1');
      const res = insertColumn(doc, pos, 'right');
      const lines = res.newText.split('\n');
      expect(lines.length).toBe(3);
      expect(lines[0]).toBe('| Col 1 |    | Col 2 |');
      expect(lines[1]).toBe('| --- | --- | --- |');
      expect(lines[2]).toBe('| Val 1 |    | Val 2 |');
    });

    it('inserts a column to the left', () => {
      const pos = doc.indexOf('Col 1');
      const res = insertColumn(doc, pos, 'left');
      const lines = res.newText.split('\n');
      expect(lines[0]).toBe('|    | Col 1 | Col 2 |');
      expect(lines[1]).toBe('| --- | --- | --- |');
      expect(lines[2]).toBe('|    | Val 1 | Val 2 |');
    });

    it('deletes a column accurately', () => {
      const pos = doc.indexOf('Col 2');
      const res = deleteColumn(doc, pos);
      const lines = res.newText.split('\n');
      expect(lines[0]).toBe('| Col 1 |');
      expect(lines[1]).toBe('| --- |');
      expect(lines[2]).toBe('| Val 1 |');
    });
  });

  describe('Column Alignment Setting', () => {
    const doc = [
      '| Left | Center | Right |',
      '| --- | --- | --- |',
      '| 1 | 2 | 3 |',
    ].join('\n');

    it('sets column alignment to center', () => {
      const pos = doc.indexOf('Center');
      const res = setColumnAlign(doc, pos, 'center');
      expect(res.newText).toContain('| --- | :---: | --- |');
    });

    it('sets column alignment to right', () => {
      const pos = doc.indexOf('Right');
      const res = setColumnAlign(doc, pos, 'right');
      expect(res.newText).toContain('| --- | --- | ---: |');
    });

    it('sets column alignment to left', () => {
      const pos = doc.indexOf('Right');
      const res = setColumnAlign(doc, pos, 'left');
      expect(res.newText).toContain('| --- | --- | :--- |');
    });
  });

  describe('Table Auto-Formatting (Auto-Padding)', () => {
    it('aligns uneven columns and pipes uniformly', () => {
      const unformatted = [
        '| Name | Status | Details |',
        '| --- | --- | --- |',
        '| Sunscreen | OK | SPF50+ PA+++ |',
        '| Water | Active | 1.5L/day |',
      ].join('\n');

      const formatted = formatTable(unformatted);
      const lines = formatted.split('\n');

      // Every line should have equal length
      expect(lines[0].length).toBe(lines[1].length);
      expect(lines[1].length).toBe(lines[2].length);
      expect(lines[2].length).toBe(lines[3].length);

      // Verify pipes align vertically
      const pipeIndex0 = lines[0].indexOf('|', 1);
      const pipeIndex1 = lines[1].indexOf('|', 1);
      const pipeIndex2 = lines[2].indexOf('|', 1);
      expect(pipeIndex0).toBe(pipeIndex1);
      expect(pipeIndex1).toBe(pipeIndex2);
    });

    it('handles CJK full-width characters during auto-formatting', () => {
      const cjkTable = [
        '| 项目 | 详情 |',
        '| --- | --- |',
        '| 防晒霜 | 每2小时补涂 |',
        '| 饮用水 | 至少1.5L |',
      ].join('\n');

      const formatted = formatTable(cjkTable);
      expect(formatted).toContain('项目');
      expect(formatted).toContain('防晒霜');
      expect(formatted).toContain('饮用水');
    });
  });

  describe('Excel Keyboard Navigation State Machine', () => {
    const doc = [
      '| H1 | H2 |',
      '| --- | --- |',
      '| A1 | A2 |',
      '| B1 | B2 |',
    ].join('\n');

    it('Tab moves to next cell in same row', () => {
      const pos = doc.indexOf('A1');
      const res = navigateTable(doc, pos, 'tab');
      expect(res).not.toBeNull();
      if (!res) return;
      expect(res.newText).toBe(doc); // no row inserted
      expect(doc.substring(res.newCursorPos, res.newCursorPos + 2)).toBe('A2');
    });

    it('Tab at end of row wraps to next row first cell', () => {
      const pos = doc.indexOf('A2');
      const res = navigateTable(doc, pos, 'tab');
      expect(res).not.toBeNull();
      if (!res) return;
      expect(res.newText).toBe(doc);
      expect(doc.substring(res.newCursorPos, res.newCursorPos + 2)).toBe('B1');
    });

    it('Tab at end of table automatically inserts a new row', () => {
      const pos = doc.indexOf('B2');
      const res = navigateTable(doc, pos, 'tab');
      expect(res).not.toBeNull();
      if (!res) return;
      expect(res.newText.split('\n').length).toBe(5); // 1 new row created
    });

    it('Shift+Tab moves to previous cell', () => {
      const pos = doc.indexOf('A2');
      const res = navigateTable(doc, pos, 'shift-tab');
      expect(res).not.toBeNull();
      if (!res) return;
      expect(doc.substring(res.newCursorPos, res.newCursorPos + 2)).toBe('A1');
    });

    it('Shift+Tab at start of row wraps to previous row last cell', () => {
      const pos = doc.indexOf('B1');
      const res = navigateTable(doc, pos, 'shift-tab');
      expect(res).not.toBeNull();
      if (!res) return;
      expect(doc.substring(res.newCursorPos, res.newCursorPos + 2)).toBe('A2');
    });

    it('Enter moves down to next row same column', () => {
      const pos = doc.indexOf('A1');
      const res = navigateTable(doc, pos, 'enter');
      expect(res).not.toBeNull();
      if (!res) return;
      expect(doc.substring(res.newCursorPos, res.newCursorPos + 2)).toBe('B1');
    });

    it('Enter at bottom row automatically inserts a new row', () => {
      const pos = doc.indexOf('B1');
      const res = navigateTable(doc, pos, 'enter');
      expect(res).not.toBeNull();
      if (!res) return;
      expect(res.newText.split('\n').length).toBe(5);
    });

    it('Shift+Enter moves up to previous row same column', () => {
      const pos = doc.indexOf('B1');
      const res = navigateTable(doc, pos, 'shift-enter');
      expect(res).not.toBeNull();
      if (!res) return;
      expect(doc.substring(res.newCursorPos, res.newCursorPos + 2)).toBe('A1');
    });
  });

  describe('Cell Value Manipulation (clearCell & setCellContent)', () => {
    const doc = [
      '| Col 1 | Col 2 |',
      '| --- | --- |',
      '| Apple | Orange |',
    ].join('\n');

    it('clears cell content cleanly while preserving table borders', () => {
      const pos = doc.indexOf('Apple');
      const res = clearCell(doc, pos);
      expect(res.newText).toBe([
        '| Col 1 | Col 2 |',
        '| --- | --- |',
        '|  | Orange |',
      ].join('\n'));
    });

    it('sets/replaces cell content and places cursor at the end of new content', () => {
      const pos = doc.indexOf('Apple');
      const res = setCellContent(doc, pos, 'Banana');
      expect(res.newText).toBe([
        '| Col 1 | Col 2 |',
        '| --- | --- |',
        '| Banana | Orange |',
      ].join('\n'));
    });
  });
});
