/**
 * L4 属性测试：sessionTitle 不变量
 *
 * 用 fast-check 验证 sessionTitle 模块的核心不变量。
 * ST1-ST100 对抗测试已修复大量 Unicode bug，本套件防止回归。
 *
 * 不变量清单：
 *  - ST-P1: sanitizeSessionTitleText 幂等性
 *  - ST-P2: sanitize 后无 lone surrogate
 *  - ST-P3: sanitize 后无 Bidi 控制符（Cf 类）
 *  - ST-P4: truncateSessionTitle 码点安全（结果码点数 <= maxLen + 1）
 *  - ST-P5: truncateSessionTitle 单调性（maxLen 越大结果越长）
 *  - ST-P6: withTitleCollisionSuffix 结果不在 existing 集合
 *  - ST-P7: deriveSessionTitle 永远返回非空字符串
 *  - ST-P8: sanitizeSessionTitleText 永远返回 string 类型（不抛错）
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  EMPTY_SESSION_TITLE,
  SESSION_TITLE_MAX_LEN,
  deriveSessionTitle,
  isDefaultSessionTitle,
  sanitizeSessionTitleText,
  truncateSessionTitle,
  withTitleCollisionSuffix,
} from './sessionTitle';

// ---------- arbitraries ----------

/** 任意 Unicode 字符串（可能含 lone surrogate、控制符、Bidi、emoji 等）。 */
const fcAnyString = fc.string({ minLength: 0, maxLength: 512 });

/** 不含 lone surrogate 的合法 Unicode 字符串。 */
const fcValidUnicode = fcAnyString.filter(s => {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);
});

/** 合法 maxLen 值（正整数）。 */
const fcMaxLen = fc.integer({ min: 1, max: 100 });

/** 任意 maxLen 值（含 0、负数、NaN、Infinity、小数）。 */
const fcAnyMaxLen = fc.oneof(
  fc.integer({ min: -10, max: 0 }),
  fc.integer({ min: 1, max: 100 }),
  fc.double({ min: -5, max: 50, noNaN: false }),
  fc.constant(NaN),
  fc.constant(Infinity),
  fc.constant(-Infinity),
);

// ---------- helpers ----------

const LONE_SURROGATE_REGEX = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

// Cf 类（Format 字符）— 包括 Bidi 控制、变体选择符等
// 注意：sanitize 后可能仍保留 ZWJ（U+200D）以保护 emoji 序列
const CF_CHARS_REGEX = /[\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\uE0000-\uE007F]/u;

function codepointCount(s: string): number {
  return Array.from(s).length;
}

// ---------- ST-P1: sanitize 幂等性 ----------

describe('ST-P1: sanitizeSessionTitleText 幂等性 — sanitize(sanitize(s)) === sanitize(s)', () => {
  it('对任意字符串成立', () => {
    fc.assert(
      fc.property(fcAnyString, (s) => {
        const once = sanitizeSessionTitleText(s);
        const twice = sanitizeSessionTitleText(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 300 },
    );
  });

  it('对 null/undefined 不抛错', () => {
    expect(sanitizeSessionTitleText(null)).toBe('');
    expect(sanitizeSessionTitleText(undefined)).toBe('');
  });
});

// ---------- ST-P2: sanitize 后无 lone surrogate ----------

describe('ST-P2: sanitize 后结果不含 lone surrogate', () => {
  it('对任意字符串（含 lone surrogate 输入）成立', () => {
    fc.assert(
      fc.property(fcAnyString, (s) => {
        const result = sanitizeSessionTitleText(s);
        expect(LONE_SURROGATE_REGEX.test(result)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});

// ---------- ST-P3: sanitize 后无危险 Cf 类字符（Bidi / VS / Tag 块等） ----------

describe('ST-P3: sanitize 后结果不含 Bidi 控制符 / Variation Selectors / Tag 块', () => {
  // 注意：ZWJ (U+200D) 在中间位置允许保留以保护 emoji 序列
  // 但首尾不允许（已由 BOUNDARY_ZWJ 剥离）
  it('首尾不含 ZWJ（U+200D）', () => {
    fc.assert(
      fc.property(fcAnyString, (s) => {
        const result = sanitizeSessionTitleText(s);
        if (result.length > 0) {
          expect(result.startsWith('\u200D')).toBe(false);
          expect(result.endsWith('\u200D')).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('不含 Bidi Isolate（U+2066-U+2069）', () => {
    fc.assert(
      fc.property(fcAnyString, (s) => {
        const result = sanitizeSessionTitleText(s);
        for (let i = 0; i < result.length; i++) {
          const cp = result.codePointAt(i)!;
          expect(cp).not.toBeGreaterThanOrEqual(0x2066);
          // 简化：只要不出现 0x2066-0x2069 即可
        }
        // 直接正则校验更稳：
        expect(/[\u2066-\u2069]/u.test(result)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('不含 Variation Selectors（U+FE00-U+FE0F）', () => {
    fc.assert(
      fc.property(fcAnyString, (s) => {
        const result = sanitizeSessionTitleText(s);
        expect(/[\uFE00-\uFE0F]/u.test(result)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('不含 Language Tag 块（U+E0000-U+E007F）', () => {
    fc.assert(
      fc.property(fcAnyString, (s) => {
        const result = sanitizeSessionTitleText(s);
        // U+E0000-U+E007F 是 Supplementary Plane 字符，需用 \u{...} 语法
        expect(/[\u{E0000}-\u{E007F}]/u.test(result)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('不含 BOM（U+FEFF）', () => {
    fc.assert(
      fc.property(fcAnyString, (s) => {
        const result = sanitizeSessionTitleText(s);
        expect(result.includes('\uFEFF')).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------- ST-P4: truncate 码点安全 ----------

describe('ST-P4: truncateSessionTitle 码点安全 — 结果码点数 <= maxLen + 1', () => {
  it('对合法 maxLen 成立', () => {
    fc.assert(
      fc.property(fcValidUnicode, fcMaxLen, (s, maxLen) => {
        const result = truncateSessionTitle(s, maxLen);
        const cpCount = codepointCount(result);
        // 结果要么是原文（<= maxLen），要么是 maxLen 码点 + '…' = maxLen + 1
        if (codepointCount(s) <= maxLen) {
          expect(result).toBe(s);
        } else {
          expect(cpCount).toBe(maxLen + 1);
          expect(result.endsWith('…')).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('结果不含 lone surrogate', () => {
    fc.assert(
      fc.property(fcValidUnicode, fcMaxLen, (s, maxLen) => {
        const result = truncateSessionTitle(s, maxLen);
        expect(LONE_SURROGATE_REGEX.test(result)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('对任意 maxLen（含 0/负/NaN/Infinity/小数）不抛错', () => {
    fc.assert(
      fc.property(fcValidUnicode, fcAnyMaxLen, (s, maxLen) => {
        expect(() => truncateSessionTitle(s, maxLen)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('maxLen=Infinity 返回原文', () => {
    fc.assert(
      fc.property(fcValidUnicode, (s) => {
        expect(truncateSessionTitle(s, Infinity)).toBe(s);
      }),
      { numRuns: 100 },
    );
  });

  it('maxLen=0/负数/NaN 回落到 SESSION_TITLE_MAX_LEN', () => {
    fc.assert(
      fc.property(fcValidUnicode, (s) => {
        const fallback = truncateSessionTitle(s, SESSION_TITLE_MAX_LEN);
        expect(truncateSessionTitle(s, 0)).toBe(fallback);
        expect(truncateSessionTitle(s, -1)).toBe(fallback);
        expect(truncateSessionTitle(s, NaN)).toBe(fallback);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------- ST-P5: truncate 单调性 ----------

describe('ST-P5: truncateSessionTitle 单调性 — maxLen 越大结果越长', () => {
  it('maxLen_a <= maxLen_b → cpCount(truncate(s,a)) <= cpCount(truncate(s,b))', () => {
    fc.assert(
      fc.property(fcValidUnicode, fcMaxLen, fcMaxLen, (s, a, b) => {
        // 保证 a <= b
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const ra = truncateSessionTitle(s, lo);
        const rb = truncateSessionTitle(s, hi);
        expect(codepointCount(ra)).toBeLessThanOrEqual(codepointCount(rb));
      }),
      { numRuns: 200 },
    );
  });
});

// ---------- ST-P6: withTitleCollisionSuffix 不冲突 ----------

describe('ST-P6: withTitleCollisionSuffix 结果不在 existing 集合', () => {
  const fcExisting = fc.array(fc.string({ minLength: 1, maxLength: 32 }), { maxLength: 10 });

  it('结果不与 existing 中任何条目冲突（trim 后比较）', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 32 }), fcExisting, (base, existing) => {
        const result = withTitleCollisionSuffix(base, existing);
        const existingTrimmed = new Set(existing.map(s => s.trim()));
        expect(existingTrimmed.has(result.trim())).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('base 为空时回落到 EMPTY_SESSION_TITLE 或其变体', () => {
    fc.assert(
      fc.property(fcExisting, (existing) => {
        const result = withTitleCollisionSuffix('', existing);
        // 结果应以 EMPTY_SESSION_TITLE 开头
        expect(result.startsWith(EMPTY_SESSION_TITLE)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('existing 为空数组时结果 === base.trim()（无冲突）', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 32 }), (base) => {
        const result = withTitleCollisionSuffix(base, []);
        expect(result).toBe(base.trim());
      }),
      { numRuns: 100 },
    );
  });
});

// ---------- ST-P7: deriveSessionTitle 永远非空 ----------

describe('ST-P7: deriveSessionTitle 永远返回非空字符串', () => {
  it('对任意输入返回非空字符串', () => {
    fc.assert(
      fc.property(fcAnyString, fcAnyMaxLen, (text, maxLen) => {
        const result = deriveSessionTitle(text, maxLen);
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  it('空输入返回 EMPTY_SESSION_TITLE', () => {
    expect(deriveSessionTitle('')).toBe(EMPTY_SESSION_TITLE);
    expect(deriveSessionTitle('   ')).toBe(EMPTY_SESSION_TITLE);
    expect(deriveSessionTitle(null as any)).toBe(EMPTY_SESSION_TITLE);
  });
});

// ---------- ST-P8: sanitize 永远不抛错 ----------

describe('ST-P8: sanitizeSessionTitleText 对任意输入不抛错', () => {
  it('返回 string 类型', () => {
    fc.assert(
      fc.property(fcAnyString, (s) => {
        expect(() => sanitizeSessionTitleText(s)).not.toThrow();
        expect(typeof sanitizeSessionTitleText(s)).toBe('string');
      }),
      { numRuns: 300 },
    );
  });

  it('对 100KB 输入不抛错（性能基线）', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 100 * 1024, maxLength: 100 * 1024 + 10 }), (s) => {
        const start = Date.now();
        expect(() => sanitizeSessionTitleText(s)).not.toThrow();
        const elapsed = Date.now() - start;
        // 不应超过 200ms（防止 ReDoS）
        expect(elapsed).toBeLessThan(200);
      }),
      { numRuns: 5 },
    );
  });
});

// ---------- ST-P9: isDefaultSessionTitle 一致性 ----------

describe('ST-P9: isDefaultSessionTitle 与 sanitize 的一致性', () => {
  it('sanitize 后「新会话」仍被识别为默认', () => {
    fc.assert(
      fc.property(fcAnyString, (s) => {
        // sanitize 不会把非默认标题变成默认，也不会把默认变成非默认
        const sanitized = sanitizeSessionTitleText(s);
        // 「新会话」及带数字后缀的变体
        if (sanitized === EMPTY_SESSION_TITLE || /^新会话 \d+$/.test(sanitized)) {
          expect(isDefaultSessionTitle(sanitized)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
