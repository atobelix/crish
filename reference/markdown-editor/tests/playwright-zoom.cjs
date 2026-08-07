const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  await page.goto('http://localhost:5173/');
  await page.waitForSelector('.editor-container');
  await page.evaluate(() => {
    window.__CRISH_SESSION_STORE__.getState().setText('#紧凑无效标题（无空格）');
  });
  await page.waitForTimeout(500);
  
  // Test BEFORE zoom
  let lineInfo = await page.evaluate(() => {
    const targetLine = Array.from(document.querySelectorAll('[data-line-start]')).find(el => el.textContent.includes('#紧凑'));
    const textNodeSpan = Array.from(targetLine.querySelectorAll('span')).find(s => s.textContent.includes('#紧凑'));
    return textNodeSpan.getBoundingClientRect().right;
  });
  
  await page.mouse.click(500, 50); // Click far right
  await page.waitForTimeout(200);
  
  let cursorInfo = await page.evaluate(() => document.querySelector('.cursor-caret').getBoundingClientRect().left);
  console.log("Before zoom - Text End:", lineInfo, "Cursor:", cursorInfo, "Diff:", cursorInfo - lineInfo);
  
  // ZOOM IN to 200% using CDP
  const session = await context.newCDPSession(page);
  await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2.0 });
  await page.waitForTimeout(500);
  
  // Test AFTER zoom
  lineInfo = await page.evaluate(() => {
    const targetLine = Array.from(document.querySelectorAll('[data-line-start]')).find(el => el.textContent.includes('#紧凑'));
    const textNodeSpan = Array.from(targetLine.querySelectorAll('span')).find(s => s.textContent.includes('#紧凑'));
    return textNodeSpan.getBoundingClientRect().right;
  });
  
  await page.mouse.click(500, 50); // Click far right again
  await page.waitForTimeout(200);
  
  cursorInfo = await page.evaluate(() => document.querySelector('.cursor-caret').getBoundingClientRect().left);
  console.log("After 2x zoom - Text End:", lineInfo, "Cursor:", cursorInfo, "Diff:", cursorInfo - lineInfo);

  // Zoom to 300%
  await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 3.0 });
  await page.waitForTimeout(500);
  
  lineInfo = await page.evaluate(() => {
    const targetLine = Array.from(document.querySelectorAll('[data-line-start]')).find(el => el.textContent.includes('#紧凑'));
    const textNodeSpan = Array.from(targetLine.querySelectorAll('span')).find(s => s.textContent.includes('#紧凑'));
    return textNodeSpan.getBoundingClientRect().right;
  });
  
  await page.mouse.click(500, 50); // Click far right again
  await page.waitForTimeout(200);
  
  cursorInfo = await page.evaluate(() => document.querySelector('.cursor-caret').getBoundingClientRect().left);
  console.log("After 3x zoom - Text End:", lineInfo, "Cursor:", cursorInfo, "Diff:", cursorInfo - lineInfo);
  
  await browser.close();
})();
