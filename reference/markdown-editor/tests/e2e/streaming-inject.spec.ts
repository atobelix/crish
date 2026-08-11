// tests/e2e/streaming-inject.spec.ts
// W3-2 包（docs/streaming-render/00-流式渲染极致化总方案.md：S-EL-12 /
// R-8 / S-T-3-02）：演示宿主流式驾驶舱全路径 e2e——开始/暂停/继续/中断/
// 丢弃/导出 + aria-live 三态播报 + C3 直刷路径浏览器级验证。
//
// 前置：vite dev server 运行于 localhost:5174（端口统一口径，见
// playwright.config.ts；启动命令：`npx vite --port 5174`）。
// 运行：`npx playwright test tests/e2e/streaming-inject.spec.ts`。
//
// 覆盖（S-T-3-02 验收断言）：
// 1. 开始模拟流式 → 内容逐 chunk 增长（DOM textContent 单调增长 + 标题/
//    表格/代码块/公式样式 class 出现）；
// 2. 暂停/继续 → 注入停止与恢复（暂停语义 = 停止注入 + flushStream 收敛，
//    Handle 无暂停 API，任务书约定）；
// 3. 中断（streamEnd）→ 内容完整、无 pending 残留（directPendingChars/
//    bufferedChars 归零，DOM 与 store 最终一致）；
// 4. 丢弃（discardStream）→ 内容回退到会话前（空文档）；
// 5. 导出 → getContent 与界面一致（=== 预置演示内容），exportHtml 含
//    <h1>/<tr> 结构；
// 6. 直刷路径：纯文本 chunk（无禁字符）注入 → DOM 即时更新（直刷生效）
//    而 store 文本滞后（directPendingChars > 0），streamEnd 收口后
//    DOM 与 store 收敛一致（最终一致性）；
// 7. aria-live 三态播报（R-8）：开始「AI 正在生成…」/ 完成「生成完成」/
//    丢弃「已丢弃生成内容」（role="status" aria-live="polite" 隐藏元素）。

import { test, expect, type Page } from '@playwright/test';

/** 进入演示宿主并等待引擎句柄就绪 */
async function gotoApp(page: Page) {
  await page.goto('http://localhost:5174');
  await page.waitForFunction(
    () =>
      !!(window as any).__CRISH_ENGINE__ &&
      typeof (window as any).__CRISH_ENGINE__.streamAppend === 'function' &&
      typeof (window as any).__CRISH_DEMO_CONTENT__ === 'string'
  );
  // 宿主挂载即加载万行压力文档（既有行为保留）；流式测试统一先清空
  // （setText('') 经代际计数取消在途分块加载），得到干净的会话起点
  await page.evaluate(() => {
    (window as any).__CRISH_SESSION_STORE__.getState().setText('');
  });
  await page.waitForFunction(
    () => (window as any).__CRISH_SESSION_STORE__.getState().textLength === 0
  );
}

/** 选择 token 率并点击开始流式 */
async function startStream(page: Page, rate: string) {
  await page.selectOption('[data-testid="rate-select"]', rate);
  await page.click('[data-testid="stream-start"]');
  await expect(page.locator('[data-testid="stream-status"]')).toHaveAttribute(
    'data-phase',
    'streaming'
  );
}

/** 读取 store 全文 */
async function storeText(page: Page) {
  return page.evaluate(() =>
    (window as any).__CRISH_SESSION_STORE__.getState().getText()
  );
}

/** 等待内容开始产出（标题行挂载） */
async function waitForContent(page: Page) {
  await page.waitForSelector('.line-h1', { timeout: 15_000 });
}

/** 等待首个完整标题行提交到 store（中断/丢弃断言需要足量内容） */
async function waitForHeadingCommitted(page: Page) {
  await page.waitForFunction(
    () =>
      (window as any).__CRISH_SESSION_STORE__
        .getState()
        .getText()
        .includes('# 流式渲染演示（AI 模拟输出）'),
    undefined,
    { timeout: 20_000 }
  );
}

test.describe('W3-2 流式驾驶舱全路径（S-T-3-02）', () => {
  test('开始流式：内容逐 chunk 增长，标题/表格/代码块/公式样式出现', async ({
    page,
  }) => {
    await gotoApp(page);
    await startStream(page, '50');

    // aria-live 开始播报（R-8 三态之一）
    await expect(page.locator('[data-testid="stream-announce"]')).toHaveText(
      'AI 正在生成…'
    );

    // 内容开始产出（演示内容首行是 H1 标题）
    await waitForContent(page);

    // 内容逐 chunk 增长：两次采样 DOM 文本长度严格递增
    const t1 = await page.locator('.editor-scroll-container').textContent();
    await page.waitForTimeout(600);
    const t2 = await page.locator('.editor-scroll-container').textContent();
    expect((t2 ?? '').length).toBeGreaterThan((t1 ?? '').length);

    // 流式覆盖表格 / 代码块 / 公式后，对应样式 class 出现
    await page.waitForSelector('.line-table-row', { timeout: 15_000 });
    await page.waitForSelector('.line-code-fence-start', { timeout: 15_000 });
    await page.waitForSelector('.line-math-block', { timeout: 15_000 });

    // store 已含流式文本（直刷/帧聚合提交路径均收敛到 store）
    const text = await storeText(page);
    expect(text).toContain('# 流式渲染演示（AI 模拟输出）');
  });

  test('暂停/继续：注入停止与恢复', async ({ page }) => {
    await gotoApp(page);
    await startStream(page, '10');
    await waitForContent(page);

    // 暂停 = 停止注入 + flushStream 收敛
    await page.click('[data-testid="stream-pause"]');
    await expect(page.locator('[data-testid="stream-status"]')).toHaveAttribute(
      'data-phase',
      'paused'
    );
    const lenPaused = await page.evaluate(
      () => (window as any).__CRISH_SESSION_STORE__.getState().textLength
    );
    // 暂停期间文本不再增长（等待 700ms 覆盖多个注入节拍）
    await page.waitForTimeout(700);
    const lenAfterPause = await page.evaluate(
      () => (window as any).__CRISH_SESSION_STORE__.getState().textLength
    );
    expect(lenAfterPause).toBe(lenPaused);

    // 继续 → 注入恢复，文本重新增长
    await page.click('[data-testid="stream-resume"]');
    await expect(page.locator('[data-testid="stream-status"]')).toHaveAttribute(
      'data-phase',
      'streaming'
    );
    await page.waitForFunction(
      (pausedLen: number) =>
        (window as any).__CRISH_SESSION_STORE__.getState().textLength >
        pausedLen,
      lenPaused,
      { timeout: 15_000 }
    );
  });

  test('中断（streamEnd）：内容完整、无 pending 残留，DOM 与 store 一致', async ({
    page,
  }) => {
    await gotoApp(page);
    await startStream(page, '10');
    // 等待首个完整标题行入库（.line-h1 在 `# ` 两字符即出现，
    // 中断断言需要足量内容）
    await waitForHeadingCommitted(page);

    // 中断收口（未到会话末尾，内容保留已生成部分）
    await page.click('[data-testid="stream-stop"]');
    await expect(page.locator('[data-testid="stream-status"]')).toHaveAttribute(
      'data-phase',
      'done'
    );
    // aria-live 完成播报（R-8 三态之二）
    await expect(page.locator('[data-testid="stream-announce"]')).toHaveText(
      '生成完成'
    );

    // 无 pending 残留：直刷累积与帧聚合缓冲全部归零，会话熄灭
    await page.waitForFunction(() => {
      const st = (window as any).__CRISH_ENGINE__.getStreamState();
      return (
        st.active === false &&
        st.directPendingChars === 0 &&
        st.bufferedChars === 0
      );
    });

    // 内容完整：store 含流式前缀文本
    const text = await storeText(page);
    expect(text.length).toBeGreaterThan(0);
    expect(text.startsWith('# 流式渲染演示（AI 模拟输出）')).toBe(true);

    // 最终一致性：DOM 末行文本 === store 末行（直刷收敛后逐字符一致）
    await page.waitForFunction(() => {
      const store = (window as any).__CRISH_SESSION_STORE__.getState();
      const lastIdx = store.getLineCount() - 1;
      const lastLine = store.getLine(lastIdx);
      const rows = document.querySelectorAll('.virtual-row');
      if (rows.length === 0) return false;
      const domLast = rows[rows.length - 1].textContent ?? '';
      return domLast === lastLine;
    });
  });

  test('丢弃（discardStream）：内容回退到会话前（空文档）', async ({
    page,
  }) => {
    await gotoApp(page);
    await startStream(page, '50');
    await waitForContent(page);
    expect((await storeText(page)).length).toBeGreaterThan(0);

    // 丢弃 → 回滚到会话起点（开始流式前已清空文档）
    await page.click('[data-testid="stream-discard"]');
    await expect(page.locator('[data-testid="stream-status"]')).toHaveAttribute(
      'data-phase',
      'discarded'
    );
    // aria-live 丢弃播报（R-8 三态之三）
    await expect(page.locator('[data-testid="stream-announce"]')).toHaveText(
      '已丢弃生成内容'
    );

    // 会话前 = 空文档；引擎取文聚合与 store 一致
    expect(await storeText(page)).toBe('');
    const content = await page.evaluate(() =>
      (window as any).__CRISH_ENGINE__.getContent()
    );
    expect(content).toBe('');
  });

  test('导出：getContent 与界面一致，exportHtml 含结构标签', async ({
    page,
  }) => {
    await gotoApp(page);
    // 高速率跑完整会话（自动 streamEnd → 播报 生成完成）
    await startStream(page, '500');
    await expect(page.locator('[data-testid="stream-status"]')).toHaveAttribute(
      'data-phase',
      'done',
      { timeout: 15_000 }
    );

    // 导出 Markdown：与预置演示内容逐字符一致（chunk 拼接无损还原）
    await page.click('[data-testid="export-md"]');
    const output = page.locator('[data-testid="export-output"]');
    await expect(output).toBeVisible();
    const exportedMd = await output.inputValue();
    const demoContent = await page.evaluate(
      () => (window as any).__CRISH_DEMO_CONTENT__
    );
    expect(exportedMd).toBe(demoContent);
    // 与引擎聚合取文一致（getContent 先 flush，直刷滞后透明化）
    const viaEngine = await page.evaluate(() =>
      (window as any).__CRISH_ENGINE__.getContent()
    );
    expect(viaEngine).toBe(demoContent);

    // 导出 HTML：标题/表格结构标签出现
    await page.click('[data-testid="export-html"]');
    const exportedHtml = await output.inputValue();
    expect(exportedHtml).toContain('<h1>');
    expect(exportedHtml).toContain('流式渲染演示');
    expect(exportedHtml).toContain('<tr>');
  });

  test('直刷路径：纯文本 chunk DOM 即时更新，store 滞后，收口后一致', async ({
    page,
  }) => {
    await gotoApp(page);
    // 低速字符注入：演示内容第 3 行起为纯文本行（无禁字符）
    // `*#`[$|>_~<\]&` 与行首列表模式 → 走 C3 直刷路径
    await startStream(page, '10');

    // 直刷生效：DOM 末行文本已领先 store（directPendingChars > 0）
    await page.waitForFunction(
      () => {
        const engine = (window as any).__CRISH_ENGINE__;
        const st = engine.getStreamState();
        if (!(st.directPendingChars > 0)) return false;
        const store = (window as any).__CRISH_SESSION_STORE__.getState();
        const lastIdx = store.getLineCount() - 1;
        const lastLine = lastIdx >= 0 ? store.getLine(lastIdx) : '';
        const rows = document.querySelectorAll('.virtual-row');
        if (rows.length === 0) return false;
        const domLast = rows[rows.length - 1].textContent ?? '';
        // DOM 领先 = 直刷即时更新 + store 滞后（最终一致性由收口保证）
        return domLast.length > lastLine.length;
      },
      undefined,
      { timeout: 20_000 }
    );

    // 中断收口：flush 直刷累积 → DOM 与 store 收敛（最终一致性）
    await page.click('[data-testid="stream-stop"]');
    await page.waitForFunction(() => {
      const st = (window as any).__CRISH_ENGINE__.getStreamState();
      return st.directPendingChars === 0 && st.bufferedChars === 0;
    });
    await page.waitForFunction(() => {
      const store = (window as any).__CRISH_SESSION_STORE__.getState();
      const lastIdx = store.getLineCount() - 1;
      const lastLine = lastIdx >= 0 ? store.getLine(lastIdx) : '';
      const rows = document.querySelectorAll('.virtual-row');
      if (rows.length === 0) return false;
      const domLast = rows[rows.length - 1].textContent ?? '';
      return domLast === lastLine;
    });
    // store 文本与引擎取文一致（flush 后直刷文本全部入库）
    const text = await storeText(page);
    const content = await page.evaluate(() =>
      (window as any).__CRISH_ENGINE__.getContent()
    );
    expect(content).toBe(text);
    expect(text.length).toBeGreaterThan(0);
  });

  test('aria-live 三态播报：开始/完成/丢弃（R-8）', async ({ page }) => {
    await gotoApp(page);
    const announce = page.locator('[data-testid="stream-announce"]');
    expect(await announce.getAttribute('role')).toBe('status');
    expect(await announce.getAttribute('aria-live')).toBe('polite');

    // ① 开始
    await page.selectOption('[data-testid="rate-select"]', '50');
    await page.click('[data-testid="stream-start"]');
    await expect(announce).toHaveText('AI 正在生成…');
    await waitForContent(page);

    // ② 完成（中断收口）
    await page.click('[data-testid="stream-stop"]');
    await expect(announce).toHaveText('生成完成');

    // 重新开始 → 播报再次生效（清空再写，同文案可重复播报）
    await page.click('[data-testid="stream-start"]');
    await expect(announce).toHaveText('AI 正在生成…');
    await waitForContent(page);

    // ③ 丢弃
    await page.click('[data-testid="stream-discard"]');
    await expect(announce).toHaveText('已丢弃生成内容');
  });
});
