import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';

describe('Parser ReDoS Security', () => {
    it('does not hang on extremely long unclosed links', () => {
        // Construct a string like "[[[[[[..." followed by characters that eagerly match
        const pathological = '['.repeat(10000) + 'a'.repeat(40000);
        
        const start = performance.now();
        // Should bail or parse linearly very fast without exponential backtracking
        const result = MarkdownParser.parse(pathological);
        const duration = performance.now() - start;

        // Expect it to process 50k characters in less than 50ms (well under a frame budget ideally, but definitely not hanging)
        expect(duration).toBeLessThan(150);
        expect(result.lines.length).toBe(1);
    });

    it('does not hang on unclosed math bounds with 500k chars', () => {
        const pathological = '$$ ' + '1 + 1 '.repeat(50000);
        
        const start = performance.now();
        const result = MarkdownParser.parse(pathological);
        const duration = performance.now() - start;

        expect(duration).toBeLessThan(150);
    });

    it('does not hang on recursive inline formatting bounds', () => {
        // e.g. ***bold*** but incomplete
        const pathological = '*'.repeat(10000) + 'text';
        
        const start = performance.now();
        const result = MarkdownParser.parse(pathological);
        const duration = performance.now() - start;

        expect(duration).toBeLessThan(150);
    });
});
