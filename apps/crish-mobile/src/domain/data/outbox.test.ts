// outbox 单测：三态队列（E2E-6 离线决策入队→重连→补发）/ 幂等键 / 失败退避 / 崩溃恢复 / 容量上限
import type { OutboxItem, OutboxState } from './outbox';
import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_ITEMS,
  createOutboxState,
  enqueueDecision,
  collectReplayable,
  setReplaying,
  markSent,
  recordFailure,
  confirmResolved,
  snapshotOutbox,
  hydrateOutbox,
  outboxBackoffMs,
  needsHumanAttention,
  isTtlExpired,
} from './outbox';

const NOW = 1_800_000_000_000;

function makeInput(
  overrides: Partial<OutboxItem> = {}
): Omit<
  OutboxItem,
  'status' | 'attempts' | 'lastError' | 'nextRetryAtMs' | 'updatedAtMs'
> {
  return {
    id: 'o-1',
    toolCallId: 'call-1',
    decision: 'approved',
    msgId: 'm-1',
    createdAtMs: NOW,
    runId: 'run-1',
    ...overrides,
  };
}

function findById(state: OutboxState, id: string): OutboxItem | undefined {
  return state.items.find((i) => i.id === id);
}

describe('enqueueDecision（F2 §8.2 本地决策队列）', () => {
  it('入队即 pending（先落本地，不管网络，M5 §4.6.1）', () => {
    const state = enqueueDecision(createOutboxState(), makeInput(), NOW);
    expect(state.outcome).toBe('ok');
    expect(state.state.items[0]!).toMatchObject({
      status: 'pending',
      attempts: 0,
      nextRetryAtMs: null,
    });
  });

  it('幂等键（toolCallId + decision）：同键重复决策覆盖为最新（D6 §6.2）', () => {
    let s = enqueueDecision(
      createOutboxState(),
      makeInput({ id: 'o-1', decision: 'denied', reason: '风险过高' }),
      NOW
    );
    expect(s.outcome).toBe('ok');
    s = enqueueDecision(
      s.state,
      makeInput({ id: 'o-1', decision: 'denied', reason: '改主意：允许' }),
      NOW + 10
    );
    expect(s.outcome).toBe('superseded');
    expect(s.state.items).toHaveLength(1);
    expect(s.state.items[0]!.reason).toBe('改主意：允许');
    expect(s.state.items[0]!.status).toBe('pending');
  });

  it('覆盖时新输入未带 reason → 清空旧 reason（reason 换新输入内容，未提供即清空）', () => {
    let s = enqueueDecision(
      createOutboxState(),
      makeInput({ id: 'o-1', decision: 'denied', reason: '风险过高' }),
      NOW
    );
    s = enqueueDecision(
      s.state,
      makeInput({ id: 'o-1', decision: 'denied' }),
      NOW + 10
    );
    expect(s.outcome).toBe('superseded');
    expect(s.state.items).toHaveLength(1);
    expect(s.state.items[0]!.reason).toBeUndefined();
    expect(s.state.items[0]!.status).toBe('pending');
  });

  it('同 toolCallId 不同 decision 是不同键：允许+拒绝可共存', () => {
    let s = enqueueDecision(
      createOutboxState(),
      makeInput({ id: 'o-1', decision: 'approved' }),
      NOW
    );
    s = enqueueDecision(
      s.state,
      makeInput({ id: 'o-2', decision: 'denied' }),
      NOW
    );
    expect(s.state.items).toHaveLength(2);
  });

  it('容量上限：满且无可剔除（全部未完成）→ 拒绝（未完成元素永不剔除，D6 §6.3）', () => {
    let s = createOutboxState();
    for (let i = 0; i < OUTBOX_MAX_ITEMS; i += 1) {
      s = enqueueDecision(
        s,
        makeInput({ id: `o-${i}`, toolCallId: `call-${i}` }),
        NOW + i
      ).state;
    }
    const full = enqueueDecision(
      s,
      makeInput({ id: 'o-x', toolCallId: 'call-x' }),
      NOW
    );
    expect(full.outcome).toBe('full');
    expect(full.state.items).toHaveLength(OUTBOX_MAX_ITEMS);
  });

  it('容量上限：满且有 sent → 剔除最早已完成（FIFO），新决策入队', () => {
    let s = createOutboxState();
    for (let i = 0; i < OUTBOX_MAX_ITEMS; i += 1) {
      s = enqueueDecision(
        s,
        makeInput({ id: `o-${i}`, toolCallId: `call-${i}` }),
        NOW + i
      ).state;
    }
    // 最早两条（o-0/o-1）置 sent
    s = markSent(s, 'o-0', NOW);
    s = markSent(s, 'o-1', NOW);
    const r = enqueueDecision(
      s,
      makeInput({ id: 'o-x', toolCallId: 'call-x' }),
      NOW + 1
    );
    expect(r.outcome).toBe('ok');
    expect(r.state.items).toHaveLength(OUTBOX_MAX_ITEMS);
    expect(findById(r.state, 'o-0')).toBeUndefined();
    expect(findById(r.state, 'o-x')).toBeDefined();
  });
});

describe('重放与补发（E2E-6 数据层：离线决策入队 → 重连 → 补发成功转 sent）', () => {
  it('collectReplayable：pending 全部按 FIFO 拾起', () => {
    let s = enqueueDecision(
      createOutboxState(),
      makeInput({ id: 'o-1', toolCallId: 'call-1', createdAtMs: NOW + 5 }),
      NOW + 5
    ).state;
    s = enqueueDecision(
      s,
      makeInput({ id: 'o-2', toolCallId: 'call-2', createdAtMs: NOW + 2 }),
      NOW + 2
    ).state;
    s = enqueueDecision(
      s,
      makeInput({ id: 'o-3', toolCallId: 'call-3', createdAtMs: NOW }),
      NOW
    ).state;
    const replayable = collectReplayable(s, NOW + 10);
    expect(replayable.map((i) => i.id)).toEqual(['o-3', 'o-2', 'o-1']);
  });

  it('sent 不参与重放（等待事件确认，D6 §6.3）', () => {
    let s = enqueueDecision(
      createOutboxState(),
      makeInput({ id: 'o-1' }),
      NOW
    ).state;
    s = markSent(s, 'o-1', NOW + 1);
    expect(collectReplayable(s, NOW + 10)).toHaveLength(0);
  });

  it('全链路（F2 §8.2 / M5 §4.6.1）：断网决策 → 重连重放 → 回执 ok → sent → resolved 事件确认出队', () => {
    // 1. 离线决策入队
    let s = enqueueDecision(
      createOutboxState(),
      makeInput({ id: 'o-1' }),
      NOW
    ).state;
    expect(s.items[0]!.status).toBe('pending');
    // 2. 重连：扫描 + 单飞重放
    s = setReplaying(s, true);
    const batch = collectReplayable(s, NOW + 60_000);
    expect(batch.map((i) => i.id)).toEqual(['o-1']);
    // 3. 逐条发送：回执 ok → sent
    s = markSent(s, batch[0]!.id, NOW + 60_001);
    expect(s.items[0]!.status).toBe('sent');
    // 4. approval-resolved 事件确认 → 出队（F2 §8.2 补发成功入历史，队列清空）
    s = confirmResolved(s, 'call-1');
    expect(s.items).toHaveLength(0);
  });

  it('confirmResolved：事件先到（冲突收敛 M5 §4.6.2）→ 同 toolCallId 条目全部清理', () => {
    let s = enqueueDecision(
      createOutboxState(),
      makeInput({ id: 'o-1' }),
      NOW
    ).state;
    s = markSent(s, 'o-1', NOW + 1);
    s = confirmResolved(s, 'call-1');
    expect(s.items).toHaveLength(0);
  });
});

describe('失败退避（D6 §6.3：1s→4s→16s→60s 封顶）', () => {
  it('退避表序列', () => {
    expect(outboxBackoffMs(1)).toBe(1_000);
    expect(outboxBackoffMs(2)).toBe(4_000);
    expect(outboxBackoffMs(3)).toBe(16_000);
    expect(outboxBackoffMs(4)).toBe(60_000);
    expect(outboxBackoffMs(10)).toBe(60_000);
  });

  it('recordFailure：pending → failed + 按退避表 nextRetryAtMs；到点拾起、未到点不拾起', () => {
    let s = enqueueDecision(
      createOutboxState(),
      makeInput({ id: 'o-1' }),
      NOW
    ).state;
    s = recordFailure(s, 'o-1', 'network.unreachable', NOW + 1);
    expect(s.items[0]!.status).toBe('failed');
    expect(s.items[0]!.attempts).toBe(1);
    expect(s.items[0]!.nextRetryAtMs).toBe(NOW + 1 + 1_000);
    expect(s.items[0]!.lastError).toBe('network.unreachable');
    // 未到点：不拾起
    expect(collectReplayable(s, NOW + 1 + 999)).toHaveLength(0);
    // 到点：拾起重发
    expect(collectReplayable(s, NOW + 1 + 1_000).map((i) => i.id)).toEqual([
      'o-1',
    ]);
  });

  it('连续 5 次失败 → needsHumanAttention（F2 §8.2 ≥5 次转人工提示，队列元素保留）', () => {
    let s = enqueueDecision(
      createOutboxState(),
      makeInput({ id: 'o-1' }),
      NOW
    ).state;
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      s = recordFailure(s, 'o-1', 'timeout', NOW + i);
    }
    expect(s.items[0]!.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(needsHumanAttention(s.items[0]!)).toBe(true);
    expect(s.items).toHaveLength(1);
  });
});

describe('崩溃恢复（任务书 R2-04：应用重启恢复扫描）', () => {
  it('构造旧队列（快照）→ hydrate 恢复 → collectReplayable 拾起全部未完成决策', () => {
    // 1. 崩溃前：1 条 pending + 1 条 failed（退避已到期）+ 1 条 sent（等确认）
    let s = enqueueDecision(
      createOutboxState(),
      makeInput({ id: 'o-1', toolCallId: 'call-1' }),
      NOW
    ).state;
    s = enqueueDecision(
      s,
      makeInput({
        id: 'o-2',
        toolCallId: 'call-2',
        decision: 'denied',
        reason: '离线拒绝',
      }),
      NOW + 1
    ).state;
    s = enqueueDecision(
      s,
      makeInput({ id: 'o-3', toolCallId: 'call-3' }),
      NOW + 2
    ).state;
    s = recordFailure(s, 'o-2', 'network', NOW + 3);
    s = markSent(s, 'o-3', NOW + 4);
    // 2. 持久化快照（应用被终止不丢，D6 §6.6 硬底线）
    const snapshot = snapshotOutbox(s);
    expect(snapshot).toHaveLength(3);
    // 3. 重启：hydrate 恢复
    const restored = hydrateOutbox(snapshot, NOW + 100_000);
    // 4. 恢复扫描：pending（o-1）+ 退避已到期的 failed（o-2）被拾起；sent（o-3）等事件确认不重发
    const replayable = collectReplayable(restored, NOW + 100_000);
    expect(replayable.map((i) => i.id).sort()).toEqual(['o-1', 'o-2']);
    expect(replayable.find((i) => i.id === 'o-2')?.reason).toBe('离线拒绝');
    expect(findById(restored, 'o-3')?.status).toBe('sent');
  });

  it('hydrate 超容量裁剪：仅剔除最早已完成的 sent（未完成永不剔除）', () => {
    const items: OutboxItem[] = [];
    for (let i = 0; i < OUTBOX_MAX_ITEMS + 5; i += 1) {
      items.push({
        ...makeInput({ id: `o-${i}`, toolCallId: `call-${i}` }),
        status: 'sent',
        attempts: 0,
        lastError: null,
        nextRetryAtMs: null,
        updatedAtMs: NOW + i,
      });
    }
    const restored = hydrateOutbox(items, NOW);
    expect(restored.items).toHaveLength(OUTBOX_MAX_ITEMS);
    // 最早的 5 条 sent 被剔除
    expect(findById(restored, 'o-0')).toBeUndefined();
    expect(findById(restored, 'o-5')).toBeDefined();
  });

  it('TTL 判定（D6 §6.4：仅展示层「可能已过期」，条目仍在队列中）', () => {
    const s = enqueueDecision(
      createOutboxState(),
      makeInput({ id: 'o-1' }),
      NOW
    ).state;
    expect(isTtlExpired(s.items[0]!, NOW + 23 * 3_600_000)).toBe(false);
    expect(isTtlExpired(s.items[0]!, NOW + 25 * 3_600_000)).toBe(true);
    expect(s.items).toHaveLength(1);
  });
});

describe('重放单飞（M5 §4.6.1：禁止并发重放同一批）', () => {
  it('setReplaying 开关语义', () => {
    const s = createOutboxState();
    expect(s.replaying).toBe(false);
    expect(setReplaying(s, true).replaying).toBe(true);
  });
});
