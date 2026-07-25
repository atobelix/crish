/**
 * sessionSearch 对抗性测试
 *
 * 目标：暴露会话搜索（查询规范化、AND 匹配、码点安全摘录、相关度排序、
 * 响应式订阅）在边界输入下的隐藏缺陷。
 *
 * 已暴露并修复的 bug 清单（详见各 it 用例注释）：
 *  SS3. ellipsizeCodepoints 对 maxCp=1 返回 2 字符（"x…"），超出 maxCp 限制（已修复）
 *  SS7. makeSearchSnippet 对 prefix+suffix 双省略号场景返回 maxCp+2 字符，超出 maxLen（已修复）
 *  SS16. matchSessionSearch 对 session.messages 含 null 条目崩溃（已修复：跳过 null）
 *  SS17. messageMatchesSearch 对 msg.blocks 含 null 条目崩溃（已修复：跳过 null）
 *  SS18. messageMatchesSearch 对 toolCalls 含 null 条目崩溃（已修复：跳过 null）
 *
 * 设计观察（非 bug，记录用例）：
 *  SS1. normalizeSearchQuery 对数组/对象输入调用 String()，产生 [object Object] / 1,2,3
 *  SS2. normalizeSearchQuery 对 Object.create(null) 抛 TypeError 被 catch 后返回 ''
 *  SS4. ellipsizeCodepoints 对 maxCp=0 回落到 SNIPPET_MAX_CP（72）
 *  SS5. ellipsizeCodepoints 对 maxCp=Infinity 返回原文（无截断）
 *  SS6. ellipsizeCodepoints 对 maxCp=NaN 回落到 72
 *  SS11. textMatchesTokens AND 语义：单字段须含全部 token
 *  SS12. matchSessionSearch 跨字段 AND 不满足
 *  SS22. storeSessionSearchQuery 对 sessionStorage 抛异常时仍通知 listeners
 *  SS29. normalizeSearchQuery 对超长字符串无长度上限（DoS 风险，记录）
 *  SS30. matchToolCalls trunc 对超长 arguments 截断到 800 字符
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SEARCH_SCORE,
  SESSION_SEARCH_QUERY_KEY,
  ellipsizeCodepoints,
  makeSearchSnippet,
  matchSessionSearch,
  messageMatchesSearch,
  normalizeSearchHaystack,
  normalizeSearchQuery,
  rankSessionsBySearch,
  storeSessionSearchQuery,
  readSessionSearchQuery,
  subscribeSearchQuery,
  getSearchQuerySnapshot,
  textMatchesSearch,
  textMatchesTokens,
  tokenizeSearchQuery,
} from './sessionSearch';
import type { SessionMessage, SessionState } from '../store/types';

// ── helpers ────────────────────────────────────────────────────────────

function msg(partial: Partial<SessionMessage> & { id: string }): SessionMessage {
  return {
    sender: 'user',
    text: '',
    timestamp: 0,
    ...partial,
  } as SessionMessage;
}

function session(partial: Partial<SessionState> & { id: string }): SessionState {
  return {
    title: '',
    folder: '',
    isPinned: false,
    isArchived: false,
    timestamp: '',
    messages: [],
    ...partial,
  };
}

// ── SS1-SS2: normalizeSearchQuery 对非字符串输入（设计观察） ──────────

describe('SS1-SS2: normalizeSearchQuery 对非字符串输入', () => {
  it('SS1: 数组输入被 String() 转为 "a,b,c"（防御性兜底）', () => {
    expect(normalizeSearchQuery(['a', 'b', 'c'] as unknown as string)).toBe('a,b,c');
  });

  it('SS1: 对象输入被 String() 转为 "[object object]"', () => {
    expect(normalizeSearchQuery({ k: 'v' } as unknown as string)).toBe('[object object]');
  });

  it('SS1: 数字输入被 String() 转为数字字符串', () => {
    expect(normalizeSearchQuery(123 as unknown as string)).toBe('123');
  });

  it('SS2: Object.create(null) 调 String() 抛 TypeError → catch 返回 ""', () => {
    const noProto = Object.create(null) as unknown as string;
    expect(normalizeSearchQuery(noProto)).toBe('');
  });

  it('SS2: 函数输入被 String() 转为 "function (){}" 之类', () => {
    const fn = (() => {}) as unknown as string;
    const result = normalizeSearchQuery(fn);
    expect(result).toMatch(/^function/);
  });
});

// ── SS3-SS6: ellipsizeCodepoints 边界 ─────────────────────────────────

describe('SS3-SS6: ellipsizeCodepoints 边界', () => {
  it('SS3（已修复）: maxCp=1 返回 "…"（1 字符），不超过 maxCp', () => {
    // 修复前：keep = Math.max(1, 0) = 1 → "h…"（2 字符，超出 maxCp=1）
    // 修复后：keep = Math.max(0, 0) = 0 → "…"（1 字符）
    const result = ellipsizeCodepoints('hello', 1);
    expect(Array.from(result).length).toBe(1);
    expect(result).toBe('…');
  });

  it('SS3: maxCp=2 返回 "h…"（2 字符）', () => {
    const result = ellipsizeCodepoints('hello', 2);
    expect(Array.from(result).length).toBe(2);
    expect(result).toBe('h…');
  });

  it('SS3: maxCp=3 返回 "he…"（3 字符）', () => {
    const result = ellipsizeCodepoints('hello', 3);
    expect(Array.from(result).length).toBe(3);
    expect(result).toBe('he…');
  });

  it('SS3: maxCp=1.9 截断为 1 → 返回 "…"（1 字符）', () => {
    const result = ellipsizeCodepoints('hello', 1.9);
    expect(Array.from(result).length).toBe(1);
  });

  it('SS3 不变量: 任意 maxCp≥1 时结果码点数 ≤ maxCp', () => {
    for (let maxCp = 1; maxCp <= 10; maxCp++) {
      const result = ellipsizeCodepoints('abcdefghij', maxCp);
      expect(Array.from(result).length).toBeLessThanOrEqual(maxCp);
    }
  });

  it('SS4: maxCp=0 回落到 SNIPPET_MAX_CP（72）', () => {
    const long = 'x'.repeat(100);
    const result = ellipsizeCodepoints(long, 0);
    expect(Array.from(result).length).toBe(72);
  });

  it('SS4: maxCp=负数 回落到 72', () => {
    const long = 'x'.repeat(100);
    const result = ellipsizeCodepoints(long, -5);
    expect(Array.from(result).length).toBe(72);
  });

  it('SS5: maxCp=Infinity 返回原文（无截断）', () => {
    const long = 'x'.repeat(1000);
    const result = ellipsizeCodepoints(long, Infinity);
    expect(result).toBe(long);
  });

  it('SS6: maxCp=NaN 回落到 72', () => {
    const long = 'x'.repeat(100);
    const result = ellipsizeCodepoints(long, NaN);
    expect(Array.from(result).length).toBe(72);
  });

  it('码点安全：emoji 不被半截', () => {
    const text = 'a'.repeat(5) + '😀' + 'b'.repeat(5);
    const result = ellipsizeCodepoints(text, 6);
    expect(Array.from(result).length).toBe(6);
    expect(result).toBe('aaaaa…');
  });

  it('文本不超过 limit 时原样返回', () => {
    expect(ellipsizeCodepoints('abc', 5)).toBe('abc');
    expect(ellipsizeCodepoints('', 5)).toBe('');
  });
});

// ── SS7-SS10: makeSearchSnippet 边界 ──────────────────────────────────

describe('SS7-SS10: makeSearchSnippet 边界', () => {
  it('SS9: 空文本返回 ""', () => {
    expect(makeSearchSnippet('', 'query')).toBe('');
    expect(makeSearchSnippet(null as unknown as string, 'query')).toBe('');
  });

  it('SS10: 查询未命中返回文首截断', () => {
    const text = '这是一段很长的文本内容用于测试摘录功能是否能在查询未命中时正确截断到指定长度';
    const result = makeSearchSnippet(text, '不存在的查询');
    expect(Array.from(result).length).toBeLessThanOrEqual(72);
    expect(result.endsWith('…')).toBe(true);
  });

  it('SS10: 空查询返回文首截断', () => {
    const text = '这是一段很长的文本内容用于测试摘录功能是否能在空查询时正确截断到指定长度';
    const result = makeSearchSnippet(text, '');
    expect(Array.from(result).length).toBeLessThanOrEqual(72);
  });

  it('SS7（已修复）: prefix+suffix 双省略号时结果 ≤ maxCp', () => {
    // 修复前：返回 32 字符（maxCp=30 + prefix … + suffix …）
    // 修复后：返回 ≤ 30 字符
    const text = 'x'.repeat(100) + 'QUERY' + 'y'.repeat(100);
    const result = makeSearchSnippet(text, 'QUERY', 30);
    expect(Array.from(result).length).toBeLessThanOrEqual(30);
  });

  it('SS7 不变量: 任意 maxLen 时结果码点数 ≤ maxLen', () => {
    const text = 'x'.repeat(100) + 'QUERY' + 'y'.repeat(100);
    for (let maxLen = 5; maxLen <= 80; maxLen += 5) {
      const result = makeSearchSnippet(text, 'QUERY', maxLen);
      expect(Array.from(result).length).toBeLessThanOrEqual(maxLen);
    }
  });

  it('SS8: maxCp < SNIPPET_RADIUS_CP 时仍能正确居中', () => {
    const text = 'x'.repeat(50) + 'QUERY' + 'y'.repeat(50);
    const result = makeSearchSnippet(text, 'QUERY', 10);
    expect(result).toContain('QUERY');
  });

  it('SS26: 代理对（emoji）边界码点安全', () => {
    const text = '😀'.repeat(20) + 'QUERY' + '😀'.repeat(20);
    const result = makeSearchSnippet(text, 'QUERY', 15);
    expect(result).toContain('QUERY');
    // 检查结果中不包含孤立 surrogate
    const hasLoneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result);
    expect(hasLoneSurrogate).toBe(false);
  });

  it('SS27: 重叠 token 返回最早起点', () => {
    const text = 'abc abcdef';
    const result = makeSearchSnippet(text, 'abc abcdef');
    expect(result).toContain('abc');
  });

  it('命中在文首时不加前缀省略号', () => {
    const text = 'QUERY 后面跟很多内容' + 'x'.repeat(100);
    const result = makeSearchSnippet(text, 'QUERY', 20);
    expect(result.startsWith('…')).toBe(false);
  });

  it('命中在文末时不加后缀省略号', () => {
    const text = 'x'.repeat(100) + '前面很多内容 QUERY';
    const result = makeSearchSnippet(text, 'QUERY', 20);
    expect(result.endsWith('…')).toBe(false);
  });

  it('maxLen=NaN 回落到默认 72', () => {
    const text = 'x'.repeat(100);
    const result = makeSearchSnippet(text, '', NaN);
    expect(Array.from(result).length).toBeLessThanOrEqual(72);
  });

  it('maxLen=0 回落到默认 72', () => {
    const text = 'x'.repeat(100);
    const result = makeSearchSnippet(text, '', 0);
    expect(Array.from(result).length).toBeLessThanOrEqual(72);
  });
});

// ── SS11-SS12: textMatchesTokens AND 语义 ─────────────────────────────

describe('SS11-SS12: textMatchesTokens AND 语义', () => {
  it('SS11: 单字段须含全部 token', () => {
    expect(textMatchesTokens('fix the bug', ['fix', 'bug'])).toBe(true);
    expect(textMatchesTokens('fix the issue', ['fix', 'bug'])).toBe(false);
  });

  it('SS11: 空 tokens 返回 false', () => {
    expect(textMatchesTokens('hello', [])).toBe(false);
  });

  it('SS11: 空 hay 返回 false', () => {
    expect(textMatchesTokens('', ['token'])).toBe(false);
    expect(textMatchesTokens(null, ['token'])).toBe(false);
  });

  it('SS12: 跨字段 AND 不满足（设计正确）', () => {
    const s = session({
      id: 's1',
      title: 'fix something',
      folder: 'bug category',
      messages: [],
    });
    const result = matchSessionSearch(s, 'fix bug');
    expect(result.match).toBe(false);
  });

  it('SS12: 单字段含全部 token 时匹配', () => {
    const s = session({
      id: 's1',
      title: 'fix the bug',
      folder: '',
      messages: [],
    });
    const result = matchSessionSearch(s, 'fix bug');
    expect(result.match).toBe(true);
    expect(result.titleMatch).toBe(true);
  });
});

// ── SS13-SS18: matchSessionSearch 边界 ────────────────────────────────

describe('SS13-SS18: matchSessionSearch 边界', () => {
  it('SS13: titleExact 加分：规范化后 displayNorm === q', () => {
    const s = session({
      id: 's1',
      title: 'Fix Bug',
      messages: [],
    });
    const result = matchSessionSearch(s, 'fix bug');
    expect(result.score).toBe(SEARCH_SCORE.titleExact);
  });

  it('SS13: 非精确标题匹配得 title 分', () => {
    const s = session({
      id: 's1',
      title: 'Fix the nasty bug',
      messages: [],
    });
    const result = matchSessionSearch(s, 'fix bug');
    expect(result.score).toBe(SEARCH_SCORE.title);
  });

  it('SS14: session.title=null 不崩溃', () => {
    const s = session({
      id: 's1',
      title: null as unknown as string,
      messages: [],
    });
    expect(() => matchSessionSearch(s, 'query')).not.toThrow();
  });

  it('SS15: session.folder=null 不崩溃', () => {
    const s = session({
      id: 's1',
      title: 'title',
      folder: null as unknown as string,
      messages: [],
    });
    expect(() => matchSessionSearch(s, 'query')).not.toThrow();
  });

  it('SS16（已修复）: session.messages 含 null 条目跳过，不崩溃', () => {
    // 修复前：matchMessage(null, ...) → null.text 抛 TypeError
    // 修复后：跳过 null 条目
    const s = session({
      id: 's1',
      title: 'title',
      messages: [null as unknown as SessionMessage],
    });
    expect(() => matchSessionSearch(s, 'query')).not.toThrow();
  });

  it('SS17（已修复）: msg.blocks 含 null 条目跳过，不崩溃', () => {
    // 修复前：b.type 抛 TypeError
    // 修复后：跳过 null block
    const m = msg({
      id: 'm1',
      text: 'hello query',
      blocks: [null as unknown as { type: 'text'; content: string }],
    });
    expect(() => messageMatchesSearch(m, 'query')).not.toThrow();
    // text 字段仍命中
    expect(messageMatchesSearch(m, 'query')).toBe(true);
  });

  it('SS18（已修复）: toolCalls 含 null 条目跳过，不崩溃', () => {
    // 修复前：tc.name 抛 TypeError
    // 修复后：跳过 null toolCall
    const m = msg({
      id: 'm1',
      text: '',
      toolCalls: [null as unknown as { id: string; name: string }],
    });
    expect(() => messageMatchesSearch(m, 'query')).not.toThrow();
    // 无命中
    expect(messageMatchesSearch(m, 'query')).toBe(false);
  });

  it('SS28: score 累加 title + folder + message', () => {
    const s = session({
      id: 's1',
      title: 'query',
      folder: 'query',
      messages: [msg({ id: 'm1', text: 'query' })],
    });
    const result = matchSessionSearch(s, 'query');
    expect(result.score).toBe(
      SEARCH_SCORE.titleExact + SEARCH_SCORE.folder + SEARCH_SCORE.messageText,
    );
  });

  it('空查询返回 match=true, hitCount=0, score=0', () => {
    const s = session({ id: 's1', title: 'title', messages: [] });
    const result = matchSessionSearch(s, '');
    expect(result.match).toBe(true);
    expect(result.hitCount).toBe(0);
    expect(result.score).toBe(0);
  });

  it('空查询返回 match=true（仅空白）', () => {
    const s = session({ id: 's1', title: 'title', messages: [] });
    const result = matchSessionSearch(s, '   \u3000 ');
    expect(result.match).toBe(true);
  });
});

// ── SS19-SS21: rankSessionsBySearch 排序 ──────────────────────────────

describe('SS19-SS21: rankSessionsBySearch 排序', () => {
  it('SS20: 空查询返回全部会话（match=true, score=0）', () => {
    const sessions = [
      session({ id: 's1', title: 'foo' }),
      session({ id: 's2', title: 'bar' }),
    ];
    const result = rankSessionsBySearch(sessions, '');
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.match.match === true)).toBe(true);
    expect(result.every((r) => r.match.score === 0)).toBe(true);
  });

  it('SS20: 空会话列表返回 []', () => {
    expect(rankSessionsBySearch([], 'query')).toEqual([]);
  });

  it('SS20: null 查询返回全部', () => {
    const sessions = [session({ id: 's1', title: 'foo' })];
    const result = rankSessionsBySearch(sessions, null);
    expect(result).toHaveLength(1);
  });

  it('SS19: 同分时按 id localeCompare 稳定排序', () => {
    const sessions = [
      session({ id: 'b', title: 'same', messages: [] }),
      session({ id: 'a', title: 'same', messages: [] }),
      session({ id: 'c', title: 'same', messages: [] }),
    ];
    const result = rankSessionsBySearch(sessions, 'same');
    expect(result.map((r) => r.session.id)).toEqual(['a', 'b', 'c']);
  });

  it('SS19: score 降序优先', () => {
    const sessions = [
      session({ id: 's1', title: 'foo', messages: [] }),
      session({ id: 's2', title: 'foo bar', messages: [] }),
    ];
    // 'foo' 精确匹配 s1 得 titleExact；'foo' 在 'foo bar' 中得 title
    const result = rankSessionsBySearch(sessions, 'foo');
    expect(result[0].session.id).toBe('s1');
  });

  it('SS21: session.id=undefined 不崩溃', () => {
    const sessions = [
      session({ id: undefined as unknown as string, title: 'foo' }),
    ];
    expect(() => rankSessionsBySearch(sessions, 'foo')).not.toThrow();
  });

  it('未命中的会话被过滤', () => {
    const sessions = [
      session({ id: 's1', title: 'foo' }),
      session({ id: 's2', title: 'bar' }),
    ];
    const result = rankSessionsBySearch(sessions, 'foo');
    expect(result).toHaveLength(1);
    expect(result[0].session.id).toBe('s1');
  });
});

// ── SS22-SS25: 存储与订阅 ─────────────────────────────────────────────

describe('SS22-SS25: storeSessionSearchQuery / subscribeSearchQuery', () => {
  let sessionStorageMock: {
    getItem: ReturnType<typeof vi.fn>;
    setItem: ReturnType<typeof vi.fn>;
    removeItem: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    sessionStorageMock = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    };
    vi.stubGlobal('sessionStorage', sessionStorageMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('SS22: sessionStorage 抛异常时仍通知 listeners', () => {
    sessionStorageMock.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const listener = vi.fn();
    subscribeSearchQuery(listener);
    expect(() => storeSessionSearchQuery('query')).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('SS23: 非字符串输入存为 ""（移除 key）', () => {
    storeSessionSearchQuery(123 as unknown as string);
    expect(sessionStorageMock.removeItem).toHaveBeenCalledWith(SESSION_SEARCH_QUERY_KEY);
  });

  it('SS23: 空白输入移除 key', () => {
    storeSessionSearchQuery('   \u3000 ');
    expect(sessionStorageMock.removeItem).toHaveBeenCalledWith(SESSION_SEARCH_QUERY_KEY);
  });

  it('SS23: 有效输入存储 trimmed 值', () => {
    storeSessionSearchQuery('  hello  ');
    expect(sessionStorageMock.setItem).toHaveBeenCalledWith(SESSION_SEARCH_QUERY_KEY, 'hello');
  });

  it('SS24: listener 抛异常不影响其他 listener', () => {
    const bad = vi.fn(() => {
      throw new Error('listener error');
    });
    const good = vi.fn();
    subscribeSearchQuery(bad);
    subscribeSearchQuery(good);
    expect(() => storeSessionSearchQuery('query')).not.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('SS25: 取消订阅后不再被通知', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSearchQuery(listener);
    unsubscribe();
    storeSessionSearchQuery('query');
    expect(listener).not.toHaveBeenCalled();
  });

  it('readSessionSearchQuery 对 sessionStorage 异常返回 ""', () => {
    sessionStorageMock.getItem.mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readSessionSearchQuery()).toBe('');
  });

  it('getSearchQuerySnapshot 与 readSessionSearchQuery 一致', () => {
    sessionStorageMock.getItem.mockReturnValue('stored-query');
    expect(getSearchQuerySnapshot()).toBe('stored-query');
  });
});

// ── SS29-SS30: 长字符串与截断 ─────────────────────────────────────────

describe('SS29-SS30: 长字符串与截断', () => {
  it('SS29: normalizeSearchQuery 对超长字符串无长度上限（DoS 风险记录）', () => {
    const long = 'a'.repeat(100_000);
    const start = Date.now();
    const result = normalizeSearchQuery(long);
    const elapsed = Date.now() - start;
    expect(result).toBe(long.toLowerCase());
    // 不应崩溃；耗时记录（不设硬上限，DoS 风险记录）
    expect(elapsed).toBeLessThan(5_000);
  });

  it('SS30: matchToolCalls 对超长 arguments 截断到 800 字符', () => {
    const longArgs = 'x'.repeat(1000) + ' query';
    const m = msg({
      id: 'm1',
      text: '',
      toolCalls: [
        {
          id: 'tc1',
          name: 'tool',
          arguments: longArgs,
          status: 'success',
        },
      ],
    });
    // 'query' 在位置 1000，超过 800 截断 → 不匹配
    expect(messageMatchesSearch(m, 'query')).toBe(false);
  });

  it('SS30: matchToolCalls 截断内命中仍匹配', () => {
    const args = 'query ' + 'x'.repeat(900);
    const m = msg({
      id: 'm1',
      text: '',
      toolCalls: [
        {
          id: 'tc1',
          name: 'tool',
          arguments: args,
          status: 'success',
        },
      ],
    });
    expect(messageMatchesSearch(m, 'query')).toBe(true);
  });
});

// ── CJK / Unicode 对抗 ────────────────────────────────────────────────

describe('CJK / Unicode 对抗', () => {
  it('全角空格 + NFKC 折叠', () => {
    expect(normalizeSearchQuery('\u3000Ｒｅｆａｃｔｏｒ\u3000')).toBe('refactor');
  });

  it('零宽字符剥离', () => {
    expect(normalizeSearchQuery('fix\u200Bbug')).toBe('fixbug');
    expect(normalizeSearchQuery('fix\uFEFFbug')).toBe('fixbug');
    expect(normalizeSearchQuery('fix\u00ADbug')).toBe('fixbug');
  });

  it('BOM + soft-hyphen 剥离', () => {
    expect(normalizeSearchQuery('\uFEFF修复\u00AD问题')).toBe('修复问题');
  });

  it('CJK 短语作为单 token', () => {
    expect(tokenizeSearchQuery('重构路径')).toEqual(['重构路径']);
  });

  it('CJK + 拉丁混合', () => {
    expect(tokenizeSearchQuery('fix 重构 bug')).toEqual(['fix', '重构', 'bug']);
  });

  it('normalizeSearchHaystack 对 null 返回 ""', () => {
    expect(normalizeSearchHaystack(null)).toBe('');
    expect(normalizeSearchHaystack(undefined)).toBe('');
  });

  it('normalizeSearchHaystack 对非字符串调 String()', () => {
    expect(normalizeSearchHaystack(123 as unknown as string)).toBe('123');
  });

  it('textMatchesSearch 是 textMatchesTokens 的包装', () => {
    expect(textMatchesSearch('fix bug', 'fix bug')).toBe(true);
    expect(textMatchesSearch('fix', 'fix bug')).toBe(false);
  });
});
