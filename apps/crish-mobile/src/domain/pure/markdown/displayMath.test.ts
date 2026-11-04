// 块级公式识别断言（批 E)：整段定界才认、混排与格式 span 不认、空公式不认。
import {
  extractDisplayMath,
  isMathFenceLang,
  isMermaidFenceLang,
} from './displayMath';
import type { MdSpan } from './types';

const text = (value: string): MdSpan => ({ type: 'text', text: value });

describe('extractDisplayMath', () => {
  it('$$…$$ 整段 → 剥出原文（多行经 break 拼接）', () => {
    expect(extractDisplayMath([text('$$E = mc^2$$')])).toBe('E = mc^2');
    expect(
      extractDisplayMath([
        text('$$'),
        { type: 'break' },
        text('a^2 + b^2 = c^2'),
        { type: 'break' },
        text('$$'),
      ])
    ).toBe('a^2 + b^2 = c^2');
  });

  it('\\[…\\] 整段 → 剥出原文', () => {
    expect(extractDisplayMath([text('\\[x + y\\]')])).toBe('x + y');
  });

  it('与正文混排不认（行内公式保持原文口径）', () => {
    expect(extractDisplayMath([text('由 $$x$$ 可知')])).toBeNull();
    expect(extractDisplayMath([text('$$x$$ 后续')])).toBeNull();
    expect(extractDisplayMath([text('前置 $$x$$')])).toBeNull();
  });

  it('含格式 span 不认（原文须逐字保真）', () => {
    expect(
      extractDisplayMath([
        text('$$'),
        { type: 'strong', children: [text('x')] },
        text('$$'),
      ])
    ).toBeNull();
    expect(
      extractDisplayMath([text('$$'), { type: 'code', text: 'x' }, text('$$')])
    ).toBeNull();
  });

  it('空公式 / 未闭合 / 普通段落不认', () => {
    expect(extractDisplayMath([text('$$$$')])).toBeNull();
    expect(extractDisplayMath([text('$$  $$')])).toBeNull();
    expect(extractDisplayMath([text('$$x')])).toBeNull();
    expect(extractDisplayMath([text('普通段落')])).toBeNull();
    expect(extractDisplayMath([])).toBeNull();
  });
});

describe('围栏语言判定', () => {
  it('math / latex / tex / katex 为公式围栏', () => {
    expect(isMathFenceLang('math')).toBe(true);
    expect(isMathFenceLang(' LaTeX ')).toBe(true);
    expect(isMathFenceLang('tex')).toBe(true);
    expect(isMathFenceLang('katex')).toBe(true);
    expect(isMathFenceLang('ts')).toBe(false);
    expect(isMathFenceLang(null)).toBe(false);
  });

  it('mermaid 围栏', () => {
    expect(isMermaidFenceLang('mermaid')).toBe(true);
    expect(isMermaidFenceLang('graph')).toBe(false);
    expect(isMermaidFenceLang(null)).toBe(false);
  });
});
