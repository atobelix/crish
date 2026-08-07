const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');
    
    // Set cursorPos to 86 to make it active
    await page.evaluate(() => window.useEditorStore.getState().setCursorPos(86));
    await page.waitForTimeout(100);
    
    const debugInfo = await page.evaluate(() => {
        const span = document.querySelector('.hr-source');
        if (!span) return 'No span';
        
        const node = span.firstChild;
        if (!node) return 'No node';
        
        const range = document.createRange();
        range.setStart(node, 3);
        range.setEnd(node, 3);
        const rect = range.getBoundingClientRect();
        const spanRect = span.getBoundingClientRect();
        
        const style = window.getComputedStyle(span);
        
        return {
            rangeRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
            spanRect: { top: spanRect.top, left: spanRect.left, width: spanRect.width, height: spanRect.height },
            spanDisplay: style.display
        };
    });
    
    console.log(debugInfo);
    await browser.close();
})();
