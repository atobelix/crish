/**
 * 消息时间线 canonical order（D1 SSOT）单测。
 * 覆盖：compareMessageOrder 序键优先级、messageOrderKey 缺省兜底、
 * findInsertIndex 二分正确性、sortMessagesByOrder 稳定且不 mutate 入参。
 */
import { describe, expect, it } from 'vitest';
import {
  compareMessageOrder,
  findInsertIndex,
  isSortedByMessageOrder,
  messageOrderKey,
  type MessageOrderKey,
} from './messageOrderKey';
import { sortMessagesByOrder } from './sessionSharedHelpers.messageMerge';
import type { SessionMessage } from './types';

function key(
  partial: Partial<MessageOrderKey> & Pick<MessageOrderKey, 'id'>
): MessageOrderKey {
  return {
    seq: Number.MAX_SAFE_INTEGER,
    ts: 0,
    ...partial,
  };
}

function msg(
  partial: Partial<SessionMessage> & Pick<SessionMessage, 'id'>
): SessionMessage {
  return {
    sender: 'assistant',
    timestamp: 1,
    ...partial,
  };
}

describe('messageOrderKey', () => {
  it('缺省 timestamp → ts=0；非法/非正数 timestamp 同样回落 0', () => {
    expect(messageOrderKey({ id: 'a' })).toEqual({
      seq: Number.MAX_SAFE_INTEGER,
      ts: 0,
      id: 'a',
    });
    expect(messageOrderKey({ id: 'a', timestamp: Number.NaN }).ts).toBe(0);
    expect(messageOrderKey({ id: 'a', timestamp: Number.POSITIVE_INFINITY }).ts).toBe(0);
    expect(messageOrderKey({ id: 'a', timestamp: -5 }).ts).toBe(0);
    expect(messageOrderKey({ id: 'a', timestamp: 0 }).ts).toBe(0);
  });

  it('有限正数 timestamp 原样保留；缺省 id → 空串', () => {
    expect(messageOrderKey({ id: 'a', timestamp: 42 }).ts).toBe(42);
    expect(messageOrderKey({ timestamp: 7 }).id).toBe('');
  });

  it('engineSequence 有限数保留，缺省 → MAX_SAFE_INTEGER', () => {
    expect(messageOrderKey({ id: 'a', engineSequence: 3 }).seq).toBe(3);
    expect(messageOrderKey({ id: 'a', engineSequence: 0 }).seq).toBe(0);
    expect(messageOrderKey({ id: 'a' }).seq).toBe(Number.MAX_SAFE_INTEGER);
    expect(messageOrderKey({ id: 'a', engineSequence: Number.NaN }).seq).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });
});

describe('compareMessageOrder：seq 优先 → ts 次之 → id 兜底', () => {
  it('seq 优先：小 seq 在前，即使其 ts 更大', () => {
    const early = key({ id: 'x', seq: 1, ts: 9999 });
    const late = key({ id: 'a', seq: 2, ts: 1 });
    expect(compareMessageOrder(early, late)).toBeLessThan(0);
    expect(compareMessageOrder(late, early)).toBeGreaterThan(0);
  });

  it('一方缺省 seq（MAX_SAFE）时排在有 seq 之后', () => {
    const withSeq = key({ id: 'a', seq: 10, ts: 999 });
    const noSeq = key({ id: 'b', ts: 1 });
    expect(compareMessageOrder(withSeq, noSeq)).toBeLessThan(0);
    expect(compareMessageOrder(noSeq, withSeq)).toBeGreaterThan(0);
  });

  it('双方同缺省 seq 时落到 ts（小在前）', () => {
    const a = key({ id: 'b', ts: 100 });
    const b = key({ id: 'a', ts: 200 });
    expect(compareMessageOrder(a, b)).toBeLessThan(0);
    expect(compareMessageOrder(b, a)).toBeGreaterThan(0);
  });

  it('同 seq 同 ts 不同 id → id 字典序稳定序', () => {
    const a = key({ id: 'a', ts: 10 });
    const b = key({ id: 'b', ts: 10 });
    expect(compareMessageOrder(a, b)).toBeLessThan(0);
    expect(compareMessageOrder(b, a)).toBeGreaterThan(0);
    expect(compareMessageOrder(a, a)).toBe(0);
  });

  it('键序可传递：seq 优先于 ts 优先于 id 的全序', () => {
    const list = [
      key({ id: 'z', ts: 1 }),
      key({ id: 'a', ts: 999 }),
      key({ id: 'm', seq: 5, ts: 0 }),
      key({ id: 'b', seq: 1, ts: 999 }),
    ];
    const sorted = [...list].sort(compareMessageOrder);
    // b(seq=1) → m(seq=5) → z(ts=1 无 seq) → a(ts=999 无 seq)
    expect(sorted.map((k) => k.id)).toEqual(['b', 'm', 'z', 'a']);
    expect(
      isSortedByMessageOrder(
        sorted.map((k) => ({
          id: k.id,
          timestamp: k.ts,
          engineSequence:
            k.seq === Number.MAX_SAFE_INTEGER ? undefined : k.seq,
        }))
      )
    ).toBe(true);
  });
});

describe('findInsertIndex 二分正确性', () => {
  it('空列表 → 0；比所有都小 → 头；比所有都大 → 尾', () => {
    const list = [key({ id: 'b', ts: 10 }), key({ id: 'c', ts: 20 })];
    expect(findInsertIndex([], key({ id: 'a', ts: 1 }))).toBe(0);
    expect(findInsertIndex(list, key({ id: 'a', ts: 1 }))).toBe(0);
    expect(findInsertIndex(list, key({ id: 'd', ts: 30 }))).toBe(2);
  });

  it('插入中间：在 ts=10 与 ts=20 之间', () => {
    const list = [key({ id: 'b', ts: 10 }), key({ id: 'd', ts: 30 })];
    expect(findInsertIndex(list, key({ id: 'c', ts: 20 }))).toBe(1);
  });

  it('相等键：upper-bound（第一个严格大于的位置），插到相等元素之后', () => {
    const list = [key({ id: 'a', ts: 10 }), key({ id: 'b', ts: 10 })];
    // 同 ts 不同 id：'a' < 'aa' < 'b'（localeCompare 字典序）
    expect(findInsertIndex(list, key({ id: 'aa', ts: 10 }))).toBe(1);
    // 与 b 完全同键：upper-bound 插到 b 之后
    expect(findInsertIndex(list, key({ id: 'b', ts: 10 }))).toBe(2);
    // 比 a 更小的 id：插到最前
    expect(findInsertIndex(list, key({ id: '0', ts: 10 }))).toBe(0);
  });

  it('与线性 upper-bound 扫描一致（乱序样本上的已序子场景）', () => {
    const list = [
      key({ id: 'a', seq: 1, ts: 5 }),
      key({ id: 'b', seq: 2, ts: 1 }),
      key({ id: 'c', ts: 0 }),
      key({ id: 'd', ts: 99 }),
      key({ id: 'e', ts: 100 }),
    ];
    expect(isSortedByMessageOrder(list.map((k) => ({ id: k.id, timestamp: k.ts, engineSequence: k.seq === Number.MAX_SAFE_INTEGER ? undefined : k.seq })))).toBe(true);
    const linearUpperBound = (arr: MessageOrderKey[], item: MessageOrderKey): number => {
      let i = 0;
      while (i < arr.length && compareMessageOrder(arr[i]!, item) <= 0) i += 1;
      return i;
    };
    const probes = [
      key({ id: '0', seq: 0 }),
      key({ id: 'a1', seq: 1, ts: 6 }),
      key({ id: 'bb', seq: 2, ts: 2 }),
      key({ id: 'cz', ts: 1 }),
      key({ id: 'm', ts: 50 }),
      key({ id: 'z', ts: 1000 }),
    ];
    for (const p of probes) {
      expect(findInsertIndex(list, p)).toBe(linearUpperBound(list, p));
    }
  });

  it('单元素列表', () => {
    const list = [key({ id: 'm', ts: 50 })];
    expect(findInsertIndex(list, key({ id: 'a', ts: 1 }))).toBe(0);
    expect(findInsertIndex(list, key({ id: 'z', ts: 99 }))).toBe(1);
  });
});

describe('sortMessagesByOrder：稳定排序且不 mutate 入参', () => {
  it('按 canonical order 重排乱序列表', () => {
    const input: SessionMessage[] = [
      msg({ id: 'a2', sender: 'assistant', timestamp: 201 }),
      msg({ id: 'u1', sender: 'user', timestamp: 100 }),
      msg({ id: 'a1', sender: 'assistant', timestamp: 101 }),
      msg({ id: 'u2', sender: 'user', timestamp: 200 }),
    ];
    const got = sortMessagesByOrder(input);
    expect(got.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    // 不 mutate 入参
    expect(input.map((m) => m.id)).toEqual(['a2', 'u1', 'a1', 'u2']);
    expect(got).not.toBe(input);
  });

  it('同 ts 不同 id 稳定序（id 字典序决定，结果确定）', () => {
    const input: SessionMessage[] = [
      msg({ id: 'b', timestamp: 10 }),
      msg({ id: 'a', timestamp: 10 }),
      msg({ id: 'c', timestamp: 10 }),
    ];
    const got = sortMessagesByOrder(input);
    expect(got.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    // 再排一次幂等
    expect(sortMessagesByOrder(got).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('engineSequence 小者优先于 timestamp', () => {
    const withSeq = msg({ id: 'has-seq', timestamp: 9999 });
    (withSeq as SessionMessage & { engineSequence?: number }).engineSequence = 1;
    const input: SessionMessage[] = [
      msg({ id: 'no-seq', timestamp: 1 }),
      withSeq,
    ];
    expect(sortMessagesByOrder(input).map((m) => m.id)).toEqual([
      'has-seq',
      'no-seq',
    ]);
  });

  it('空列表 / 单元素', () => {
    expect(sortMessagesByOrder([])).toEqual([]);
    const one = [msg({ id: 'only', timestamp: 3 })];
    expect(sortMessagesByOrder(one).map((m) => m.id)).toEqual(['only']);
  });
});
