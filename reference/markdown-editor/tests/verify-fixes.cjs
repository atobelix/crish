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

  console.log('All screenshots saved successfully!');
  await browser.close();
})();
