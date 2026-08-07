const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
    console.log("Starting M2 AST Caching & Store Update Performance Test...");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', error => console.log('PAGE ERROR:', error.message));

    // Start Vite dev server if not already running
    await page.goto('http://localhost:5173');
    
    console.log("Waiting for app to load 10,000 lines...");
    // Wait until the editor container is present
    await page.waitForSelector('.editor-container');
    
    // Let's inject a script to measure how long a single character insertion takes
    const result = await page.evaluate(async () => {
        const store = window.__CRISH_SESSION_STORE__; // If we exposed the store
        if (!store) {
            // Find store from DOM if not exposed
            return { error: "Store not globally exposed." };
        }
        
        // Ensure cursor is at the very top (line 0)
        store.getState().setCursorPos(0);
        
        // Measure insertion time
        const start = performance.now();
        
        // Insert a character at the beginning of the 10,000 line document
        store.getState().insertText('A');
        
        const end = performance.now();
        
        // Also measure how long it takes for React to render the change
        // We'll wait for next animation frame
        return new Promise(resolve => {
            requestAnimationFrame(() => {
                const renderEnd = performance.now();
                resolve({
                    zustandUpdateTime: end - start,
                    totalRenderTime: renderEnd - start
                });
            });
        });
    });
    
    console.log(result);
    await browser.close();
})();
