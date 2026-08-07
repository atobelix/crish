import { describe, it, expect } from 'vitest';
import { findNextGraphemeBoundary, findPrevGraphemeBoundary } from '../../src/core/EditorStore';

describe('Grapheme Boundary Functions', () => {
    it('handles regular ASCII text', () => {
        const text = 'hello';
        expect(findNextGraphemeBoundary(text, 0)).toBe(1);
        expect(findNextGraphemeBoundary(text, 1)).toBe(2);
        
        expect(findPrevGraphemeBoundary(text, 5)).toBe(4);
        expect(findPrevGraphemeBoundary(text, 1)).toBe(0);
    });

    it('handles surrogate pairs (emojis)', () => {
        // "😀" is represented by two code units in UTF-16 (D83D DE00)
        const text = 'a😀b';
        expect(text.length).toBe(4); // a (1) + 😀 (2) + b (1)
        
        expect(findNextGraphemeBoundary(text, 0)).toBe(1); // after 'a'
        expect(findNextGraphemeBoundary(text, 1)).toBe(3); // after '😀'
        expect(findNextGraphemeBoundary(text, 3)).toBe(4); // after 'b'
        
        expect(findPrevGraphemeBoundary(text, 4)).toBe(3); // before 'b'
        expect(findPrevGraphemeBoundary(text, 3)).toBe(1); // before '😀'
        expect(findPrevGraphemeBoundary(text, 1)).toBe(0); // before 'a'
    });

    it('handles combining characters', () => {
        // "é" is 'e' (1) + Combining Acute Accent (1)
        const text = 'e\u0301x';
        expect(text.length).toBe(3);
        
        expect(findNextGraphemeBoundary(text, 0)).toBe(2); // after "é"
        expect(findNextGraphemeBoundary(text, 2)).toBe(3); // after 'x'
        
        expect(findPrevGraphemeBoundary(text, 3)).toBe(2); // before 'x'
        expect(findPrevGraphemeBoundary(text, 2)).toBe(0); // before "é"
    });

    it('handles complex emojis (ZNJ / Fitzpatrick modifiers)', () => {
        // 👨‍👩‍👧‍👦 = Man + ZWJ + Woman + ZWJ + Girl + ZWJ + Boy (11 code units!)
        const emoji = '👨‍👩‍👧‍👦';
        const text = `a${emoji}b`;
        expect(text.length).toBe(13);

        expect(findNextGraphemeBoundary(text, 1)).toBe(12); // jumps entire family emoji
        expect(findPrevGraphemeBoundary(text, 12)).toBe(1);
    });

    it('handles edge cases', () => {
        const text = 'x';
        expect(findNextGraphemeBoundary(text, 1)).toBe(1);
        expect(findNextGraphemeBoundary(text, 5)).toBe(1);
        
        expect(findPrevGraphemeBoundary(text, 0)).toBe(0);
        expect(findPrevGraphemeBoundary(text, -5)).toBe(0);
    });

    it('handles extremely long ZWJ sequences and window boundaries', () => {
        // Construct a ZWJ sequence that exceeds the window size (50)
        // Man + ZWJ + Woman + ZWJ + Man + ZWJ + Woman ...
        const man = '👨';
        const zwj = '\u200D';
        const sequence = Array(30).fill(man).join(zwj); // 30 emojis, 29 ZWJs => 30*2 + 29*1 = 89 code units
        
        // Let's pad it with regular chars
        const text = 'abcdef' + sequence + 'ghijkl';
        
        const startOfSeq = 6;
        const endOfSeq = 6 + sequence.length;
        
        // Forward
        expect(findNextGraphemeBoundary(text, startOfSeq)).toBe(endOfSeq);
        // Backward
        expect(findPrevGraphemeBoundary(text, endOfSeq)).toBe(startOfSeq);
        
        // Consistency check: next(prev(x)) === x for boundary
        expect(findNextGraphemeBoundary(text, findPrevGraphemeBoundary(text, endOfSeq))).toBe(endOfSeq);
        
        // If we query right in the middle of the long ZWJ sequence
        // Ideally it snaps out or fails gracefully, but the requirement is that it doesn't crash 
        // and ideally maintains consistency if it finds a boundary.
        const midPoint = startOfSeq + 40; 
        const prev = findPrevGraphemeBoundary(text, midPoint);
        const next = findNextGraphemeBoundary(text, prev);
        // Should be consistent
        expect(next).toBeGreaterThanOrEqual(prev);
    });
});
