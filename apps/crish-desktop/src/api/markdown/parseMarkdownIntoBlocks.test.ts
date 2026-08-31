import { describe, expect, it } from 'vitest';
import {
  countClosingTags,
  countDoubleDollars,
  countNonSelfClosingOpenTags,
  parseMarkdownIntoBlocks,
} from './parseMarkdownIntoBlocks';

describe('parseMarkdownIntoBlocks', () => {
  describe('Basic Markdown Structure & Lossless Invariant', () => {
    it('returns an empty array for empty or falsy inputs', () => {
      expect(parseMarkdownIntoBlocks('')).toEqual([]);
      expect(parseMarkdownIntoBlocks(null as unknown as string)).toEqual([]);
      expect(parseMarkdownIntoBlocks(undefined as unknown as string)).toEqual([]);
    });

    it('splits basic paragraphs and headings while maintaining lossless concatenation', () => {
      const markdown = '# Heading 1\n\nFirst paragraph.\n\nSecond paragraph.';
      const blocks = parseMarkdownIntoBlocks(markdown);
      expect(blocks.join('')).toBe(markdown);
      expect(blocks.some((b) => b.includes('# Heading 1'))).toBe(true);
      expect(blocks.some((b) => b.includes('First paragraph.'))).toBe(true);
      expect(blocks.some((b) => b.includes('Second paragraph.'))).toBe(true);
    });

    it('handles mixed markdown structures (lists, blockquotes, code blocks, tables)', () => {
      const markdown = [
        '# Main Title',
        '',
        '> This is a blockquote.',
        '',
        '- Item 1',
        '- Item 2',
        '',
        '```typescript',
        'const x = 42;',
        '```',
        '',
        '| Header 1 | Header 2 |',
        '| --- | --- |',
        '| Val 1 | Val 2 |',
        '',
        'Final paragraph.',
      ].join('\n');

      const blocks = parseMarkdownIntoBlocks(markdown);
      expect(blocks.join('')).toBe(markdown);
      expect(blocks.some((b) => b.includes('# Main Title'))).toBe(true);
      expect(blocks.some((b) => b.includes('> This is a blockquote.'))).toBe(true);
      expect(blocks.some((b) => b.includes('- Item 1'))).toBe(true);
      expect(blocks.some((b) => b.includes('const x = 42;'))).toBe(true);
      expect(blocks.some((b) => b.includes('| Header 1 | Header 2 |'))).toBe(true);
      expect(blocks.some((b) => b.includes('Final paragraph.'))).toBe(true);
    });
  });

  describe('HTML Block State Machine & Nested Tag Merging', () => {
    it('merges multiline content inside <details> across blank lines', () => {
      const htmlMd = [
        '<details>',
        '<summary>Click to expand</summary>',
        '',
        'Paragraph 1 inside details.',
        '',
        'Paragraph 2 inside details.',
        '</details>',
        '',
        'Outer paragraph.',
      ].join('\n');

      const blocks = parseMarkdownIntoBlocks(htmlMd);
      expect(blocks.join('')).toBe(htmlMd);

      const detailsBlock = blocks.find((b) => b.includes('<details>'));
      expect(detailsBlock).toBeTruthy();
      expect(detailsBlock).toContain('</details>');
      expect(detailsBlock).toContain('Paragraph 1 inside details.');
      expect(detailsBlock).toContain('Paragraph 2 inside details.');

      const outerBlock = blocks.find((b) => b.includes('Outer paragraph.'));
      expect(outerBlock).toBeTruthy();
    });

    it('merges nested HTML tags correctly (div containing details)', () => {
      const nestedHtml = [
        '<div class="wrapper">',
        '',
        '<details>',
        '<summary>Summary</summary>',
        '',
        'Nested paragraph inside details.',
        '</details>',
        '',
        '</div>',
        '',
        'Outside content.',
      ].join('\n');

      const blocks = parseMarkdownIntoBlocks(nestedHtml);
      expect(blocks.join('')).toBe(nestedHtml);

      const outerDivBlock = blocks.find((b) => b.includes('<div class="wrapper">'));
      expect(outerDivBlock).toBeTruthy();
      expect(outerDivBlock).toContain('Nested paragraph inside details.');
      expect(outerDivBlock).toContain('</div>');

      const outsideBlock = blocks.find((b) => b.includes('Outside content.'));
      expect(outsideBlock).toBeTruthy();
    });

    it('supports custom hyphenated/colon tags like <ai-thinking>', () => {
      const customTagMd = [
        '<ai-thinking>',
        'Thinking step 1...',
        '',
        'Thinking step 2...',
        '</ai-thinking>',
        '',
        'Response text.',
      ].join('\n');

      const blocks = parseMarkdownIntoBlocks(customTagMd);
      expect(blocks.join('')).toBe(customTagMd);

      const thinkingBlock = blocks.find((b) => b.includes('<ai-thinking>'));
      expect(thinkingBlock).toBeTruthy();
      expect(thinkingBlock).toContain('</ai-thinking>');
      expect(thinkingBlock).toContain('Thinking step 1...');
      expect(thinkingBlock).toContain('Thinking step 2...');

      const responseBlock = blocks.find((b) => b.includes('Response text.'));
      expect(responseBlock).toBeTruthy();
    });

    it('ignores void elements like <img>, <br>, <hr>, <input> and self-closing tags', () => {
      const voidTagsMd = [
        '<p>Before image</p>',
        '',
        '<img src="https://example.com/photo.png" alt="Photo" width="200" />',
        '',
        '<p>After image</p>',
      ].join('\n');

      const blocks = parseMarkdownIntoBlocks(voidTagsMd);
      expect(blocks.join('')).toBe(voidTagsMd);

      // Void element <img> does not capture following paragraphs into its block
      const imgBlock = blocks.find((b) => b.includes('<img'));
      expect(imgBlock).toBeTruthy();
      expect(imgBlock).not.toContain('After image');

      const afterBlock = blocks.find((b) => b.includes('After image'));
      expect(afterBlock).toBeTruthy();
    });

    it('handles self-closing XML-style non-void tags like <div />', () => {
      const selfClosingDivMd = [
        '<div class="divider" />',
        '',
        'Paragraph after self-closing div.',
      ].join('\n');

      const blocks = parseMarkdownIntoBlocks(selfClosingDivMd);
      expect(blocks.join('')).toBe(selfClosingDivMd);

      const divBlock = blocks.find((b) => b.includes('<div class="divider" />'));
      expect(divBlock).toBeTruthy();
      expect(divBlock).not.toContain('Paragraph after self-closing div.');

      const paragraphBlock = blocks.find((b) => b.includes('Paragraph after self-closing div.'));
      expect(paragraphBlock).toBeTruthy();
    });
  });

  describe('LaTeX $$ Math Block Merging & Code Block Avoidance', () => {
    it('merges multiline LaTeX blocks with $$ delimiters into a single block', () => {
      const mathMd = [
        'Intro text.',
        '',
        '$$',
        'f(x) = \\int_{-\\infty}^{\\infty} e^{-t^2} dt',
        '$$',
        '',
        'Outro text.',
      ].join('\n');

      const blocks = parseMarkdownIntoBlocks(mathMd);
      expect(blocks.join('')).toBe(mathMd);

      const mathBlock = blocks.find((b) => b.includes('$$') && b.includes('f(x) ='));
      expect(mathBlock).toBeTruthy();
      expect(countDoubleDollars(mathBlock!)).toBe(2);
      expect(mathBlock).not.toContain('Intro text.');
      expect(mathBlock).not.toContain('Outro text.');
    });

    it('handles LaTeX multiline alignment equations where marked lexer might split on equal signs', () => {
      const multilineAlignMd = [
        'Before formula.',
        '',
        '$$',
        '\\begin{aligned}',
        'a &= b + c \\\\',
        '&= d + e',
        '\\end{aligned}',
        '$$',
        '',
        'After formula.',
      ].join('\n');

      const blocks = parseMarkdownIntoBlocks(multilineAlignMd);
      expect(blocks.join('')).toBe(multilineAlignMd);

      const mathBlock = blocks.find((b) => b.includes('$$') && b.includes('a &= b + c'));
      expect(mathBlock).toBeTruthy();
      expect(mathBlock).toContain('&= d + e');
      expect(countDoubleDollars(mathBlock!)).toBe(2);
    });

    it('does NOT treat $$ inside code blocks as LaTeX math delimiters', () => {
      const codeWithDollars = [
        '```bash',
        '# Process ID check',
        'pstree -p $$',
        'echo $$',
        '```',
        '',
        'Follow-up text.',
      ].join('\n');

      const blocks = parseMarkdownIntoBlocks(codeWithDollars);
      expect(blocks.join('')).toBe(codeWithDollars);

      const codeBlock = blocks.find((b) => b.includes('```bash'));
      expect(codeBlock).toBeTruthy();
      expect(codeBlock).toContain('pstree -p $$');
      expect(codeBlock).toContain('echo $$');

      const followUpBlock = blocks.find((b) => b.includes('Follow-up text.'));
      expect(followUpBlock).toBeTruthy();
    });

    it('correctly handles code block with $$ followed immediately by a real $$ math block', () => {
      const mixedMd = [
        '```bash',
        'echo $$',
        '```',
        '',
        '$$',
        'E = mc^2',
        '$$',
        '',
        'Conclusion.',
      ].join('\n');

      const blocks = parseMarkdownIntoBlocks(mixedMd);
      expect(blocks.join('')).toBe(mixedMd);

      const codeBlock = blocks.find((b) => b.includes('```bash') && b.includes('echo $$'));
      expect(codeBlock).toBeTruthy();

      const mathBlock = blocks.find((b) => b.includes('$$') && b.includes('E = mc^2'));
      expect(mathBlock).toBeTruthy();
      expect(countDoubleDollars(mathBlock!)).toBe(2);

      const conclusionBlock = blocks.find((b) => b.includes('Conclusion.'));
      expect(conclusionBlock).toBeTruthy();
    });
  });

  describe('Helper Functions Unit Tests', () => {
    it('countDoubleDollars counts double dollars accurately', () => {
      expect(countDoubleDollars('$$')).toBe(1);
      expect(countDoubleDollars('$$$$')).toBe(2);
      expect(countDoubleDollars('$$ x = 1 $$')).toBe(2);
      expect(countDoubleDollars('$$$')).toBe(1); // non-overlapping
      expect(countDoubleDollars('$10 and $20')).toBe(0);
      expect(countDoubleDollars('')).toBe(0);
    });

    it('countNonSelfClosingOpenTags and countClosingTags count accurately', () => {
      expect(countNonSelfClosingOpenTags('<div class="a"><div>', 'div')).toBe(2);
      expect(countNonSelfClosingOpenTags('<div /><span>', 'div')).toBe(0);
      expect(countNonSelfClosingOpenTags('<img><img src="x" />', 'img')).toBe(0); // void element
      expect(countClosingTags('</div></div>', 'div')).toBe(2);
      expect(countClosingTags('</span>', 'div')).toBe(0);
    });
  });

  describe('Streaming Simulation Scenarios', () => {
    it('handles progressive chunk accumulation cleanly and preserves lossless reconstruction', () => {
      const step1 = '# Intro\n\n';
      const blocks1 = parseMarkdownIntoBlocks(step1);
      expect(blocks1.join('')).toBe(step1);
      expect(blocks1[0]).toContain('# Intro');

      const step2 = '# Intro\n\nParagraph in progress';
      const blocks2 = parseMarkdownIntoBlocks(step2);
      expect(blocks2.join('')).toBe(step2);
      expect(blocks2.some((b) => b.includes('# Intro'))).toBe(true);
      expect(blocks2.some((b) => b.includes('Paragraph in progress'))).toBe(true);

      const step3 = '# Intro\n\nParagraph completed.\n\n```js\nconst x = 1;\n';
      const blocks3 = parseMarkdownIntoBlocks(step3);
      expect(blocks3.join('')).toBe(step3);
      const codeBlock3 = blocks3.find((b) => b.includes('```js'));
      expect(codeBlock3).toBeTruthy();

      const step4 = '# Intro\n\nParagraph completed.\n\n```js\nconst x = 1;\n```\n\nConclusion.';
      const blocks4 = parseMarkdownIntoBlocks(step4);
      expect(blocks4.join('')).toBe(step4);
      const codeBlock4 = blocks4.find((b) => b.includes('```js'));
      expect(codeBlock4).toBeTruthy();
      expect(blocks4.some((b) => b.includes('Conclusion.'))).toBe(true);
    });
  });
});
