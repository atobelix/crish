const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    page.on('console', msg => console.log('PAGE:', msg.text()));

    await page.goto('http://localhost:5173');
    await page.waitForSelector('.editor-container', { timeout: 30000 });
    
    console.log("Testing Arrow Navigation Layout Thrashing...");
    await page.evaluate(() => {
        const store = window.__CRISH_SESSION_STORE__.getState();
        store.setText("hello world ".repeat(200) + "\n" + "hello world ".repeat(200));
        store.setCursorPos(500);
    });

    await page.waitForTimeout(500);

    // Click the container to focus the hidden input
    await page.click('.editor-container');
    await page.waitForTimeout(100);

    const startLayouts = await page.evaluate(() => window.__CRISH_METRICS__.layoutThrashCount);
    
    // Press Up arrow
    await page.keyboard.press('ArrowUp');
    
    const endLayouts = await page.evaluate(() => window.__CRISH_METRICS__.layoutThrashCount);
    console.log(`ArrowUp triggered ${endLayouts - startLayouts} synchronous layouts.`);
    
    await browser.close();
    process.exit(0);
})();
