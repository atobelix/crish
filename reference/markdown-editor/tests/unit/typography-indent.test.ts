import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';

/**
 * 排版缩进与混合内容基线
 *
 * 战役 wysiwyg-layout-remediation（ADR-1/ADR-2）语义升级——本文件原先固化的是
 * **被整改的偏差**，现按新语义重写：
 *
 * | 旧断言 | 新断言 | 原因 |
 * |---|---|---|
 * | `listIndent`（缩进**字符数**，tab 计 1） | `indentColumns`（缩进**列宽**，tab 停靠 4） | 列宽是 CommonMark §Tabs 的语义，也是渲染层唯一能还原真实缩进量的口径 |
 * | 无嵌套层级概念 | `listDepth`（整数层级） | 嵌套是容器语义，由 `ListContainerStack` 产出；旧实现用 `listIndent > indent` 数值比较推断，会把 1 空格缩进的同级项误判为子列表 |
 * | 无内容缩进列 | `contentIndentColumns` | CommonMark §5.2 的内容缩进列是列表项归属判定的基准 |
 *
 * 注：任务列表 `- [x] ` 的内容缩进列按 GFM 语义为 **2**（`[x]` 属内容而非标记），
 * 故 `- [x] a` 的子项缩进 2 列即可嵌套。
 */
describe('2. Repro & Regression: Typography Indentation & Mixed Content Baseline', () => {
  it('混合行内格式不破坏缩进列与标记识别', () => {
    const markdown = [
      '- 根列表',
      '    - [x] **大写X任务**',
      '        - Nested task',
    ].join('\n');

    const result = MarkdownParser.parse(markdown);

    // 四列缩进必须有列表父容器；根文档的四列缩进是代码块。
    const task = result.lines[1];
    expect(task.type).toBe('body');
    expect(task.indentColumns).toBe(4);
    expect(task.listPrefix).toBe('- [x]');
    // GFM：任务复选框属内容 → 内容缩进列 = 4 + 2 = 6
    expect(task.contentIndentColumns).toBe(6);
    expect(task.listDepth).toBe(1);

    const inlineTokens = task.inlineTokens!;
    // 应同时存在 task token 与 bold token
    expect(inlineTokens.some((t) => t.type === 'list_task')).toBe(true);
    expect(
      inlineTokens.some((t) => t.type === 'bold' && t.raw === '**大写X任务**')
    ).toBe(true);

    const child = result.lines[2];
    expect(child.type).toBe('body');
    expect(child.indentColumns).toBe(8);
    expect(child.contentIndentColumns).toBe(10);
    expect(child.listDepth).toBe(2);
    expect(MarkdownParser.parse('    - [x] **根缩进代码**').lines[0].type).toBe('code');
  });

  it('有序列表的嵌套层级按标记段宽决定', () => {
    const markdown = ['1. Root list', '    1. Nested list'].join('\n');

    const result = MarkdownParser.parse(markdown);

    // `1. ` → 内容缩进列 3
    expect(result.lines[0].indentColumns).toBe(0);
    expect(result.lines[0].listPrefix).toBe('1.');
    expect(result.lines[0].contentIndentColumns).toBe(3);
    expect(result.lines[0].listDepth).toBe(0);

    // 缩进 4 ≥ 3 → 嵌套
    expect(result.lines[1].indentColumns).toBe(4);
    expect(result.lines[1].listPrefix).toBe('1.');
    expect(result.lines[1].listDepth).toBe(1);
  });

  it('I3：tab 缩进与等价空格缩进产出相同的列宽与层级', () => {
    const tabbed = MarkdownParser.parse('- a\n\t- b');
    const spaced = MarkdownParser.parse('- a\n    - b');
    expect(tabbed.lines[1].indentColumns).toBe(spaced.lines[1].indentColumns);
    expect(tabbed.lines[1].indentColumns).toBe(4);
    expect(tabbed.lines[1].listDepth).toBe(spaced.lines[1].listDepth);
    expect(tabbed.lines[1].listDepth).toBe(1);
  });

  it('I6：1 空格缩进的同级项不是嵌套（旧实现误判为子列表）', () => {
    const doc = MarkdownParser.parse('- a\n - b');
    expect(doc.lines[0].listDepth).toBe(0);
    expect(doc.lines[1].listDepth).toBe(0);
  });
});
