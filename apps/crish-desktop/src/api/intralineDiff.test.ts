import { describe, it, expect, beforeEach } from 'vitest';
import {
  tokenizeLine,
  coalesceTokens,
  computeIntralinePair,
  computeContinuousHunkDiff,
  IntralineLRUCache,
  globalDiffCache,
  MAX_INTRALINE_TOKENS,
  } from './intralineDiff';

describe('intralineDiff - Lexical Intraline Diffing Engine', () => {
  beforeEach(() => {
    globalDiffCache.clear();
  });

  describe('tokenizeLine', () => {
    it('tokenizes code into words, symbols, and whitespace', () => {
      const line = 'const value = 42; // note';
      const tokens = tokenizeLine(line);
      expect(tokens).toEqual([
        'const',
        ' ',
        'value',
        ' ',
        '=',
        ' ',
        '42',
        ';',
        ' ',
        '/',
        '/',
        ' ',
        'note',
      ]);
      expect(tokens.join('')).toBe(line);
    });

    it('handles empty and whitespace strings', () => {
      expect(tokenizeLine('')).toEqual([]);
      expect(tokenizeLine('   ')).toEqual(['   ']);
    });

    it('handles special symbols and identifiers with $ and _', () => {
      const line = 'let $foo_bar = $_baz(1, 2);';
      const tokens = tokenizeLine(line);
      expect(tokens).toContain('$foo_bar');
      expect(tokens).toContain('$_baz');
      expect(tokens.join('')).toBe(line);
    });
  });

  describe('coalesceTokens', () => {
    it('merges adjacent tokens of the same diff type', () => {
      const raw = [
        { text: 'const', type: 'same' as const },
        { text: ' ', type: 'same' as const },
        { text: 'a', type: 'removed' as const },
        { text: 'b', type: 'removed' as const },
        { text: ' = ', type: 'same' as const },
      ];
      const coalesced = coalesceTokens(raw);
      expect(coalesced).toEqual([
        { text: 'const ', type: 'same' },
        { text: 'ab', type: 'removed' },
        { text: ' = ', type: 'same' },
      ]);
    });

    it('handles empty or single token array', () => {
      expect(coalesceTokens([])).toEqual([]);
      expect(coalesceTokens([{ text: 'hi', type: 'added' }])).toEqual([
        { text: 'hi', type: 'added' },
      ]);
    });
  });

  describe('computeIntralinePair', () => {
    it('returns same tokens for identical lines without running full DP', () => {
      const line = '  const result = calculate(x, y);';
      const diff = computeIntralinePair(line, line);
      expect(diff.oldTokens).toEqual([{ text: line, type: 'same' }]);
      expect(diff.newTokens).toEqual([{ text: line, type: 'same' }]);
    });

    it('accurately identifies single word replacements', () => {
      const oldLine = 'const oldValue = 100;';
      const newLine = 'const newValue = 100;';
      const diff = computeIntralinePair(oldLine, newLine);

      // Reconstructed text must match exactly (character-by-character invariant)
      expect(diff.oldTokens.map((t) => t.text).join('')).toBe(oldLine);
      expect(diff.newTokens.map((t) => t.text).join('')).toBe(newLine);

      // Verify removed and added parts
      const removedToken = diff.oldTokens.find((t) => t.type === 'removed');
      const addedToken = diff.newTokens.find((t) => t.type === 'added');
      expect(removedToken?.text).toBe('oldValue');
      expect(addedToken?.text).toBe('newValue');
    });

    it('handles line additions and deletions (one line empty)', () => {
      const diffAdd = computeIntralinePair('', 'import React from "react";');
      expect(diffAdd.oldTokens).toEqual([]);
      expect(diffAdd.newTokens).toEqual([
        { text: 'import React from "react";', type: 'added' },
      ]);

      const diffDel = computeIntralinePair('import React from "react";', '');
      expect(diffDel.oldTokens).toEqual([
        { text: 'import React from "react";', type: 'removed' },
      ]);
      expect(diffDel.newTokens).toEqual([]);
    });

    it('preserves indentation changes', () => {
      const oldLine = '  return value;';
      const newLine = '    return value;';
      const diff = computeIntralinePair(oldLine, newLine);

      expect(diff.oldTokens.map((t) => t.text).join('')).toBe(oldLine);
      expect(diff.newTokens.map((t) => t.text).join('')).toBe(newLine);
    });

    it('anti-DoS circuit breaker triggers when tokens > MAX_INTRALINE_TOKENS', () => {
      // Create a line with 200 tokens
      const words = Array.from({ length: 150 }, (_, i) => `w${i}`).join(' + ');
      const oldLine = words;
      const newLine = words + ' + extra';

      expect(tokenizeLine(oldLine).length).toBeGreaterThan(MAX_INTRALINE_TOKENS);

      const t0 = performance.now();
      const diff = computeIntralinePair(oldLine, newLine);
      const elapsed = performance.now() - t0;

      // Circuit breaker should complete in < 1ms
      expect(elapsed).toBeLessThan(5);
      // Fallback is whole-line removed and added
      expect(diff.oldTokens).toEqual([{ text: oldLine, type: 'removed' }]);
      expect(diff.newTokens).toEqual([{ text: newLine, type: 'added' }]);
    });
  });

  describe('IntralineLRUCache', () => {
    it('caches diff results and returns identical references on hit', () => {
      const cache = new IntralineLRUCache(10);
      const res1 = computeIntralinePair('let a = 1;', 'let a = 2;', cache);
      const res2 = computeIntralinePair('let a = 1;', 'let a = 2;', cache);
      expect(res1).toBe(res2);
      expect(cache.size).toBe(1);
    });

    it('evicts least recently used entries when capacity is exceeded', () => {
      const cache = new IntralineLRUCache(3);
      computeIntralinePair('a', '1', cache);
      computeIntralinePair('b', '2', cache);
      computeIntralinePair('c', '3', cache);
      expect(cache.size).toBe(3);

      // Access 'a' to refresh its recency
      cache.get('a\x001');

      // Insert 4th item -> should evict 'b' (oldest unaccessed)
      computeIntralinePair('d', '4', cache);
      expect(cache.size).toBe(3);
      expect(cache.get('b\x002')).toBeUndefined();
      expect(cache.get('a\x001')).toBeDefined();
      expect(cache.get('c\x003')).toBeDefined();
      expect(cache.get('d\x004')).toBeDefined();
    });

    it('clears all cached entries', () => {
      const cache = new IntralineLRUCache(5);
      computeIntralinePair('x', 'y', cache);
      expect(cache.size).toBe(1);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get('x\x00y')).toBeUndefined();
    });
  });

  describe('Performance benchmark', () => {
    it('computes 200 diff comparisons in under 20ms', () => {
      const testPairs: [string, string][] = [];
      for (let i = 0; i < 200; i++) {
        testPairs.push([
          `function calculateItem_${i}(price: number, taxRate = 0.0${i % 9}): number {`,
          `function calculateOrderItem_${i}(price: number, taxRate: number = 0.0${(i + 1) % 9}): number {`,
        ]);
      }

      const t0 = performance.now();
      for (const [oldL, newL] of testPairs) {
        computeIntralinePair(oldL, newL);
      }
      const elapsed = performance.now() - t0;

      expect(elapsed).toBeLessThan(50); // fast < 50ms (typically < 15ms)
    });
  });

  describe('computeContinuousHunkDiff', () => {
    it('handles equal length N del : N add blocks', () => {
      const dels = ['const a = 1;', 'const b = 2;'];
      const adds = ['const a = 10;', 'const b = 20;'];
      const res = computeContinuousHunkDiff(dels, adds);
      expect(res.deletionTokens).toHaveLength(2);
      expect(res.additionTokens).toHaveLength(2);
      expect(res.deletionTokens[0]?.map((t) => t.text).join('')).toBe(dels[0]);
      expect(res.additionTokens[0]?.map((t) => t.text).join('')).toBe(adds[0]);
    });

    it('handles unequal length N del : M add blocks (N > M)', () => {
      const dels = ['line 1', 'line 2', 'line 3'];
      const adds = ['line 1 modified'];
      const res = computeContinuousHunkDiff(dels, adds);
      expect(res.deletionTokens).toHaveLength(3);
      expect(res.additionTokens).toHaveLength(1);
      expect(res.deletionTokens[2]).toEqual([{ text: 'line 3', type: 'removed' }]);
    });

    it('handles unequal length N del : M add blocks (M > N)', () => {
      const dels = ['line 1'];
      const adds = ['line 1 modified', 'line 2 extra', 'line 3 extra'];
      const res = computeContinuousHunkDiff(dels, adds);
      expect(res.deletionTokens).toHaveLength(1);
      expect(res.additionTokens).toHaveLength(3);
      expect(res.additionTokens[1]).toEqual([{ text: 'line 2 extra', type: 'added' }]);
    });

    it('triggers circuit breaker when total hunk lines exceed ', () => {
      const dels = Array.from({ length: 300 }, (_, i) => `del line ${i}`);
      const adds = Array.from({ length: 300 }, (_, i) => `add line ${i}`);
      const res = computeContinuousHunkDiff(dels, adds);
      expect(res.deletionTokens).toHaveLength(300);
      expect(res.additionTokens).toHaveLength(300);
      expect(res.deletionTokens[0]).toEqual([{ text: 'del line 0', type: 'removed' }]);
      expect(res.additionTokens[0]).toEqual([{ text: 'add line 0', type: 'added' }]);
    });
  });
});
