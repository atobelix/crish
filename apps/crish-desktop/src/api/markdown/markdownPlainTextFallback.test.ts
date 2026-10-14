import { describe, expect, it } from 'vitest';
import { toMarkdownPlainTextFallback } from './markdownPlainTextFallback';

describe('toMarkdownPlainTextFallback', () => {
  it('剥离标题与强调控制符，保留语义正文', () => {
    expect(toMarkdownPlainTextFallback('## Source **must never appear**')).toBe(
      'Source must never appear'
    );
    expect(toMarkdownPlainTextFallback('# Title')).toBe('Title');
    expect(toMarkdownPlainTextFallback('plain *emphasis* text')).toBe(
      'plain emphasis text'
    );
    expect(toMarkdownPlainTextFallback('~~removed~~ and __strong__')).toBe(
      'removed and strong'
    );
  });

  it('链接与图片只保留可见语义，不保留 URL 与语法', () => {
    expect(
      toMarkdownPlainTextFallback('See [label](https://example.test) now')
    ).toBe('See label now');
    expect(
      toMarkdownPlainTextFallback('![alt](https://example.test/a.png)')
    ).toBe('alt');
    expect(toMarkdownPlainTextFallback('raw <https://example.test> link')).toBe(
      'raw https://example.test link'
    );
  });

  it('表格管道、引用与列表标记不进入兜底文本', () => {
    expect(
      toMarkdownPlainTextFallback('| A | B |\n| --- | --- |\n| 1 | 2 |')
    ).toBe('A B\n1 2');
    expect(toMarkdownPlainTextFallback('> quoted line')).toBe('quoted line');
    expect(toMarkdownPlainTextFallback('- first\n- second')).toBe(
      'first\nsecond'
    );
    expect(toMarkdownPlainTextFallback('1. one\n2. two')).toBe('one\ntwo');
  });

  it('代码围栏只丢开关行，正文按原文保留', () => {
    const source = '```ts\nconst value = 1;\n```';
    expect(toMarkdownPlainTextFallback(source)).toBe('const value = 1;');
  });

  it('分割线与 setext 下划线不进入兜底文本', () => {
    expect(toMarkdownPlainTextFallback('Title\n---\nbody')).toBe('Title\nbody');
    expect(toMarkdownPlainTextFallback('a\n\n***\n\nb')).toBe('a\nb');
  });

  it('不配对的控制符同样被清除，绝不泄漏 ** 与围栏反引号', () => {
    expect(toMarkdownPlainTextFallback('half ** open')).not.toContain('**');
    expect(toMarkdownPlainTextFallback('trailing `')).not.toContain('`');
    expect(toMarkdownPlainTextFallback('**bold is fine**')).not.toContain('**');
  });

  it('空输入与纯语法输入返回空串，绝不产生伪内容', () => {
    expect(toMarkdownPlainTextFallback('')).toBe('');
    expect(toMarkdownPlainTextFallback('   \n\n  ')).toBe('');
    expect(toMarkdownPlainTextFallback('```\n```')).toBe('');
  });
});
