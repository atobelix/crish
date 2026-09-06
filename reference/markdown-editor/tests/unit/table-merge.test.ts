import { describe, it, expect } from 'vitest';
import {
  mergeSelectedCells,
  unmergeCells,
  setColumnAlign,
  parseTableAlignments,
  appendRowAtEnd,
} from '../../src/core/TableOperations';
import { MarkdownParser } from '../../src/core/parser';

describe('Table Operations - Excel-like Features', () => {
  const sampleTable = [
    '| 标题 A | 标题 B | 标题 C |',
    '| :--- | :---: | ---: |',
    '| 单元格 1 | 单元格 2 | 单元格 3 |',
    '| 单元格 4 | 单元格 5 | 单元格 6 |',
  ].join('\n');

  describe('parseTableAlignments', () => {
    it('accurately extracts column alignments from separator line', () => {
      const sep = '| :--- | :---: | ---: | --- |';
      const alignments = parseTableAlignments(sep);
      expect(alignments).toEqual(['left', 'center', 'right', 'left']);
    });
  });

  describe('setColumnAlign', () => {
    it('changes alignment of target column to center', () => {
      const res = setColumnAlign(sampleTable, 10, 'center', 0);
      expect(res.newText).toContain('| :---: | :---: | ---: |');
    });

    it('changes alignment of target column to right', () => {
      const res = setColumnAlign(sampleTable, 10, 'right', 1);
      expect(res.newText).toContain('| :--- | ---: | ---: |');
    });

    it('changes alignment of target column to left', () => {
      const res = setColumnAlign(sampleTable, 10, 'left', 2);
      expect(res.newText).toContain('| :--- | :---: | :--- |');
    });
  });

  describe('mergeSelectedCells (True Cell Merge)', () => {
    it('merges adjacent cells horizontally using standard > syntax', () => {
      // Merge line 2 (first body row), col 0 and col 1
      const res = mergeSelectedCells(sampleTable, 2, 0, 2, 1);
      const lines = res.newText.split('\n');
      expect(lines[2]).toContain('>  | 单元格 3 |');
      expect(lines[2]).toContain('单元格 1');
      expect(lines[2]).toContain('单元格 2');
    });

    it('merges three cells horizontally', () => {
      const res = mergeSelectedCells(sampleTable, 2, 0, 2, 2);
      const lines = res.newText.split('\n');
      expect(lines[2]).toContain('>  |  >  |');
    });
  });

  describe('unmergeCells', () => {
    it('restores merged slave cells to independent cells', () => {
      const mergedTable = [
        '| 标题 A | 标题 B | 标题 C |',
        '| :--- | :--- | :--- |',
        '| 合并单元格 | > | 单元格 3 |',
      ].join('\n');

      const res = unmergeCells(mergedTable, 2, 0);
      const lines = res.newText.split('\n');
      expect(lines[2]).not.toContain('>');
      expect(lines[2]).toContain('合并单元格');
      expect(lines[2]).toContain('单元格 3');
    });
  });

  describe('appendRowAtEnd', () => {
    it('appends a new row with matching columns at the end of table', () => {
      const res = appendRowAtEnd(sampleTable, 15);
      const lines = res.newText.split('\n');
      expect(lines.length).toBe(5);
      expect(lines[4].trim()).toMatch(/^\|(\s*\|\s*){3}$/);
    });
  });

  describe('AST Parser Integration', () => {
    it('parses > as horizontal merge and sets colSpan on master cell', () => {
      const line = '| 跨两列主单元格 | > | 独立单元格 |';
      const node = MarkdownParser.parseLine(line, 0, false);
      const cells = node.inlineTokens!.filter(t => t.type === 'table_cell');

      expect(cells.length).toBe(3);
      // Cell 0: master cell
      expect(cells[0].isMergedMaster).toBe(true);
      expect(cells[0].colSpan).toBe(2);
      expect(cells[0].raw.trim()).toBe('跨两列主单元格');

      // Cell 1: slave cell
      expect(cells[1].isMergedSlave).toBe(true);
      expect(cells[1].raw.trim()).toBe('>');

      // Cell 2: normal cell
      expect(cells[2].isMergedMaster).toBeUndefined();
      expect(cells[2].isMergedSlave).toBeUndefined();
      expect(cells[2].raw.trim()).toBe('独立单元格');
    });
  });
});
