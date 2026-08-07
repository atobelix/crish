const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');
    
    // We will find the heading "## 核心交互测试区块 1"
    const headingToken = await page.locator('text=核心交互测试区块 1').first();
    
    // Get its bounding box so we can click on it
    const box = await headingToken.boundingBox();
    console.log('Heading Token Box:', box);
    
    if (box) {
        // Click in the middle of the heading text
        await page.mouse.click(box.x + 20, box.y + box.height / 2);
        await page.waitForTimeout(100);
        
        // Let's get the cursor position from the store
        const cursorPos = await page.evaluate(() => {
            // @ts-ignore
            return window.useEditorStore.getState().cursorPos;
        });
        console.log('Cursor Pos in store:', cursorPos);
        
        // Let's get the cursor Rect that is being rendered
        const cursorRect = await page.evaluate(() => {
            // @ts-ignore
            return window.useEditorStore.getState().cursorRect;
        });
        console.log('Cursor Rect in store:', cursorRect);
        
        // Let's see the DOM element for that cursor position
        const measurement = await page.evaluate((pos) => {
            const container = document.querySelector('.editor-overlay');
            if (!container) return null;
            
            const tokens = Array.from(container.querySelectorAll('[data-token-start]'));
            const matchingToken = tokens.find(el => {
                const start = parseInt(el.getAttribute('data-token-start') || '0', 10);
                const len = parseInt(el.getAttribute('data-token-length') || '0', 10);
                return pos >= start && pos < start + len;
            });
            
            if (matchingToken) {
                return {
                    tagName: matchingToken.tagName,
                    className: matchingToken.className,
                    text: matchingToken.textContent,
                    start: matchingToken.getAttribute('data-token-start'),
                    len: matchingToken.getAttribute('data-token-length'),
                    rect: matchingToken.getBoundingClientRect()
                };
            }
            return null;
        }, cursorPos);
        
        console.log('Measurement for Token:', measurement);
    }

    await browser.close();
})();
