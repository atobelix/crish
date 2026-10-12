/**
 * 消息时间线四级因果全序（Causal Total Order SSOT）单测。
 * 覆盖：
 * 1. compareMessageOrder 四级优先级（seq → ts → roleRank → naturalNumericId）
 * 2. getMessageOrderKey / messageOrderKey 缺省兜底与 role/sender 解析
 * 3. 严格弱序（Strict Weak Ordering）四大代数公理穷举验证
 * 4. 同毫秒时间戳碰撞下 User 恒先于 Assistant 魔鬼用例（杜绝 AI 置顶、用户沉底）
 * 5. 自然数字 ID 排序（'hyd-user-2' < 'hyd-user-10'）与 findInsertIndex / sortMessagesByOrder
 */
import { describe, expect, it } from 'vitest';
import {
  compareMessageOrder,
  compareNaturalNumericId,
  findInsertIndex,
  getMessageOrderKey,
  getRoleRank,
  isSortedByMessageOrder,
  messageOrderKey,
  resolveRoleRank,
  type MessageOrderKey,
} from './messageOrderKey';
import {
  sortMessagesByOrder,
  upsertMessageById,
} from './sessionSharedHelpers.messageMerge';
import type { SessionMessage } from './types';

function key(
  partial: Partial<MessageOrderKey> & Pick<MessageOrderKey, 'id'>
): MessageOrderKey {
  return {
    seq: Number.MAX_SAFE_INTEGER,
    ts: 0,
    roleRank: 3,
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

describe('getRoleRank & getMessageOrderKey / messageOrderKey', () => {
  it('getRoleRank 严格映射 system=0, user=1, assistant=2, other=3（大小写/空白宽容）', () => {
    expect(getRoleRank('system')).toBe(0);
    expect(getRoleRank('SYSTEM')).toBe(0);
    expect(getRoleRank('  user ')).toBe(1);
    expect(getRoleRank('User')).toBe(1);
    expect(getRoleRank('assistant')).toBe(2);
    expect(getRoleRank('Assistant')).toBe(2);
    expect(getRoleRank('tool')).toBe(3);
    expect(getRoleRank('')).toBe(3);
    expect(getRoleRank(undefined)).toBe(3);
    expect(getRoleRank(null)).toBe(3);
    expect(resolveRoleRank).toBe(getRoleRank);
  });

  it('缺省 timestamp → ts=0；非法/非正数 timestamp 同样回落 0', () => {
    expect(messageOrderKey({ id: 'a' })).toEqual({
      seq: Number.MAX_SAFE_INTEGER,
      ts: 0,
      roleRank: 3,
      id: 'a',
    });
    expect(messageOrderKey({ id: 'a', timestamp: Number.NaN }).ts).toBe(0);
    expect(
      messageOrderKey({ id: 'a', timestamp: Number.POSITIVE_INFINITY }).ts
    ).toBe(0);
    expect(messageOrderKey({ id: 'a', timestamp: -5 }).ts).toBe(0);
    expect(messageOrderKey({ id: 'a', timestamp: 0 }).ts).toBe(0);
  });

  it('有限正数 timestamp 原样保留；缺省 id → 空串；同时兼容 role 与 sender', () => {
    expect(messageOrderKey({ id: 'a', timestamp: 42 }).ts).toBe(42);
    expect(messageOrderKey({ timestamp: 7 }).id).toBe('');
    expect(
      getMessageOrderKey({ id: 'u1', role: 'user', timestamp: 10 }).roleRank
    ).toBe(1);
    expect(
      getMessageOrderKey({ id: 'a1', sender: 'assistant', timestamp: 10 })
        .roleRank
    ).toBe(2);
    expect(
      getMessageOrderKey({ id: 's1', role: 'system', sender: 'user' }).roleRank
    ).toBe(0);
  });

  it('engineSequence / seq 有限数保留，缺省 → MAX_SAFE_INTEGER', () => {
    expect(messageOrderKey({ id: 'a', engineSequence: 3 }).seq).toBe(3);
    expect(messageOrderKey({ id: 'a', engineSequence: 0 }).seq).toBe(0);
    expect(getMessageOrderKey({ id: 'a', seq: 7 }).seq).toBe(7);
    expect(getMessageOrderKey({ id: 'a', engineSequence: 4, seq: 9 }).seq).toBe(
      4
    );
    expect(messageOrderKey({ id: 'a' }).seq).toBe(Number.MAX_SAFE_INTEGER);
    expect(messageOrderKey({ id: 'a', engineSequence: Number.NaN }).seq).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });
});

describe('compareMessageOrder：seq → ts → roleRank → naturalNumericId 四级全序', () => {
  it('第 1 级 seq 优先：小 seq 在前，即使其 ts 更大或 roleRank 更大', () => {
    const early = key({ id: 'x', seq: 1, ts: 9999, roleRank: 2 });
    const late = key({ id: 'a', seq: 2, ts: 1, roleRank: 1 });
    expect(compareMessageOrder(early, late)).toBeLessThan(0);
    expect(compareMessageOrder(late, early)).toBeGreaterThan(0);
  });

  it('一方缺省 seq（MAX_SAFE 或 undefined）时排在有 seq 之后', () => {
    const withSeq = key({ id: 'a', seq: 10, ts: 999 });
    const noSeq = key({ id: 'b', ts: 1 });
    const omittedSeq: MessageOrderKey = { ts: 1, roleRank: 1, id: 'c' };
    expect(compareMessageOrder(withSeq, noSeq)).toBeLessThan(0);
    expect(compareMessageOrder(noSeq, withSeq)).toBeGreaterThan(0);
    expect(compareMessageOrder(withSeq, omittedSeq)).toBeLessThan(0);
    expect(compareMessageOrder(omittedSeq, withSeq)).toBeGreaterThan(0);
  });

  it('第 2 级 ts 次之：双方同缺省 seq 时按 ts 升序', () => {
    const a = key({ id: 'b', ts: 100, roleRank: 2 });
    const b = key({ id: 'a', ts: 200, roleRank: 1 });
    expect(compareMessageOrder(a, b)).toBeLessThan(0);
    expect(compareMessageOrder(b, a)).toBeGreaterThan(0);
  });

  it('第 3 级 roleRank（核心防倒置）：同毫秒且无 seq 时，user 恒先于 assistant，免疫 ID 字典序', () => {
    const sysMsg = getMessageOrderKey({
      id: 'z-system-msg',
      role: 'system',
      timestamp: 1791764675736,
    });
    const userMsg = getMessageOrderKey({
      id: 'user-msg-1791764675736',
      sender: 'user',
      timestamp: 1791764675736,
    });
    const asstMsg = getMessageOrderKey({
      id: 'assistant-msg-1791764675736',
      sender: 'assistant',
      timestamp: 1791764675736,
    });

    // 即使 'assistant-msg-*' < 'user-msg-*' < 'z-system-msg'，严格按 system(0) < user(1) < assistant(2) 排序
    expect(compareMessageOrder(sysMsg, userMsg)).toBeLessThan(0);
    expect(compareMessageOrder(userMsg, asstMsg)).toBeLessThan(0);
    expect(compareMessageOrder(asstMsg, userMsg)).toBeGreaterThan(0);
  });

  it('第 4 级 naturalNumericId：同 seq 同 ts 同 roleRank 时按自然数字序（hyd-user-2 < hyd-user-10）', () => {
    const m2 = getMessageOrderKey({
      id: 'hyd-user-2',
      sender: 'user',
      timestamp: 1000,
    });
    const m10 = getMessageOrderKey({
      id: 'hyd-user-10',
      sender: 'user',
      timestamp: 1000,
    });
    const m100 = getMessageOrderKey({
      id: 'hyd-user-100',
      sender: 'user',
      timestamp: 1000,
    });

    expect(compareMessageOrder(m2, m10)).toBeLessThan(0);
    expect(compareMessageOrder(m10, m2)).toBeGreaterThan(0);
    expect(compareMessageOrder(m10, m100)).toBeLessThan(0);
    expect(compareMessageOrder(m2, m100)).toBeLessThan(0);
    // 前导零数值相等时仍有确定性全序（不返回 0）
    expect(compareNaturalNumericId('id-01', 'id-1')).not.toBe(0);
    expect(compareNaturalNumericId('id-01', 'id-1')).toBe(
      -compareNaturalNumericId('id-1', 'id-01')
    );
  });

  it('同 seq 同 ts 同 roleRank 不同字母 id → 稳定全序', () => {
    const a = key({ id: 'a', ts: 10 });
    const b = key({ id: 'b', ts: 10 });
    expect(compareMessageOrder(a, b)).toBeLessThan(0);
    expect(compareMessageOrder(b, a)).toBeGreaterThan(0);
    expect(compareMessageOrder(a, a)).toBe(0);
  });

  it('键序可传递：seq → ts → roleRank → id 的四级全序', () => {
    const list = [
      key({ id: 'z', ts: 1, roleRank: 2 }),
      key({ id: 'a', ts: 1, roleRank: 1 }),
      key({ id: 'a', ts: 999, roleRank: 1 }),
      key({ id: 'm', seq: 5, ts: 0, roleRank: 2 }),
      key({ id: 'b', seq: 1, ts: 999, roleRank: 2 }),
    ];
    const sorted = [...list].sort(compareMessageOrder);
    // b(seq=1) → m(seq=5) → a(ts=1, user) → z(ts=1, asst) → a(ts=999, user)
    expect(sorted.map((k) => `${k.id}:${k.ts}:${k.roleRank}`)).toEqual([
      'b:999:2',
      'm:0:2',
      'a:1:1',
      'z:1:2',
      'a:999:1',
    ]);
    expect(
      isSortedByMessageOrder(
        sorted.map((k) => ({
          id: k.id,
          timestamp: k.ts,
          role: k.roleRank === 1 ? 'user' : 'assistant',
          engineSequence: k.seq === Number.MAX_SAFE_INTEGER ? undefined : k.seq,
        }))
      )
    ).toBe(true);
  });
});

describe('严格弱序（Strict Weak Ordering）代数公理穷举验证', () => {
  const sampleKeys: MessageOrderKey[] = [
    { seq: 1, ts: 1000, roleRank: 1, id: 'user-1' },
    { seq: 1, ts: 1000, roleRank: 2, id: 'asst-1' },
    { seq: 1, ts: 2000, roleRank: 1, id: 'user-2' },
    { seq: 2, ts: 500, roleRank: 2, id: 'asst-0' },
    { seq: Number.MAX_SAFE_INTEGER, ts: 1000, roleRank: 0, id: 'sys-1' },
    { seq: Number.MAX_SAFE_INTEGER, ts: 1000, roleRank: 1, id: 'hyd-user-1' },
    { seq: Number.MAX_SAFE_INTEGER, ts: 1000, roleRank: 1, id: 'hyd-user-2' },
    { seq: Number.MAX_SAFE_INTEGER, ts: 1000, roleRank: 1, id: 'hyd-user-10' },
    { seq: Number.MAX_SAFE_INTEGER, ts: 1000, roleRank: 2, id: 'hyd-asst-1' },
    { seq: Number.MAX_SAFE_INTEGER, ts: 1000, roleRank: 2, id: 'hyd-asst-2' },
    { seq: Number.MAX_SAFE_INTEGER, ts: 1000, roleRank: 2, id: 'hyd-asst-10' },
    { ts: 2000, roleRank: 1, id: 'omitted-seq-user' },
  ];

  it('公理 1：非自反性 (Irreflexivity) - compareMessageOrder(k, k) === 0', () => {
    for (const k of sampleKeys) {
      expect(compareMessageOrder(k, k)).toBe(0);
    }
  });

  it('公理 2：反对称性/非对称性 (Asymmetry) - a < b 必有 b > a', () => {
    for (let i = 0; i < sampleKeys.length; i++) {
      for (let j = 0; j < sampleKeys.length; j++) {
        const ki = sampleKeys[i]!;
        const kj = sampleKeys[j]!;
        const ab = compareMessageOrder(ki, kj);
        const ba = compareMessageOrder(kj, ki);
        if (ab === 0) {
          expect(ba).toBe(0);
        } else {
          expect(ab).toBe(-ba);
        }
      }
    }
  });

  it('公理 3：传递性 (Transitivity) - a < b 且 b < c 必有 a < c', () => {
    for (const a of sampleKeys) {
      for (const b of sampleKeys) {
        for (const c of sampleKeys) {
          if (compareMessageOrder(a, b) < 0 && compareMessageOrder(b, c) < 0) {
            expect(compareMessageOrder(a, c)).toBeLessThan(0);
          }
        }
      }
    }
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
    expect(findInsertIndex(list, key({ id: 'aa', ts: 10 }))).toBe(1);
    expect(findInsertIndex(list, key({ id: 'b', ts: 10 }))).toBe(2);
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
    expect(
      isSortedByMessageOrder(
        list.map((k) => ({
          id: k.id,
          timestamp: k.ts,
          engineSequence: k.seq === Number.MAX_SAFE_INTEGER ? undefined : k.seq,
        }))
      )
    ).toBe(true);
    const linearUpperBound = (
      arr: MessageOrderKey[],
      item: MessageOrderKey
    ): number => {
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

describe('sortMessagesByOrder & upsertMessageById：防倒置魔鬼用例与稳定排序', () => {
  it('按 canonical order 重排乱序列表且不 mutate 入参', () => {
    const input: SessionMessage[] = [
      msg({ id: 'a2', sender: 'assistant', timestamp: 201 }),
      msg({ id: 'u1', sender: 'user', timestamp: 100 }),
      msg({ id: 'a1', sender: 'assistant', timestamp: 101 }),
      msg({ id: 'u2', sender: 'user', timestamp: 200 }),
    ];
    const got = sortMessagesByOrder(input);
    expect(got.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(input.map((m) => m.id)).toEqual(['a2', 'u1', 'a1', 'u2']);
    expect(got).not.toBe(input);
  });

  it('同 ts 同角色不同 id 稳定序（结果确定且幂等）', () => {
    const input: SessionMessage[] = [
      msg({ id: 'b', timestamp: 10 }),
      msg({ id: 'a', timestamp: 10 }),
      msg({ id: 'c', timestamp: 10 }),
    ];
    const got = sortMessagesByOrder(input);
    expect(got.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(sortMessagesByOrder(got).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('engineSequence 小者优先于 timestamp（SessionMessage.engineSequence 原生强类型）', () => {
    const withSeq = msg({ id: 'has-seq', timestamp: 9999, engineSequence: 1 });
    const input: SessionMessage[] = [
      msg({ id: 'no-seq', timestamp: 1 }),
      withSeq,
    ];
    expect(sortMessagesByOrder(input).map((m) => m.id)).toEqual([
      'has-seq',
      'no-seq',
    ]);
  });

  it('魔鬼用例：同毫秒碰撞下 upsertMessageById 逆序注入 assistant 与 user，user 必排在 assistant 之前', () => {
    const list: SessionMessage[] = [];
    upsertMessageById(
      list,
      msg({
        id: 'assistant-msg-1791764675736',
        sender: 'assistant',
        timestamp: 1791764675736,
      })
    );
    upsertMessageById(
      list,
      msg({
        id: 'user-msg-1791764675736',
        sender: 'user',
        timestamp: 1791764675736,
      })
    );
    expect(list.map((m) => m.sender)).toEqual(['user', 'assistant']);
    expect(list.map((m) => m.id)).toEqual([
      'user-msg-1791764675736',
      'assistant-msg-1791764675736',
    ]);
  });

  it('魔鬼用例：12 条全零时间戳乱序消息重排，User 恒在 Assistant 前且按自然数字 1..12 升序', () => {
    const corrupted: SessionMessage[] = [
      msg({ id: 'hyd-asst-10', sender: 'assistant', timestamp: 0 }),
      msg({ id: 'hyd-user-10', sender: 'user', timestamp: 0 }),
      msg({ id: 'hyd-asst-2', sender: 'assistant', timestamp: 0 }),
      msg({ id: 'hyd-user-2', sender: 'user', timestamp: 0 }),
      msg({ id: 'hyd-asst-1', sender: 'assistant', timestamp: 0 }),
      msg({ id: 'hyd-user-1', sender: 'user', timestamp: 0 }),
    ];
    const sorted = sortMessagesByOrder(corrupted);
    expect(sorted.map((m) => m.id)).toEqual([
      'hyd-user-1',
      'hyd-user-2',
      'hyd-user-10',
      'hyd-asst-1',
      'hyd-asst-2',
      'hyd-asst-10',
    ]);
  });

  it('空列表 / 单元素', () => {
    expect(sortMessagesByOrder([])).toEqual([]);
    const one = [msg({ id: 'only', timestamp: 3 })];
    expect(sortMessagesByOrder(one).map((m) => m.id)).toEqual(['only']);
  });
});
