const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.setContent(`
        <textarea style="width: 300px; height: 300px;"></textarea>
    `);
    
    const textarea = page.locator('textarea');
    await textarea.focus();
    await page.keyboard.type('Line 1');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Line 2');
    
    let selectionStart = await textarea.evaluate(el => el.selectionStart);
    console.log('After type, selectionStart:', selectionStart); // should be 13
    
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(50);
    
    selectionStart = await textarea.evaluate(el => el.selectionStart);
    console.log('After ArrowUp, selectionStart:', selectionStart); // should be 6
    
    await browser.close();
})();
