// @vitest-environment node
/**
 * 搜索态性能优化测试（08-detail 步骤 3：T3.1）。
 *
 * - T3.1：messageMatchesSearchTokens（预折叠版）与 messageMatchesSearch
 *   逐项对拍（既有用例语义等价）；tokens 空 → false。
 */
import { describe, expect, it } from 'vitest';
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

  it('tokens 版 === 原版（既有用例语义对拍）', () => {
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
