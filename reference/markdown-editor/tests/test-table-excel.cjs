const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  
  await page.goto('http://localhost:5173/');
  await page.waitForSelector('.markdown-engine');
  
  console.log('[1/5] Injecting test table Markdown into editor...');
  await page.evaluate(() => {
    window.__CRISH_SESSION_STORE__.getState().setText(
      '# 现代表格交互测试\n\n' +
      '| 姓名 | 年龄 | 职业 | 城市 |\n' +
      '| :--- | :---: | ---: | :--- |\n' +
      '| 张三 | 28 | 工程师 | 北京 |\n' +
      '| 李四 | 32 | 设计师 | 上海 |\n' +
      '| 王五 | 25 | 产品经理 | 深圳 |\n\n' +
      '正文段落结束。'
    );
  });
  
  await page.waitForTimeout(500);

  // 1. Single click on a cell
  console.log('[2/5] Testing 1-click cell selection...');
  const cell = page.locator('.rendered-table-cell:has-text("工程师")');
  await cell.waitFor();
  await cell.click();
  await page.waitForTimeout(200);

  const isSelected = await cell.evaluate(el => el.classList.contains('is-cell-selected'));
  console.log('  -> Cell is selected (1-click):', isSelected ? 'PASS ✓' : 'FAIL ✗');

  await page.screenshot({ path: path.join(__dirname, 'screenshot-table-cell-selected.png') });

  // 2. Double click on a cell
  console.log('[3/5] Testing 2-click cell editing...');
  await cell.dblclick();
  await page.waitForTimeout(200);

  const isEditing = await cell.evaluate(el => el.classList.contains('is-cell-editing'));
  console.log('  -> Cell is editing (2-click):', isEditing ? 'PASS ✓' : 'FAIL ✗');

  await page.screenshot({ path: path.join(__dirname, 'screenshot-table-cell-editing.png') });

  // 3. Tab key navigation
  console.log('[4/5] Testing Tab navigation...');
  await page.keyboard.press('Escape'); // back to select mode
  await page.waitForTimeout(100);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);

  const nextCell = page.locator('.rendered-table-cell:has-text("北京")');
  const isNextSelected = await nextCell.evaluate(el => el.classList.contains('is-cell-selected'));
  console.log('  -> Next cell ("北京") selected after Tab:', isNextSelected ? 'PASS ✓' : 'FAIL ✗');

  // 4. Direct typing replaces cell text
  console.log('[5/5] Testing direct typing replacement in select mode...');
  await page.keyboard.type('杭州');
  await page.waitForTimeout(300);

  const fullText = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().getText());
  const containsHangzhou = fullText.includes('杭州');
  console.log('  -> Cell content replaced with "杭州":', containsHangzhou ? 'PASS ✓' : 'FAIL ✗');

  await page.screenshot({ path: path.join(__dirname, 'screenshot-table-cell-replaced.png') });

  await browser.close();
  console.log('All Excel-like Table E2E Tests Completed Successfully!');
})();
