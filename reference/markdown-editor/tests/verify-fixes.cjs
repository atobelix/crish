const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  console.log('Navigating to http://localhost:5173/ ...');
  await page.goto('http://localhost:5173/');
  await page.waitForSelector('.editor-container');
  await page.waitForTimeout(1000);

  const outDir = path.join(__dirname, 'verify-output');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // 1. Check Code Block & Blockquote
  console.log('Testing Code Block and Blockquote rendering...');
  await page.evaluate(() => {
    window.__CRISH_SESSION_STORE__.getState().setText(
      '# 测试代码块断档与引用块连续性\n\n' +
      '```typescript\n' +
      '// Line 1: 函数声明\n' +
      'function testBreak() {\n' +
      '\n' +
      '  const a = 1;\n' +
      '  const b = 2;\n' +
      '  return a + b;\n' +
      '}\n' +
      '```\n\n' +
      '> 这是一段超长的引用文本，测试自动换行时左侧竖线是否能够自顶到底保持连续不中断。即便是单行非常长并发生多行折行的情况下，整体左侧引导竖线也应该始终完整连贯，绝不发生断档或者文字与竖线错位的情况。灾难性雪崩。\n\n' +
      '正文结束。'
    );
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, '01-code-and-blockquote.png') });

  // 2. Check Table Selection
  console.log('Testing Table multi-cell selection...');
  await page.evaluate(() => {
    window.__CRISH_SESSION_STORE__.getState().setText(
      '# 表格选区样式测试\n\n' +
      '| 模块 | 指标 | 状态 | 耗时 |\n' +
      '| :--- | :---: | :---: | ---: |\n' +
      '| 核心引擎 | 99.9% | 正常 | 12ms |\n' +
      '| 渲染流水线 | 100% | 正常 | 8ms |\n' +
      '| 虚拟滚动 | 60fps | 优秀 | 16ms |\n' +
      '| 大纲索引 | O(logN)| 正常 | 1ms |\n\n' +
      '表格后正文。'
    );
  });
  await page.waitForTimeout(600);
  // Click a cell
  const cell = page.locator('.token-table-cell').filter({ hasText: /99\.9%/ });
  await cell.waitFor();
  await cell.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, '02-table-cell-selected.png') });

  // 3. Check Headings with 0-3 leading spaces
  console.log('Testing TC-HEAD-03 leading space headings...');
  await page.evaluate(() => {
    window.__CRISH_SESSION_STORE__.getState().setText(
      '# TC-HEAD-03 前导空格标题测试\n\n' +
      '# 零前导空格标题\n' +
      ' # 1个前导空格标题\n' +
      '  # 2个前导空格标题\n' +
      '   # 3个前导空格标题\n' +
      '    # 4个前导空格（规范应解析为缩进代码块）\n\n' +
      '正文说明结束。'
    );
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, '03-tc-head-03.png') });

  // 4. Check Complex Nested Lists
  console.log('Testing Complex Nested Lists with tree branch guides...');
  await page.evaluate(() => {
    window.__CRISH_SESSION_STORE__.getState().setText(
      '# 4. 复杂嵌套列表树状引导线测试\n\n' +
      '- 项目一级 A\n' +
      '  - 项目二级 A-1\n' +
      '    - 项目三级 A-1-a（带横向分支引导）\n' +
      '    - 项目三级 A-1-b\n' +
      '  - 项目二级 A-2\n' +
      '    - [x] 完成的任务项三级\n' +
      '    - [ ] 待办的任务项三级\n' +
      '- 项目一级 B\n' +
      '  1. 有序二级 B-1\n' +
      '  2. 有序二级 B-2\n' +
      '    - 嵌套无序三级 B-2-a\n\n' +
      '列表结束。'
    );
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, '04-complex-lists.png') });

  // 5. Test User Selection Geometry & Zero Overlap
  console.log('5. Testing Selection Geometry & Zero Overlap on Multi-line Wrapped Text...');
  await page.evaluate(() => {
    const text =
      '这是一段很长很长的段落文字，用来测试多行视觉折行时的选区几何表现。它应该在每一行之间绝对零重叠，并且选区上下对称地包裹正文文字。即便是包含不同字号与标点符号，选区的上边界和下边界也必须与行网格严格吻合，绝不发生侵入下一行造成的双层颜色加深问题。同时下一行也是被选中的文字，可以看到两行之间的分界线完全无缝贴合。';
    window.__CRISH_SESSION_STORE__.getState().setText(text);
  });
  await page.waitForTimeout(500);

  // Select across lines
  await page.evaluate(() => {
    const store = window.__CRISH_SESSION_STORE__.getState();
    store.setSelection(10, 120);
  });
  await page.waitForTimeout(500);

  const rects = await page.evaluate(() => {
    const selRects = Array.from(document.querySelectorAll('.selection-rect')).map(el => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height, left: r.left, width: r.width };
    });
    return selRects;
  });

  console.log('Selection rects count:', rects.length);
  for (let i = 0; i < rects.length; i++) {
    console.log(`Rect ${i}: top=${rects[i].top.toFixed(1)}, bottom=${rects[i].bottom.toFixed(1)}, height=${rects[i].height.toFixed(1)}`);
    if (i > 0) {
      const gapOrOverlap = rects[i].top - rects[i - 1].bottom;
      console.log(`  -> Gap/Overlap with prev line: ${gapOrOverlap.toFixed(2)}px (0 = perfect zero-overlap)`);
    }
  }
  await page.screenshot({ path: path.join(outDir, '05-selection-zero-overlap.png') });

  // 6. Test Task List [x] Baseline Invariance
  console.log('6. Testing Task List Baseline Invariance...');
  await page.evaluate(() => {
    window.__CRISH_SESSION_STORE__.getState().setText(
      '- [x] 这是一条已完成的任务项，测试源码态与正文文字的垂直基线是否绝对贴合。\n' +
      '- [ ] 待办任务项测试'
    );
  });
  await page.waitForTimeout(500);

  // Put cursor in `[x]` to activate source mode
  await page.evaluate(() => {
    const store = window.__CRISH_SESSION_STORE__.getState();
    store.setSelection(3, 3);
    store.setCursorPos(3);
  });
  await page.waitForTimeout(500);

  const baselineData = await page.evaluate(() => {
    const taskEl = document.querySelector('.token-list-task');
    const textSpan = document.querySelector('.token-list-task ~ span') || document.querySelector('.line-block span:nth-of-type(2)');
    if (!taskEl) return null;
    const taskRect = taskEl.getBoundingClientRect();
    const textRect = textSpan ? textSpan.getBoundingClientRect() : null;
    return {
      task: { top: taskRect.top, bottom: taskRect.bottom, height: taskRect.height },
      text: textRect ? { top: textRect.top, bottom: textRect.bottom, height: textRect.height } : null
    };
  });
  console.log('Baseline comparison in source mode:', JSON.stringify(baselineData));
  await page.screenshot({ path: path.join(outDir, '06-task-baseline-invariance.png') });

  // 7. Test Blockquote Live Preview in-place hybrid mode
  console.log('7. Testing Blockquote Live Preview in-place hybrid mode...');
  await page.evaluate(() => {
    window.__CRISH_SESSION_STORE__.getState().setText(
      '> 这是一个块引用段落，测试点击进入时展开源码 > 前缀，移出时恢复为精致竖导线。\n\n' +
      '这是引用外普通正文。'
    );
  });
  await page.waitForTimeout(500);

  // Inactive
  await page.evaluate(() => {
    const store = window.__CRISH_SESSION_STORE__.getState();
    store.setCursorPos(50);
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, '07-blockquote-inactive.png') });

  // Active (focus in blockquote)
  await page.evaluate(() => {
    const store = window.__CRISH_SESSION_STORE__.getState();
    store.setCursorPos(5);
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, '08-blockquote-active.png') });

  // 8. Test Table Cell Text Selection
  console.log('8. Testing Table Cell Text Drag Selection...');
  await page.evaluate(() => {
    window.__CRISH_SESSION_STORE__.getState().setText(
      '| 模块 | 核心功能说明 |\n' +
      '| :--- | :--- |\n' +
      '| 引擎内核 | 负责高并发 Markdown 渲染与虚拟树调度 |\n' +
      '| 样式系统 | 视觉行盒网格对齐与排版基线守恒 |'
    );
  });
  await page.waitForTimeout(500);

  const targetCell = page.locator('.token-table-cell').filter({ hasText: /负责高并发/ });
  await targetCell.waitFor();
  await targetCell.dblclick();
  await page.waitForTimeout(400);

  const cellSelResult = await page.evaluate(() => {
    const cellEl = document.querySelector('.is-cell-editing');
    if (!cellEl) return { error: 'not editing' };
    const start = parseInt(cellEl.getAttribute('data-token-start') || '0', 10);
    const store = window.__CRISH_SESSION_STORE__.getState();
    store.setSelection(start + 2, start + 5);
    return {
      isEditing: true,
      selectionStart: store.selectionStart,
      selectionEnd: store.selectionEnd
    };
  });
  console.log('Cell selection result:', JSON.stringify(cellSelResult));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, '09-table-cell-text-selected.png') });

  // 9. Test Heading Selection across prefix
  console.log('9. Testing Heading Selection across prefix...');
  await page.evaluate(() => {
    window.__CRISH_SESSION_STORE__.getState().setText(
      '### 1. 标题边缘测试 (Headings)\n\n' +
      '正文内容。'
    );
  });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const store = window.__CRISH_SESSION_STORE__.getState();
    store.setSelection(0, 15);
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, '10-heading-selection-prefix.png') });

  console.log('All screenshots saved successfully!');
  await browser.close();
})();
