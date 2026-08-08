const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('[CRISH METRICS]')) {
      console.log('[BROWSER ERROR]', msg.text());
      consoleErrors.push(msg.text());
    }
  });

  page.on('pageerror', err => {
    console.log('[PAGE CRASH/ERROR]', err.message, err.stack);
    consoleErrors.push(err.message + '\n' + err.stack);
  });

  await page.goto('http://localhost:5174/');
  await page.waitForSelector('.editor-container');

  console.log('Page loaded. Simulating scroll to Section 6...');
  
  // Slowly scroll down step by step and check for errors
  for (let scroll = 0; scroll <= 10000; scroll += 200) {
    await page.evaluate((scrollTop) => {
      const el = document.querySelector('.editor-container');
      if (el) el.scrollTop = scrollTop;
    }, scroll);

    await page.waitForTimeout(50);

    // Check if children rendered
    const childCount = await page.evaluate(() => {
      const el = document.querySelector('.editor-container > div');
      return el ? el.children.length : 0;
    });

    if (scroll % 1000 === 0) {
      console.log(`Scroll: ${scroll}px, rendered line count: ${childCount}`);
    }

    if (consoleErrors.length > 0) {
      console.log(`Error occurred at scroll ${scroll}px!`);
      break;
    }
  }

  await page.screenshot({ path: 'tests/screenshot-scroll-bug.png' });
  await browser.close();

  if (consoleErrors.length > 0) {
    console.log('FAILED with errors:', consoleErrors);
  } else {
    console.log('No console errors detected during scroll.');
  }
})();
