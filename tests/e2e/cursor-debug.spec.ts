import { test, expect } from '@playwright/test';

// 算法生成各种刁钻的 Markdown 文件
const generateMarkdown = () => {
  const blocks = [
    '# Heading 1',
    '## Heading 2',
    '   ### Heading with leading spaces', // Tricky leading spaces
    'Normal paragraph text here that spans multiple words.',
    '  Indented paragraph by 2 spaces.',
    '> Blockquote line 1\n> Blockquote line 2',
    '- List item 1\n- List item 2',
    '* [ ] Task list item 1\n* [x] Task list item 2',
    '```javascript\nconst a = 1;\n```',
    '```\nNo lang code block\n```',
    '---', // HR
    '***', // HR
    'Line with **bold** and *italic* and ~~strike~~.',
    'Line with `inline code` and $E=mc^2$.',
    'Line with <span style="color:red">HTML</span> tags.',
  ];

  // Shuffle blocks to create a random markdown document
  for (let i = blocks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
  }

  return blocks.join('\n\n');
};

test('Randomized cross-validation of cursor positions', async ({ page }) => {
  await page.goto('http://localhost:5173');

  const editor = page.locator('.editor-container');
  await expect(editor).toBeVisible();

  const markdownContent = generateMarkdown();

  // Inject content and a spy to monitor setCursorPos and getGlobalIndexFromDOMNode
  await page.evaluate((content) => {
    window.cursorLogs = [];
    const store = window.useEditorStore.getState();
    store.setText(content);

    const originalSetCursorPos = store.setCursorPos;

    // Override setCursorPos to record changes
    store.setCursorPos = (pos) => {
      window.cursorLogs.push({ source: 'setCursorPos', pos, time: Date.now() });
      originalSetCursorPos.call(store, pos);
    };

    // Spy on selectionchange
    document.addEventListener('selectionchange', () => {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        window.cursorLogs.push({
          source: 'selectionchange',
          event: 'triggered',
          time: Date.now(),
        });
      }
    });
  }, markdownContent);

  // Wait for rendering
  await page.waitForTimeout(500);

  // Pick N random lines to click on
  const lineCount = await page.locator('.line-block').count();
  const testLines = 10;

  for (let i = 0; i < testLines; i++) {
    const randomLineIndex = Math.floor(Math.random() * lineCount);
    const line = page.locator('.line-block').nth(randomLineIndex);

    const box = await line.boundingBox();
    if (!box) continue;

    // Pick a random X offset within the line
    const randomX = Math.floor(Math.random() * (box.width - 20)) + 10;
    const clickX = box.x + randomX;
    const clickY = box.y + box.height / 2;

    // Clear logs
    await page.evaluate(() => {
      window.cursorLogs = [];
    });

    // Perform native click
    await page.mouse.click(clickX, clickY);

    // Wait for events to settle
    await page.waitForTimeout(100);

    // Get logs
    const logs = await page.evaluate(() => window.cursorLogs);

    // Check how many times setCursorPos was called
    const setCursorLogs = logs.filter((l) => l.source === 'setCursorPos');

    if (setCursorLogs.length > 1) {
      console.log(
        `Line ${randomLineIndex} multiple setCursorPos calls!`,
        setCursorLogs
      );
      // Assert that if there are multiple calls, they MUST resolve to the SAME index.
      // Because if MarkdownEngine and selectionchange both trigger, they must agree.
      const firstPos = setCursorLogs[0].pos;
      const allMatch = setCursorLogs.every((l) => l.pos === firstPos);
      expect(
        allMatch,
        'Cursor positions from different events must match'
      ).toBeTruthy();
    }
  }
});
