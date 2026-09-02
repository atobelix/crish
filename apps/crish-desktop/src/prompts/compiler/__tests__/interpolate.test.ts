/**
 * 编译器单测：普通替换、数组换行展开、缺参回退、特殊字符防注入、locale 回退。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPromptTemplate } from '../interpolate';
import { escapePromptValue } from '../escaping';
import type { PromptMetadata } from '../../types';

const baseMeta: PromptMetadata<{ name: string }> = {
  id: 'test-basic',
  name: '测试模板',
  description: '编译器单测用',
  layer: 'mode',
  version: '1.0.0',
  defaultLocale: 'zh-CN',
  tags: ['test'],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('escaping：Markdown 结构防注入', () => {
  it('回车换行统一为 LF', () => {
    expect(escapePromptValue('a\r\nb\r\nc')).toBe('a\nb\nc');
  });

  it('整段连续分隔线行包入代码段（防横向分隔线注入）', () => {
    expect(escapePromptValue('---')).toBe('`---`');
    expect(escapePromptValue('===  ')).toBe('`===`');
    expect(escapePromptValue('line1\n___\nline2')).toBe('line1\n`___`\nline2');
  });

  it('不足三个分隔符或混排文本不动', () => {
    expect(escapePromptValue('--')).toBe('--');
    expect(escapePromptValue('a---b')).toBe('a---b');
    expect(escapePromptValue(' - - ')).toBe('- -');
  });

  it('空值安全；首尾空白裁剪保留段落内部排版', () => {
    expect(escapePromptValue('')).toBe('');
    expect(escapePromptValue('  a\n  b  ')).toBe('a\n  b');
  });
});

describe('interpolate：类型安全模板渲染', () => {
  it('普通字符串参数替换', () => {
    const tpl = createPromptTemplate(baseMeta, {
      'zh-CN': '你好 {{name}}',
      'en-US': 'Hi {{name}}',
    });
    expect(tpl.render({ name: '世界' })).toBe('你好 世界');
    expect(tpl.render({ name: '世界' }, { locale: 'en-US' })).toBe('Hi 世界');
  });

  it('数组参数按行展开', () => {
    const tpl = createPromptTemplate(
      { ...baseMeta, id: 'test-list' },
      {
        'zh-CN': '待办：\n{{items}}',
        'en-US': 'Todos:\n{{items}}',
      }
    );
    expect(tpl.render({ items: ['a', 'b'] })).toBe('待办：\na\nb');
    expect(tpl.render({ items: ['---', 'b'] })).toBe('待办：\n`---`\nb');
  });

  it('缺参安全回退为空串并告警（不抛异常）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tpl = createPromptTemplate<{ name: string; nick?: string }>(
      { ...baseMeta, id: 'test-missing' },
      {
        'zh-CN': '{{name}} / {{nick}}',
        'en-US': '{{name}} / {{nick}}',
      }
    );
    expect(tpl.render({ name: 'x' })).toBe('x /');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('test-missing');
  });

  it('defaultParams 与实参浅合并（实参优先）', () => {
    const tpl = createPromptTemplate<{ topic: string; maxQuestions: number }>(
      {
        ...baseMeta,
        id: 'test-defaults',
        defaultParams: { maxQuestions: 5 },
      } as PromptMetadata<{ topic: string; maxQuestions: number }>,
      {
        'zh-CN': 'topic={{topic}} max={{maxQuestions}}',
        'en-US': 'topic={{topic}} max={{maxQuestions}}',
      }
    );
    expect(tpl.render({ topic: 't' } as never)).toBe('topic=t max=5');
    expect(tpl.render({ topic: 't', maxQuestions: 9 })).toBe('topic=t max=9');
  });

  it('locale 回退：缺 en-US 时回落 zh-CN；未知 locale 主回退', () => {
    const tpl = createPromptTemplate(baseMeta, {
      'zh-CN': '中文内容',
      'en-US': 'English',
    });
    // 类型上仅支持已声明 locale；此处用 any 模拟「未支持语言」回退断言
    const anyTpl = tpl as unknown as {
      render(p: { name: string }, ctx?: { locale?: string }): string;
    };
    expect(anyTpl.render({ name: 'x' }, { locale: 'fr-FR' })).toBe('中文内容');
  });

  it('占位符前后允许空白；渲染整体 trim', () => {
    const tpl = createPromptTemplate(baseMeta, {
      'zh-CN': '\n\n  hi {{  name  }}  \n',
      'en-US': 'hi {{name}}',
    });
    expect(tpl.render({ name: 'x' })).toBe('hi x');
  });

  it('多语言完整性：同模板双 locale 均含变量替换', () => {
    const tpl = createPromptTemplate(baseMeta, {
      'zh-CN': '主题「{{name}}」',
      'en-US': 'Topic: {{name}}',
    });
    expect(tpl.render({ name: '对齐' })).toBe('主题「对齐」');
    expect(tpl.render({ name: 'align' }, { locale: 'en-US' })).toBe(
      'Topic: align'
    );
  });
});
