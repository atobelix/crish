import { describe, expect, it } from 'vitest';
import { countTextLines } from './countTextLines';
import { LineBuffer } from '../components/diff/LineBuffer';

describe('countTextLines §3.2', () => {
  it('对齐 LineBuffer / split 行边界，且不依赖 split 分配', () => {
    const samples = ['', 'a', 'a\nb', 'a\nb\n', 'a\r\nb\r\n', 'x'.repeat(10000) + '\n' + 'y'];
    for (const s of samples) {
      expect(countTextLines(s)).toBe(new LineBuffer(s).totalLines);
      expect(countTextLines(s)).toBe(s.split('\n').length || 1);
    }
  });
});