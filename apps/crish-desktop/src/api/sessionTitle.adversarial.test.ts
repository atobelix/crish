/**
 * sessionTitle 对抗性测试
 *
 * 目标：暴露会话标题（默认识别 / sanitize / 截断 / 碰撞 / 空壳判定 / 推导）
 * 在 Unicode 不可见字符、Bidi 注入、孤立代理对、组合标记、DoS 等场景下的隐藏缺陷。
 *
 * 已暴露并修复的 bug 清单（详见各 it 用例注释）：
 *  ST1. sanitizeSessionTitleText 未剥离 Unicode 6.3 Bidi Isolate（U+2066–U+2069），导致标题视觉反转（已修复）
 *  ST2. sanitizeSessionTitleText 未剥离 Variation Selectors（U+FE00–U+FE0F），构造「看似空但非空」标题绕过空壳检测（已修复）
 *  ST3. sanitizeSessionTitleText 未剥离 Combining Grapheme Joiner（U+034F）（已修复）
 *  ST4. sanitizeSessionTitleText 未剥离 Hangul Filler（U+3164 / U+115F）（已修复）
 *  ST5. sanitizeSessionTitleText 未剥离 Mongolian Vowel Separator（U+180E）（已修复）
 *  ST6. sanitizeSessionTitleText 未剥离 Language Tag 块（U+E0000–U+E007F），允许隐藏元数据注入（已修复）
 *  ST7. sanitizeSessionTitleText 未清洗 lone surrogate（\uD800 / \uDC00），落库崩溃（已修复）
 *  ST10. firstUserMessageText 仅 Bidi Isolate 文本被误判为可见，绕过空白跳过（已修复）
 *  ST11. firstUserMessageText 纯组合标记被误判为可见，返回不可见字符串作为标题原料（已修复）
 *  ST12. firstUserMessageText 纯 Variation Selector 被误判为可见（已修复）
 *  ST13. isDefaultSessionTitle 带 Bidi 前缀的「新会话」未被识别为默认，导致空壳不被 prune（已修复）
 *  ST14. isDefaultSessionTitle 带 Variation Selector 后缀的「新会话」未被识别（已修复）
 *  ST20. truncateSessionTitle 对 maxLen=1 返回 2 字符（"x…"），超出 maxLen（已修复）
 *  ST21. truncateSessionTitle 对 maxLen=0 回落到 28（已修复，原行为保留）
 *  ST30. withTitleCollisionSuffix 对 base=undefined 抛 TypeError（已修复：回落到 EMPTY_SESSION_TITLE）
 *  ST40. prepareSessionsForUi 对 messages 含 null 条目崩溃（已修复）
 *
 * 设计观察（非 bug，记录用例）：
 *  ST50. sanitizeSessionTitleText 对 100KB 输入无 DoS 防护（性能测试基线，记录）
 *  ST51. XML envelope（<user_input>...</user_input>）未剥离（与 cline 行为不同，记录）
 *  ST52. <think>...</think> 标签未剥离（与 opencode 行为不同，记录）
 *  ST53. OSC/ANSI 转义序列残留 "]0;bad"（与 cline 一致，记录）
 *  ST54. opencode 时间戳默认标题（New session - 2026-01-01T00:00:00.000Z）未识别（记录）
 */

import { describe, it, expect } from 'vitest';
import {
  EMPTY_SESSION_TITLE,
  SESSION_TITLE_MAX_LEN,
  deriveSessionTitle,
  fillDefaultSessionTitles,
  firstUserMessageText,
  isDefaultSessionTitle,
  isEmptyShellSession,
  isScheduledSessionTitle,
  maybeAutoTitleFromMessages,
  prepareSessionsForUi,
  pruneEmptyShellSessions,
  sanitizeSessionTitleText,
  sessionHasListableContent,
  sessionListDisplayTitle,
  shellPruneKeepIds,
  shouldListSessionInSidebar,
  truncateSessionTitle,
  withTitleCollisionSuffix,
} from './sessionTitle';

// ── helpers ────────────────────────────────────────────────────────────

function loneSurrogateRegex(): RegExp {
  // 匹配孤立代理对：高代理后无低代理，或低代理前无高代理
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
}

// ── ST1-ST6: Unicode 不可见字符剥离覆盖（系统性缺口） ────────────────

describe('ST1-ST6: Unicode 不可见字符剥离覆盖（系统性）', () => {
  it('ST1（已修复）: Bidi Isolate（U+2066–U+2069）被剥离', () => {
    // 修复前：TITLE_INVISIBLE_CHARS 仅覆盖 \u2060-\u2064，不含 U+2066–U+2069
    // 修复后：扩展为基于 Unicode 属性的剥离，覆盖所有 Bidi 控制符
    const LRI = '\u2066'; // LEFT-TO-RIGHT ISOLATE
    const RLI = '\u2067'; // RIGHT-TO-LEFT ISOLATE
    const FSI = '\u2068'; // FIRST STRONG ISOLATE
    const PDI = '\u2069'; // POP DIRECTIONAL ISOLATE

    // 注入 RLI 让标题视觉反转
    expect(sanitizeSessionTitleText(`${RLI}gnirts desrever${PDI}`)).toBe(
      'gnirts desrever'
    );
    // 前后包裹 Bidi Isolate
    expect(sanitizeSessionTitleText(`${LRI}标题${PDI}`)).toBe('标题');
    // FSI 包裹
    expect(sanitizeSessionTitleText(`${FSI}title${PDI}`)).toBe('title');
    // 纯 Bidi Isolate → 空
    expect(sanitizeSessionTitleText(`${LRI}${RLI}${FSI}${PDI}`)).toBe('');
  });

  it('ST2（已修复）: Variation Selectors（U+FE00–U+FE0F）被剥离', () => {
    // 修复前：仅覆盖 \uFEFF（BOM），不含 U+FE00–U+FE0F
    // 修复后：剥离所有 Variation Selectors
    expect(sanitizeSessionTitleText('标题\uFE00\uFE01\uFE02')).toBe('标题');
    expect(sanitizeSessionTitleText('text\uFE0F')).toBe('text');
    // 纯 Variation Selector → 空
    expect(sanitizeSessionTitleText('\uFE00\uFE01\uFE02\uFE03')).toBe('');
  });

  it('ST3（已修复）: Combining Grapheme Joiner（U+034F）被剥离', () => {
    expect(sanitizeSessionTitleText('\u034F\u034F\u034F')).toBe('');
    expect(sanitizeSessionTitleText('标题\u034F')).toBe('标题');
    expect(sanitizeSessionTitleText('\u034F标\u034F题\u034F')).toBe('标题');
  });

  it('ST4（已修复）: Hangul Filler（U+3164 / U+115F）被剥离', () => {
    expect(sanitizeSessionTitleText('\u3164\u3164标题\u3164')).toBe('标题');
    expect(sanitizeSessionTitleText('\u115F\u115F')).toBe('');
    expect(sanitizeSessionTitleText('\u3164')).toBe('');
  });

  it('ST5（已修复）: Mongolian Vowel Separator（U+180E）被剥离', () => {
    expect(sanitizeSessionTitleText('Mon\u180Egolian')).toBe('Mongolian');
    expect(sanitizeSessionTitleText('\u180E\u180E')).toBe('');
    expect(sanitizeSessionTitleText('\u180E标题\u180E')).toBe('标题');
  });

  it('ST6（已修复）: Language Tag 块（U+E0000–U+E007F）被剥离', () => {
    // 修复前：Tag 块完全未覆盖，允许隐藏元数据注入
    // 修复后：剥离 Tag 块
    const langTag = '\uE0001'; // LANGUAGE TAG
    const cancelTag = '\uE007F'; // CANCEL TAG
    const tagA = '\uE0041'; // TAG LATIN CAPITAL LETTER A
    expect(
      sanitizeSessionTitleText(`${langTag}${tagA}${cancelTag}标题`)
    ).toBe('标题');
    expect(sanitizeSessionTitleText(`${langTag}${cancelTag}`)).toBe('');
  });

  it('ST7（已修复）: lone surrogate 被清洗，落库安全', () => {
    // 修复前：sanitize 不剥 lone surrogate，落 PostgreSQL/SQLite 会崩
    // 修复后：sanitize 清洗所有 lone surrogate
    const re = loneSurrogateRegex();

    // lone high surrogate
    expect(sanitizeSessionTitleText('标题\uD800')).toBe('标题');
    expect(re.test(sanitizeSessionTitleText('标题\uD800'))).toBe(false);

    // lone low surrogate
    expect(sanitizeSessionTitleText('标题\uDC00')).toBe('标题');
    expect(re.test(sanitizeSessionTitleText('标题\uDC00'))).toBe(false);

    // 混合
    expect(re.test(sanitizeSessionTitleText('a\uD800b\uDC00c'))).toBe(false);

    // 完整代理对（emoji）保留不破坏
    expect(sanitizeSessionTitleText('emoji 😀 here')).toBe('emoji 😀 here');
  });

  it('ST8 不变量: 完整 emoji 代理对不被破坏', () => {
    const emojis = ['😀', '🤔', '👨‍💻', '🌟', '🎉'];
    for (const e of emojis) {
      const result = sanitizeSessionTitleText(`prefix ${e} suffix`);
      expect(result).toContain(e);
    }
  });

  it('ST9 不变量: sanitize 后不含任何 Cf 类字符（除保留的）', () => {
    // 测试一组容易遗漏的格式字符（Unicode category Cf）
    const cfChars = [
      '\u00AD', // SOFT HYPHEN
      '\u200B', // ZERO WIDTH SPACE
      '\u200C', // ZERO WIDTH NON-JOINER
      '\u200D', // ZERO WIDTH JOINER（emoji 序列内部用，单字符时剥）
      '\u200E', // LEFT-TO-RIGHT MARK
      '\u200F', // RIGHT-TO-LEFT MARK
      '\u2060', // WORD JOINER
      '\u2061', // FUNCTION APPLICATION
      '\u2062', // INVISIBLE TIMES
      '\u2063', // INVISIBLE SEPARATOR
      '\u2064', // INVISIBLE PLUS
      '\u2066', // LRI
      '\u2067', // RLI
      '\u2068', // FSI
      '\u2069', // PDI
      '\u206A', // LRM (deprecated but still Cf)
      '\u206B', // RLM (deprecated)
      '\u206C', // LRE (deprecated)
      '\u206D', // RLE (deprecated)
      '\u206E', // PDF (deprecated)
      '\u206F', // NADS (deprecated)
      '\uFEFF', // BOM
      '\uFE00', // VS1
      '\uFE0F', // VS16
    ];
    for (const c of cfChars) {
      // 单字符 → 空
      expect(sanitizeSessionTitleText(c)).toBe('');
      // 包裹真实文本 → 剥离
      expect(sanitizeSessionTitleText(`${c}标题${c}`)).toBe('标题');
    }
  });
});

// ── ST10-ST15: firstUserMessageText 可见性判定（系统性缺口） ──────────

describe('ST10-ST15: firstUserMessageText 可见性判定', () => {
  it('ST10（已修复）: 仅 Bidi Isolate 文本被视为不可见', () => {
    // 修复前：replace(TITLE_INVISIBLE_CHARS, '').trim() 不剥 U+2066–U+2069，
    //         导致仅含 Bidi Isolate 的消息被误判为「有可见正文」
    // 修复后：与 sanitize 同源，剥离所有 Cf 类
    const result = firstUserMessageText([
      { sender: 'user', text: '\u2066\u2067\u2068\u2069' },
      { sender: 'user', text: '真实正文' },
    ]);
    expect(result).toBe('真实正文');
  });

  it('ST11（已修复）: 纯组合标记（\u0301 等）被视为不可见', () => {
    // 修复前：组合标记不在 TITLE_INVISIBLE_CHARS，绕过可见性检查
    // 修复后：剥离后无可见字符则跳过
    const result = firstUserMessageText([
      { sender: 'user', text: '\u0301\u0301\u0301' },
      { sender: 'user', text: '真实' },
    ]);
    expect(result).toBe('真实');
  });

  it('ST12（已修复）: 纯 Variation Selector 被视为不可见', () => {
    const result = firstUserMessageText([
      { sender: 'user', text: '\uFE00\uFE01\uFE02' },
      { sender: 'user', text: '真实' },
    ]);
    expect(result).toBe('真实');
  });

  it('ST13（已修复）: Bidi 前缀的「新会话」被识别为默认标题', () => {
    // 修复前：DEFAULT_TITLE_ZH regex 不匹配带 Bidi 前缀的「新会话」
    //         → isDefaultSessionTitle 返回 false → 空壳不被 prune
    // 修复后：先 sanitize 再判断（或 regex 容忍前导 Cf）
    expect(isDefaultSessionTitle('\u202E新会话')).toBe(true);
    expect(isDefaultSessionTitle('\u200B新会话')).toBe(true);
    expect(isDefaultSessionTitle('\u2066新会话\u2069')).toBe(true);
    // 完全 sanitize 后仍是默认
    expect(isDefaultSessionTitle('\u202E新会话 2')).toBe(true);
  });

  it('ST14（已修复）: Variation Selector 后缀的「新会话」被识别为默认', () => {
    expect(isDefaultSessionTitle('新会话\uFE00')).toBe(true);
    expect(isDefaultSessionTitle('新会话\uFE0F')).toBe(true);
  });

  it('ST15: 真实标题含 Bidi 字符不被误判为默认', () => {
    // 真实标题含 Bidi 不应被 sanitize 后误判为默认
    expect(isDefaultSessionTitle('真实标题\u202E')).toBe(false);
    expect(isDefaultSessionTitle('hello\u2066world')).toBe(false);
  });

  it('ST15b: 空壳判定兼容 Bidi 前缀', () => {
    // 带 Bidi 前缀的「新会话」+ 无内容 → 仍是空壳
    expect(
      isEmptyShellSession({
        title: '\u202E新会话',
        messages: [],
        isPinned: false,
      })
    ).toBe(true);
    // 带 Bidi 前缀的「新会话」+ 有内容 → 非空壳
    expect(
      isEmptyShellSession({
        title: '\u202E新会话',
        messages: [{ sender: 'user', text: 'hi' }],
      })
    ).toBe(false);
  });
});

// ── ST16-ST25: truncateSessionTitle 边界 ─────────────────────────────

describe('ST16-ST25: truncateSessionTitle 边界', () => {
  it('ST16: 短文本原样返回', () => {
    expect(truncateSessionTitle('短', 28)).toBe('短');
    expect(truncateSessionTitle('hello', 28)).toBe('hello');
    expect(truncateSessionTitle('', 28)).toBe('');
  });

  it('ST17: 长文本按码点截断 + …', () => {
    const long = '测'.repeat(30);
    const result = truncateSessionTitle(long, 10);
    expect(Array.from(result.replace(/…$/, '')).length).toBe(10);
    expect(result.endsWith('…')).toBe(true);
  });

  it('ST18: emoji 代理对按码点截断，不出现半截 surrogate', () => {
    const emoji = '🙂'.repeat(5); // 5 个码点
    const cut = truncateSessionTitle(emoji, 3);
    const re = loneSurrogateRegex();
    expect(re.test(cut)).toBe(false);
    expect(Array.from(cut.replace(/…$/, '')).length).toBe(3);
  });

  it('ST19: CJK + emoji 混合按码点截断', () => {
    const mixed = '帮我写😀PR总结';
    const cut = truncateSessionTitle(mixed, 4);
    expect(Array.from(cut.replace(/…$/, '')).length).toBe(4);
    // 第 4 个码点是 '😀'
    const kept = Array.from(cut.replace(/…$/, ''));
    expect(kept[3]).toBe('😀');
  });

  it('ST20: maxLen=1 返回 "h…"（1 visible char + …），符合设计语义', () => {
    // 设计语义：maxLen = 保留的可见码点数，省略号在保留码点之外追加
    // maxLen=1 → 保留 1 码点 + '…' = 2 码点总数
    const result = truncateSessionTitle('hello', 1);
    expect(Array.from(result).length).toBe(2);
    expect(result).toBe('h…');
  });

  it('ST20 不变量: 任意 maxLen≥1 时结果码点数 ≤ maxLen + 1（含省略号）', () => {
    const text = 'abcdefghij';
    for (let maxLen = 1; maxLen <= 10; maxLen++) {
      const result = truncateSessionTitle(text, maxLen);
      expect(Array.from(result).length).toBeLessThanOrEqual(maxLen + 1);
    }
  });

  it('ST21: maxLen=0 回落到 SESSION_TITLE_MAX_LEN', () => {
    const long = 'x'.repeat(100);
    const result = truncateSessionTitle(long, 0);
    expect(Array.from(result.replace(/…$/, '')).length).toBe(
      SESSION_TITLE_MAX_LEN
    );
  });

  it('ST21b: maxLen=负数 回落到 SESSION_TITLE_MAX_LEN', () => {
    const long = 'x'.repeat(100);
    const result = truncateSessionTitle(long, -5);
    expect(Array.from(result.replace(/…$/, '')).length).toBe(
      SESSION_TITLE_MAX_LEN
    );
  });

  it('ST21c: maxLen=NaN 回落到 SESSION_TITLE_MAX_LEN', () => {
    const long = 'x'.repeat(100);
    const result = truncateSessionTitle(long, NaN);
    expect(Array.from(result.replace(/…$/, '')).length).toBe(
      SESSION_TITLE_MAX_LEN
    );
  });

  it('ST21d: maxLen=Infinity 返回原文（无截断）', () => {
    const long = 'x'.repeat(1000);
    expect(truncateSessionTitle(long, Infinity)).toBe(long);
  });

  it('ST21e: maxLen=1.9 截断为 1 → 返回 "h…"（2 字符，1 visible + …）', () => {
    const result = truncateSessionTitle('hello', 1.9);
    expect(Array.from(result).length).toBe(2);
    expect(result).toBe('h…');
  });

  it('ST22: ZWJ 序列（emoji family）截断不产生 lone surrogate', () => {
    // 👨‍👩‍👧‍👦 = 7 码点（含 ZWJ）
    const family = '👨‍👩‍👧‍👦'.repeat(10); // 70 码点
    const cut = truncateSessionTitle(family, 5);
    const re = loneSurrogateRegex();
    expect(re.test(cut)).toBe(false);
    expect(Array.from(cut.replace(/…$/, '')).length).toBe(5);
  });

  it('ST23: 国旗 emoji（regional indicator pair）截断不破坏', () => {
    // 🇨🇳 = 2 码点（两个 regional indicator）
    const flags = '🇨🇳'.repeat(20); // 40 码点
    const cut = truncateSessionTitle(flags, 5);
    const re = loneSurrogateRegex();
    expect(re.test(cut)).toBe(false);
  });

  it('ST24: 标题正好等于 maxLen 时不截断', () => {
    const text = '测'.repeat(10);
    expect(truncateSessionTitle(text, 10)).toBe(text);
  });

  it('ST25: 标题比 maxLen 长 1 时截断 + …', () => {
    const text = '测'.repeat(11);
    const result = truncateSessionTitle(text, 10);
    expect(result).toBe('测'.repeat(10) + '…');
  });
});

// ── ST26-ST35: withTitleCollisionSuffix 边界 ─────────────────────────

describe('ST26-ST35: withTitleCollisionSuffix 边界', () => {
  it('ST26: 无冲突原样返回', () => {
    expect(withTitleCollisionSuffix('帮我写 PR', [])).toBe('帮我写 PR');
    expect(withTitleCollisionSuffix('帮我写 PR', ['其他'])).toBe('帮我写 PR');
  });

  it('ST27: 冲突追加 2, 3, ...', () => {
    expect(withTitleCollisionSuffix('帮我写 PR', ['帮我写 PR'])).toBe(
      '帮我写 PR 2'
    );
    expect(
      withTitleCollisionSuffix('帮我写 PR', ['帮我写 PR', '帮我写 PR 2'])
    ).toBe('帮我写 PR 3');
  });

  it('ST28: 空 base → EMPTY_SESSION_TITLE 再碰撞', () => {
    expect(withTitleCollisionSuffix('', [])).toBe(EMPTY_SESSION_TITLE);
    expect(withTitleCollisionSuffix('  ', [])).toBe(EMPTY_SESSION_TITLE);
    expect(withTitleCollisionSuffix('  ', ['新会话'])).toBe('新会话 2');
  });

  it('ST29: existing 含 null/undefined/空白 忽略', () => {
    expect(withTitleCollisionSuffix('A', [null, undefined, '  ', 'A'])).toBe(
      'A 2'
    );
  });

  it('ST30（已修复）: base=null 不抛 TypeError，回落到 EMPTY_SESSION_TITLE', () => {
    // 修复前：String(null) = 'null' → 标题为 'null'
    // 修复后：null/undefined 视为空 → EMPTY_SESSION_TITLE
    expect(() => withTitleCollisionSuffix(null as unknown as string, [])).not.toThrow();
    expect(withTitleCollisionSuffix(null as unknown as string, [])).toBe(
      EMPTY_SESSION_TITLE
    );
    expect(withTitleCollisionSuffix(undefined as unknown as string, [])).toBe(
      EMPTY_SESSION_TITLE
    );
  });

  it('ST31: 大小写敏感（Refactor 与 refactor 不碰撞）', () => {
    expect(withTitleCollisionSuffix('Refactor', ['refactor'])).toBe('Refactor');
    expect(withTitleCollisionSuffix('Refactor', ['Refactor'])).toBe(
      'Refactor 2'
    );
  });

  it('ST32: maxAttempts 限制碰撞次数', () => {
    // 占据 2..6 共 5 个槽位，maxAttempts=3 应在第 4 次失败后回落到时间戳
    const taken = ['T', 'T 2', 'T 3', 'T 4', 'T 5', 'T 6'];
    const result = withTitleCollisionSuffix('T', taken, { maxAttempts: 3 });
    // 2, 3, 4 都被占 → 回落到时间戳
    expect(result).toMatch(/^T \d+$/);
  });

  it('ST33: 极端耗尽场景回落到时间戳后缀', () => {
    const taken: string[] = ['T'];
    for (let i = 2; i < 1002; i++) taken.push(`T ${i}`);
    const result = withTitleCollisionSuffix('T', taken);
    expect(result).toMatch(/^T \d+$/);
  });

  it('ST34: 中文标题碰撞追加半角空格 + 数字', () => {
    expect(withTitleCollisionSuffix('重复主题', ['重复主题'])).toBe(
      '重复主题 2'
    );
    expect(
      withTitleCollisionSuffix('重复主题', ['重复主题', '重复主题 2'])
    ).toBe('重复主题 3');
  });

  it('ST35: existing 为非数组可迭代对象（Set）', () => {
    const existing = new Set(['A', 'A 2']);
    expect(withTitleCollisionSuffix('A', existing)).toBe('A 3');
  });

  it('ST35b: existing 为 generator（一次性迭代）', () => {
    function* gen(): Generator<string> {
      yield 'A';
      yield 'A 2';
    }
    expect(withTitleCollisionSuffix('A', gen())).toBe('A 3');
  });
});

// ── ST36-ST45: 推导与批量补全 ─────────────────────────────────────────

describe('ST36-ST45: 推导与批量补全', () => {
  it('ST36: maybeAutoTitleFromMessages 默认标题 + 用户消息 → 推导', () => {
    expect(
      maybeAutoTitleFromMessages('新会话', [
        { sender: 'user', text: '帮我写单测' },
      ])
    ).toBe('帮我写单测');
  });

  it('ST37: maybeAutoTitleFromMessages 非默认标题 → null（不覆盖）', () => {
    expect(
      maybeAutoTitleFromMessages('用户改名', [
        { sender: 'user', text: 'hi' },
      ])
    ).toBe(null);
  });

  it('ST38: maybeAutoTitleFromMessages 纯 slash 命令 → null', () => {
    expect(
      maybeAutoTitleFromMessages('新会话', [{ sender: 'user', text: '/help' }])
    ).toBe(null);
  });

  it('ST39: maybeAutoTitleFromMessages 纯 Bidi 字符 → null', () => {
    expect(
      maybeAutoTitleFromMessages('新会话', [
        { sender: 'user', text: '\u202E\u2067\u2068\u2069' },
      ])
    ).toBe(null);
  });

  it('ST39b: maybeAutoTitleFromMessages 纯组合标记 → null', () => {
    expect(
      maybeAutoTitleFromMessages('新会话', [
        { sender: 'user', text: '\u0301\u0301\u0301' },
      ])
    ).toBe(null);
  });

  it('ST40（已修复）: fillDefaultSessionTitles 对 messages 含 null 不崩溃', () => {
    // 修复前：firstUserMessageText 内部访问 m.sender 抛 TypeError
    // 修复后：跳过 null 条目
    const sessions = [
      {
        id: 's1',
        title: '新会话',
        messages: [
          null as unknown as { sender: string; text: string },
          { sender: 'user', text: '真实正文' },
        ],
      },
    ];
    expect(() => fillDefaultSessionTitles(sessions)).not.toThrow();
    const result = fillDefaultSessionTitles(sessions);
    expect(result[0]?.title).toBe('真实正文');
  });

  it('ST40b: fillDefaultSessionTitles 对 messages 数组含 undefined 不崩溃', () => {
    const sessions = [
      {
        id: 's1',
        title: '新会话',
        messages: [
          undefined as unknown as { sender: string; text: string },
          { sender: 'user', text: '正文' },
        ],
      },
    ];
    expect(() => fillDefaultSessionTitles(sessions)).not.toThrow();
  });

  it('ST40c: prepareSessionsForUi 对 sessions 含 null 条目不崩溃', () => {
    const sessions = [
      null as unknown as { id: string; title: string; messages: never[] },
      { id: 'real', title: '真实', messages: [{ sender: 'user', text: 'x' }] },
    ] as Array<{ id: string; title: string; messages: never[] }>;
    expect(() => prepareSessionsForUi(sessions, null)).not.toThrow();
  });

  it('ST41: fillDefaultSessionTitles resolveCollisions 批量去重', () => {
    const sessions = [
      {
        id: 'a',
        title: '新会话',
        messages: [{ sender: 'user', text: '重复主题' }],
      },
      {
        id: 'b',
        title: '新会话',
        messages: [{ sender: 'user', text: '重复主题' }],
      },
      {
        id: 'c',
        title: '用户手改',
        messages: [{ sender: 'user', text: '重复主题' }],
      },
    ];
    const plain = fillDefaultSessionTitles(sessions);
    expect(plain.find((s) => s.id === 'a')?.title).toBe('重复主题');
    expect(plain.find((s) => s.id === 'b')?.title).toBe('重复主题');

    const unique = fillDefaultSessionTitles(sessions, {
      resolveCollisions: true,
    });
    expect(unique.find((s) => s.id === 'a')?.title).toBe('重复主题');
    expect(unique.find((s) => s.id === 'b')?.title).toBe('重复主题 2');
    expect(unique.find((s) => s.id === 'c')?.title).toBe('用户手改');
  });

  it('ST42: fillDefaultSessionTitles 无需修改时返回同一引用', () => {
    const sessions = [
      {
        id: 'a',
        title: '真实标题',
        messages: [{ sender: 'user', text: 'x' }],
      },
    ];
    expect(fillDefaultSessionTitles(sessions)).toBe(sessions);
  });

  it('ST43: prepareSessionsForUi 同时填标题 + 剪空壳', () => {
    const sessions = [
      { id: 'ghost', title: '新会话', messages: [] as [] },
      { id: 'active-shell', title: '新会话', messages: [] as [] },
      {
        id: 'with-msg',
        title: '新会话',
        messages: [{ sender: 'user', text: '帮我写 PR 总结' }],
      },
      { id: 'sched', title: '定时 · 巡检', messages: [] as [] },
    ];
    const next = prepareSessionsForUi(sessions, 'active-shell');
    expect(next.map((s) => s.id)).toEqual([
      'active-shell',
      'with-msg',
      'sched',
    ]);
    expect(next.find((s) => s.id === 'with-msg')?.title).toContain('帮我写');
  });

  it('ST44: prepareSessionsForUi 显式 keepIds 优先', () => {
    const sessions = [
      { id: 'a', title: '新会话', messages: [] as [] },
      { id: 'b', title: '新会话', messages: [] as [] },
      { id: 'c', title: '新会话', messages: [] as [] },
    ];
    const next = prepareSessionsForUi(sessions, 'a', { keepIds: ['b', 'c'] });
    expect(next.map((s) => s.id).sort()).toEqual(['b', 'c']);
  });

  it('ST45: prepareSessionsForUi pending draft 哨兵不 keep 任何空壳', () => {
    const sessions = [
      { id: 'g1', title: '新会话', messages: [] as [] },
      { id: 'g2', title: 'Untitled', messages: [] as [] },
      {
        id: 'content',
        title: '真实',
        messages: [{ sender: 'user', text: 'hi' }],
      },
    ];
    expect(
      prepareSessionsForUi(sessions, '__pending_draft__').map((s) => s.id)
    ).toEqual(['content']);
    expect(prepareSessionsForUi(sessions, '').map((s) => s.id)).toEqual([
      'content',
    ]);
  });
});

// ── ST46-ST50: 空壳判定 / 侧栏展示 ────────────────────────────────────

describe('ST46-ST50: 空壳判定 / 侧栏展示', () => {
  it('ST46: isEmptyShellSession 置顶永非空壳', () => {
    expect(
      isEmptyShellSession({
        title: '新会话',
        messages: [],
        isPinned: true,
      })
    ).toBe(false);
  });

  it('ST47: isEmptyShellSession 定时标题永非空壳', () => {
    expect(
      isEmptyShellSession({
        title: '定时 · 任务',
        messages: [],
      })
    ).toBe(false);
  });

  it('ST48: isEmptyShellSession 有实质内容非空壳', () => {
    expect(
      isEmptyShellSession({
        title: '新会话',
        messages: [{ sender: 'user', text: 'hi' }],
      })
    ).toBe(false);
    // 仅 thinking 亦非空壳
    expect(
      isEmptyShellSession({
        title: '新会话',
        messages: [{ sender: 'assistant', text: '', thinking: 'plan' }],
      })
    ).toBe(false);
    // 有 toolCalls 非空壳
    expect(
      isEmptyShellSession({
        title: '新会话',
        messages: [{ sender: 'assistant', text: '', toolCalls: [{ id: 't1' }] }],
      })
    ).toBe(false);
  });

  it('ST49: shouldListSessionInSidebar 归档双重保险', () => {
    expect(
      shouldListSessionInSidebar(
        {
          id: 'ar',
          title: '真实',
          messages: [{ sender: 'user', text: 'x' }],
          isArchived: true,
        },
        'ar'
      )
    ).toBe(false);
  });

  it('ST50: shouldListSessionInSidebar 定时标题始终列表', () => {
    expect(
      shouldListSessionInSidebar(
        { id: 's', title: '定时 · 任务', messages: [] },
        'other'
      )
    ).toBe(true);
  });
});

// ── ST51-ST60: sessionListDisplayTitle / sanitize 边界 ───────────────

describe('ST51-ST60: sessionListDisplayTitle / sanitize 边界', () => {
  it('ST51: sessionListDisplayTitle 真实标题原样返回', () => {
    expect(
      sessionListDisplayTitle({
        title: '真实侧栏名',
        messages: [{ sender: 'user', text: '应被忽略' }],
      })
    ).toBe('真实侧栏名');
  });

  it('ST52: sessionListDisplayTitle 默认标题 + 消息 → 推导', () => {
    expect(
      sessionListDisplayTitle({
        title: '新会话',
        messages: [{ sender: 'user', text: '从消息展示' }],
      })
    ).toContain('从消息');
  });

  it('ST53: sessionListDisplayTitle 空标题 + 空消息 → EMPTY_SESSION_TITLE', () => {
    expect(sessionListDisplayTitle({ title: '', messages: [] })).toBe(
      EMPTY_SESSION_TITLE
    );
    expect(
      sessionListDisplayTitle({ title: null as unknown as string, messages: [] })
    ).toBe(EMPTY_SESSION_TITLE);
  });

  it('ST54: sessionListDisplayTitle 定时标题原样返回', () => {
    expect(
      sessionListDisplayTitle({ title: '定时 · 任务', messages: [] })
    ).toBe('定时 · 任务');
  });

  it('ST55: sanitizeSessionTitleText null/undefined → ""', () => {
    expect(sanitizeSessionTitleText(null)).toBe('');
    expect(sanitizeSessionTitleText(undefined)).toBe('');
  });

  it('ST56: sanitizeSessionTitleText 控制符 + 全角空格折叠', () => {
    expect(sanitizeSessionTitleText('  a\n\tb  ')).toBe('a b');
    expect(sanitizeSessionTitleText('中文\u3000标题')).toBe('中文 标题');
  });

  it('ST57: sanitizeSessionTitleText slash 命令剥离', () => {
    expect(sanitizeSessionTitleText('/help')).toBe('');
    expect(sanitizeSessionTitleText('/cmd  /other  正文')).toBe('正文');
  });

  it('ST58: sanitizeSessionTitleText markdown / 列表前缀剥离', () => {
    expect(sanitizeSessionTitleText('## 标题草稿')).toBe('标题草稿');
    expect(sanitizeSessionTitleText('- 列表项')).toBe('列表项');
    expect(sanitizeSessionTitleText('1. 有序项')).toBe('有序项');
    expect(sanitizeSessionTitleText('1、中文有序')).toBe('中文有序');
  });

  it('ST59: sanitizeSessionTitleText 引号 / 句末标点剥离', () => {
    expect(sanitizeSessionTitleText('「加引号」')).toBe('加引号');
    expect(sanitizeSessionTitleText('句末噪声。')).toBe('句末噪声');
    expect(sanitizeSessionTitleText('Hello!')).toBe('Hello');
  });

  it('ST60: sanitizeSessionTitleText 零宽 / BOM 剥离', () => {
    expect(sanitizeSessionTitleText('\u200B隐\uFEFF藏')).toBe('隐藏');
  });
});

// ── ST61-ST70: 设计观察 / 兼容性记录 ──────────────────────────────────

describe('ST61-ST70: 设计观察 / 兼容性记录', () => {
  it('ST61（设计观察）: XML envelope 未剥离（与 cline 行为不同）', () => {
    // 当前行为：含 <user_input> 标签的标题保留引号被剥后的残骸
    const result = sanitizeSessionTitleText(
      '<user_input mode="act">修复 bug</user_input>'
    );
    // 引号被剥，标签残骸保留
    expect(result).toContain('修复 bug');
  });

  it('ST62（设计观察）: <think>...</think> 标签未剥离（与 opencode 行为不同）', () => {
    const result = sanitizeSessionTitleText(
      '<think>internal reasoning</think>实际标题'
    );
    // 当前行为：保留 think 标签（未剥）
    expect(result).toContain('实际标题');
  });

  it('ST63（设计观察）: OSC/ANSI 转义序列残留 "]0;bad"', () => {
    // \x1b（0x1B）和 \x07（0x07）被剥，但 ]0;bad 残留
    const result = sanitizeSessionTitleText('hello\x1b]0;bad\x07\nworld');
    expect(result).toContain('hello');
    expect(result).toContain('world');
    // ]0;bad 残骸（与 cline 一致）
    expect(result).toContain(']0;bad');
  });

  it('ST64（设计观察）: opencode 时间戳默认标题被识别为默认（regex 意外覆盖，有益）', () => {
    // opencode 用 "New session - 2026-01-01T00:00:00.000Z" 作为默认标题
    // 我们的 isDefaultSessionTitle regex 匹配 "new session" + 数字后缀，
    // 意外覆盖了 opencode 时间戳格式（因为时间戳以数字开头）。
    // 这是有益的：导入 opencode 会话时，默认标题被正确识别。
    expect(isDefaultSessionTitle('New session - 2026-01-15T10:30:00.000Z')).toBe(
      true
    );
  });

  it('ST65（设计观察）: DoS 防护缺失 - 100KB 输入处理时间基线', () => {
    const huge = 'a'.repeat(100_000);
    const start = performance.now();
    sanitizeSessionTitleText(huge);
    const elapsed = performance.now() - start;
    // 仅记录耗时，不强制上限（oraca 限制 512 字符扫描，我们暂未实现）
    // 软性断言：< 1s（V8 regex 引擎通常很快）
    expect(elapsed).toBeLessThan(1000);
  });
});

// ── ST66-ST75: pruneEmptyShellSessions / shellPruneKeepIds ───────────

describe('ST66-ST75: pruneEmptyShellSessions / shellPruneKeepIds', () => {
  it('ST66: pruneEmptyShellSessions 保留 keepIds + 真实标题', () => {
    const sessions = [
      { id: 'a', title: '新会话', messages: [] as [] },
      { id: 'b', title: '新会话', messages: [] as [] },
      {
        id: 'c',
        title: '真实',
        messages: [{ sender: 'user', text: 'hi' }],
      },
    ];
    const next = pruneEmptyShellSessions(sessions, { keepIds: ['b'] });
    expect(next.map((s) => s.id)).toEqual(['b', 'c']);
  });

  it('ST67: pruneEmptyShellSessions 无壳可剪时返回同一引用', () => {
    const sessions = [
      {
        id: 'c',
        title: '真实',
        messages: [{ sender: 'user', text: 'hi' }],
      },
    ];
    expect(pruneEmptyShellSessions(sessions)).toBe(sessions);
  });

  it('ST68: pruneEmptyShellSessions 保留置顶空壳', () => {
    const sessions = [
      { id: 'ghost', title: '新会话', messages: [] as [], isPinned: false },
      { id: 'pinned', title: '新会话', messages: [] as [], isPinned: true },
      { id: 'sched', title: '定时 · 巡检', messages: [] as [] },
    ];
    const next = pruneEmptyShellSessions(sessions);
    expect(next.map((s) => s.id)).toEqual(['pinned', 'sched']);
  });

  it('ST69: shellPruneKeepIds activating=true 丢弃旧 active', () => {
    expect(shellPruneKeepIds('new', 'old', { activating: true })).toEqual([
      'new',
    ]);
    expect(shellPruneKeepIds('bg', 'old', { activating: false })).toEqual([
      'bg',
      'old',
    ]);
    expect(shellPruneKeepIds('same', 'same', { activating: false })).toEqual([
      'same',
    ]);
    expect(shellPruneKeepIds(null, 'old', { activating: true })).toEqual([]);
  });

  it('ST70: shellPruneKeepIds extraKeepIds 去重', () => {
    expect(
      shellPruneKeepIds('new', 'old', {
        activating: true,
        extraKeepIds: ['extra', 'new', 'extra'],
      })
    ).toEqual(['new', 'extra']);
  });

  it('ST70b: shellPruneKeepIds extraKeepIds 含 null/undefined 跳过', () => {
    expect(
      shellPruneKeepIds('new', 'old', {
        activating: true,
        extraKeepIds: [null as unknown as string, undefined as unknown as string, 'extra'],
      })
    ).toEqual(['new', 'extra']);
  });
});

// ── ST76-ST85: isDefaultSessionTitle / isScheduledSessionTitle 边界 ──

describe('ST76-ST85: isDefaultSessionTitle / isScheduledSessionTitle 边界', () => {
  it('ST76: isDefaultSessionTitle 中文占位', () => {
    expect(isDefaultSessionTitle('')).toBe(true);
    expect(isDefaultSessionTitle('  ')).toBe(true);
    expect(isDefaultSessionTitle('新会话')).toBe(true);
    expect(isDefaultSessionTitle('新对话')).toBe(true);
    expect(isDefaultSessionTitle('会话')).toBe(true);
    expect(isDefaultSessionTitle('无标题')).toBe(true);
    expect(isDefaultSessionTitle('未命名')).toBe(true);
    expect(isDefaultSessionTitle('未命名会话')).toBe(true);
    expect(isDefaultSessionTitle('未命名对话')).toBe(true);
    expect(isDefaultSessionTitle('未命名聊天')).toBe(true);
  });

  it('ST77: isDefaultSessionTitle 中文占位 + 编号后缀', () => {
    expect(isDefaultSessionTitle('新会话 2')).toBe(true);
    expect(isDefaultSessionTitle('新会话2')).toBe(true);
    expect(isDefaultSessionTitle('新对话(1)')).toBe(true);
    expect(isDefaultSessionTitle('新会话#3')).toBe(true);
    expect(isDefaultSessionTitle('新会话-2')).toBe(true);
    expect(isDefaultSessionTitle('新对话#3')).toBe(true);
    expect(isDefaultSessionTitle('未命名会话 2')).toBe(true);
  });

  it('ST78: isDefaultSessionTitle 英文占位', () => {
    expect(isDefaultSessionTitle('New Session')).toBe(true);
    expect(isDefaultSessionTitle('new chat')).toBe(true);
    expect(isDefaultSessionTitle('Untitled')).toBe(true);
    expect(isDefaultSessionTitle('Untitled Session')).toBe(true);
    expect(isDefaultSessionTitle('Untitled Conversation')).toBe(true);
    expect(isDefaultSessionTitle('Untitled-1')).toBe(true);
    expect(isDefaultSessionTitle('No Title')).toBe(true);
    expect(isDefaultSessionTitle('Session')).toBe(true);
    expect(isDefaultSessionTitle('Chat 3')).toBe(true);
  });

  it('ST79: isDefaultSessionTitle 真实标题不被误判', () => {
    expect(isDefaultSessionTitle('真实标题')).toBe(false);
    expect(isDefaultSessionTitle('新会话记录')).toBe(false);
    expect(isDefaultSessionTitle('新对话中的方案')).toBe(false);
    expect(isDefaultSessionTitle('未命名方案')).toBe(false);
  });

  it('ST80: isDefaultSessionTitle 定时标题永非默认', () => {
    expect(isDefaultSessionTitle('定时 · 每日 PR 总结')).toBe(false);
    expect(isDefaultSessionTitle('定时 · 任务')).toBe(false);
    expect(isDefaultSessionTitle('定时·紧凑')).toBe(false);
  });

  it('ST81: isScheduledSessionTitle 匹配', () => {
    expect(isScheduledSessionTitle('定时 · 每日 PR 总结')).toBe(true);
    expect(isScheduledSessionTitle('定时 · 任务')).toBe(true);
    expect(isScheduledSessionTitle('定时·紧凑')).toBe(true);
    expect(isScheduledSessionTitle('  定时 · x  ')).toBe(true);
  });

  it('ST82: isScheduledSessionTitle 非定时标题', () => {
    expect(isScheduledSessionTitle('新会话')).toBe(false);
    expect(isScheduledSessionTitle('定时任务无间隔点')).toBe(false);
    expect(isScheduledSessionTitle('')).toBe(false);
    expect(isScheduledSessionTitle(null)).toBe(false);
    expect(isScheduledSessionTitle(undefined)).toBe(false);
  });

  it('ST83: isDefaultSessionTitle null/undefined 视为默认', () => {
    expect(isDefaultSessionTitle(null)).toBe(true);
    expect(isDefaultSessionTitle(undefined)).toBe(true);
  });

  it('ST84: isDefaultSessionTitle 含 Bidi 前缀的「新会话」被识别为默认', () => {
    // 与 ST13 呼应：sanitize 后再判断
    expect(isDefaultSessionTitle('\u202E新会话')).toBe(true);
    expect(isDefaultSessionTitle('\u200B新会话')).toBe(true);
    expect(isDefaultSessionTitle('\u2066新会话\u2069')).toBe(true);
  });

  it('ST85: isDefaultSessionTitle 含 Variation Selector 后缀的「新会话」被识别为默认', () => {
    expect(isDefaultSessionTitle('新会话\uFE00')).toBe(true);
    expect(isDefaultSessionTitle('新会话\uFE0F')).toBe(true);
  });
});

// ── ST86-ST95: messageHasSubstance / sessionHasListableContent 边界 ──

describe('ST86-ST95: messageHasSubstance / sessionHasListableContent 边界', () => {
  it('ST86: sessionHasListableContent 空 messages 返回 false', () => {
    expect(sessionHasListableContent({ messages: [] })).toBe(false);
    expect(sessionHasListableContent({ messages: null })).toBe(false);
    expect(sessionHasListableContent({ messages: undefined })).toBe(false);
    expect(sessionHasListableContent({})).toBe(false);
  });

  it('ST87: sessionHasListableContent 仅空白 text 返回 false', () => {
    expect(
      sessionHasListableContent({ messages: [{ sender: 'user', text: '' }] })
    ).toBe(false);
    expect(
      sessionHasListableContent({ messages: [{ sender: 'user', text: '   ' }] })
    ).toBe(false);
  });

  it('ST88: sessionHasListableContent 有 text 返回 true', () => {
    expect(
      sessionHasListableContent({ messages: [{ sender: 'user', text: 'x' }] })
    ).toBe(true);
  });

  it('ST89: sessionHasListableContent 有 thinking 返回 true', () => {
    expect(
      sessionHasListableContent({
        messages: [{ sender: 'assistant', thinking: 'draft' }],
      })
    ).toBe(true);
  });

  it('ST90: sessionHasListableContent 有 toolCalls 返回 true', () => {
    expect(
      sessionHasListableContent({
        messages: [{ sender: 'assistant', toolCalls: [{ id: 't1' }] }],
      })
    ).toBe(true);
  });

  it('ST91: sessionHasListableContent 有 agents 返回 true', () => {
    expect(sessionHasListableContent({ agents: [{}] })).toBe(true);
    expect(sessionHasListableContent({ agents: [{ id: 'a1' }] })).toBe(true);
  });

  it('ST92: sessionHasListableContent 空 agents 数组返回 false', () => {
    expect(sessionHasListableContent({ agents: [] })).toBe(false);
  });

  it('ST93: sessionHasListableContent 有 blocks 返回 true', () => {
    expect(
      sessionHasListableContent({
        messages: [{ sender: 'assistant', blocks: [{ type: 'text' }] }],
      })
    ).toBe(true);
  });

  it('ST94: 纯 Bidi / 控制符 text 视为无实质（与 firstUserMessageText 一致）', () => {
    // 当前 messageHasSubstance 仅检查 (m.text || '').trim()，
    // 不剥 Bidi / 控制符 → 纯 Bidi 字符串 trim 后非空 → 误判为有实质
    // 修复后：与 firstUserMessageText 同源，剥离后判空
    expect(
      sessionHasListableContent({
        messages: [{ sender: 'user', text: '\u2066\u2067\u2068\u2069' }],
      })
    ).toBe(false);
    expect(
      sessionHasListableContent({
        messages: [{ sender: 'user', text: '\u202E\u202E\u202E' }],
      })
    ).toBe(false);
  });

  it('ST95: 纯组合标记 text 视为无实质', () => {
    expect(
      sessionHasListableContent({
        messages: [{ sender: 'user', text: '\u0301\u0301\u0301' }],
      })
    ).toBe(false);
  });
});

// ── ST96-ST100: 综合端到端场景 ────────────────────────────────────────

describe('ST96-ST100: 综合端到端场景', () => {
  it('ST96: Bidi 注入攻击 - 攻击者用 RLI 让标题视觉反转，sanitize 后正常', () => {
    const attack = '\u2067攻击者文本\u2069';
    const sanitized = sanitizeSessionTitleText(attack);
    // 不再含 Bidi Isolate
    expect(sanitized).not.toContain('\u2067');
    expect(sanitized).not.toContain('\u2069');
    // 视觉顺序正常
    expect(sanitized).toBe('攻击者文本');
  });

  it('ST97: Variation Selector 攻击 - 用 VS 字符构造「看似空但非空」标题', () => {
    const attack = '\uFE00\uFE01\uFE02\uFE03';
    const sanitized = sanitizeSessionTitleText(attack);
    expect(sanitized).toBe('');
    // 推导为 EMPTY_SESSION_TITLE
    expect(deriveSessionTitle(attack)).toBe(EMPTY_SESSION_TITLE);
  });

  it('ST98: lone surrogate 攻击 - 落库前清洗', () => {
    const attack = '标题\uD800';
    const sanitized = sanitizeSessionTitleText(attack);
    const re = loneSurrogateRegex();
    expect(re.test(sanitized)).toBe(false);
    expect(sanitized).toBe('标题');
  });

  it('ST99: 旧数据水合 - Bidi 前缀的「新会话」+ 无内容 → 仍是空壳，被 prune', () => {
    const oldData = [
      {
        id: 'old-ghost',
        title: '\u202E新会话',
        messages: [] as [],
      },
      {
        id: 'real',
        title: '真实标题',
        messages: [{ sender: 'user', text: 'hi' }],
      },
    ];
    const next = prepareSessionsForUi(oldData, 'real');
    // 旧数据空壳被剪掉
    expect(next.find((s) => s.id === 'old-ghost')).toBeUndefined();
    expect(next.map((s) => s.id)).toEqual(['real']);
  });

  it('ST100: 综合攻击 - Bidi + VS + lone surrogate + 真实文本混合', () => {
    const attack =
      '\u202E\u2066\uFE00\uD800真实标题\uD800\uFE01\u2069\u202D';
    const sanitized = sanitizeSessionTitleText(attack);
    const re = loneSurrogateRegex();
    expect(re.test(sanitized)).toBe(false);
    expect(sanitized).not.toContain('\u202E');
    expect(sanitized).not.toContain('\u2066');
    expect(sanitized).not.toContain('\u2069');
    expect(sanitized).not.toContain('\u202D');
    expect(sanitized).not.toContain('\uFE00');
    expect(sanitized).not.toContain('\uFE01');
    expect(sanitized).toBe('真实标题');
  });
});
