import { test, expect } from '@playwright/test';

test.describe('Matrix: IME & Selection Mutations', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173');
    await page.waitForSelector('.editor-container');
    await page.locator('.editor-container').click();
  });

  test('M-SEL-01: Shift+Arrow selection over multiple text elements', async ({ page }) => {
    // Navigate slightly down
    for(let i=0; i<10; i++) {
        await page.keyboard.press('ArrowDown');
    }

    const startPos = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().cursorPos);

    // Hold shift and press Right 20 times to select across the text
    await page.keyboard.down('Shift');
    for(let i=0; i<20; i++) {
        await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.up('Shift');

    // Verify selection is set
    const state = await page.evaluate(() => {
        const s = window.__CRISH_SESSION_STORE__.getState();
        return { start: s.selectionStart, end: s.selectionEnd, cursor: s.cursorPos };
    });

    expect(state.start).not.toBe(state.end);
    expect(state.start).toBe(startPos);
    expect(state.cursor).toBe(state.end); // Cursor should be at the moving edge

    // Press delete to mutate
    await page.keyboard.press('Backspace');

    const textLenAfter = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().textLength);
    const finalState = await page.evaluate(() => {
        const s = window.__CRISH_SESSION_STORE__.getState();
        return { start: s.selectionStart, end: s.selectionEnd, cursor: s.cursorPos };
    });

    expect(finalState.start).toBe(finalState.end);
    expect(finalState.cursor).toBe(startPos);
  });

  test('M-IME-01: IME Composition with active selection replacement', async ({ page }) => {
    // Select 5 characters
    await page.keyboard.press('Control+Home');
    await page.keyboard.down('Shift');
    for(let i=0; i<5; i++) {
        await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.up('Shift');

    const state = await page.evaluate(() => {
        const s = window.__CRISH_SESSION_STORE__.getState();
        return { start: s.selectionStart, end: s.selectionEnd };
    });
    expect(state.end - state.start).toBe(5);

    // Get textarea and force a composition event sequence that should replace the selection
    const textarea = page.locator('textarea');
    
    // Simulate user starting IME composition
    await textarea.evaluate((el: HTMLTextAreaElement) => {
        el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
        el.value = 'nihao';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Check store state during composition (should NOT have inserted 'nihao' into the store yet)
    let isComposing = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().isComposing);
    expect(isComposing).toBe(true);

    // Simulate IME finish
    await textarea.evaluate((el: HTMLTextAreaElement) => {
        el.dispatchEvent(new CompositionEvent('compositionend', { data: '你好', bubbles: true }));
        el.value = '你好';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    isComposing = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().isComposing);
    expect(isComposing).toBe(false);

    // Verify selection is gone and cursor moved by 2 characters ('你好')
    const finalState = await page.evaluate(() => {
        const s = window.__CRISH_SESSION_STORE__.getState();
        return { start: s.selectionStart, end: s.selectionEnd, cursor: s.cursorPos };
    });

    expect(finalState.start).toBe(finalState.end);
    expect(finalState.cursor).toBe(state.start + 2); // '你好' is 2 length
  });
});
