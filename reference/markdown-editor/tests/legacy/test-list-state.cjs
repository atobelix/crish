const { chromium } = require('playwright');
const assert = require('assert');
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');
    
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('- item');
    
    await page.waitForTimeout(500);
    
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    
    await page.waitForTimeout(500);
    
    const info = await page.evaluate(() => {
        const line = document.querySelector('.line-container');
        const bullet = document.querySelector('.token-list-bullet');
        const hidden = bullet ? bullet.querySelector('.syntax-hidden') : null;
        const content = bullet ? bullet.querySelector('.syntax-content') : null;
        
        return {
            hasActiveLine: line ? line.classList.contains('is-active-line') : false,
            bulletText: bullet ? bullet.innerText : null,
            hiddenDisplay: hidden ? window.getComputedStyle(hidden).display : null,
            contentDisplay: content ? window.getComputedStyle(content).display : null,
            rawTextContent: bullet ? bullet.textContent : null
        };
    });
    
    console.log('UI state:', info);
    
    await browser.close();
})();
