const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');
    
    // Screenshot
    await page.screenshot({ path: 'test-math-rendering.png' });
    console.log('Screenshot saved to test-math-rendering.png');
    
    await browser.close();
})();
