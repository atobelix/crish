import { test, expect } from '@playwright/test';

test.describe('Comprehensive Syntax Matrix Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173');
    await page.waitForSelector('.editor-container');
  });

  test('Basic inline formatting parsing', async ({ page }) => {
    const textBlock = page
      .locator('.line-block')
      .filter({ hasText: '基础样式：' })
      .first();
    await expect(textBlock).toBeVisible();

    // **加粗**
    const bold = textBlock.locator('.style-bold').first();
    await expect(bold).toBeVisible();
    await expect(bold).toHaveText(/加粗/);

    // *斜体*
    const italic = textBlock.locator('.style-italic').first();
    await expect(italic).toBeVisible();
    await expect(italic).toHaveText(/斜体/);

    // ~~删除线~~
    const strike = textBlock.locator('.style-strike').first();
    await expect(strike).toBeVisible();
    await expect(strike).toHaveText(/删除线/);

    // ==高亮==
    const mark = textBlock.locator('.style-mark').first();
    await expect(mark).toBeVisible();
    await expect(mark).toHaveText(/高亮/);

    // `行内代码`
    const code = textBlock.locator('.style-inline-code').first();
    await expect(code).toBeVisible();
    await expect(code).toHaveText(/行内代码/);
  });

  test('Complex nested combinations', async ({ page }) => {
    const depthBlock = page
      .locator('.line-block')
      .filter({ hasText: '深度嵌套组合：' })
      .first();
    await expect(depthBlock).toBeVisible();

    // **~~*==高亮斜体删除线加粗==*~~**
    const boldNode = depthBlock.locator('.style-bold').first();
    await expect(boldNode).toBeVisible();

    const strikeNode = boldNode.locator('.style-strike').first();
    await expect(strikeNode).toBeVisible();

    const italicNode = strikeNode.locator('.style-italic').first();
    await expect(italicNode).toBeVisible();

    const markNode = italicNode.locator('.style-mark').first();
    await expect(markNode).toBeVisible();

    // The innermost text should be 高亮斜体删除线加粗
    await expect(markNode).toContainText('高亮斜体删除线加粗');
  });

  test('Empty tags and unclosed tags do not break parsing', async ({
    page,
  }) => {
    const emptyBlock = page
      .locator('.line-block')
      .filter({ hasText: '空标签测试：' })
      .first();
    await expect(emptyBlock).toBeVisible();

    // Should contain raw text since they are empty
    await expect(emptyBlock).toContainText(
      '** **、**  **、****、**、* *、~~ ~~、===='
    );

    const unclosedBlock = page
      .locator('.line-block')
      .filter({ hasText: '单边未闭合测试：' })
      .first();
    await expect(unclosedBlock).toBeVisible();

    // Unclosed tags should remain as plain text
    await expect(unclosedBlock).toContainText('**未闭合的加粗');
    await expect(unclosedBlock).toContainText('*未闭合的斜体');
    await expect(unclosedBlock).toContainText('~~未闭合的删除线');
  });

  test('Extended syntax (math, sub, sup, kbd, spoiler)', async ({ page }) => {
    // Since we use virtualization, we need to scroll down to find the elements
    await page.evaluate(() => {
      const container = document.querySelector('.editor-container');
      if (container) {
        container.scrollTop = 2500; // Scroll down approximately to where the extended syntax is
      }
    });
    // Wait a bit for virtualizer to render
    await page.waitForTimeout(100);

    const mathBlock = page
      .locator('.line-block')
      .filter({ hasText: '数学公式:' })
      .first();
    await expect(mathBlock).toBeVisible();
    const mathNodes = mathBlock.locator('.style-math');
    await expect(mathNodes).toHaveCount(2); // $E = mc^2$ and $e^{i\\pi} + 1 = 0$

    const kbdBlock = page
      .locator('.line-block')
      .filter({ hasText: '按键标记:' })
      .first();
    await expect(kbdBlock).toBeVisible();
    const kbdNodes = kbdBlock.locator('.style-kbd');
    await expect(kbdNodes).toHaveCount(4); // Ctrl, C, Cmd, K

    const subSupBlock = page
      .locator('.line-block')
      .filter({ hasText: '上下标:' })
      .first();
    await expect(subSupBlock).toBeVisible();
    const subNodes = subSupBlock.locator('.style-sub');
    const supNodes = subSupBlock.locator('.style-sup');
    await expect(subNodes).toHaveCount(2); // <sub>2</sub> and ~2~
    await expect(supNodes).toHaveCount(2); // <sup>10</sup> and ^10^

    const spoilerBlock = page
      .locator('.line-block')
      .filter({ hasText: '剧透警告:' })
      .first();
    await expect(spoilerBlock).toBeVisible();
    const spoilerNodes = spoilerBlock.locator('.style-spoiler');
    await expect(spoilerNodes).toHaveCount(1); // ||那个一直在微笑的管家||
    await expect(spoilerNodes.first()).toContainText('那个一直在微笑的管家');
  });

  test('Escaping and Links', async ({ page }) => {
    await page.evaluate(() => {
      const container = document.querySelector('.editor-container');
      if (container) container.scrollTop = 1000;
    });
    await page.waitForTimeout(100);

    const escapeBlock = page
      .locator('.line-block')
      .filter({ hasText: '转义字符测试：' })
      .first();
    await expect(escapeBlock).toBeVisible();

    // Check that \*这不是斜体\* does NOT produce a .style-italic
    const italicNodes = escapeBlock.locator('.style-italic');
    await expect(italicNodes).toHaveCount(0);

    // Check that \*\*这不是加粗\*\* does NOT produce a .style-bold
    const boldNodes = escapeBlock.locator('.style-bold');
    await expect(boldNodes).toHaveCount(0);

    const linkBlock = page
      .locator('.line-block')
      .filter({ hasText: '基础链接：' })
      .first();
    await expect(linkBlock).toBeVisible();
    const linkNodes = linkBlock.locator('.interactive-link');
    await expect(linkNodes).toHaveCount(1);
    await expect(linkNodes.first()).toContainText('普通链接文本');
  });
});
