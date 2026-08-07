const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');
    
    const allTokens = await page.evaluate(() => {
        const container = document.querySelector('.editor-overlay');
        if (!container) return [];
        return Array.from(container.querySelectorAll('[data-token-start]')).map(el => ({
            start: parseInt(el.getAttribute('data-token-start') || '0', 10),
            len: parseInt(el.getAttribute('data-token-length') || '0', 10),
            text: el.textContent
        }));
    });
    
    console.log('Tokens related to heading:');
    allTokens.filter(t => t.text.includes('核心')).forEach(t => {
        console.log(`[${t.start}, ${t.start + t.len}] "${t.text}"`);
    });

    console.log('\nTokens related to hr:');
    allTokens.filter(t => t.text.includes('---')).forEach(t => {
        console.log(`[${t.start}, ${t.start + t.len}] "${t.text}"`);
    });

    await browser.close();
})();
