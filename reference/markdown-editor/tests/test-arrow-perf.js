const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');
    
    // Generate a long line with 1000 tokens (e.g. bold words)
    const longLine = '**a** '.repeat(1000);
    
    await page.evaluate((text) => {
        const state = window.__CRISH_SESSION_STORE__.getState();
        // Insert a very long line with many tokens, a newline, and then a short line
        state.insertText(text + '\nshort');
        // Move cursor to the short line
        state.setCursorPos(text.length + 3);
    }, longLine);
    
    await page.waitForTimeout(1000);
    
    console.log('Testing ArrowUp performance (into 6000-char line)...');
    
    await page.evaluate(() => {
        document.querySelector('textarea').focus();
    });
    
    const logs = [];
    page.on('console', msg => logs.push(msg.text()));

    const duration = await page.evaluate(async () => {
        const start = performance.now();
        const textarea = document.querySelector('textarea');
        // Override querySelectorAll to count? No, just measure
        const event = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true });
        textarea.dispatchEvent(event);
        return performance.now() - start;
    });
    
    console.log(`ArrowUp execution time: ${duration.toFixed(2)} ms`);
    console.log('Browser Logs:', logs);
    
    await browser.close();
})();
