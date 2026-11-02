/**
 * R6：msgIds 增量维护纯函数回归。
 * - id 序列不变（消息对象被替换）→ 返回上一轮数组本身（引用稳定）；
 * - 纯尾部追加 → 前缀复用、尾部拼接；
 * - 中段变化 / 缩减 → 全量重建（结果仍正确）。
 */
import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../../store/types';
import { deriveMsgIdsIncremental } from './MessageVirtualizer';

const msg = (id: string): SessionMessage => ({ id }) as SessionMessage;

describe('R6 deriveMsgIdsIncremental', () => {
  it('首轮全量构建', () => {
    expect(deriveMsgIdsIncremental(null, [msg('a'), msg('b')])).toEqual([
      'a',
      'b',
    ]);
  });

  it('同 id 序列（对象全换）返回上一轮数组引用', () => {
    const prev = { ids: deriveMsgIdsIncremental(null, [msg('a'), msg('b')]) };
    const next = deriveMsgIdsIncremental(prev, [msg('a'), msg('b')]);
    expect(next).toBe(prev.ids);
  });

  it('尾部追加复用前缀', () => {
    const prev = { ids: deriveMsgIdsIncremental(null, [msg('a')]) };
    const next = deriveMsgIdsIncremental(prev, [msg('a'), msg('b'), msg('c')]);
    expect(next).toEqual(['a', 'b', 'c']);
    expect(next).not.toBe(prev.ids);
  });

  it('中段 id 变化回退全量重建', () => {
    const prev = {
      ids: deriveMsgIdsIncremental(null, [msg('a'), msg('b'), msg('c')]),
    };
    expect(
      deriveMsgIdsIncremental(prev, [msg('a'), msg('x'), msg('c')])
    ).toEqual(['a', 'x', 'c']);
  });

  it('列表缩减回退全量重建', () => {
    const prev = {
      ids: deriveMsgIdsIncremental(null, [msg('a'), msg('b'), msg('c')]),
    };
    expect(deriveMsgIdsIncremental(prev, [msg('a')])).toEqual(['a']);
  });
});
