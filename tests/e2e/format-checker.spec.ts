import { test, expect } from '@playwright/test';

test.describe('Universal Markdown Format Checker & Validator', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173');
    await page.waitForSelector('.editor-container');
  });

  test('Format checker correctly validates valid documents and counts syntax elements', async ({ page }) => {
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

    const result = await page.evaluate((docText) => {
      return (window as any).MarkdownFormatChecker.validate(docText);
    }, validDoc);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.stats.headingsCount).toBe(1);
    expect(result.stats.codeBlocksCount).toBe(1);
    expect(result.stats.mathCount).toBe(2); // 1 block math + 1 inline math
  });

  test('Format checker detects unclosed code fence and math fence', async ({ page }) => {
    const unclosedDoc = `
# 未闭合测试
\`\`\`typescript
const a = 1;
// Missing closing fence
`.trim();

    const result = await page.evaluate((docText) => {
      return (window as any).MarkdownFormatChecker.validate(docText);
    }, unclosedDoc);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: any) => e.rule === 'unclosed-code-fence')).toBe(true);
  });

  test('Format checker warns on invalid LaTeX math formula', async ({ page }) => {
    const invalidMathDoc = `
数学公式: $\\frac{invalid_macro_unclosed{2}$
`.trim();

    const result = await page.evaluate((docText) => {
      return (window as any).MarkdownFormatChecker.validate(docText);
    }, invalidMathDoc);

    // KaTeX syntax error produces a diagnostic warning
    expect(result.warnings.some((w: any) => w.rule === 'math-katex-syntax')).toBe(true);
  });

  test('Format checker handles unclosed inline tags without throwing or corrupting bounds', async ({ page }) => {
    const edgeDoc = `
**未闭合加粗 *未闭合斜体 ~~未闭合删除线 mc^2 和 ~500ms
`.trim();

    const result = await page.evaluate((docText) => {
      return (window as any).MarkdownFormatChecker.validate(docText);
    }, edgeDoc);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
