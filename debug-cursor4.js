const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');
    
    const allTokens = await page.evaluate(() => {
        const container = document.querySelector('.editor-container');
        if (!container) return [];
        return Array.from(container.querySelectorAll('[data-token-start]')).map(el => ({
            start: parseInt(el.getAttribute('data-token-start') || '0', 10),
            len: parseInt(el.getAttribute('data-token-length') || '0', 10),
            text: el.textContent,
            tagName: el.tagName
        }));
    });
    
    // Log the first 20 tokens
    console.log('First 20 tokens:');
    allTokens.slice(0, 20).forEach(t => {
        console.log(`[${t.start}, ${t.start + t.len}] <${t.tagName}> "${t.text}"`);
    });

    await browser.close();
})();
