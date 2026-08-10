/**
 * B5 自动补全核心测试（src/core/autocomplete.ts）
 *
 * 覆盖（对应任务书验收：触发/候选/选中）：
 * - 候选源注册表：内置 @mention 演示源默认注册；register 同名替换；
 *   unregister；版本号自增；触发字符集合动态派生（@/:/# 可配）；
 * - findAutocompleteTriggerInLine：行首/空白后触发、词中间不触发、
 *   query 提取、空 query、超长 query 上限；
 * - filterAutocompleteCandidates：前缀 > 包含 > 插入文本包含的评分
 *   排序、空 query 全量截断；
 * - buildAutocompleteReplace：默认/自定义 cursorOffset、insertText
 *   替换语义（选中即插入事务参数）。
 *
 * 纪律：注册的测试源在 afterEach 统一移除（内置 @ 演示源不动——
 * 出厂注册），不污染其它测试文件（ruler.test.ts 同款清理协议）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  registerAutocompleteSource,
  unregisterAutocompleteSource,
  getAutocompleteTriggers,
  getAutocompleteCandidates,
  getAutocompleteVersion,
  findAutocompleteTriggerInLine,
  filterAutocompleteCandidates,
  buildAutocompleteReplace,
  MENTION_DEMO_CANDIDATES,
  AUTOCOMPLETE_QUERY_MAX_LEN,
  type AutocompleteCandidate,
} from '../../src/core/autocomplete';

const registeredTriggers: string[] = [];

afterEach(() => {
  while (registeredTriggers.length > 0) {
    unregisterAutocompleteSource(registeredTriggers.pop()!);
  }
});

/** 注册测试源并记账（afterEach 统一清理） */
function registerTestSource(trigger: string, candidates: AutocompleteCandidate[]): void {
  registerAutocompleteSource({ trigger, candidates });
  if (!registeredTriggers.includes(trigger)) registeredTriggers.push(trigger);
}

describe('候选源注册表（InlineRuler.register 同款形态）', () => {
  it('内置 @mention 演示源出厂注册：触发集合含 @，候选为演示成员', () => {
    expect(getAutocompleteTriggers()).toContain('@');
    expect(getAutocompleteCandidates('@')).toEqual(MENTION_DEMO_CANDIDATES);
  });

  it('register 新增触发字符（@/:/# 可配——宿主注册任意字符即启用）', () => {
    registerTestSource(':', [
      { label: 'alert', detail: '命令' },
      { label: 'align', detail: '命令' },
    ]);
    expect(getAutocompleteTriggers()).toContain(':');
    expect(getAutocompleteCandidates(':').length).toBe(2);
  });

  it('同名注册即替换（markdown-it at 语义）；版本号自增', () => {
    const v0 = getAutocompleteVersion();
    registerTestSource('#', [{ label: 'first' }]);
    const v1 = getAutocompleteVersion();
    registerTestSource('#', [{ label: 'second' }]);
    expect(getAutocompleteVersion()).toBeGreaterThan(v1);
    expect(getAutocompleteVersion()).toBeGreaterThan(v0);
    // 同名 # 被替换（内置 @ 演示源不触碰——afterEach 只清测试记账）
    expect(getAutocompleteCandidates('#')[0].label).toBe('second');
  });

  it('unregister 返回命中与否；未注册触发字符候选为空数组', () => {
    expect(unregisterAutocompleteSource('#')).toBe(false);
    registerTestSource('#', [{ label: 'tag1' }]);
    expect(getAutocompleteTriggers()).toContain('#');
    expect(unregisterAutocompleteSource('#')).toBe(true);
    expect(getAutocompleteCandidates('#')).toEqual([]);
  });
});

describe('findAutocompleteTriggerInLine（行内触发检测）', () => {
  const triggers = ['@', ':', '#'];

  it('空白后触发：query 正确提取（行内偏移）', () => {
    const line = 'hello @alice';
    const q = findAutocompleteTriggerInLine(line, line.length, triggers);
    expect(q).not.toBeNull();
    expect(q!.trigger).toBe('@');
    expect(q!.query).toBe('alice');
    expect(q!.start).toBe(6);
    expect(q!.cursorPos).toBe(12);
  });

  it('行首触发：start = 0', () => {
    const line = '@alice';
    const q = findAutocompleteTriggerInLine(line, line.length, triggers);
    expect(q).not.toBeNull();
    expect(q!.start).toBe(0);
    expect(q!.query).toBe('alice');
  });

  it('空 query（刚输入触发字符）：触发且 query 为空', () => {
    const line = 'say @';
    const q = findAutocompleteTriggerInLine(line, line.length, triggers);
    expect(q).not.toBeNull();
    expect(q!.trigger).toBe('@');
    expect(q!.query).toBe('');
    expect(q!.start).toBe(4);
  });

  it('词中间不触发：foo@bar 光标在 r 后 → null', () => {
    const line = 'foo@bar';
    expect(findAutocompleteTriggerInLine(line, line.length, triggers)).toBeNull();
  });

  it('触发字符前为行首/空白才有效：非空白前字符不触发', () => {
    expect(findAutocompleteTriggerInLine('a@b', 3, triggers)).toBeNull();
    // 空格后触发
    const q = findAutocompleteTriggerInLine('a @b', 4, triggers);
    expect(q).not.toBeNull();
    expect(q!.start).toBe(2);
  });

  it('query 含空白不触发（query 段在首个空白前截止）', () => {
    // 光标在 "hello @" 的 @ 后："@ " 后是空白 → query 空 → 触发空 query
    const line = 'hello @ alice';
    const q = findAutocompleteTriggerInLine(line, 7, triggers);
    expect(q).not.toBeNull();
    expect(q!.query).toBe('');
  });

  it('超长 query 上限：超过 AUTOCOMPLETE_QUERY_MAX_LEN 不触发', () => {
    const line = '@' + 'x'.repeat(AUTOCOMPLETE_QUERY_MAX_LEN + 10);
    expect(findAutocompleteTriggerInLine(line, line.length, triggers)).toBeNull();
    // 恰好在上限内触发
    const okLine = '@' + 'x'.repeat(AUTOCOMPLETE_QUERY_MAX_LEN - 1);
    expect(findAutocompleteTriggerInLine(okLine, okLine.length, triggers)).not.toBeNull();
  });

  it('多触发字符共存（注册后）：冒号与井号同样可触发', () => {
    const line = 'cmd :align';
    const q = findAutocompleteTriggerInLine(line, line.length, ['@', ':']);
    expect(q).not.toBeNull();
    expect(q!.trigger).toBe(':');
    expect(q!.query).toBe('align');
    const tagLine = '#topic';
    const tq = findAutocompleteTriggerInLine(tagLine, tagLine.length, ['@', '#']);
    expect(tq).not.toBeNull();
    expect(tq!.trigger).toBe('#');
  });

  it('光标在行首/空触发集合 → null', () => {
    expect(findAutocompleteTriggerInLine('@abc', 0, triggers)).toBeNull();
    expect(findAutocompleteTriggerInLine('@abc', 4, [])).toBeNull();
  });
});

describe('filterAutocompleteCandidates（候选过滤/排序）', () => {
  const candidates: AutocompleteCandidate[] = [
    { label: 'alice' },
    { label: 'bob' },
    { label: 'carol' },
    { label: 'dave' },
    { label: 'eve' },
    { label: 'felix' },
    { label: 'grace' },
    { label: 'hank' },
    { label: 'alex' }, // 前缀命中（al-）
    { label: 'cal' }, // 包含命中（-al）
  ];

  it('前缀匹配优先于包含匹配（稳定排序）', () => {
    const result = filterAutocompleteCandidates('al', candidates);
    expect(result[0].label).toBe('alex'); // 前缀
    expect(result.map((c) => c.label)).toContain('alice'); // 前缀
    expect(result.map((c) => c.label)).toContain('cal'); // 包含
    const idxAlice = result.findIndex((c) => c.label === 'alice');
    const idxCal = result.findIndex((c) => c.label === 'cal');
    expect(idxAlice).toBeLessThan(idxCal);
    expect(result.map((c) => c.label)).not.toContain('bob');
  });

  it('大小写不敏感', () => {
    const result = filterAutocompleteCandidates('ALI', candidates);
    expect(result.map((c) => c.label)).toContain('alice');
  });

  it('空 query：全量返回（截断到 AUTOCOMPLETE_MAX_CANDIDATES=20）', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ label: `c${i}` }));
    const result = filterAutocompleteCandidates('', many);
    expect(result.length).toBe(20);
  });

  it('无命中返回空数组', () => {
    expect(filterAutocompleteCandidates('zzz', candidates)).toEqual([]);
  });

  it('insertText 包含也参与匹配（label 不含时兜底）', () => {
    const cs = [
      { label: '显示名', insertText: '实际插入值' },
      { label: 'other' },
    ];
    const result = filterAutocompleteCandidates('插入', cs);
    expect(result.length).toBe(1);
    expect(result[0].label).toBe('显示名');
  });
});

describe('buildAutocompleteReplace（选中候选 → 替换事务参数）', () => {
  const query = { start: 6, cursorPos: 12 };

  it('默认：insert = label，光标落在插入文本末尾', () => {
    const r = buildAutocompleteReplace(query, { label: 'alice' });
    expect(r.from).toBe(6);
    expect(r.to).toBe(12);
    expect(r.insert).toBe('alice');
    expect(r.cursorAfter).toBe(6 + 5);
  });

  it('自定义 insertText 与 cursorOffset（光标留在插入文本内）', () => {
    const r = buildAutocompleteReplace(query, {
      label: '链接',
      insertText: '[链接](https://x)',
      cursorOffset: 3,
    });
    expect(r.insert).toBe('[链接](https://x)');
    expect(r.cursorAfter).toBe(6 + 3);
  });
});
