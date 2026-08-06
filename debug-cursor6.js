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
        const cursor = await page.evaluate(() => {
            const c = document.querySelector('.cursor-caret');
            return c ? { top: c.style.top, height: c.style.height } : null;
        });
        console.log('Cursor after HR click:', cursor);
    }

    // Click on Heading
    const headingToken = await page.locator('text=核心交互测试区块 1').first();
    const headingBox = await headingToken.boundingBox();
    console.log('\nHeading Token Box:', headingBox);
    
    if (headingBox) {
        await page.mouse.click(headingBox.x + 20, headingBox.y + headingBox.height / 2);
        await page.waitForTimeout(200);
        
        const cursor = await page.evaluate(() => {
            const c = document.querySelector('.editor-cursor');
            return c ? { top: c.style.top, left: c.style.left, height: c.style.height } : null;
        });
        console.log('Cursor after Heading click:', cursor);
        
        const cursorPos = await page.evaluate(() => window.useEditorStore.getState().cursorPos);
        console.log('cursorPos:', cursorPos);
        
        // Find the matching token for that cursorPos manually
        const coords = await page.evaluate((pos) => {
            const container = document.querySelector('.editor-container');
            const tokenElements = container.querySelectorAll('[data-token-start]');
            let targetElement = null;
            for (let i = 0; i < tokenElements.length; i++) {
                const el = tokenElements[i];
                const start = parseInt(el.getAttribute('data-token-start') || '0', 10);
                const length = parseInt(el.getAttribute('data-token-length') || '0', 10);
                // Important: for End of Token, we do <=
                if (pos >= start && pos <= start + length) {
                    targetElement = el;
                    // break on first match for exact pos inside, but if pos == start+length we might prefer next token
                    if (pos < start + length) break;
                }
            }
            if (targetElement) {
                const rect = targetElement.getBoundingClientRect();
                return {
                    tagName: targetElement.tagName,
                    className: targetElement.className,
                    text: targetElement.textContent,
                    start: targetElement.getAttribute('data-token-start'),
                    len: targetElement.getAttribute('data-token-length'),
                    rect: { top: rect.top, left: rect.left, height: rect.height }
                };
            }
            return null;
        }, cursorPos);
        
        console.log('Token matching cursorPos:', coords);
    }

    await browser.close();
})();
