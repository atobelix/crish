import { describe, it, expect } from 'vitest';
import { LineOffsetTree } from '../../src/core/SegmentTree';

describe('LineOffsetTree (Segment Tree)', () => {
  it('should initialize and calculate total lines and offsets correctly', () => {
    // 3 lines: length 5, 10, 3 (each including +1 for newline if handled by caller)
    const tree = new LineOffsetTree([5, 10, 3]);
    expect(tree.lineCount).toBe(3);
    
    expect(tree.getOffset(0)).toBe(0);
    expect(tree.getOffset(1)).toBe(5);
    expect(tree.getOffset(2)).toBe(15);
    // Out of bounds behavior (often depends on caller, but should be stable)
    expect(tree.getOffset(3)).toBe(18);
  });

  it('should find correct line index from offset', () => {
    const tree = new LineOffsetTree([5, 10, 3]); // Offsets: 0, 5, 15
    // offset 0-4 is line 0
    expect(tree.findLineIndex(0)).toBe(0);
    expect(tree.findLineIndex(4)).toBe(0);
    // offset 5-14 is line 1
    expect(tree.findLineIndex(5)).toBe(1);
    expect(tree.findLineIndex(14)).toBe(1);
    // offset 15-17 is line 2
    expect(tree.findLineIndex(15)).toBe(2);
    expect(tree.findLineIndex(17)).toBe(2);
    // beyond text
    expect(tree.findLineIndex(100)).toBe(2);
  });

  it('should handle large number of lines triggering block splits', () => {
    const lengths = new Array(1000).fill(10); // 1000 lines, length 10 each
    const tree = new LineOffsetTree(lengths);
    expect(tree.lineCount).toBe(1000);
    expect(tree.getOffset(500)).toBe(5000);
    expect(tree.findLineIndex(5005)).toBe(500);
  });

  it('should support updating lines (insertion without deletion)', () => {
    const tree = new LineOffsetTree([5, 5, 5]); // offsets: 0, 5, 10
    tree.updateLines(1, 0, [3, 3]); // insert 2 lines before line 1
    // New lengths: 5, 3, 3, 5, 5
    // New offsets: 0, 5, 8, 11, 16
    expect(tree.lineCount).toBe(5);
    expect(tree.getOffset(0)).toBe(0);
    expect(tree.getOffset(1)).toBe(5);
    expect(tree.getOffset(2)).toBe(8);
    expect(tree.getOffset(3)).toBe(11);
    expect(tree.getOffset(4)).toBe(16);
    expect(tree.getOffset(5)).toBe(21);
    
    expect(tree.findLineIndex(8)).toBe(2);
    expect(tree.findLineIndex(11)).toBe(3);
    
    expect(tree.toArray()).toEqual([0, 5, 8, 11, 16]);
  });

  it('should support updating lines (deletion without insertion)', () => {
    const tree = new LineOffsetTree([5, 5, 5, 5, 5]);
    tree.updateLines(1, 3, []); // delete 3 lines starting from index 1 (deletes 1,2,3)
    // Remaining lengths: [5, 5] (original index 0 and 4)
    expect(tree.lineCount).toBe(2);
    expect(tree.getOffset(1)).toBe(5);
    expect(tree.getOffset(2)).toBe(10);
    expect(tree.toArray()).toEqual([0, 5]);
  });

  it('should support updating lines (replacement)', () => {
    const tree = new LineOffsetTree([5, 5, 5, 5, 5]);
    tree.updateLines(2, 2, [10, 10, 10]); // delete lines 2,3; insert 3 lines of 10
    // original: 5, 5, 5, 5, 5
    // new: 5, 5, 10, 10, 10, 5
    expect(tree.lineCount).toBe(6);
    expect(tree.getOffset(0)).toBe(0);
    expect(tree.getOffset(1)).toBe(5);
    expect(tree.getOffset(2)).toBe(10);
    expect(tree.getOffset(3)).toBe(20);
    expect(tree.getOffset(4)).toBe(30);
    expect(tree.getOffset(5)).toBe(40);
    expect(tree.getOffset(6)).toBe(45);
    expect(tree.toArray()).toEqual([0, 5, 10, 20, 30, 40]);
  });

  it('should handle updates crossing multiple block boundaries', () => {
    const lengths = new Array(1000).fill(10);
    const tree = new LineOffsetTree(lengths);
    
    // Delete 500 lines starting at index 250 (crosses at least two 256-sized blocks)
    tree.updateLines(250, 500, [100, 100]);
    // new count = 1000 - 500 + 2 = 502
    expect(tree.lineCount).toBe(502);
    
    // line 0-249: length 10
    // line 250-251: length 100
    // line 252-501: length 10
    expect(tree.getOffset(250)).toBe(2500);
    expect(tree.getOffset(251)).toBe(2600);
    expect(tree.getOffset(252)).toBe(2700);
    expect(tree.getOffset(253)).toBe(2710);
  });
});
