import { test, expect } from '@playwright/test';

test.describe('Matrix: Navigation & Edge Boundaries', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173');
    await page.waitForSelector('.editor-container');
    await page.locator('.editor-container').click();
  });

  test('M-NAV-01: Absolute boundaries clamp correctly', async ({ page }) => {
    // Jump to the very beginning
    await page.keyboard.press('Control+Home');
    
    let cursorPos = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().cursorPos);
    expect(cursorPos).toBe(0);

    // Try to force beyond beginning
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    cursorPos = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().cursorPos);
    expect(cursorPos).toBe(0); // Should remain 0

    // Jump to the very end
    await page.keyboard.press('Control+End');
    const textLen = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().textLength);
    cursorPos = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().cursorPos);
    expect(cursorPos).toBe(textLen);

    // Try to force beyond end
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    cursorPos = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().cursorPos);
    expect(cursorPos).toBe(textLen); // Should remain max
  });

  test('M-NAV-02: Fast directional navigation across void elements', async ({ page }) => {
    // Navigate to a section with an HR (assuming '---' exists in the document)
    // We will search for the first HR element's token start offset
    const hrOffset = await page.evaluate(() => {
        const hr = document.querySelector('hr.hr-rendered');
        return hr ? parseInt(hr.getAttribute('data-token-start') || '-1', 10) : -1;
    });

    expect(hrOffset).toBeGreaterThan(-1);

    // Set cursor exactly before the HR line
    await page.evaluate((offset) => {
        window.__CRISH_SESSION_STORE__.getState().setCursorPos(offset - 1);
    }, hrOffset);

    // Move right into the HR line
    await page.keyboard.press('ArrowRight');
    let cursorPos = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().cursorPos);
    expect(cursorPos).toBe(hrOffset);

    // Move down from the HR line
    await page.keyboard.press('ArrowDown');
    cursorPos = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().cursorPos);
    
    // The line below HR in our document is '***'. It should successfully navigate there.
    expect(cursorPos).toBeGreaterThan(hrOffset);
  });

  test('M-NAV-03: PageUp and PageDown virtualization boundaries', async ({ page }) => {
    // Page down multiple times to force virtualized scrolling
    for(let i=0; i<10; i++) {
        await page.keyboard.press('PageDown');
    }
    
    const cursorPos = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().cursorPos);
    expect(cursorPos).toBeGreaterThan(1000); // Should have scrolled significantly
    
    // Page up should reduce cursor pos
    await page.keyboard.press('PageUp');
    const newPos = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().cursorPos);
    expect(newPos).toBeLessThan(cursorPos);
  });
});
