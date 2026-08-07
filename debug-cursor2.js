const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');
    
    // We will find the heading "## 核心交互测试区块 1"
    const headingToken = await page.locator('text=核心交互测试区块 1').first();
    const box = await headingToken.boundingBox();
    console.log('Heading Token Box:', box);
    
    if (box) {
        await page.mouse.click(box.x + 20, box.y + box.height / 2);
        await page.waitForTimeout(100);
        
        const state = await page.evaluate(() => {
            const st = window.useEditorStore.getState();
            return {
                cursorPos: st.cursorPos,
                textLen: st.text.length,
                textAroundCursor: st.text.substring(Math.max(0, st.cursorPos - 10), st.cursorPos + 10)
            };
        });
        console.log('State:', state);
        
        const allTokens = await page.evaluate(() => {
            const container = document.querySelector('.editor-overlay');
            if (!container) return [];
            return Array.from(container.querySelectorAll('[data-token-start]')).map(el => ({
                start: parseInt(el.getAttribute('data-token-start') || '0', 10),
                len: parseInt(el.getAttribute('data-token-length') || '0', 10),
                text: el.textContent
            }));
        });
        
        console.log('Tokens around cursorPos:');
        allTokens.filter(t => t.start >= state.cursorPos - 20 && t.start <= state.cursorPos + 20).forEach(t => {
            console.log(`[${t.start}, ${t.start + t.len}] "${t.text}"`);
        });
    }

    await browser.close();
})();
