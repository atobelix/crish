const { chromium } = require('playwright');
const assert = require('assert');
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');
    
    // Clear and type list
    await page.evaluate(() => {
        const store = window.__CRISH_SESSION_STORE__; // assuming available, or we just type
    });
    
    // Select all and delete
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    
    // Type unordered list
    await page.keyboard.type('- item');
    
    // Wait for render
    await page.waitForTimeout(500);
    
    // Screenshot before click
    await page.screenshot({ path: 'test-list-before.png' });
    
    // Click on 'item' (index 4)
    // We can simulate ArrowLeft to move cursor into the text
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    
    await page.waitForTimeout(500);
    
    // Screenshot after click (line active)
    await page.screenshot({ path: 'test-list-after.png' });
    
    // Get text content of the list bullet
    const textContent = await page.evaluate(() => {
        const bullet = document.querySelector('.token-list-bullet');
        return bullet ? bullet.innerText : null;
    });
    
    console.log('Bullet inner text:', textContent);
    
    await browser.close();
})();
