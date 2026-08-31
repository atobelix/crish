import { describe, expect, it } from 'vitest';
import { normalizeUnclosedOpenTags } from '../normalizeUnclosedOpenTags';
import { findMarkdownCodeRanges } from '../preprocessCustomTags';

describe('normalizeUnclosedOpenTags (未闭合标签流式即时呈现)', () => {
  it('TC-N01: 仅有开始标签且无后续字符时保持原样缓冲', () => {
    const input = '<widget-diff title="Fix">';
    const output = normalizeUnclosedOpenTags(input, 'widget-diff');
    expect(output).toBe(input);
  });

  it('TC-N02: 开始标签后紧跟换行与正文时立即注入 \\n\\n 激活即时渲染', () => {
    const input = '<widget-diff title="Fix">\n+ let a = 1;';
    const output = normalizeUnclosedOpenTags(input, 'widget-diff');
    expect(output).toBe('<widget-diff title="Fix">\n\n+ let a = 1;');
  });

  it('TC-N03: 开始标签后已具有 \\n\\n 时正文内部双换行转换为 <!---->', () => {
    const input = '<widget-diff title="Fix">\n\nline1\n\nline2';
    const output = normalizeUnclosedOpenTags(input, 'widget-diff');
    expect(output).toBe('<widget-diff title="Fix">\n\nline1\n<!---->\nline2');
  });

  it('TC-N04: 未闭合标签在行内且无换行时保持单行原样', () => {
    const input = '正在生成 <ai-card title="Step 1"> 稍后返回';
    const output = normalizeUnclosedOpenTags(input, 'ai-card');
    expect(output).toBe(input);
  });

  it('TC-N05: 开始标签后只有空白字符与换行时保持原样缓冲', () => {
    const input = '<ai-card>\n   ';
    const output = normalizeUnclosedOpenTags(input, 'ai-card');
    expect(output).toBe(input);
  });

  it('TC-N06: 代码栅栏内的未闭合标签被忽略，不进行注入', () => {
    const input = '```\n<widget-diff>\n+ let a = 1;\n```';
    const ranges = findMarkdownCodeRanges(input);
    const output = normalizeUnclosedOpenTags(input, 'widget-diff', ranges);
    expect(output).toBe(input);
  });

  it('TC-N07: 自闭合标签 <widget-diff /> 被忽略', () => {
    const input = '<widget-diff title="Empty" />\n后续文本';
    const output = normalizeUnclosedOpenTags(input, 'widget-diff');
    expect(output).toBe(input);
  });

  it('TC-N08: 存在对应闭合标签时不作处理（交由闭合 Pass 处理）', () => {
    const input = '<file-tree>\nfile.ts\n</file-tree>';
    const output = normalizeUnclosedOpenTags(input, 'file-tree');
    expect(output).toBe(input);
  });

  it('TC-N09: 标签名称大小写不敏感支持', () => {
    const input = '<Widget-Diff title="Fix">\n+ let a = 1;';
    const output = normalizeUnclosedOpenTags(input, 'widget-diff');
    expect(output).toBe('<Widget-Diff title="Fix">\n\n+ let a = 1;');
  });

  it('TC-N10: 空字符串输入安全返回空字符串', () => {
    expect(normalizeUnclosedOpenTags('', 'widget-diff')).toBe('');
  });
});
