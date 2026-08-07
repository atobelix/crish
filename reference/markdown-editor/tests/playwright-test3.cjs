const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/');
  await page.waitForSelector('.editor-container');
  await page.evaluate(() => {
    window.__CRISH_SESSION_STORE__.getState().setText('#紧凑无效标题（无空格）\n#   多空格标题测试\n普通文本');
  });
  await page.waitForTimeout(500);
  
  const beforeInfo = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('[data-index]'));
    const line = lines.find(l => l.textContent.includes('多空格标题测试'));
    const span = Array.from(line.querySelectorAll('span')).find(s => s.textContent.includes('多空格'));
    return {
       textRight: span.getBoundingClientRect().right,
       lineY: line.getBoundingClientRect().top + 10
    };
  });
  
  await page.mouse.click(500, beforeInfo.lineY); // Click on the correct line
  await page.waitForTimeout(200);
  
  const afterInfo = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('[data-index]'));
    const line = lines.find(l => l.textContent.includes('多空格标题测试'));
    const span = Array.from(line.querySelectorAll('span')).find(s => s.textContent.includes('多空格'));
    const cursor = document.querySelector('.cursor-caret');
    return {
      textRight: span.getBoundingClientRect().right,
      cursorLeft: cursor ? cursor.getBoundingClientRect().left : null,
      isActive: span.closest('.is-active-token') !== null || line.querySelector('.is-active-token') !== null
    };
  });
  
  console.log("Before text right:", beforeInfo.textRight);
  console.log("After:", afterInfo);
  console.log("Diff:", afterInfo.cursorLeft - afterInfo.textRight);
  
  await browser.close();
})();
