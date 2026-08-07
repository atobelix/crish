const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // Navigate to the local dev server
  await page.goto('http://localhost:5173/');
  
  // Wait for editor to load
  await page.waitForSelector('.editor-container');
  
  // Set some specific text that replicates the user's issue
  await page.evaluate(() => {
    window.__CRISH_SESSION_STORE__.getState().setText(
      '六级标题 H6\n' +
      '######## 非法七级标题（应被解析为普通文本）\n' +
      '#紧凑无效标题（无空格）\n' +
      '#   多空格标题测试'
    );
  });
  
  // Wait for React to render
  await page.waitForTimeout(500);
  
  // Find the line containing "#紧凑"
  const lineInfo = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('[data-line-start]'));
    const targetLine = lines.find(el => el.textContent.includes('#紧凑'));
    if (!targetLine) return null;
    
    const rect = targetLine.getBoundingClientRect();
    const textNodeSpan = Array.from(targetLine.querySelectorAll('span')).find(s => s.textContent.includes('#紧凑'));
    const spanRect = textNodeSpan ? textNodeSpan.getBoundingClientRect() : null;
    
    return {
      lineStart: parseInt(targetLine.getAttribute('data-line-start'), 10),
      lineLength: parseInt(targetLine.getAttribute('data-line-length'), 10),
      rect: { left: rect.left, top: rect.top, right: rect.right, width: rect.width },
      spanRect: spanRect ? { left: spanRect.left, right: spanRect.right, width: spanRect.width } : null,
      text: targetLine.textContent
    };
  });
  
  console.log("Line Info (#紧凑):", lineInfo);
  
  // Now simulate clicking on the FAR RIGHT of that line
  await page.mouse.click(lineInfo.rect.left + 500, lineInfo.rect.top + 10);
  
  await page.waitForTimeout(200);
  
  // Check where the cursor is
  const cursorInfo = await page.evaluate(() => {
    const cursor = document.querySelector('.cursor-caret');
    if (!cursor) return null;
    const rect = cursor.getBoundingClientRect();
    const pos = window.__CRISH_SESSION_STORE__.getState().cursorPos;
    return {
      pos,
      rect: { left: rect.left, top: rect.top }
    };
  });
  
  console.log("Cursor after clicking far right:", cursorInfo);
  console.log("Difference between Cursor and Text End:", cursorInfo.rect.left - lineInfo.spanRect.right);
  
  
  // Test clicking "多空格标题测试"
  const headingInfo = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('[data-line-start]'));
    const targetLine = lines.find(el => el.textContent.includes('多空格'));
    if (!targetLine) return null;
    
    const rect = targetLine.getBoundingClientRect();
    const textNodeSpan = Array.from(targetLine.querySelectorAll('span')).find(s => s.textContent.includes('多空格'));
    const spanRect = textNodeSpan ? textNodeSpan.getBoundingClientRect() : null;
    
    return {
      rect: { left: rect.left, top: rect.top, right: rect.right, width: rect.width },
      spanRect: spanRect ? { left: spanRect.left, right: spanRect.right, width: spanRect.width } : null
    };
  });
  
  console.log("Line Info (多空格):", headingInfo);
  await page.mouse.click(headingInfo.rect.left + 500, headingInfo.rect.top + 10);
  await page.waitForTimeout(200);
  
  const cursorInfo2 = await page.evaluate(() => {
    const cursor = document.querySelector('.cursor-caret');
    const rect = cursor.getBoundingClientRect();
    const pos = window.__CRISH_SESSION_STORE__.getState().cursorPos;
    return { pos, rect: { left: rect.left, top: rect.top } };
  });
  
  console.log("Cursor after clicking far right on heading:", cursorInfo2);
  console.log("Difference:", cursorInfo2.rect.left - headingInfo.spanRect.right);

  await browser.close();
})();
