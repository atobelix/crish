// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WidgetDiff } from '../../custom-tags/WidgetDiff';
import styles from '../../custom-tags/custom-tags.module.css';

describe('WidgetDiff 对偶分栏与占位行对齐断言套件', () => {
  it('Split 视图下，3 行删除紧随 1 行新增时，产出 3 行分栏对偶，右侧后 2 行包含 diffLineEmpty 占位槽', () => {
    const rawDiff = `@@ -1,3 +1,1 @@
-del line 1
-del line 2
-del line 3
+add line 1`;

    const { container } = render(
      <WidgetDiff from="a.ts" to="b.ts" mode="split">
        {rawDiff}
      </WidgetDiff>
    );

    const splitRows = container.querySelectorAll(`.${styles.diffSplitLineRow}`);
    expect(splitRows.length).toBe(3);

    // 检查第 1 行左右两侧均有内容
    const firstRowCells = splitRows[0]?.querySelectorAll(`.${styles.diffSplitColCell}`);
    expect(firstRowCells?.[0]?.textContent).toContain('del line 1');
    expect(firstRowCells?.[1]?.textContent).toContain('add line 1');

    // 检查第 2 行右侧为 empty 占位
    const secondRowCells = splitRows[1]?.querySelectorAll(`.${styles.diffSplitColCell}`);
    expect(secondRowCells?.[0]?.textContent).toContain('del line 2');
    expect(secondRowCells?.[1]?.classList.contains(styles.diffLineEmpty)).toBe(true);

    // 检查第 3 行右侧为 empty 占位
    const thirdRowCells = splitRows[2]?.querySelectorAll(`.${styles.diffSplitColCell}`);
    expect(thirdRowCells?.[0]?.textContent).toContain('del line 3');
    expect(thirdRowCells?.[1]?.classList.contains(styles.diffLineEmpty)).toBe(true);
  });

  it('WidgetDiff 正确推导并高亮真实代码语言', () => {
    const rawDiff = `@@ -1,1 +1,1 @@
-const oldVar: number = 10;
+const newVar: string = "hello";`;

    const { container } = render(
      <WidgetDiff from="src/config.ts" to="src/config.ts" mode="unified">
        {rawDiff}
      </WidgetDiff>
    );

    const html = container.innerHTML;
    expect(html).toContain('hljs-keyword'); // "const"
    expect(html).toContain('hljs-string');  // "hello"
  });
});
