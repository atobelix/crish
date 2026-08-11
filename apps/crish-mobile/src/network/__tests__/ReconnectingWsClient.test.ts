// ReconnectingWsClient 纯逻辑单测（R2-02）：退避序列 / 心跳假死判定 / 相位投影映射表全量
import {
  HEARTBEAT_DEAD_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_FACTOR,
  RECONCILE_REBUILD_THRESHOLD,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_CAP_MS,
  RETRY_BACKOFF_MULTIPLIER,
  RETRY_JITTER_MAX_MS,
  classifyReconcile,
  isHeartbeatDead,
  nextRetryDelayMs,
  projectReconnect,
  shouldSendHeartbeat,
} from '../ReconnectingWsClient';
import type { ReconcileSnapshot } from '../ReconnectingWsClient';

describe('指数退避参数表（D4 §6.2.4：1s → 2s → 4s → 8s → 16s → 30s 封顶）', () => {
  test('参数表常量对齐任务书口径', () => {
    expect(RETRY_BACKOFF_BASE_MS).toBe(1000);
    expect(RETRY_BACKOFF_MULTIPLIER).toBe(2);
    expect(RETRY_BACKOFF_CAP_MS).toBe(30_000);
    expect(RETRY_JITTER_MAX_MS).toBe(1000);
  });

  test('退避序列全量（jitter=0）：0..8 → 1000/2000/4000/8000/16000/30000 封顶', () => {
    const jitterless = { jitterMaxMs: 0 };
    const expected = [
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000,
    ];
    for (let n = 0; n <= 8; n++) {
      expect(nextRetryDelayMs(n, jitterless)).toBe(expected[n]);
    }
  });

  test('负重试次数视为 0（初值）', () => {
    expect(nextRetryDelayMs(-3, { jitterMaxMs: 0 })).toBe(1000);
  });

  test('默认抖动落在 [base, base + 1s) 区间', () => {
    for (let i = 0; i < 50; i++) {
      const delay = nextRetryDelayMs(0);
      expect(delay).toBeGreaterThanOrEqual(RETRY_BACKOFF_BASE_MS);
      expect(delay).toBeLessThan(RETRY_BACKOFF_BASE_MS + RETRY_JITTER_MAX_MS);
    }
    // 封顶后仍带抖动（上限 + jitter 可能超 cap，语义为“等待≥cap”）
    const capped = nextRetryDelayMs(99);
    expect(capped).toBeGreaterThanOrEqual(RETRY_BACKOFF_CAP_MS);
    expect(capped).toBeLessThan(RETRY_BACKOFF_CAP_MS + RETRY_JITTER_MAX_MS);
  });

  test('自定义参数表（可配置初值/倍率/封顶）', () => {
    const custom = { baseMs: 500, multiplier: 3, capMs: 9000, jitterMaxMs: 0 };
    expect(nextRetryDelayMs(0, custom)).toBe(500);
    expect(nextRetryDelayMs(1, custom)).toBe(1500);
    expect(nextRetryDelayMs(3, custom)).toBe(9000); // 500×27=13500 → 封顶 9000
  });
});

describe('心跳定时（D3 §9.3：30s 心跳 / 3×间隔 90s 假死）', () => {
  test('常量对齐 version.rs 协议常量表', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(HEARTBEAT_TIMEOUT_FACTOR).toBe(3);
    expect(HEARTBEAT_DEAD_MS).toBe(90_000);
  });

  test('假死判定边界：89s 存活 / 90s 判定死', () => {
    const lastRx = 1_000_000;
    expect(isHeartbeatDead(lastRx, lastRx + 89_999)).toBe(false);
    expect(isHeartbeatDead(lastRx, lastRx + 90_000)).toBe(true);
    expect(isHeartbeatDead(lastRx, lastRx + 90_001)).toBe(true);
  });

  test('刚好收到心跳（间隔=30s）不算假死', () => {
    const lastRx = 5_000;
    expect(isHeartbeatDead(lastRx, lastRx + 30_000)).toBe(false);
  });

  test('心跳节拍判定：29.9s 不发 / 30s 应发', () => {
    const lastTx = 2_000_000;
    expect(shouldSendHeartbeat(lastTx, lastTx + 29_999)).toBe(false);
    expect(shouldSendHeartbeat(lastTx, lastTx + 30_000)).toBe(true);
  });
});

describe('classifyReconcile 对账分类（M6 §9.3 ①订阅 ②投影 ③游标）', () => {
  const snap = (p: Partial<ReconcileSnapshot>): ReconcileSnapshot => ({
    sessionId: 's-001',
    localCursor: 0,
    serverNext: 0,
    serverStale: false,
    ...p,
  });

  test('本地无投影 → fresh（② 权威有本地无 → 写入投影 + 初始化游标）', () => {
    expect(
      classifyReconcile(snap({ localCursor: undefined, serverNext: 120 }))
    ).toBe('fresh');
  });

  test('服务端无此会话（serverNext=-1）→ cleanup（② 清理本地投影 + 游标 + 队列）', () => {
    expect(classifyReconcile(snap({ localCursor: 120, serverNext: -1 }))).toBe(
      'cleanup'
    );
  });

  test('stale=true（本地游标超服务端 max）→ full-replay（① 全量回放）', () => {
    expect(
      classifyReconcile(
        snap({ localCursor: 200, serverNext: 100, serverStale: true })
      )
    ).toBe('full-replay');
  });

  test('落后超重建阈值 5000 → full-replay（③ 快照重建）', () => {
    expect(
      classifyReconcile(
        snap({ localCursor: 0, serverNext: RECONCILE_REBUILD_THRESHOLD + 1 })
      )
    ).toBe('full-replay');
  });

  test('落后恰为阈值 → resume（仅 > 阈值触发重建）', () => {
    expect(
      classifyReconcile(
        snap({ localCursor: 0, serverNext: RECONCILE_REBUILD_THRESHOLD })
      )
    ).toBe('resume');
  });

  test('落后未超阈值 → resume（① stale=false 增量补齐）', () => {
    expect(classifyReconcile(snap({ localCursor: 100, serverNext: 160 }))).toBe(
      'resume'
    );
  });

  test('游标一致 → noop', () => {
    expect(classifyReconcile(snap({ localCursor: 100, serverNext: 100 }))).toBe(
      'noop'
    );
  });
});

describe('projectReconnect 相位投影映射表全量（M6 §9.3 ①~⑤）', () => {
  const snapshots: ReconcileSnapshot[] = [
    {
      sessionId: 's-fresh',
      localCursor: undefined,
      serverNext: 10,
      serverStale: false,
    },
    {
      sessionId: 's-resume',
      localCursor: 5,
      serverNext: 12,
      serverStale: false,
    },
    {
      sessionId: 's-replay',
      localCursor: 0,
      serverNext: 6000,
      serverStale: false,
    },
    {
      sessionId: 's-stale',
      localCursor: 300,
      serverNext: 100,
      serverStale: true,
    },
    {
      sessionId: 's-clean',
      localCursor: 50,
      serverNext: -1,
      serverStale: false,
    },
    {
      sessionId: 's-noop',
      localCursor: 42,
      serverNext: 42,
      serverStale: false,
    },
  ];

  test('非 open 相位一律空投影（对账入口仅在重连成功后）', () => {
    for (const phase of [
      'idle',
      'connecting',
      'reconnecting',
      'dead',
    ] as const) {
      const p = projectReconnect(phase, snapshots, true);
      expect(p.actions).toEqual([]);
      expect(p.outboxFlush).toBe(false);
      expect(p.log).toEqual([]);
      expect(p.phase).toBe(phase);
    }
  });

  test('open 相位：动作聚合 + 会话分组映射表全量', () => {
    const p = projectReconnect('open', snapshots, false);
    expect(p.actions).toEqual([
      'fresh',
      'resume',
      'full-replay',
      'full-replay',
      'cleanup',
      'noop',
    ]);
    expect(p.fresh).toEqual(['s-fresh']);
    expect(p.resume).toEqual(['s-resume']);
    expect(p.fullReplay).toEqual(['s-replay', 's-stale']);
    expect(p.cleanup).toEqual(['s-clean']);
    expect(p.outboxFlush).toBe(false);
  });

  test('④ 队列对账：outbox 有待提交 → outboxFlush + 留痕', () => {
    const p = projectReconnect('open', [], true);
    expect(p.outboxFlush).toBe(true);
    expect(p.log.some((l) => l.includes('outbox'))).toBe(true);
  });

  test('⑤ 留痕：全部分歧写日志，不静默（noop 不写）', () => {
    const p = projectReconnect('open', snapshots, false);
    expect(p.log.length).toBeGreaterThanOrEqual(5);
    expect(p.log.join('\n')).toContain('s-clean');
    expect(p.log.join('\n')).toContain('s-resume');
    expect(p.log.join('\n')).not.toContain('s-noop');
  });

  test('空快照 + 无 outbox → 空投影（幂等收敛，M6 §9.3 对账可重复执行）', () => {
    const p = projectReconnect('open', [], false);
    expect(p.actions).toEqual([]);
    expect(p.log).toEqual([]);
    expect(p.outboxFlush).toBe(false);
  });
});
