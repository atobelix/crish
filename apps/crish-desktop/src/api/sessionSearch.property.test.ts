/**
 * L4 属性测试：sessionSearch 不变量
 *
 * 用 fast-check 验证 sessionSearch 模块的核心不变量。
 * SS1-SS30 对抗测试已修复大量 Unicode / null 安全 bug，本套件防止回归。
 *
 * 不变量清单：
 *  - SS-P1: normalizeSearchQuery 幂等性
 *  - SS-P2: normalizeSearchQuery 永远返回 string 不抛错
 *  - SS-P3: normalizeSearchHaystack 与 normalizeSearchQuery 用同一 fold 函数（对齐）
 *  - SS-P4: tokenizeSearchQuery 与 normalizeSearchQuery 一致（split 后非空）
 *  - SS-P5: textMatchesTokens AND 语义（等价于 tokens.every(hay.includes)）
 *  - SS-P6: ellipsizeCodepoints 码点安全（结果码点数 <= maxCp）
 *  - SS-P7: ellipsizeCodepoints 单调性
 *  - SS-P8: ellipsizeCodepoints 幂等性
 *  - SS-P9: makeSearchSnippet 码点上限（结果码点数 <= maxLen）
 *  - SS-P10: makeSearchSnippet 永不抛错
 *  - SS-P11: makeSearchSnippet 命中包含性（maxLen 足够时包含 token）
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ellipsizeCodepoints,
  isEmptySearchQuery,
  makeSearchSnippet,
  normalizeSearchHaystack,
  normalizeSearchQuery,
  textMatchesSearch,
  textMatchesTokens,
  tokenizeSearchQuery,
} from './sessionSearch';

// ---------- arbitraries ----------

const fcAnyString = fc.string({ minLength: 0, maxLength: 512 });

const fcValidUnicode = fcAnyString.filter(s => {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);
});

const fcMaxCp = fc.integer({ min: 1, max: 200 });

const fcAnyMaxCp = fc.oneof(
  fc.integer({ min: -10, max: 0 }),
  fc.integer({ min: 1, max: 200 }),
  fc.double({ min: -5, max: 50, noNaN: false }),
  fc.constant(NaN),
  fc.constant(Infinity),
  fc.constant(-Infinity),
);

const fcToken = fc.string({ minLength: 1, maxLength: 16 }).filter(s => !/\s/.test(s));

// ---------- helpers ----------

const LONE_SURROGATE_REGEX = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function codepointCount(s: string): number {
  return Array.from(s).length;
}

// ---------- SS-P1: normalizeSearchQuery 幂等性 ----------

describe('SS-P1: normalizeSearchQuery 幂等性', () => {
  it('normalize(normalize(q)) === normalize(q)', () => {
    fc.assert(
      fc.property(fcAnyString, (q) => {
        const once = normalizeSearchQuery(q);
        const twice = normalizeSearchQuery(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 300 },
    );
  });

  it('null/undefined → empty string', () => {
    expect(normalizeSearchQuery(null)).toBe('');
    expect(normalizeSearchQuery(undefined)).toBe('');
  });

  it('非字符串不抛错', () => {
    expect(() => normalizeSearchQuery(123 as any)).not.toThrow();
    expect(() => normalizeSearchQuery({} as any)).not.toThrow();
  });
});

// ---------- SS-P2: normalizeSearchQuery 永不抛错 ----------

describe('SS-P2: normalizeSearchQuery 永远返回 string 类型', () => {
  it('对任意输入返回 string', () => {
    fc.assert(
      fc.property(fcAnyString, (q) => {
        expect(() => normalizeSearchQuery(q)).not.toThrow();
        expect(typeof normalizeSearchQuery(q)).toBe('string');
      }),
      { numRuns: 300 },
    );
  });
});

// ---------- SS-P3: normalizeSearchHaystack 与 normalizeSearchQuery 对齐 ----------

describe('SS-P3: normalizeSearchHaystack 与 normalizeSearchQuery 用同一 fold 逻辑', () => {
  it('对相同输入两者结果相同', () => {
    fc.assert(
      fc.property(fcAnyString, (s) => {
        expect(normalizeSearchHaystack(s)).toBe(normalizeSearchQuery(s));
      }),
      { numRuns: 300 },
    );
  });
});

// ---------- SS-P4: tokenizeSearchQuery 与 normalizeSearchQuery 一致 ----------

describe('SS-P4: tokenizeSearchQuery 与 normalizeSearchQuery 一致', () => {
  it('tokenize(q).join(" ") === normalize(q)（在无非空 token 的常见情况下）', () => {
    fc.assert(
      fc.property(fcAnyString, (q) => {
        const normalized = normalizeSearchQuery(q);
        const tokens = tokenizeSearchQuery(q);
        // tokens 是 normalized split(' ').filter(Boolean)
        expect(tokens).toEqual(normalized.split(' ').filter(Boolean));
      }),
      { numRuns: 300 },
    );
  });

  it('空查询 → 空 tokens', () => {
    expect(tokenizeSearchQuery('')).toEqual([]);
    expect(tokenizeSearchQuery(null)).toEqual([]);
    expect(tokenizeSearchQuery('   ')).toEqual([]);
  });

  it('isEmptySearchQuery 与 normalize 等价', () => {
    fc.assert(
      fc.property(fcAnyString, (q) => {
        expect(isEmptySearchQuery(q)).toBe(normalizeSearchQuery(q) === '');
      }),
      { numRuns: 200 },
    );
  });
});

// ---------- SS-P5: textMatchesTokens AND 语义 ----------

describe('SS-P5: textMatchesTokens AND 语义', () => {
  it('textMatchesTokens(hay, tokens) === tokens.every(t => normalizeHaystack(hay).includes(t))', () => {
    fc.assert(
      fc.property(fcAnyString, fc.array(fcToken, { maxLength: 5 }), (hay, tokens) => {
        const expected = tokens.length > 0 && tokens.every(t => normalizeSearchHaystack(hay).includes(t));
        expect(textMatchesTokens(hay, tokens)).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it('空 tokens → false', () => {
    expect(textMatchesTokens('anything', [])).toBe(false);
  });

  it('textMatchesSearch 与 textMatchesTokens 一致', () => {
    fc.assert(
      fc.property(fcAnyString, fcAnyString, (hay, query) => {
        const direct = textMatchesSearch(hay, query);
        const viaTokens = textMatchesTokens(hay, tokenizeSearchQuery(query));
        expect(direct).toBe(viaTokens);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------- SS-P6: ellipsizeCodepoints 码点安全 ----------

describe('SS-P6: ellipsizeCodepoints 码点安全 — 结果码点数 <= maxCp', () => {
  it('对合法 maxCp 成立', () => {
    fc.assert(
      fc.property(fcValidUnicode, fcMaxCp, (text, maxCp) => {
        const result = ellipsizeCodepoints(text, maxCp);
        const cpCount = codepointCount(result);
        expect(cpCount).toBeLessThanOrEqual(maxCp);
      }),
      { numRuns: 300 },
    );
  });

  it('结果不含 lone surrogate', () => {
    fc.assert(
      fc.property(fcValidUnicode, fcMaxCp, (text, maxCp) => {
        const result = ellipsizeCodepoints(text, maxCp);
        expect(LONE_SURROGATE_REGEX.test(result)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('maxCp=Infinity 返回原文', () => {
    fc.assert(
      fc.property(fcValidUnicode, (text) => {
        expect(ellipsizeCodepoints(text, Infinity)).toBe(text);
      }),
      { numRuns: 100 },
    );
  });

  it('maxCp=0/负数/NaN 回落到默认值（不抛错）', () => {
    fc.assert(
      fc.property(fcValidUnicode, fcAnyMaxCp, (text, maxCp) => {
        expect(() => ellipsizeCodepoints(text, maxCp)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('maxCp=1 时返回 "…"', () => {
    fc.assert(
      fc.property(fcValidUnicode.filter(s => s.length > 0), (text) => {
        // 仅当原文非空且需要截断时
        if (codepointCount(text) > 1) {
          expect(ellipsizeCodepoints(text, 1)).toBe('…');
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------- SS-P7: ellipsizeCodepoints 单调性 ----------

describe('SS-P7: ellipsizeCodepoints 单调性 — maxCp 越大结果越长', () => {
  it('maxCp_a <= maxCp_b → cpCount(ellipsize(s,a)) <= cpCount(ellipsize(s,b))', () => {
    fc.assert(
      fc.property(fcValidUnicode, fcMaxCp, fcMaxCp, (text, a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const ra = ellipsizeCodepoints(text, lo);
        const rb = ellipsizeCodepoints(text, hi);
        expect(codepointCount(ra)).toBeLessThanOrEqual(codepointCount(rb));
      }),
      { numRuns: 200 },
    );
  });
});

// ---------- SS-P8: ellipsizeCodepoints 幂等性 ----------

describe('SS-P8: ellipsizeCodepoints 幂等性 — 二次截断不改变结果', () => {
  it('ellipsize(ellipsize(s, maxCp), maxCp) === ellipsize(s, maxCp)', () => {
    fc.assert(
      fc.property(fcValidUnicode, fcMaxCp, (text, maxCp) => {
        const once = ellipsizeCodepoints(text, maxCp);
        const twice = ellipsizeCodepoints(once, maxCp);
        expect(twice).toBe(once);
      }),
      { numRuns: 300 },
    );
  });
});

// ---------- SS-P9: makeSearchSnippet 码点上限 ----------

describe('SS-P9: makeSearchSnippet 结果码点数 <= maxLen', () => {
  it('对任意 (text, query, maxLen) 成立', () => {
    fc.assert(
      fc.property(fcValidUnicode, fcAnyString, fcMaxCp, (text, query, maxLen) => {
        const result = makeSearchSnippet(text, query, maxLen);
        expect(codepointCount(result)).toBeLessThanOrEqual(maxLen);
      }),
      { numRuns: 300 },
    );
  });

  it('结果不含 lone surrogate', () => {
    fc.assert(
      fc.property(fcValidUnicode, fcAnyString, fcMaxCp, (text, query, maxLen) => {
        const result = makeSearchSnippet(text, query, maxLen);
        expect(LONE_SURROGATE_REGEX.test(result)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});

// ---------- SS-P10: makeSearchSnippet 永不抛错 ----------

describe('SS-P10: makeSearchSnippet 对任意输入不抛错', () => {
  it('返回 string 类型', () => {
    fc.assert(
      fc.property(fcAnyString, fcAnyString, fcAnyMaxCp, (text, query, maxLen) => {
        expect(() => makeSearchSnippet(text, query, maxLen)).not.toThrow();
        expect(typeof makeSearchSnippet(text, query, maxLen)).toBe('string');
      }),
      { numRuns: 200 },
    );
  });

  it('null/undefined text → 空字符串', () => {
    expect(makeSearchSnippet(null as any, 'query')).toBe('');
    expect(makeSearchSnippet(undefined as any, 'query')).toBe('');
  });
});

// ---------- SS-P11: makeSearchSnippet 命中包含性 ----------

describe('SS-P11: makeSearchSnippet 在 maxLen 足够时包含命中 token', () => {
  it('当 token 命中且 maxLen 足够大时，结果包含 token', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 32 }),
        fcToken,
        fc.integer({ min: 50, max: 200 }),
        (prefix, token, maxLen) => {
          // 构造确保命中的文本
          const text = `${prefix}${token} trailing content here`;
          const result = makeSearchSnippet(text, token, maxLen);
          // 结果应包含 token（小写比较）
          expect(result.toLowerCase()).toContain(token.toLowerCase());
        },
      ),
      { numRuns: 200 },
    );
  });
});
