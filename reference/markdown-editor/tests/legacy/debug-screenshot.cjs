const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');

    // 1. Click directly on the heading text
    const headingToken = await page.locator('text=核心交互测试区块 1').first();
    const headingBox = await headingToken.boundingBox();
    
    if (headingBox) {
        await page.mouse.click(headingBox.x + 20, headingBox.y + 10);
        await page.waitForTimeout(200);
        await page.screenshot({ path: 'C:\\Software\\conex\\screenshot-click-heading.png' });
        
        const pos1 = await page.evaluate(() => window.useEditorStore.getState().cursorPos);
        console.log('Pos after clicking heading text:', pos1);
    }

    // 2. Click in the margin ABOVE the heading text (but below the HR)
    if (headingBox) {
        // The HR is above. Let's click 20px above the heading text.
        await page.mouse.click(headingBox.x + 20, headingBox.y - 20);
        await page.waitForTimeout(200);
        await page.screenshot({ path: 'C:\\Software\\conex\\screenshot-click-margin.png' });
        
        const pos2 = await page.evaluate(() => window.useEditorStore.getState().cursorPos);
        console.log('Pos after clicking margin above heading:', pos2);
    }

    await browser.close();
})();
