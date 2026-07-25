import { describe, expect, it } from 'vitest';
import {
  SEARCH_SCORE,
  compareSessionSearchRank,
  ellipsizeCodepoints,
  isEmptySearchQuery,
  makeSearchSnippet,
  matchSessionSearch,
  messageMatchesSearch,
  normalizeSearchHaystack,
  normalizeSearchQuery,
  rankSessionsBySearch,
  textMatchesSearch,
  textMatchesTokens,
  tokenizeSearchQuery,
  type SessionSearchMatch,
} from './sessionSearch';
import type { SessionMessage, SessionState } from '../store/types';

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

// ── normalize / empty / tokenize ─────────────────────────────────────

describe('normalizeSearchQuery', () => {
  it('returns empty for nullish / blank / whitespace-only', () => {
    expect(normalizeSearchQuery(null)).toBe('');
    expect(normalizeSearchQuery(undefined)).toBe('');
    expect(normalizeSearchQuery('')).toBe('');
    expect(normalizeSearchQuery('   ')).toBe('');
    expect(normalizeSearchQuery('\u3000\u3000')).toBe('');
  });

  it('trims, lowercases Latin, collapses spaces', () => {
    expect(normalizeSearchQuery('  Foo  BAR  ')).toBe('foo bar');
    expect(normalizeSearchQuery('Hello\n\tWorld')).toBe('hello world');
  });

  it('folds full-width spaces and NFKC full-width Latin', () => {
    // 全角空格
    expect(normalizeSearchQuery('\u3000重构\u3000路径\u3000')).toBe('重构 路径');
    // 全角拉丁 → 半角（NFKC）
    expect(normalizeSearchQuery('Ｒｅｆａｃｔｏｒ')).toBe('refactor');
    expect(normalizeSearchQuery('ＦＯＯ ｂａｒ')).toBe('foo bar');
    // 兼容字形 / 全角数字
    expect(normalizeSearchQuery('①㎏')).toBe('1kg');
  });

  it('strips zero-width / BOM / soft-hyphen (CJK paste residue)', () => {
    expect(normalizeSearchQuery('路径\u200B重构')).toBe('路径重构');
    expect(normalizeSearchQuery('登录\uFEFF模块')).toBe('登录模块');
    expect(normalizeSearchQuery('修\u00AD复')).toBe('修复');
    expect(normalizeSearchQuery('foo\u2060bar')).toBe('foobar');
  });

  it('preserves CJK and mixed queries', () => {
    expect(normalizeSearchQuery('中文搜索')).toBe('中文搜索');
    expect(normalizeSearchQuery('  Fix 登录 Bug  ')).toBe('fix 登录 bug');
  });
});

describe('isEmptySearchQuery', () => {
  it('true only when normalized empty', () => {
    expect(isEmptySearchQuery('')).toBe(true);
    expect(isEmptySearchQuery('  \u3000 ')).toBe(true);
    expect(isEmptySearchQuery(null)).toBe(true);
    expect(isEmptySearchQuery('\u200B\uFEFF')).toBe(true);
    expect(isEmptySearchQuery('x')).toBe(false);
    expect(isEmptySearchQuery('中')).toBe(false);
  });
});

describe('tokenizeSearchQuery', () => {
  it('returns empty for blank', () => {
    expect(tokenizeSearchQuery('')).toEqual([]);
    expect(tokenizeSearchQuery('   ')).toEqual([]);
  });

  it('splits Latin on whitespace; keeps CJK phrase as one token', () => {
    expect(tokenizeSearchQuery('git status')).toEqual(['git', 'status']);
    expect(tokenizeSearchQuery('重构路径')).toEqual(['重构路径']);
    expect(tokenizeSearchQuery('修复 登录')).toEqual(['修复', '登录']);
  });
});

describe('normalizeSearchHaystack / textMatches', () => {
  it('aligns haystack with query folding', () => {
    expect(normalizeSearchHaystack('  Hello\u3000WORLD  ')).toBe('hello world');
    expect(normalizeSearchHaystack('全角ＡＢＣ')).toBe('全角abc');
  });

  it('AND-matches tokens; empty tokens never match', () => {
    expect(textMatchesTokens('git push status ok', ['git', 'status'])).toBe(true);
    expect(textMatchesTokens('git only', ['git', 'status'])).toBe(false);
    expect(textMatchesTokens('anything', [])).toBe(false);
    expect(textMatchesSearch('请重构路径模块', '重构路径')).toBe(true);
    expect(textMatchesSearch('请重构路径模块', '重构 模块')).toBe(true);
    expect(textMatchesSearch('请重构路径', '不存在')).toBe(false);
  });

  it('matches full-width needle against half-width hay and vice versa', () => {
    expect(textMatchesSearch('refactor path', 'Ｒｅｆａｃｔｏｒ')).toBe(true);
    expect(textMatchesSearch('Ｒｅｆａｃｔｏｒ 路径', 'refactor')).toBe(true);
  });

  it('matches across zero-width chars in hay or needle (CJK paste)', () => {
    expect(textMatchesSearch('请路径\u200B重构模块', '路径重构')).toBe(true);
    expect(textMatchesSearch('请路径重构模块', '路径\u200B重构')).toBe(true);
    expect(textMatchesSearch('登录\uFEFF校验', '登录校验')).toBe(true);
    expect(normalizeSearchHaystack('A\u200B\u3000B')).toBe('a b');
  });
});

// ── messageMatchesSearch ─────────────────────────────────────────────

describe('messageMatchesSearch', () => {
  it('returns false for empty query', () => {
    expect(messageMatchesSearch(msg({ id: '1', text: 'hello' }), '')).toBe(false);
    expect(messageMatchesSearch(msg({ id: '1', text: 'hello' }), '   ')).toBe(false);
    expect(messageMatchesSearch(msg({ id: '1', text: 'hello' }), '\u3000')).toBe(false);
  });

  it('matches text case-insensitively', () => {
    const m = msg({ id: '1', text: 'Hello World' });
    expect(messageMatchesSearch(m, 'hello')).toBe(true);
    expect(messageMatchesSearch(m, 'WORLD')).toBe(true);
    expect(messageMatchesSearch(m, 'xyz')).toBe(false);
  });

  it('matches CJK substrings and multi-token AND', () => {
    const m = msg({ id: 'cjk', text: '需要重构登录模块与权限校验' });
    expect(messageMatchesSearch(m, '重构')).toBe(true);
    expect(messageMatchesSearch(m, '登录模块')).toBe(true);
    expect(messageMatchesSearch(m, '重构 权限')).toBe(true);
    expect(messageMatchesSearch(m, '重构 支付')).toBe(false);
  });

  it('matches thinking and tool fields', () => {
    const m = msg({
      id: '2',
      sender: 'assistant',
      text: 'done',
      thinking: 'consider refactor path',
      toolCalls: [
        {
          id: 't1',
          name: 'bash',
          arguments: '{"cmd":"git status"}',
          output: 'modified: foo.ts',
          status: 'success',
        },
      ],
    });
    expect(messageMatchesSearch(m, 'refactor')).toBe(true);
    expect(messageMatchesSearch(m, 'git status')).toBe(true);
    expect(messageMatchesSearch(m, 'foo.ts')).toBe(true);
    expect(messageMatchesSearch(m, 'bash')).toBe(true);
  });

  it('matches blocks text (used by chat local filter)', () => {
    const m = msg({
      id: '3',
      sender: 'assistant',
      text: '',
      blocks: [{ type: 'text', content: 'unique-block-token-42' }],
    });
    expect(messageMatchesSearch(m, 'unique-block-token')).toBe(true);
    expect(messageMatchesSearch(m, 'nope')).toBe(false);
  });

  it('matches tool explanation and full-width query', () => {
    const m = msg({
      id: '4',
      sender: 'assistant',
      text: '',
      toolCalls: [
        {
          id: 't2',
          name: 'read',
          arguments: '{}',
          explanation: '读取配置文件 config.json',
          status: 'success',
        },
      ],
    });
    expect(messageMatchesSearch(m, '配置文件')).toBe(true);
    expect(messageMatchesSearch(m, 'ＣＯＮＦＩＧ')).toBe(true);
  });
});

// ── snippets ─────────────────────────────────────────────────────────

describe('ellipsizeCodepoints', () => {
  it('is codepoint-safe for CJK and does not split short text', () => {
    expect(ellipsizeCodepoints('短', 5)).toBe('短');
    expect(ellipsizeCodepoints('一二三四五六七八', 5)).toBe('一二三四…');
    // emoji as single codepoint
    expect(ellipsizeCodepoints('👍👍👍', 2)).toBe('👍…');
  });
});

describe('makeSearchSnippet', () => {
  it('returns empty for blank text', () => {
    expect(makeSearchSnippet('', 'x')).toBe('');
    expect(makeSearchSnippet('   ', 'x')).toBe('');
  });

  it('centers around first hit', () => {
    const snip = makeSearchSnippet('aaaa TARGET bbbb', 'TARGET', 72);
    expect(snip.toLowerCase()).toContain('target');
  });

  it('handles CJK hit window and ellipsis', () => {
    const long =
      '前文前文前文前文前文前文前文前文命中关键词后文后文后文后文后文后文后文后文';
    const snip = makeSearchSnippet(long, '命中关键词', 24);
    expect(snip).toContain('命中关键词');
    expect(snip.startsWith('…') || snip.endsWith('…')).toBe(true);
  });

  it('empty query returns head truncate', () => {
    const snip = makeSearchSnippet('abcdefghij', '', 5);
    expect(snip).toBe('abcd…');
  });

  it('collapses whitespace before snippet', () => {
    const snip = makeSearchSnippet('hello\n\n  world  TARGET  x', 'target', 72);
    expect(snip.toLowerCase()).toContain('target');
    expect(snip).not.toMatch(/\n/);
  });

  it('strips zero-width so snippet still centers on CJK hit', () => {
    const long =
      '前文前文前文前文前文前文前文前文命中\u200B关键词后文后文后文后文后文后文后文后文';
    const snip = makeSearchSnippet(long, '命中关键词', 24);
    expect(snip).toContain('命中关键词');
    expect(snip).not.toContain('\u200B');
  });
});

// ── matchSessionSearch + ranking ─────────────────────────────────────

describe('matchSessionSearch', () => {
  it('empty query matches all with zero hits/score', () => {
    const s = session({
      id: 's1',
      title: 'hello',
      messages: [msg({ id: 'm1', text: 'world' })],
    });
    expect(matchSessionSearch(s, '')).toEqual({
      match: true,
      hitCount: 0,
      score: 0,
    });
    expect(matchSessionSearch(s, '  \u3000 ')).toEqual({
      match: true,
      hitCount: 0,
      score: 0,
    });
  });

  it('matches title and sets titleMatch + title score', () => {
    const s = session({ id: 's2', title: 'Refactor Auth' });
    const r = matchSessionSearch(s, 'refactor');
    expect(r.match).toBe(true);
    expect(r.titleMatch).toBe(true);
    expect(r.hitCount).toBeGreaterThanOrEqual(1);
    expect(r.score).toBeGreaterThanOrEqual(SEARCH_SCORE.title);
    // 仅标题命中：无正文 snippet
    expect(r.snippet).toBeUndefined();
  });

  it('exact title scores higher than partial', () => {
    const exact = matchSessionSearch(session({ id: 'e', title: '登录' }), '登录');
    const partial = matchSessionSearch(
      session({ id: 'p', title: '登录模块重构' }),
      '登录',
    );
    expect(exact.score).toBeGreaterThan(partial.score);
    expect(exact.score).toBe(SEARCH_SCORE.titleExact);
  });

  it('matches folder and message body with snippet', () => {
    const s = session({
      id: 's3',
      title: '其它',
      folder: 'work',
      messages: [
        msg({
          id: 'm1',
          text: '请在此处修复支付回调逻辑',
        }),
      ],
    });
    const byFolder = matchSessionSearch(s, 'work');
    expect(byFolder.match).toBe(true);
    expect(byFolder.score).toBe(SEARCH_SCORE.folder);

    const byBody = matchSessionSearch(s, '支付回调');
    expect(byBody.match).toBe(true);
    expect(byBody.snippet).toBeDefined();
    expect(byBody.snippet).toContain('支付回调');
    expect(byBody.score).toBe(SEARCH_SCORE.messageText);
  });

  it('matches agent description and nested messages', () => {
    const s = session({
      id: 's4',
      title: '主会话',
      agents: [
        {
          id: 'a1',
          subagentRunId: 'r1',
          parentSessionId: 's4',
          parentRunId: 'pr',
          description: '探索代码库结构',
          mode: 'explore',
          status: 'completed',
          messages: [msg({ id: 'am1', text: '发现 sessionSearch 模块' })],
          startedAt: 0,
          depth: 0,
          subagentPath: ['a1'],
        },
      ],

    });
    expect(matchSessionSearch(s, '代码库').match).toBe(true);
    const nested = matchSessionSearch(s, 'sessionSearch');
    expect(nested.match).toBe(true);
    expect(nested.snippet).toContain('sessionSearch');
  });

  it('non-match returns match false', () => {
    const s = session({ id: 's5', title: 'alpha', messages: [msg({ id: 'm', text: 'beta' })] });
    const r = matchSessionSearch(s, 'zzz-nope');
    expect(r.match).toBe(false);
    expect(r.hitCount).toBe(0);
    expect(r.score).toBe(0);
  });

  it('matches body with ZWSP residue and yields clean snippet', () => {
    const s = session({
      id: 's6',
      title: '其它',
      messages: [msg({ id: 'm', text: '请修复\u200B支付\u200B回调逻辑' })],
    });
    const r = matchSessionSearch(s, '支付回调');
    expect(r.match).toBe(true);
    expect(r.snippet).toBeDefined();
    expect(r.snippet).toContain('支付回调');
    expect(r.snippet).not.toContain('\u200B');
  });
});

describe('compareSessionSearchRank / rankSessionsBySearch', () => {
  it('orders by score then hitCount then titleMatch', () => {
    const high: SessionSearchMatch = {
      match: true,
      hitCount: 1,
      score: 100,
      titleMatch: true,
    };
    const low: SessionSearchMatch = {
      match: true,
      hitCount: 5,
      score: 10,
      titleMatch: false,
    };
    expect(compareSessionSearchRank(high, low)).toBeLessThan(0);
    expect(compareSessionSearchRank(low, high)).toBeGreaterThan(0);

    const moreHits: SessionSearchMatch = { match: true, hitCount: 3, score: 10 };
    const fewerHits: SessionSearchMatch = { match: true, hitCount: 1, score: 10 };
    expect(compareSessionSearchRank(moreHits, fewerHits)).toBeLessThan(0);
  });

  it('empty query returns original order with zero scores', () => {
    const list = [
      session({ id: 'b', title: 'B' }),
      session({ id: 'a', title: 'A' }),
    ];
    const ranked = rankSessionsBySearch(list, '');
    expect(ranked.map((x) => x.session.id)).toEqual(['b', 'a']);
    expect(ranked.every((x) => x.match.score === 0 && x.match.match)).toBe(true);
  });

  it('filters non-hits and ranks title above body', () => {
    const bodyOnly = session({
      id: 'body',
      title: '无关标题',
      messages: [msg({ id: 'm', text: '讨论重构策略' })],
    });
    const titleHit = session({
      id: 'title',
      title: '重构计划',
      messages: [msg({ id: 'm2', text: '细节' })],
    });
    const miss = session({
      id: 'miss',
      title: '其它',
      messages: [msg({ id: 'm3', text: '天气不错' })],
    });
    const ranked = rankSessionsBySearch([bodyOnly, miss, titleHit], '重构');
    expect(ranked.map((x) => x.session.id)).toEqual(['title', 'body']);
    expect(ranked![0]!.match.score).toBeGreaterThan(ranked![1]!.match.score);
  });

  it('stable id tiebreak when scores equal', () => {
    const s1 = session({ id: 'z-id', title: 'token-x' });
    const s2 = session({ id: 'a-id', title: 'token-x' });
    const ranked = rankSessionsBySearch([s1, s2], 'token-x');
    expect(ranked.map((x) => x.session.id)).toEqual(['a-id', 'z-id']);
  });

  it('handles empty sessions array', () => {
    expect(rankSessionsBySearch([], 'q')).toEqual([]);
  });
});
