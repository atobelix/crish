const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');
    
    // Focus the hidden input directly
    await page.evaluate(() => {
        document.querySelector('textarea').focus();
    });
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('  - item');
    
    await page.waitForTimeout(500);
    
    const info = await page.evaluate(() => {
        const line = document.querySelector('.line-body');
        const bullet = document.querySelector('.token-list-bullet');
        const content = bullet ? bullet.querySelector('.syntax-content') : null;
        
        return {
            inlineStyle: line ? line.style.paddingLeft : null,
            computed: line ? window.getComputedStyle(line).paddingLeft : null,
            html: line ? line.outerHTML : null,
            contentHtml: content ? content.outerHTML : null
        };
    });
    
    console.log('Padding:', info);
    
    await browser.close();
})();
