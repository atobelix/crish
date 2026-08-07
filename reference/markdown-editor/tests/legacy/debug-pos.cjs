const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');
    
    const res = await page.evaluate(() => {
        const store = window.useEditorStore.getState();
        // Force set cursorPos to 87
        store.setCursorPos(87);
        return store.cursorPos;
    });
    
    await page.waitForTimeout(100);
    
    const cursor = await page.evaluate(() => {
        const c = document.querySelector('.cursor-caret');
        return c ? { top: c.style.top, left: c.style.left, height: c.style.height } : null;
    });
    
    console.log('Cursor for pos 87:', cursor);

    // Also get for 86
    await page.evaluate(() => window.useEditorStore.getState().setCursorPos(86));
    await page.waitForTimeout(100);
    const cursor86 = await page.evaluate(() => {
        const c = document.querySelector('.cursor-caret');
        return c ? { top: c.style.top, left: c.style.left, height: c.style.height } : null;
    });
    console.log('Cursor for pos 86:', cursor86);

    await browser.close();
})();
