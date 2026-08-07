import { describe, it, expect } from 'vitest';
import { MarkdownFormatChecker } from '../../src/core/validator';

describe('Format Checker', () => {
  it('validates valid documents and counts syntax elements', () => {
    const validDoc = `
# 标题一
这是一段常规文本，包含 **加粗** 和 *斜体* 以及 \`行内代码\`。

$$
\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}
$$

数学公式 $E = mc^2$ 以及上下标 H~2~O 和 2^10^。
<kbd>Ctrl</kbd> + <kbd>C</kbd>

\`\`\`ts
const x = 10;
\`\`\`
`.trim();
    const result = MarkdownFormatChecker.validate(validDoc);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.stats.headingsCount).toBe(1);
    expect(result.stats.codeBlocksCount).toBe(1);
    expect(result.stats.mathCount).toBe(2);
  });

  it('detects unclosed code fence and math fence', () => {
    const unclosedDoc = `
# 未闭合测试
\`\`\`typescript
const a = 1;
// Missing closing fence
`.trim();
    const result = MarkdownFormatChecker.validate(unclosedDoc);
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.rule === 'unclosed-code-fence')).toBe(
      true
    );
  });

  it('warns on invalid LaTeX math formula', () => {
    const invalidMathDoc = `
数学公式: $\\frac{invalid_macro_unclosed{2}$
`.trim();
    const result = MarkdownFormatChecker.validate(invalidMathDoc);
    expect(result.warnings.some((w) => w.rule === 'math-katex-syntax')).toBe(
      true
    );
  });

  it('handles unclosed inline tags without throwing or corrupting bounds', () => {
    const edgeDoc = `
**未闭合加粗 *未闭合斜体 ~~未闭合删除线 mc^2 和 ~500ms
`.trim();
    const result = MarkdownFormatChecker.validate(edgeDoc);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
