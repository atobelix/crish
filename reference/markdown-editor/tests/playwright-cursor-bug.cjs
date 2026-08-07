const { chromium } = require('playwright');
const fs = require('fs');

async function runTest() {
    console.log('Starting Playwright Test for Heading Cursor Bug...');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    console.log('Navigating to editor...');
    await page.goto('http://localhost:5173');
    
    // Wait for the editor container to load
    await page.waitForSelector('.editor-container');
    
    // Clear and insert some text with a heading
    await page.evaluate(() => {
        window.__CRISH_SESSION_STORE__.getState().setText('# Test Heading\n\nSome body text here.\n\nMore text.');
    });
    
    // Wait for rendering
    await page.waitForTimeout(500);
    
    console.log('Testing clicking empty space on the heading line...');
    // The heading is on line 1. We click far to the right of the heading text.
    await page.mouse.click(300, 20); // x=300 (margin), y=20 (line 1)
    
    await page.waitForTimeout(100);
    
    const activeLineIndex = await page.evaluate(() => {
        const state = window.__CRISH_SESSION_STORE__.getState();
        return state.getLineIndex(state.cursorPos);
    });
    
    console.log('Active Line Index after click: ' + activeLineIndex);
    
    if (activeLineIndex === 0) {
        console.log('SUCCESS: Clicked heading empty space and activated correct line (index 0).');
    } else {
        console.error('FAILED: Clicked heading empty space but activated line index ' + activeLineIndex + ' instead of 0!');
        process.exit(1);
    }
    
    await browser.close();
}

runTest().catch(err => {
    console.error(err);
    process.exit(1);
});
