// @vitest-environment node
/**
 * 搜索态性能优化测试（08-detail 步骤 3：T3.1 / T3.2）。
 *
 * - T3.1：messageMatchesSearchTokens（预折叠版）与 messageMatchesSearch
 *   逐项对拍（既有用例语义等价）；tokens 空 → false。
 * - T3.2：collectMustIncludeIndicesCached 与 collectMustIncludeIndices
 *   输出对拍 + immer 对象身份命中缓存三路径失效断言
 *   （query 变更 / 消息增删 / 工具状态终态）+ 引用未变不复算（spy 计数）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  collectMustIncludeIndices,
  collectMustIncludeIndicesCached,
  createMustIncludeHitCache,
} from './messageWindow';
import {
  messageMatchesSearch,
  messageMatchesSearchTokens,
  normalizeSearchQuery,
  tokenizeSearchQuery,
} from './sessionSearch';
import type { SessionMessage } from '../store/types';

function msg(
  id: string,
  opts: { text?: string; toolCalls?: SessionMessage['toolCalls'] } = {}
): SessionMessage {
  return {
    id,
    sender: 'assistant',
    timestamp: 1000,
    text: opts.text ?? '',
    toolCalls: opts.toolCalls ?? [],
    blocks: [],
  } as SessionMessage;
}

// ── T3.1 ──────────────────────────────────────────────────────────────
describe('messageMatchesSearchTokens 预折叠对拍（T3.1）', () => {
  const sampleMessages = [
    msg('m1', { text: 'hello world' }),
    msg('m2', { text: '重构完成' }),
    msg('m3', {
      text: '普通正文',
      toolCalls: [
        {
          id: 't1',
          name: 'read_file',
          arguments: '{"path":"a.ts"}',
          status: 'success',
          output: '吞吐与延迟指标',
        },
      ],
    }),
    msg('m4', { text: '  空  ' }),
  ];

  it('tokens 版 === 原版（既有 messageMatchesSearch 用例集语义对拍）', () => {
    const queries = [
      '',
      '   ',
      'hello',
      'WORLD',
      '重构',
      '吞吐',
      'read_file',
      'a.ts',
      '不存在的词',
      'hello world',
      'hello 不存在的',
    ];
    for (const q of queries) {
      const tokens = tokenizeSearchQuery(q);
      const norm = normalizeSearchQuery(q);
      for (const m of sampleMessages) {
        expect(
          messageMatchesSearchTokens(m, tokens, norm),
          `query=${JSON.stringify(q)} msg=${m.id}`
        ).toBe(messageMatchesSearch(m, q));
      }
    }
  });

  it('空 tokens / 空消息 → false（与包装版一致）', () => {
    expect(messageMatchesSearchTokens(null, [], '')).toBe(false);
    expect(messageMatchesSearchTokens(msg('x'), [], '')).toBe(false);
    expect(messageMatchesSearchTokens(undefined, ['t'], 't')).toBe(false);
  });

  it('多 token AND + 工具字段命中', () => {
    const tokens = tokenizeSearchQuery('吞吐 延迟');
    const norm = normalizeSearchQuery('吞吐 延迟');
    // 工具 output 同时含两 token → 命中
    expect(messageMatchesSearchTokens(msg('t', { text: '无关', toolCalls: [
      { id: 'a', name: 'x', arguments: '', status: 'success', output: '吞吐 延迟 报告' },
    ] }), tokens, norm)).toBe(true);
  });
});

// ── T3.2 ──────────────────────────────────────────────────────────────
describe('collectMustIncludeIndicesCached（T3.2）', () => {
  function baseOptions(cache: ReturnType<typeof createMustIncludeHitCache>, queryKey: string) {
    return {
      includePendingApprovals: true,
      matchOnlyFirst: true,
      match: (m: SessionMessage) => (m.text || '').includes('命中'),
      cache,
      queryKey,
    };
  }

  it('输出与 collectMustIncludeIndices 逐项相等', () => {
    const messages = [
      msg('a', { text: '命中第一' }),
      msg('b', { text: '未中' }),
      msg('c', { text: '命中第二' }),
      msg('d', { text: '未中', toolCalls: [{ id: 't', name: 'x', arguments: '', status: 'pending_approval' }] }),
    ];
    const cache = createMustIncludeHitCache();
    const cached = collectMustIncludeIndicesCached(messages, {
      ...baseOptions(cache, 'q1'),
    });
    const plain = collectMustIncludeIndices(messages, {
      includePendingApprovals: true,
      matchOnlyFirst: true,
      match: (m: SessionMessage) => (m.text || '').includes('命中'),
    });
    expect(cached).toEqual(plain);
  });

  it('引用未变不复算（spy 计数）：纯文本流式期除最后一条外全部命中缓存', () => {
    const messages = [
      msg('a', { text: '命中' }),
      msg('b', { text: '未中' }),
      msg('c', { text: '命中' }),
    ];
    const cache = createMustIncludeHitCache();
    const spy = vi.fn((m: SessionMessage) => (m.text || '').includes('命中'));
    // matchOnlyFirst:false → 全量求值（spy 计数口径；首命中短路由对拍用例覆盖）
    const first = collectMustIncludeIndicesCached(messages, {
      includePendingApprovals: true,
      matchOnlyFirst: false,
      match: spy,
      cache,
      queryKey: 'q',
    });
    expect(first).toEqual([0, 2]);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockClear();

    // 流式帧：只有最后一条换引用（immer 结构共享）→ 仅重求值最后一条
    const nextMessages = [messages[0]!, messages[1]!, { ...messages[2]!, text: '命中（更新）' }];
    const second = collectMustIncludeIndicesCached(nextMessages, {
      includePendingApprovals: true,
      matchOnlyFirst: false,
      match: spy,
      cache,
      queryKey: 'q',
    });
    expect(second).toEqual([0, 2]);
    expect(spy).toHaveBeenCalledTimes(1); // 仅最后一条重求值
  });

  it('query 变更 → 整体失效重扫（spy 全量重求值）', () => {
    const messages = [msg('a', { text: '命中' }), msg('b', { text: '未中' })];
    const cache = createMustIncludeHitCache();
    const spy = vi.fn((m: SessionMessage) => (m.text || '').includes('命中'));
    collectMustIncludeIndicesCached(messages, {
      ...baseOptions(cache, 'q1'),
      matchOnlyFirst: false,
      match: spy,
    });
    spy.mockClear();
    collectMustIncludeIndicesCached(messages, {
      ...baseOptions(cache, 'q2'),
      matchOnlyFirst: false,
      match: spy,
    });
    expect(spy).toHaveBeenCalledTimes(2); // 全量重扫
  });

  it('工具状态终态：仅该消息重求值，其余命中缓存', () => {
    const messages = [
      msg('a', { text: '正文' }),
      msg('b', { text: '正文' }),
    ];
    const cache = createMustIncludeHitCache();
    const spy = vi.fn((m: SessionMessage) => (m.text || '').includes('正文'));
    collectMustIncludeIndicesCached(messages, {
      includePendingApprovals: true,
      matchOnlyFirst: false,
      match: spy,
      cache,
      queryKey: 'q',
    });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockClear();
    // 工具状态终态：b 换引用（toolCalls 更新）→ 仅 b 重求值
    const b2 = { ...messages[1]!, toolCalls: [{ id: 't', name: 'x', arguments: '', status: 'success' }] };
    collectMustIncludeIndicesCached([messages[0]!, b2], {
      includePendingApprovals: true,
      matchOnlyFirst: false,
      match: spy,
      cache,
      queryKey: 'q',
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('消息增删：新增消息重求值，未变消息复用', () => {
    const messages = [msg('a', { text: '命中' }), msg('b', { text: '未中' })];
    const cache = createMustIncludeHitCache();
    const spy = vi.fn((m: SessionMessage) => (m.text || '').includes('命中'));
    collectMustIncludeIndicesCached(messages, {
      ...baseOptions(cache, 'q'),
      matchOnlyFirst: false,
      match: spy,
    });
    spy.mockClear();
    const withNew = [...messages, msg('c', { text: '命中第三' })];
    const result = collectMustIncludeIndicesCached(withNew, {
      ...baseOptions(cache, 'q'),
      matchOnlyFirst: false,
      match: spy,
    });
    expect(result).toEqual([0, 2]);
    expect(spy).toHaveBeenCalledTimes(1); // 仅新增的 c 被求值
  });

  it('与 collectMustIncludeIndices 对拍：pin/extra/审批混合场景', () => {
    const messages = [
      msg('a', { text: '命中' }),
      msg('b', { text: '未中', toolCalls: [{ id: 't', name: 'x', arguments: '', status: 'pending_approval' }] }),
      msg('c', { text: '未中' }),
    ];
    const cache = createMustIncludeHitCache();
    const mkMatch = (q: string) => (m: SessionMessage) => (m.text || '').includes(q);
    const cached = collectMustIncludeIndicesCached(messages, {
      includePendingApprovals: true,
      match: mkMatch('命中'),
      matchOnlyFirst: false,
      pinIds: ['c'],
      extraIndices: [1],
      cache,
      queryKey: 'h',
    });
    const plain = collectMustIncludeIndices(messages, {
      includePendingApprovals: true,
      match: mkMatch('命中'),
      matchOnlyFirst: false,
      pinIds: ['c'],
      extraIndices: [1],
    });
    expect(cached).toEqual(plain);
  });
});
