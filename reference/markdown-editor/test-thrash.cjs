const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    page.on('console', msg => console.log('PAGE:', msg.text()));

    await page.goto('http://localhost:5173');
    await page.waitForSelector('.editor-container', { timeout: 30000 });
    
    console.log("Testing Thrash Tracker...");
    await page.evaluate(() => {
        document.body.getBoundingClientRect();
        document.body.getBoundingClientRect();
    });

    const layouts = await page.evaluate(() => window.__CRISH_METRICS__.layoutThrashCount);
    console.log(`Manual calls triggered ${layouts} synchronous layouts.`);
    
    await browser.close();
    process.exit(0);
})();
