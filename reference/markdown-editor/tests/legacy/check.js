const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    // Listen for console errors
    page.on('console', msg => {
        if (msg.type() === 'error') console.log(`Console Error: "${msg.text()}"`);
    });
    page.on('pageerror', error => {
        console.log(`Page Error: ${error.message}`);
    });
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');
    console.log('Found editor');
    
    await page.evaluate(() => {
        // @ts-ignore
        window.useEditorStore.getState().setText('');
        // @ts-ignore
        window.useEditorStore.getState().setCursorPos(0);
    });
    
    await page.waitForTimeout(500);
    
    const editor = await page.$('.editor-container');
    console.log('Editor exists?', !!editor);
    if (editor) {
        const bounds = await editor.boundingBox();
        console.log('Bounds:', bounds);
    }
    
    await browser.close();
})();
