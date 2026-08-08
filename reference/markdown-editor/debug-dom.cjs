const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('BROWSER ERROR:', err));
  
  await page.goto('http://localhost:5173');
  
  await page.evaluate(() => {
      const store = (window).__CRISH_SESSION_STORE__.getState();
      store.setText('| Col1 | Col2 |\\n|---|---|\\n| A | B |\\n| C | D |');
      store.setCursorPos(2);
  });
  
  await page.waitForTimeout(3000);
  
  await browser.close();
})();
