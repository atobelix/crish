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
  
  // Click at X=500, Y = line 1 (which is line index 1, the second line)
  const line1Y = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('[data-index]'));
    const line = lines.find(l => l.textContent.includes('多空格标题测试'));
    return line.getBoundingClientRect().top + 10;
  });
  
  console.log("Clicking at Y =", line1Y);
  await page.mouse.click(500, line1Y);
  await page.waitForTimeout(200);
  
  const cursorInfo = await page.evaluate(() => {
    const cursorPos = window.__CRISH_SESSION_STORE__.getState().cursorPos;
    const text = window.__CRISH_SESSION_STORE__.getState().getText();
    return { cursorPos, textAround: text.substring(Math.max(0, cursorPos - 5), Math.min(text.length, cursorPos + 5)) };
  });
  
  console.log("Cursor after click:", cursorInfo);
  
  await browser.close();
})();
