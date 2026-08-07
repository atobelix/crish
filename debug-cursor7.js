const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');

    const headingToken = await page.locator('text=核心交互测试区块 1').first();
    const headingBox = await headingToken.boundingBox();
    
    if (headingBox) {
        await page.mouse.click(headingBox.x + 20, headingBox.y + headingBox.height / 2);
        await page.waitForTimeout(200);
        
        const sel = await page.evaluate(() => {
            const selection = window.getSelection();
            return {
                isCollapsed: selection.isCollapsed,
                text: selection.toString(),
                len: selection.toString().length
            };
        });
        console.log('Selection:', sel);
        
        const cursor = await page.evaluate(() => {
            const c = document.querySelector('.cursor-caret');
            return c ? { top: c.style.top, left: c.style.left, height: c.style.height } : null;
        });
        console.log('Cursor:', cursor);
    }

    await browser.close();
})();
