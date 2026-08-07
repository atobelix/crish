import { test, expect } from '@playwright/test';

test.describe('WYSIWYG Interaction & Active State Tests', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', (msg) => console.log('BROWSER CONSOLE:', msg.text()));
    await page.goto('http://localhost:5173');
    await page.waitForSelector('.editor-container');
  });

  test('Heading prefix visibility toggles on click', async ({ page }) => {
    // Scroll to Heading H1
    const headingBlock = page
      .locator('.line-block')
      .filter({ hasText: '一级标题 H1' })
      .first();
    await expect(headingBlock).toBeVisible();

    // 1. Before click, the source code "# " should NOT be visible
    // Actually, `.syntax-hidden` has `display: none` unless `.is-active-line` is present on the block.
    const prefix = headingBlock.locator('.token-heading-prefix .syntax-hidden');
    await expect(prefix).toBeHidden();

    // 2. Click the heading
    await headingBlock.click();

    // Wait for state update (HiddenInput updating .is-active-line)
    await page.waitForTimeout(100);

    // 3. After click, the block should have .is-active-line and "# " should be visible
    const lineContainer = headingBlock.locator('..').first(); // The wrapping div with data-index
    await expect(lineContainer).toHaveClass(/is-active-line/);
    await expect(prefix).toBeVisible();
    await expect(prefix).toHaveText('# ');
  });

  test('Horizontal Rule (HR) toggles between rendered line and source on click', async ({
    page,
  }) => {
    // Find the HR block
    const hrBlock = page.locator('.line-hr').first();
    await expect(hrBlock).toBeVisible();

    const hrRendered = hrBlock.locator('.hr-rendered');
    const hrSource = hrBlock.locator('.hr-source');

    // 1. Before click, rendered HR is visible, source is hidden
    await expect(hrRendered).toBeVisible();
    await expect(hrSource).toBeHidden();

    // 2. Click the HR
    // We click slightly below or exactly on the HR line
    await hrBlock.click();
    await page.waitForTimeout(100);

    // 3. After click, rendered HR is hidden, source "---" is visible
    const lineContainer = hrBlock.locator('..').first();
    await expect(lineContainer).toHaveClass(/is-active-line/);

    await expect(hrRendered).toBeHidden();
    await expect(hrSource).toBeVisible();
    await expect(hrSource).toHaveText(/---/); // Or *** etc
  });

  test('Blockquote toggles prefix visibility on click', async ({ page }) => {
    // Find a blockquote block
    const quoteBlock = page
      .locator('.line-blockquote')
      .filter({ hasText: '第一层引用' })
      .first();
    await expect(quoteBlock).toBeVisible();

    const quoteSource = quoteBlock.locator('.blockquote-source');

    // 1. Before click, ">" prefix is hidden
    await expect(quoteSource).toBeHidden();

    // 2. Click the blockquote text
    await quoteBlock.click();
    await page.waitForTimeout(100);

    // 3. After click, ">" prefix is visible
    const lineContainer = quoteBlock.locator('..').first();
    await expect(lineContainer).toHaveClass(/is-active-line/);
    await expect(quoteSource).toBeVisible();
    await expect(quoteSource).toHaveText(/>\s?/);
  });

  test('Inline code toggles backticks when clicking specifically on it', async ({
    page,
  }) => {
    // Find paragraph with inline code
    const textBlock = page
      .locator('.line-block')
      .filter({ hasText: '基础样式：' })
      .first();
    await expect(textBlock).toBeVisible();

    // The inline code token
    const codeToken = textBlock.locator('.style-inline-code').first();
    const syntaxHidden = codeToken.locator('.syntax-hidden');

    // 1. Click somewhere else in the line (e.g. at the beginning)
    await textBlock.click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(100);

    // The line is active, but the token itself is NOT active!
    // Therefore, backticks should STILL be hidden!
    await expect(syntaxHidden.first()).toBeHidden();

    // 2. Click exactly ON the inline code element
    await codeToken.click();
    await page.waitForTimeout(100);

    // Now the token should have is-active-token and backticks should be visible
    await expect(codeToken).toHaveClass(/is-active-token/);
    await expect(syntaxHidden.first()).toBeVisible();
    await expect(syntaxHidden.first()).toHaveText('`');
  });

  test('Code fence start toggles language pill and ``` source on click', async ({
    page,
  }) => {
    // Scroll down so virtualizer renders the code block section
    await page
      .locator('.editor-container')
      .evaluate((el) => (el.scrollTop = 1800));
    await page.waitForTimeout(300);

    // Find the code fence start block for javascript
    const fenceBlock = page.locator('.line-code-fence-start').first();
    await expect(fenceBlock).toBeVisible();

    const renderedPill = fenceBlock.locator('.code-fence-rendered');
    const fenceSource = fenceBlock.locator('.code-fence-source');

    // 1. Before click: rendered pill is visible, source is hidden
    await expect(renderedPill).toBeVisible();
    await expect(renderedPill).toHaveText(/javascript/i);
    await expect(fenceSource).toBeHidden();

    // 2. Click the fence start line
    await fenceBlock.click();
    await page.waitForTimeout(100);

    // 3. After click: rendered pill is hidden, source is visible
    const lineContainer = fenceBlock.locator('..').first();
    await expect(lineContainer).toHaveClass(/is-active-line/);
    await expect(renderedPill).toBeHidden();
    await expect(fenceSource).toBeVisible();
    await expect(fenceSource).toHaveText(/```javascript/);
  });

  test('HTML element renders styled text and reveals raw tags on click', async ({
    page,
  }) => {
    // Scroll down so virtualizer renders the HTML section
    await page
      .locator('.editor-container')
      .evaluate((el) => (el.scrollTop = 2200));
    await page.waitForTimeout(300);

    // Scroll to the HTML tag line
    const htmlLine = page
      .locator('.line-block')
      .filter({ hasText: '内联 HTML 标签解析逃逸' })
      .first();
    await expect(htmlLine).toBeVisible();

    const htmlElement = htmlLine.locator('.token-html-element').first();
    await expect(htmlElement).toBeVisible();

    // Verify it has blue color applied
    await expect(htmlElement).toHaveCSS('color', 'rgb(0, 0, 255)');

    // 1. Before click: raw tags <span style="color: blue"> and </span> are hidden
    const hiddenTags = htmlElement.locator('.syntax-hidden');
    await expect(hiddenTags.first()).toBeHidden();

    // 2. Click the HTML element
    await htmlElement.click();
    await page.waitForTimeout(100);

    // 3. After click: raw tags are revealed
    await expect(htmlElement).toHaveClass(/is-active-token/);
    await expect(hiddenTags.first()).toBeVisible();
    await expect(hiddenTags.first()).toHaveText('<span style="color: blue">');
  });

  test('Selection range reveals source code for selected tokens while unselected remain previewed', async ({
    page,
  }) => {
    // Locate the line with multiple inline styles
    const line = page
      .locator('.line-block')
      .filter({ hasText: '基础样式：' })
      .first();
    await expect(line).toBeVisible();

    const boldToken = line.locator('.style-bold').first();
    const italicToken = line.locator('.style-italic').first();
    const strikeToken = line.locator('.style-strike').first();

    // Before selection, none of them should have .is-active-token
    await expect(boldToken.locator('.syntax-hidden').first()).toBeHidden();
    await expect(italicToken.locator('.syntax-hidden').first()).toBeHidden();
    await expect(strikeToken.locator('.syntax-hidden').first()).toBeHidden();

    // Perform a drag selection across bold and italic tokens
    const boldBox = await boldToken.boundingBox();
    const italicBox = await italicToken.boundingBox();

    if (boldBox && italicBox) {
      await page.mouse.move(boldBox.x + 2, boldBox.y + boldBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        italicBox.x + italicBox.width - 2,
        italicBox.y + italicBox.height / 2
      );
      // Wait for selectionchange event
      await page.waitForTimeout(150);

      // Selected tokens should have .is-active-token and show source syntax
      await expect(boldToken).toHaveClass(/is-active-token/);
      await expect(boldToken.locator('.syntax-hidden').first()).toBeVisible();

      await expect(italicToken).toHaveClass(/is-active-token/);
      await expect(italicToken.locator('.syntax-hidden').first()).toBeVisible();

      // Unselected token (strike) outside selection range should REMAIN IN PREVIEW
      await expect(strikeToken).not.toHaveClass(/is-active-token/);
      await expect(strikeToken.locator('.syntax-hidden').first()).toBeHidden();
    }
  });

  test('Subscript and Math formula toggle source syntax on click', async ({
    page,
  }) => {
    // Scroll down to the extended syntax section
    await page
      .locator('.editor-container')
      .evaluate((el) => (el.scrollTop = 2500));
    await page.waitForTimeout(200);

    const subSupBlock = page
      .locator('.line-block')
      .filter({ hasText: '上下标:' })
      .first();
    await expect(subSupBlock).toBeVisible();

    // The first .style-sub corresponds to <sub>2</sub>
    const subToken = subSupBlock.locator('.style-sub').first();
    await expect(subToken).toBeVisible();

    // 1. Before click: raw <sub> and </sub> are hidden
    const subHidden = subToken.locator('.syntax-hidden');
    await expect(subHidden.first()).toBeHidden();

    // 2. Click on the subscript
    await subToken.click();
    await page.waitForTimeout(100);

    // 3. After click: raw <sub> is revealed
    await expect(subToken).toHaveClass(/is-active-token/);
    await expect(subHidden.first()).toBeVisible();
    await expect(subHidden.first()).toHaveText('<sub>');

    // 4. Test Math formula KaTeX toggle
    const mathBlock = page
      .locator('.line-block')
      .filter({ hasText: '数学公式:' })
      .first();
    await expect(mathBlock).toBeVisible();
    const mathWrapper = mathBlock.locator('.token-math-wrapper').first();
    await expect(mathWrapper).toBeVisible();

    // Before click: math-preview is visible, math-source is hidden
    await expect(mathWrapper.locator('.math-preview')).toBeVisible();
    await expect(mathWrapper.locator('.math-source')).toBeHidden();

    // Click inside the math formula
    await mathWrapper.click();
    await page.waitForTimeout(100);

    // After click: active token shows math source and hides preview
    await expect(mathWrapper).toHaveClass(/is-active-token/);
    await expect(mathWrapper.locator('.math-source')).toBeVisible();
    await expect(mathWrapper.locator('.math-preview')).toBeHidden();
  });
});
