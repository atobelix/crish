/**
 * inlineParser 单元测试
 *
 * 覆盖 Token-in-Document 解析器的核心行为：mark 区间、语法分隔符区间、
 * 嵌套强调、以及那些「不该被解析」的边界情况（词内下划线、未闭合分隔符等）。
 */

import { describe, it, expect } from 'vitest';
import {
  parseInline,
  isSyntaxRevealed,
  type MarkSpan,
  type SyntaxSpan,
} from '../../core/live-preview/inlineParser';

/** 把 MarkSpan 压成 "name[from,to)" 便于断言 */
function m(marks: MarkSpan[]): string[] {
  return marks.map((s) => `${s.name}[${s.from},${s.to})`);
}

/** 把 SyntaxSpan 压成 "[from,to)" 便于断言 */
function s(syntax: SyntaxSpan[]): string[] {
  return syntax.map((x) => `[${x.from},${x.to})`);
}

/** 取出隐藏语法后用户实际看到的文本 */
function visible(text: string): string {
  const { syntax } = parseInline(text);
  const hidden = new Set<number>();
  for (const sp of syntax) for (let i = sp.from; i < sp.to; i++) hidden.add(i);
  return [...text].filter((_, i) => !hidden.has(i)).join('');
}

describe('parseInline — 基础强调', () => {
  it('**bold** 的 mark 覆盖整段含分隔符的区间', () => {
    const r = parseInline('hello **world**!');
    expect(m(r.marks)).toEqual(['bold[6,15)']);
    expect(s(r.syntax)).toEqual(['[6,8)', '[13,15)']);
    expect(visible('hello **world**!')).toBe('hello world!');
  });

  it('*italic* / ~~strike~~ / ==highlight== / `code`', () => {
    expect(m(parseInline('*i*').marks)).toEqual(['italic[0,3)']);
    expect(m(parseInline('~~s~~').marks)).toEqual(['strike[0,5)']);
    expect(m(parseInline('==h==').marks)).toEqual(['highlight[0,5)']);
    expect(m(parseInline('`c`').marks)).toEqual(['code[0,3)']);
    expect(visible('a *i* ~~s~~ ==h== `c` b')).toBe('a i s h c b');
  });

  it('单个 ~ 或 = 不构成 mark', () => {
    expect(parseInline('~s~').marks).toEqual([]);
    expect(parseInline('=h=').marks).toEqual([]);
  });
});

describe('parseInline — 嵌套', () => {
  it('***bi*** 拆成外层 italic + 内层 bold', () => {
    const r = parseInline('***bi***');
    expect(m(r.marks)).toEqual(['italic[0,8)', 'bold[1,7)']);
    // 全部 6 个星号都是语法
    expect(s(r.syntax)).toEqual(['[0,1)', '[1,3)', '[5,7)', '[7,8)']);
    expect(visible('***bi***')).toBe('bi');
  });

  it('**a *b* c** 内层 italic 落在外层 bold 内', () => {
    const r = parseInline('**a *b* c**');
    expect(m(r.marks)).toEqual(['bold[0,11)', 'italic[4,7)']);
    expect(visible('**a *b* c**')).toBe('a b c');
  });

  it('代码段内的星号不参与配对', () => {
    const r = parseInline('`a * b` c');
    expect(m(r.marks)).toEqual(['code[0,7)']);
    expect(visible('`a * b` c')).toBe('a * b c');
  });
});

describe('parseInline — 不该解析的情况', () => {
  it('词内下划线保持字面量（snake_case 不变斜体）', () => {
    expect(parseInline('snake_case_name').marks).toEqual([]);
    expect(visible('snake_case_name')).toBe('snake_case_name');
  });

  it('未闭合的分隔符不产生 mark', () => {
    expect(parseInline('*unclosed').marks).toEqual([]);
    expect(parseInline('a ** b').marks).toEqual([]);
    expect(visible('*unclosed')).toBe('*unclosed');
  });

  it('分隔符两侧是空白时不能开合', () => {
    expect(parseInline('a * b * c').marks).toEqual([]);
  });

  it('反斜杠转义：\\* 不构成强调，反斜杠本身隐藏', () => {
    const r = parseInline('a \\*b\\* c');
    expect(r.marks).toEqual([]);
    expect(visible('a \\*b\\* c')).toBe('a *b* c');
  });

  it('未闭合的反引号当普通文本', () => {
    expect(parseInline('a ` b').marks).toEqual([]);
  });
});

describe('parseInline — 链接', () => {
  it('[text](url) 产生 link mark，href 落在 attrs 上', () => {
    const r = parseInline('see [Conex](https://x.dev) now');
    expect(m(r.marks)).toEqual(['link[4,26)']);
    expect(r.marks[0].attrs).toEqual({ href: 'https://x.dev' });
    expect(visible('see [Conex](https://x.dev) now')).toBe('see Conex now');
  });

  it('链接文字内部仍可继续解析强调', () => {
    const r = parseInline('[**b**](u)');
    expect(m(r.marks)).toEqual(['link[0,10)', 'bold[1,6)']);
    expect(visible('[**b**](u)')).toBe('b');
  });

  it('URL 中的星号不参与配对', () => {
    const r = parseInline('[t](http://a*b*c)');
    expect(m(r.marks)).toEqual(['link[0,17)']);
  });
});

describe('isSyntaxRevealed — 显形判定', () => {
  const text = 'hello **world**!';
  const { syntax } = parseInline(text);

  it('光标在 mark 作用域内时两侧分隔符同时显形', () => {
    // 光标落在 "world" 中间（偏移 10）
    const revealed = syntax.filter((sp) => isSyntaxRevealed(sp, 10, 10));
    expect(s(revealed)).toEqual(['[6,8)', '[13,15)']);
  });

  it('光标远离时全部隐藏', () => {
    const revealed = syntax.filter((sp) => isSyntaxRevealed(sp, 2, 2));
    expect(revealed).toEqual([]);
  });

  it('光标贴着作用域边界时也显形（便于用键盘删掉分隔符）', () => {
    expect(syntax.filter((sp) => isSyntaxRevealed(sp, 6, 6)).length).toBe(2);
    expect(syntax.filter((sp) => isSyntaxRevealed(sp, 15, 15)).length).toBe(2);
  });
});

describe('parseInline — 幂等与性能', () => {
  it('解析结果对同一输入稳定', () => {
    const t = 'a **b** `c` [d](e) ~~f~~ ==g== ***h***';
    expect(parseInline(t)).toEqual(parseInline(t));
  });

  it('长段落解析耗时可忽略', () => {
    const t = ('word **bold** and *em* plus `code` '.repeat(60)).trim();
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) parseInline(t);
    const per = (performance.now() - t0) / 200;
    console.log(`  parseInline: ${t.length} 字符 → ${per.toFixed(3)} ms/次`);
    expect(per).toBeLessThan(2);
  });
});
