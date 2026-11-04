// 未送达行规格化纯函数测试（批 C 03-4）：7 类原因家族映射与动作
// 裁决、每会话一行分组、送达转绿恰 2000ms 退场。
import {
  classifyUndeliveredItem,
  deriveDeliveredFlashes,
  groupUndelivered,
  type UndeliveredJoin,
} from './undelivered';
import { OUTBOX_TTL_MS, type OutboxItem } from '../data/outbox';

const NOW = 1_800_000_000_000;

function item(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: 'ob-1',
    toolCallId: 'tc-1',
    decision: 'approved',
    msgId: 'm-1',
    status: 'failed',
    attempts: 1,
    lastError: '连接未就绪，无法发送请求',
    nextRetryAtMs: null,
    createdAtMs: NOW - 60_000,
    updatedAtMs: NOW - 60_000,
    ...overrides,
  };
}

const JOIN_PENDING: UndeliveredJoin = { sessionId: 's-1', settled: 'pending' };

describe('classifyUndeliveredItem（7 类家族）', () => {
  it('changed：审批已由别处落定 → changed', () => {
    expect(
      classifyUndeliveredItem(
        item(),
        { sessionId: 's-1', settled: 'changed' },
        NOW
      )
    ).toBe('changed');
  });

  it('sessionGone：审批在待批与历史中均不存在 → sessionGone', () => {
    expect(
      classifyUndeliveredItem(
        item(),
        { sessionId: null, settled: 'missing' },
        NOW
      )
    ).toBe('sessionGone');
  });

  it('unsendable：TTL 过期 → unsendable（优先于错误串分类）', () => {
    const expired = item({ createdAtMs: NOW - OUTBOX_TTL_MS - 1 });
    expect(classifyUndeliveredItem(expired, JOIN_PENDING, NOW)).toBe(
      'unsendable'
    );
  });

  it('stream：失败串含中断形态 → stream', () => {
    expect(
      classifyUndeliveredItem(
        item({ lastError: 'stream closed unexpectedly' }),
        JOIN_PENDING,
        NOW
      )
    ).toBe('stream');
    expect(
      classifyUndeliveredItem(
        item({ lastError: '发送时连接被断开' }),
        JOIN_PENDING,
        NOW
      )
    ).toBe('stream');
  });

  it('endpointUnavailable：失败串含对端形态 → endpointUnavailable', () => {
    expect(
      classifyUndeliveredItem(
        item({ lastError: 'peer not subscribed' }),
        JOIN_PENDING,
        NOW
      )
    ).toBe('endpointUnavailable');
    expect(
      classifyUndeliveredItem(
        item({ lastError: '桌面端未响应' }),
        JOIN_PENDING,
        NOW
      )
    ).toBe('endpointUnavailable');
  });

  it('network：pending 未送出 / 失败串含连接形态 → network', () => {
    expect(
      classifyUndeliveredItem(
        item({ status: 'pending', attempts: 0, lastError: null }),
        JOIN_PENDING,
        NOW
      )
    ).toBe('network');
    expect(classifyUndeliveredItem(item(), JOIN_PENDING, NOW)).toBe('network');
  });

  it('unknown：失败串无任何形态命中 → unknown（诚实兜底）', () => {
    expect(
      classifyUndeliveredItem(
        item({ lastError: 'weird failure xyz' }),
        JOIN_PENDING,
        NOW
      )
    ).toBe('unknown');
  });
});

describe('groupUndelivered（每会话一行）', () => {
  const joinBySession =
    (map: Record<string, UndeliveredJoin>) =>
    (i: OutboxItem): UndeliveredJoin =>
      map[i.toolCallId] ?? { sessionId: null, settled: 'missing' };

  it('同会话多条聚合为一行：家族取最严重者，计数 = 条数', () => {
    const items = [
      item({ id: 'ob-1', toolCallId: 'tc-1' }), // network
      item({
        id: 'ob-2',
        toolCallId: 'tc-2',
        lastError: 'stream closed',
      }), // stream（优先级高于 network）
    ];
    const groups = groupUndelivered(
      items,
      joinBySession({
        'tc-1': JOIN_PENDING,
        'tc-2': JOIN_PENDING,
      }),
      NOW
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sessionId).toBe('s-1');
    expect(groups[0]!.items).toHaveLength(2);
    expect(groups[0]!.family).toBe('stream');
    expect(groups[0]!.action).toBe('resend');
    expect(groups[0]!.representative.id).toBe('ob-2');
  });

  it('不同会话分行；sent 条目不入未送达组', () => {
    const items = [
      item({ id: 'ob-1', toolCallId: 'tc-1' }),
      item({ id: 'ob-2', toolCallId: 'tc-2' }),
      item({ id: 'ob-3', toolCallId: 'tc-3', status: 'sent' }),
    ];
    const groups = groupUndelivered(
      items,
      joinBySession({
        'tc-1': { sessionId: 's-1', settled: 'pending' },
        'tc-2': { sessionId: 's-2', settled: 'pending' },
        'tc-3': { sessionId: 's-1', settled: 'pending' },
      }),
      NOW
    );
    expect(groups.map((g) => g.sessionId)).toEqual(['s-1', 's-2']);
  });

  it('重发无用家族 → edit 动作；其余 → resend', () => {
    const cases: Array<[UndeliveredJoin, Partial<OutboxItem>, string]> = [
      [{ sessionId: 's-1', settled: 'changed' }, {}, 'edit'],
      [{ sessionId: null, settled: 'missing' }, {}, 'edit'],
      [JOIN_PENDING, { createdAtMs: NOW - OUTBOX_TTL_MS - 1 }, 'edit'],
      [JOIN_PENDING, { lastError: 'mystery' }, 'resend'],
    ];
    for (const [join, overrides, action] of cases) {
      const groups = groupUndelivered([item(overrides)], () => join, NOW);
      expect(groups[0]!.action).toBe(action);
    }
  });
});

describe('deriveDeliveredFlashes（送达转绿恰 2000ms）', () => {
  const join = (): UndeliveredJoin => JOIN_PENDING;

  it('sent 后 1999ms 仍在场，2000ms 整退场', () => {
    const sent = item({ status: 'sent', updatedAtMs: NOW });
    expect(deriveDeliveredFlashes([sent], join, NOW + 1_999)).toHaveLength(1);
    expect(deriveDeliveredFlashes([sent], join, NOW + 2_000)).toHaveLength(0);
  });

  it('flash 携带 sessionId 与退场时刻 = sentAt + 2000', () => {
    const sent = item({ status: 'sent', updatedAtMs: NOW });
    const flashes = deriveDeliveredFlashes([sent], join, NOW + 10);
    expect(flashes[0]).toEqual({
      sessionId: 's-1',
      sentAtMs: NOW,
      expiresAtMs: NOW + 2_000,
    });
  });

  it('同会话多条 sent 取最近一条；非 sent 不产生 flash', () => {
    const items = [
      item({ id: 'ob-1', status: 'sent', updatedAtMs: NOW - 5_000 }),
      item({ id: 'ob-2', status: 'sent', updatedAtMs: NOW - 100 }),
      item({ id: 'ob-3', status: 'failed', updatedAtMs: NOW - 100 }),
    ];
    const flashes = deriveDeliveredFlashes(items, join, NOW);
    expect(flashes).toHaveLength(1);
    expect(flashes[0]!.sentAtMs).toBe(NOW - 100);
  });
});
