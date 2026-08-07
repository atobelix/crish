const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');
    
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('  - item');
    
    await page.waitForTimeout(500);
    
    const info = await page.evaluate(() => {
        const line = document.querySelector('.line-body');
        const bullet = document.querySelector('.token-list-bullet');
        const content = bullet ? bullet.querySelector('.syntax-content') : null;
        
        return {
            paddingLeft: line ? window.getComputedStyle(line).paddingLeft : null,
            contentHtml: content ? content.innerHTML : null,
            contentInnerText: content ? content.innerText : null
        };
    });
    
    console.log('Nested list state:', info);
    
    await browser.close();
})();
