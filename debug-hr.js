const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');

    const hrToken = await page.locator('text=---').first();
    const hrBox = await hrToken.boundingBox();
    
    if (hrBox) {
        // Click just below HR
        await page.mouse.click(hrBox.x + 20, hrBox.y + 20);
        await page.waitForTimeout(200);
        
        const hrClass = await page.evaluate(() => {
            const hrLine = document.querySelector('.line-hr').closest('[data-line-start]');
            return hrLine.className;
        });
        console.log('HR Line Class:', hrClass);
        
        const hrSourceStyle = await page.evaluate(() => {
            const source = document.querySelector('.line-hr .hr-source');
            return window.getComputedStyle(source).display;
        });
        console.log('HR Source Display:', hrSourceStyle);
        
        const hrRenderedStyle = await page.evaluate(() => {
            const rendered = document.querySelector('.line-hr .hr-rendered');
            return window.getComputedStyle(rendered).display;
        });
        console.log('HR Rendered Display:', hrRenderedStyle);
    }

    await browser.close();
})();
