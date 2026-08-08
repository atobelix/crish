const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('BROWSER:', msg.text()));

  try {
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 10000 });

    console.log('\n--- Clicking the editor ---');
    await page.locator('.editor-container').click();
    
    // Inject a subscriber to Zustand store to monitor state changes
    await page.evaluate(() => {
      window.stateHistory = [];
      window.__CRISH_SESSION_STORE__.subscribe((state, prevState) => {
        window.stateHistory.push({
          cursorPos: state.cursorPos,
          selectionStart: state.selectionStart,
          selectionEnd: state.selectionEnd,
          textLength: state.textLength,
          linesChanged: state.lines !== prevState.lines,
          firstLine: state.lines[0].substring(0, 50),
        });
      });
    });

    console.log('\n--- Typing "Hello" ---');
    await page.keyboard.type('Hello', { delay: 50 });

    const history = await page.evaluate(() => window.stateHistory);
    console.log('\n--- State History ---');
    console.table(history);

    const activeTag = await page.evaluate(() => document.activeElement ? document.activeElement.tagName : 'NONE');
    console.log('\nActive Element:', activeTag);

  } catch (e) {
    console.error('Failed:', e);
  }

  await browser.close();
})();
