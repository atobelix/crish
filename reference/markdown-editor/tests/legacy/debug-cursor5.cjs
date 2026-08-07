const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');
    
    // Click on HR
    const hrToken = await page.locator('text=---').first();
    const hrBox = await hrToken.boundingBox();
    console.log('HR Token Box:', hrBox);
    
    if (hrBox) {
        await page.mouse.click(hrBox.x + 10, hrBox.y + hrBox.height / 2);
        await page.waitForTimeout(200);
        const hrRect = await page.evaluate(() => window.useEditorStore.getState().cursorRect);
        console.log('Cursor Rect after HR click:', hrRect);
    }

    // Click on Heading
    const headingToken = await page.locator('text=核心交互测试区块 1').first();
    const headingBox = await headingToken.boundingBox();
    console.log('\nHeading Token Box:', headingBox);
    
    if (headingBox) {
        await page.mouse.click(headingBox.x + 20, headingBox.y + headingBox.height / 2);
        await page.waitForTimeout(200);
        const headingRect = await page.evaluate(() => window.useEditorStore.getState().cursorRect);
        console.log('Cursor Rect after Heading click:', headingRect);
        
        // Let's also check what `getCoordinatesFromIndex` returns directly!
        const cursorPos = await page.evaluate(() => window.useEditorStore.getState().cursorPos);
        const coords = await page.evaluate((pos) => {
            // Re-implement the search to see what element it finds
            const container = document.querySelector('.editor-overlay');
            const tokenElements = container.querySelectorAll('[data-token-start]');
            let targetElement = null;
            for (let i = 0; i < tokenElements.length; i++) {
                const el = tokenElements[i];
                const start = parseInt(el.getAttribute('data-token-start') || '0', 10);
                const length = parseInt(el.getAttribute('data-token-length') || '0', 10);
                if (pos >= start && pos < start + length) {
                    targetElement = el;
                    break;
                }
            }
            if (targetElement) {
                return {
                    tagName: targetElement.tagName,
                    className: targetElement.className,
                    text: targetElement.textContent,
                    rect: targetElement.getBoundingClientRect()
                };
            }
            return null;
        }, cursorPos);
        console.log('Target element found by getCoordinatesFromIndex logic:', coords);
    }

    await browser.close();
})();
