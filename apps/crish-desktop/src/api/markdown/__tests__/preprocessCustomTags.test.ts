import { describe, expect, it } from 'vitest';
import {
  preprocessCustomTags,
  findMarkdownCodeRanges,
  isPositionInRanges,
  normalizeClosedTag,
} from '../preprocessCustomTags';

describe('preprocessCustomTags (CommonMark 空行三明治与代码栅栏保护)', () => {
  const tagNames = ['widget-diff', 'ai-card', 'file-tree'];

  it('TC-01: 单行内联标签保持原样，不注入多余换行', () => {
    const input = '这是一个 <ai-card>**粗体**</ai-card> 测试';
    const output = preprocessCustomTags(input, tagNames);
    expect(output).toBe(input);
  });

  it('TC-02: 多行闭合标签注入空行三明治与尾部双换行', () => {
    const input = '<ai-card>\n**加粗标题**\n- 步骤1\n</ai-card>';
    const output = preprocessCustomTags(input, tagNames);
    expect(output).toBe('<ai-card>\n\n**加粗标题**\n- 步骤1\n\n</ai-card>\n\n');
  });

  it('TC-03: 内部已有的连续空行安全转为 <!----> 占位，防止 Block 撕裂', () => {
    const input = '<ai-card>\n第一段\n\n第二段\n</ai-card>';
    const output = preprocessCustomTags(input, tagNames);
    expect(output).toBe('<ai-card>\n\n第一段\n<!---->\n第二段\n\n</ai-card>\n\n');
  });

  it('TC-04: Markdown 代码栅栏内的自定义标签受保护，绝不被注入空行', () => {
    const input = '```html\n<widget-diff>\n+ let a = 1;\n</widget-diff>\n```';
    const output = preprocessCustomTags(input, tagNames);
    expect(output).toBe(input);
  });

  it('TC-05: 流式未闭合标签在正文到达换行后立即注入空行中断激活渲染', () => {
    const input = '<widget-diff title="Fix">\n+ let a = 1;';
    const output = preprocessCustomTags(input, tagNames);
    expect(output).toBe('<widget-diff title="Fix">\n\n+ let a = 1;');
  });

  it('TC-06: 流式未闭合标签仅有开始标签时保持原样缓冲', () => {
    const input = '<widget-diff title="Fix">';
    const output = preprocessCustomTags(input, tagNames);
    expect(output).toBe(input);
  });

  it('TC-07: 行内代码内部的自定义标签受保护', () => {
    const input = '请查看 `<widget-diff>\n+ let a = 1;\n</widget-diff>` 代码示例';
    const output = preprocessCustomTags(input, tagNames);
    expect(output).toBe(input);
  });

  it('TC-08: 多种不同自定义标签在同一篇文档中正确预处理', () => {
    const input = `
<file-tree root="src">
file1.ts
</file-tree>

<ai-card status="success">
执行完成
</ai-card>
`.trim();

    const output = preprocessCustomTags(input, tagNames);
    expect(output).toContain('<file-tree root="src">\n\nfile1.ts\n\n</file-tree>\n\n');
    expect(output).toContain('<ai-card status="success">\n\n执行完成\n\n</ai-card>\n\n');
  });

  it('TC-09: 波浪线代码栅栏 (~~~) 中的标签同样受保护', () => {
    const input = '~~~markdown\n<ai-card>\n内部内容\n</ai-card>\n~~~';
    const output = preprocessCustomTags(input, tagNames);
    expect(output).toBe(input);
  });

  it('TC-10: 边界条件测试：空字符串或空标签列表', () => {
    expect(preprocessCustomTags('', tagNames)).toBe('');
    expect(preprocessCustomTags('正文内容', [])).toBe('正文内容');
  });

  it('TC-11: findMarkdownCodeRanges 辅助函数准确识别范围', () => {
    const md = 'Hello `code` world\n```js\nconst x = 1;\n```';
    const ranges = findMarkdownCodeRanges(md);
    expect(ranges.length).toBe(2);
    expect(isPositionInRanges(md.indexOf('code'), ranges)).toBe(true);
    expect(isPositionInRanges(md.indexOf('const'), ranges)).toBe(true);
    expect(isPositionInRanges(md.indexOf('Hello'), ranges)).toBe(false);
  });

  it('TC-12: normalizeClosedTag 单行与多行行为一致性', () => {
    expect(normalizeClosedTag('<tag>', 'abc', '</tag>')).toBe('<tag>abc</tag>');
    expect(normalizeClosedTag('<tag>', '\nabc\n', '</tag>')).toBe('<tag>\n\nabc\n\n</tag>\n\n');
  });
});
