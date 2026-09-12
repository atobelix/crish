// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyCodeBlockIndentToDocument,
  applyCodeIndentToRenderedRoot,
  codeIndentAttr,
  normalizeCodeBlockIndent,
  readCodeBlockIndent,
  rematerializeLeadingIndent,
  rematerializeMarkdownHtml,
  tabSizeFromCodeIndent,
} from './codeBlockIndent';
import { useSettingsStore } from '../store/settingsStore';

describe('normalizeCodeBlockIndent', () => {
  it('白名单：2 空格 / 4 空格 / Tab', () => {
    expect(normalizeCodeBlockIndent('  ')).toBe('  ');
    expect(normalizeCodeBlockIndent('    ')).toBe('    ');
    expect(normalizeCodeBlockIndent('\t')).toBe('\t');
  });

  it('非法值回落 2 空格', () => {
    expect(normalizeCodeBlockIndent('weird')).toBe('  ');
    expect(normalizeCodeBlockIndent(undefined)).toBe('  ');
    expect(normalizeCodeBlockIndent(4)).toBe('  ');
  });
});

describe('tabSizeFromCodeIndent / codeIndentAttr', () => {
  it('2 空格 → tab-size 2；4 空格与 Tab → 4', () => {
    expect(tabSizeFromCodeIndent('  ')).toBe(2);
    expect(tabSizeFromCodeIndent('    ')).toBe(4);
    expect(tabSizeFromCodeIndent('\t')).toBe(4);
    expect(codeIndentAttr('\t')).toBe('tab');
    expect(codeIndentAttr('    ')).toBe('4');
    expect(codeIndentAttr('  ')).toBe('2');
  });
});

describe('rematerializeLeadingIndent', () => {
  it('4 空格级 → 2 空格', () => {
    expect(rematerializeLeadingIndent('    foo\n        bar', '  ')).toBe(
      '  foo\n    bar'
    );
  });

  it('2 空格级 → 4 空格', () => {
    expect(rematerializeLeadingIndent('  foo\n    bar', '    ')).toBe(
      '    foo\n        bar'
    );
  });

  it('4 空格级 → Tab', () => {
    expect(rematerializeLeadingIndent('    foo\n        bar', '\t')).toBe(
      '\tfoo\n\t\tbar'
    );
  });

  it('Tab → 2 空格', () => {
    expect(rematerializeLeadingIndent('\tfoo\n\t\tbar', '  ')).toBe(
      '  foo\n    bar'
    );
  });

  it('空行与无缩进保持', () => {
    expect(rematerializeLeadingIndent('foo\n\nbar', '    ')).toBe('foo\n\nbar');
  });

  it('1 空格不对齐不改', () => {
    expect(rematerializeLeadingIndent(' foo\n  bar', '    ')).toBe(
      ' foo\n  bar'
    );
  });

  it('已是目标单位则恒等（2 空格）', () => {
    const src = '  foo\n    bar';
    expect(rematerializeLeadingIndent(src, '  ')).toBe(src);
  });
});

describe('applyCodeBlockIndentToDocument', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--md-code-tab-size');
    document.documentElement.removeAttribute('data-code-indent');
  });

  it('写入 CSS 变量与 data-code-indent', () => {
    applyCodeBlockIndentToDocument('    ');
    expect(
      document.documentElement.style.getPropertyValue('--md-code-tab-size')
    ).toBe('4');
    expect(document.documentElement.getAttribute('data-code-indent')).toBe(
      '4'
    );
    applyCodeBlockIndentToDocument('\t');
    expect(
      document.documentElement.style.getPropertyValue('--md-code-tab-size')
    ).toBe('4');
    expect(document.documentElement.getAttribute('data-code-indent')).toBe(
      'tab'
    );
  });
});

describe('applyCodeIndentToRenderedRoot', () => {
  it('改行首空白、保留高亮 span', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<div class="md-code-block"><pre class="md-code-pre"><code>    <span class="hljs-keyword">const</span> x</code></pre></div>';
    applyCodeIndentToRenderedRoot(root, '  ');
    const code = root.querySelector('code')!;
    expect(code.textContent).toBe('  const x');
    expect(code.querySelector('.hljs-keyword')?.textContent).toBe('const');
  });
});

describe('rematerializeMarkdownHtml', () => {
  it('无代码块原样返回', () => {
    expect(rematerializeMarkdownHtml('<p>hi</p>', '    ')).toBe('<p>hi</p>');
  });
});

describe('readCodeBlockIndent', () => {
  beforeEach(() => {
    useSettingsStore.setState({ appSettings: null });
  });

  afterEach(() => {
    useSettingsStore.setState({ appSettings: null });
  });

  it('store 存在值时优先读取', () => {
    useSettingsStore.setState({
      appSettings: { markdown: { codeBlockIndent: '\t' } } as never,
    });
    expect(readCodeBlockIndent()).toBe('\t');
  });

  it('store 为空或未就绪时回落 2 空格', () => {
    expect(readCodeBlockIndent()).toBe('  ');
  });
});
