import { test, expect, type Locator, type Page } from '@playwright/test';

// —— 虚拟化适配辅助（reference 演进：MarkdownEngine 只物化视口内行，
// overscan 40 行；App.tsx 挂载即加载 100×test-document ≈ 1.5 万行）——
// 滚动编辑器容器直到目标行被虚拟化物化（直接设 scrollTop，ScrollMap 在
// 总高 ≤ 3000 万 px 时恒等短路，物理坐标 = 逻辑坐标）。
async function scrollUntilMaterialized(
  page: Page,
  target: Locator,
  stepPx = 1500,
  maxSteps = 60
): Promise<void> {
  const container = page.locator('.editor-container');
  for (let i = 0; i < maxSteps; i++) {
    if ((await target.count()) > 0) return;
    await container.evaluate((el, step) => (el.scrollTop += step), stepPx);
    await page.waitForTimeout(100);
  }
  throw new Error(`目标行滚动 ${maxSteps} 步后仍未物化（虚拟化窗口外）`);
}

// 把目标行滚到视口底部：page.mouse.* 原始坐标不自动滚动，且左上 OutlinePanel
// （x∈[229,461]、y∈[77,498]，zIndex 500）会拦截覆盖区内的鼠标事件——
// 贴视口底部可同时满足「事件坐标在视口内」与「避开面板覆盖区」。
async function scrollToViewportBottom(
  page: Page,
  target: Locator
): Promise<void> {
  await target.first().evaluate((el) => el.scrollIntoView(false));
  await page.waitForTimeout(150);
}

// App.tsx 挂载即加载 100×test-document（分块加载：首块 1000 行同步载入、
// 续载走空闲分片）。加载期间每落一块，HiddenInput 光标跟随 effect 会把
// scrollTop 拉回 0（光标停在文档首行、目标滚动位置在视口下方），虚拟化行
// 随之卸载——所有滚动辅助必须先等加载完成再滚。判定：lineCount 连续两次
// 采样一致（分块期间每次落地必然递增）即视为文档就绪。
async function waitForDocumentLoaded(page: Page): Promise<void> {
  let prev = -1;
  for (let i = 0; i < 100; i++) {
    const count = await page.evaluate(() =>
      // @ts-expect-error markdown-editor main.tsx 注入的测试全局
      window.__CRISH_SESSION_STORE__.getState().getLineCount()
    );
    if (count === prev) {
      await page.waitForTimeout(200);
      const again = await page.evaluate(() =>
        // @ts-expect-error markdown-editor main.tsx 注入的测试全局
        window.__CRISH_SESSION_STORE__.getState().getLineCount()
      );
      if (again === count) return;
    }
    prev = count;
    await page.waitForTimeout(200);
  }
}

test.describe('WYSIWYG Interaction & Active State Tests', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', (msg) => console.log('BROWSER CONSOLE:', msg.text()));
    await page.goto('http://localhost:5173');
    await page.waitForSelector('.editor-container');
    // 等 100 副本分块加载完成（加载期间滚动位置会被分块落地复位，见上）
    await waitForDocumentLoaded(page);
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
    // 引用行当前渲染为 .line-block + token-blockquote-prefix（无 .line-blockquote
    // 类——BlockRenderer 已演进为 token 前缀架构），且位于初始视口外
    // （虚拟化只物化视口内行）——按文本定位 + 先滚动物化再断言
    const quoteBlock = page
      .locator('.line-block')
      .filter({ hasText: /第一层引用$/ })
      .first();
    await scrollUntilMaterialized(page, quoteBlock);
    await expect(quoteBlock).toBeVisible();

    // 引用前缀（> ）的隐藏/显示由 is-active-line 驱动（index.css:
    // .is-active-line .token-blockquote-prefix .syntax-hidden）
    const quoteSource = quoteBlock.locator(
      '.token-blockquote-prefix .syntax-hidden'
    );

    // 1. Before click, ">" prefix is hidden
    await expect(quoteSource).toBeHidden();

    // 2. Click the blockquote text
    await quoteBlock.click();
    await page.waitForTimeout(100);

    // 3. After click, ">" prefix is visible
    const lineContainer = quoteBlock.locator('..').first();
    await expect(lineContainer).toHaveClass(/is-active-line/);
    await expect(quoteSource).toBeVisible();
    await expect(quoteSource).toHaveText(/>\s*$/);
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
    // 点击点 x≈241 落在左上大纲面板覆盖区（x∈[229,461]），贴视口底部避开
    await scrollToViewportBottom(page, textBlock);

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
    // 目标 javascript 围栏行：虚拟化下 first() = 视口内第一个围栏（json，
    // 文档副本 1 第 6 节先出现），必须按语言文本过滤定位，先滚动物化再断言
    const fenceBlock = page
      .locator('.line-code-fence-start')
      .filter({ hasText: 'javascript' })
      .first();
    await scrollUntilMaterialized(page, fenceBlock);
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
    // 目标行初始在视口底部下方（preamble + 100 副本位移，row≈26 → y≈811 >
    // 视口高 800），page.mouse.* 原始坐标不自动滚动——浏览器把越界鼠标事件
    // 钳制到视口边缘，拖选坐标全部错位。先贴视口底部（同 Inline code 用例），
    // 保证 boundingBox 与鼠标事件落在可见区
    await scrollToViewportBottom(page, line);

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
    // 目标行（数学公式 row≈151、上下标 row≈157）远超原 scrollTop=2500 的
    // 物化窗口（rows [44,149]）——先滚动物化再断言
    const subSupBlock = page
      .locator('.line-block')
      .filter({ hasText: '上下标:' })
      .first();
    await scrollUntilMaterialized(page, subSupBlock);
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
    await scrollUntilMaterialized(page, mathBlock);
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
