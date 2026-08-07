const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');

    const layout = await page.evaluate(() => {
        const lines = document.querySelectorAll('[data-line-index]');
        const res = [];
        for (let i = 0; i < 4; i++) {
            if (lines[i]) {
                const rect = lines[i].getBoundingClientRect();
                res.push({
                    index: lines[i].getAttribute('data-line-index'),
                    top: rect.top,
                    bottom: rect.bottom,
                    height: rect.height,
                    text: lines[i].textContent
                });
            }
        }
        return res;
    });
    
    console.log(layout);
    await browser.close();
})();
