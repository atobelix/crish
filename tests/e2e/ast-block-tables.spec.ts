import { test, expect } from '@playwright/test';

test.describe('AST Block & Tables validation', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:5173/');
        // Wait for engine to boot
        await page.waitForSelector('.editor-container');
    });

    test('should parse lists correctly', async ({ page }) => {
        const result = await page.evaluate(() => {
            // @ts-ignore
            const doc = window.MarkdownParser.parse('- item 1\n  - nested\n1. number');
            return doc.lines;
        });

        expect(result.length).toBe(3);
        expect(result[0].type).toBe('body');
        expect(result[0].listPrefix).toBe('-');
        expect(result[0].listIndent).toBe(0);

        expect(result[1].type).toBe('body');
        expect(result[1].listPrefix).toBe('-');
        expect(result[1].listIndent).toBe(2);

        expect(result[2].type).toBe('body');
        expect(result[2].listPrefix).toBe('1.');
        expect(result[2].listIndent).toBe(0);
    });

    test('should parse tables correctly', async ({ page }) => {
        const result = await page.evaluate(() => {
            // @ts-ignore
            const doc = window.MarkdownParser.parse('| Header 1 | Header 2 |\n|---|---|\n| cell 1 | cell 2 |');
            return doc.lines;
        });

        expect(result.length).toBe(3);
        expect(result[0].type).toBe('table_row');
        expect(result[1].type).toBe('table_separator');
        expect(result[2].type).toBe('table_row');
    });
});
