// ReconnectingWsClient 纯逻辑单测（R2-02）：退避序列 / 心跳假死判定 / 相位投影映射表全量
// + R2-02 部分 2：connect/disconnect 原生 WS 接线（mock WebSocket 事件序列驱动状态机）
import {
  HEARTBEAT_DEAD_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_FACTOR,
  RECONCILE_REBUILD_THRESHOLD,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_CAP_MS,
  RETRY_BACKOFF_MULTIPLIER,
  RETRY_JITTER_MAX_MS,
  ReconnectingWsClient,
  classifyReconcile,
  isHeartbeatDead,
  nextRetryDelayMs,
  projectReconnect,
  shouldSendHeartbeat,
} from '../ReconnectingWsClient';
import type {
  ReconcileSnapshot,
  ReconnectingWsClientOptions,
  ReconnectProjection,
  WsSocket,
} from '../ReconnectingWsClient';
import {
  DEFAULT_INVOKE_TIMEOUT_MS,
  WsGateway,
  encodeFrame,
} from '../WsGateway';
import type { WsPhase } from '@/domain/pure/selectors';
import type { JsonValue } from '../../../../../packages/shared-types/src/primitive-types';

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

// ── R2-02 部分 2：connect/disconnect 原生 WS 接线（M5 §4.3.1 状态机）────────

/**
 * mock WebSocket（RN jest 环境无原生 WS）：模拟 open/message/close/error 事件序列。
 * close() 同步触发 onclose（对齐 RN 真实行为：close 后必发 close 事件）。
 */
class MockWebSocket implements WsSocket {
  static instances: MockWebSocket[] = [];
  readonly url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  readonly closeSpy = jest.fn(() => {
    this.onclose?.();
  });
  readonly sendSpy = jest.fn((data: string) => {
    this.sent.push(data);
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sendSpy(data);
  }

  close(): void {
    this.closeSpy();
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emitMessage(raw: unknown): void {
    this.onmessage?.({ data: raw });
  }

  emitClose(): void {
    this.onclose?.();
  }

  emitError(): void {
    this.onerror?.();
  }
}

/** 服务端入站帧编码（桌面 → 移动端形态；供 emitMessage 模拟对端消息） */
function serverFrame(kind: string, body: JsonValue): string {
  return encodeFrame({
    v: 1,
    kind,
    msgId: `srv-${Math.random().toString(36).slice(2, 8)}`,
    ts: 1,
    from: 'desktop',
    to: 'mobile',
    body,
  });
}

interface Harness {
  client: ReconnectingWsClient;
  factory: jest.Mock;
  ws: MockWebSocket;
  gateway: WsGateway;
  phaseCalls: WsPhase[];
  projectionCalls: ReconnectProjection[];
}

/**
 * 装配客户端 + mock 工厂（jitter 锁定 0 便于断言退避序列）。
 * 默认自动 connect（ws = 首个 socket 已就绪）；传 autoConnect:false 拿到未连接态。
 */
function makeHarness(
  opts: Partial<ReconnectingWsClientOptions> = {},
  cfg: { autoConnect?: boolean } = {}
): Harness {
  MockWebSocket.instances = [];
  const factory = jest.fn((url: string) => new MockWebSocket(url));
  const phaseCalls: WsPhase[] = [];
  const projectionCalls: ReconnectProjection[] = [];
  const gateway = new WsGateway();
  const client = new ReconnectingWsClient({
    url: 'wss://host:8765',
    factory,
    gateway,
    jitterMaxMs: 0,
    onPhaseChange: (p) => phaseCalls.push(p),
    onProjection: (p) => projectionCalls.push(p),
    ...opts,
  });
  if (cfg.autoConnect !== false) client.connect();
  return {
    client,
    factory,
    ws: MockWebSocket.instances[0]!,
    gateway,
    phaseCalls,
    projectionCalls,
  };
}

describe('ReconnectingWsClient connect 生命周期（M5 §4.3.1）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('connect → connecting → open；相位回调序列 + 投影调用（open 相位对账）', () => {
    const { client, factory, ws, phaseCalls, projectionCalls } = makeHarness();
    expect(client.url).toBe('wss://host:8765'); // url 透出（端点诊断/日志）
    client.connect();
    expect(client.phase).toBe('connecting');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('wss://host:8765');
    expect(client.gateway).toBeInstanceOf(WsGateway);
    ws.emitOpen();
    expect(client.phase).toBe('open');
    expect(phaseCalls).toEqual(['connecting', 'open']);
    expect(projectionCalls).toHaveLength(1);
    expect(projectionCalls[0]?.phase).toBe('open');
    expect(client.retryCount).toBe(0);
    expect(client.lastProjection?.actions).toEqual([]);
  });

  test('open 相位投影：注入对账源 → 动作分类正确（R2-05 接线点）', () => {
    const snap: ReconcileSnapshot = {
      sessionId: 's-1',
      localCursor: 0,
      serverNext: 5,
      serverStale: false,
    };
    const { client, ws, projectionCalls } = makeHarness({
      projections: () => ({ snapshots: [snap], outboxPending: true }),
    });
    client.connect();
    ws.emitOpen();
    expect(projectionCalls[0]?.actions).toEqual(['resume']);
    expect(projectionCalls[0]?.outboxFlush).toBe(true);
    expect(client.lastProjection?.resume).toEqual(['s-1']);
  });

  test('双连接防护：connect 两次只建一个 socket（R2B §4）', () => {
    const { client, factory } = makeHarness();
    client.connect();
    client.connect();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('onmessage → decodeFrame → 分发到订阅者；heartbeat.ok 更新回执', () => {
    const { client, ws, gateway } = makeHarness();
    client.connect();
    ws.emitOpen();
    const pushHandler = jest.fn();
    gateway.on('events.push', pushHandler);
    ws.emitMessage(
      serverFrame('events.push', {
        sessionId: 's-1',
        event: { type: 'agent-start', sessionId: 's-1', timestamp: 1 },
      })
    );
    expect(pushHandler).toHaveBeenCalledTimes(1);
    expect(pushHandler.mock.calls[0]?.[0]?.kind).toBe('events.push');
    ws.emitMessage(
      serverFrame('heartbeat.ok', {
        ts: 1754651200000,
        serverTime: 1754651200300,
      })
    );
    expect(client.lastHeartbeatOk).toEqual({
      ts: 1754651200000,
      serverTime: 1754651200300,
    });
    expect(client.phase).toBe('open');
  });

  test('解码失败帧 → 宽容丢弃（不打断连接，D3 §10.3）', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, ws } = makeHarness();
    client.connect();
    ws.emitOpen();
    ws.emitMessage('not-json{');
    ws.emitMessage('"scalar"');
    expect(client.phase).toBe('open');
    expect(ws.closeSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('非文本帧（二进制等）→ 宽容丢弃不处理', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, ws, gateway } = makeHarness();
    client.connect();
    ws.emitOpen();
    const spy = jest.fn();
    gateway.on('*', spy);
    ws.emitMessage({ binary: true }); // 非 string data：协议 v1 全文本，丢弃
    expect(spy).not.toHaveBeenCalled();
    expect(client.phase).toBe('open');
    warnSpy.mockRestore();
  });

  test('路由骨架：subscribe.ok / resume.page / resume.done 接分发（R2-05 域实现）', () => {
    const { client, ws, gateway } = makeHarness();
    client.connect();
    ws.emitOpen();
    const spy = jest.fn();
    gateway.on('events.subscribe.ok', spy);
    ws.emitMessage(
      serverFrame('events.subscribe.ok', {
        sessions: [{ sessionId: 's-1', nextSequence: 10, stale: false }],
      })
    );
    expect(spy).toHaveBeenCalledTimes(1);
    ws.emitMessage(
      serverFrame('events.resume.page', {
        sessionId: 's-1',
        events: [],
        nextAfterSequence: 10,
        hasMore: false,
      })
    );
    ws.emitMessage(
      serverFrame('events.resume.done', { sessionId: 's-1', resumedTo: 10 })
    );
    expect(client.phase).toBe('open'); // 骨架不破坏连接
  });
});

describe('ReconnectingWsClient 心跳（D3 §9.3：30s 发包 / 90s 假死）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('open 后每 30s 发 heartbeat；90s 无收包 → 假死 close → 重连', () => {
    const { client, ws, phaseCalls } = makeHarness();
    client.connect();
    ws.emitOpen();
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(ws.sent).toHaveLength(1);
    const hb = JSON.parse(ws.sent[0] ?? '') as {
      kind: string;
      body: { ts: number; deviceTimeMs: number };
    };
    expect(hb.kind).toBe('heartbeat');
    expect(typeof hb.body.ts).toBe('number');
    expect(typeof hb.body.deviceTimeMs).toBe('number');
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2); // 到 90s：无收包 → 假死
    expect(ws.closeSpy).toHaveBeenCalledTimes(1);
    expect(client.phase).toBe('reconnecting');
    expect(phaseCalls).toContain('reconnecting');
  });

  test('heartbeat.ok 重置假死计时：回执期内不判死，90s 无回执才判死', () => {
    const { client, ws } = makeHarness();
    client.connect();
    ws.emitOpen();
    // t=30s 发心跳 → 对端回 heartbeat.ok（重置假死计时）
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    ws.emitMessage(serverFrame('heartbeat.ok', { ts: 1, serverTime: 2 }));
    // t=60s 再发 → 再回执
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    ws.emitMessage(serverFrame('heartbeat.ok', { ts: 1, serverTime: 2 }));
    // t=90s：距上次收包仅 30s → 存活
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(ws.closeSpy).not.toHaveBeenCalled();
    // t=120s：距上次收包 60s → 仍存活
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(ws.closeSpy).not.toHaveBeenCalled();
    // t=150s：距上次收包 90s → 假死
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(ws.closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ReconnectingWsClient 重连退避（D4 §6.2.4 / M5 §4.3.2）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('退避序列 1s→2s→4s→8s→16s；连续 6 次失败 → dead 终态不再重连', () => {
    const { client, factory, ws } = makeHarness({ maxRetries: 5 });
    client.connect();
    ws.emitOpen();
    const delays = [1000, 2000, 4000, 8000, 16000];
    for (let i = 0; i < delays.length; i++) {
      MockWebSocket.instances[i]!.emitClose();
      expect(client.phase).toBe('reconnecting');
      expect(client.retryCount).toBe(i + 1);
      jest.advanceTimersByTime(delays[i]! - 1);
      expect(factory).toHaveBeenCalledTimes(i + 1); // 退避未到不重试
      jest.advanceTimersByTime(1);
      expect(factory).toHaveBeenCalledTimes(i + 2); // 退避到期 → 新连接
      expect(client.phase).toBe('connecting');
    }
    // 第 6 次失败（超 maxRetries=5）→ dead（任务书「closed」终态）
    MockWebSocket.instances[5]!.emitClose();
    expect(client.phase).toBe('dead');
    jest.advanceTimersByTime(120_000);
    expect(factory).toHaveBeenCalledTimes(delays.length + 1);
  });

  test('重连成功：投影再次调用（open 相位）+ retryCount 归零', () => {
    const { client, ws, projectionCalls } = makeHarness();
    client.connect();
    ws.emitOpen();
    expect(projectionCalls).toHaveLength(1);
    ws.emitClose();
    jest.advanceTimersByTime(1000);
    expect(client.phase).toBe('connecting');
    MockWebSocket.instances[1]!.emitOpen();
    expect(client.phase).toBe('open');
    expect(client.retryCount).toBe(0);
    expect(projectionCalls).toHaveLength(2);
    expect(projectionCalls[1]?.phase).toBe('open');
  });

  test('reconnecting 中 connect() → 取消退避立即重试（防双连接）', () => {
    const { client, factory, ws } = makeHarness();
    client.connect();
    ws.emitOpen();
    ws.emitClose();
    expect(client.phase).toBe('reconnecting');
    client.connect();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(client.phase).toBe('connecting');
    jest.advanceTimersByTime(60_000); // 原退避计时已取消
    expect(factory).toHaveBeenCalledTimes(2);
  });

  test('offline 注入（NetInfo 断网，R2-03 接线点）→ 直接 dead 不重试', () => {
    const { client, factory, ws } = makeHarness({ offline: () => true });
    client.connect();
    ws.emitOpen();
    ws.emitClose();
    expect(client.phase).toBe('dead');
    jest.advanceTimersByTime(120_000);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('onerror 不触发重连（以 onclose 为判死事件，M5 R-02）', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, factory, ws } = makeHarness();
    client.connect();
    ws.emitOpen();
    ws.emitError();
    expect(client.phase).toBe('open');
    jest.advanceTimersByTime(60_000);
    expect(factory).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  test('意外断开 → 挂起请求 reject transport.closed（outbox 重发入口）', async () => {
    const { client, ws, gateway } = makeHarness();
    client.connect();
    ws.emitOpen();
    const p = gateway.invoke('remote.approve', { toolCallId: 'tc-1' });
    expect(gateway.pendingCount()).toBe(1);
    ws.emitClose();
    await expect(p).rejects.toMatchObject({
      code: 'transport.closed',
      retryable: true,
    });
    expect(gateway.pendingCount()).toBe(0);
  });
});

describe('ReconnectingWsClient disconnect 清理（M5 §4.3.2）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('disconnect：清 pending/心跳/重连计时器 + 相位 idle + 不自动重连', async () => {
    const { client, factory, ws, gateway } = makeHarness();
    client.connect();
    ws.emitOpen();
    const p = gateway.invoke('remote.getStatus', {});
    expect(gateway.pendingCount()).toBe(1);
    expect(ws.sent).toHaveLength(1); // 请求帧
    client.disconnect();
    expect(ws.closeSpy).toHaveBeenCalledTimes(1);
    expect(client.phase).toBe('idle');
    await expect(p).rejects.toMatchObject({ code: 'cmd.cancelled' });
    expect(gateway.pendingCount()).toBe(0);
    // 心跳/重连计时器已清：时间推进无发包、无重连
    jest.advanceTimersByTime(300_000);
    expect(ws.sent).toHaveLength(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('disconnect 后 connect 可重新连接（idle → connecting → open）', () => {
    const { client, factory, ws } = makeHarness();
    client.connect();
    ws.emitOpen();
    client.disconnect();
    client.connect();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(client.phase).toBe('connecting');
    MockWebSocket.instances[1]!.emitOpen();
    expect(client.phase).toBe('open');
  });

  test('idle 态 disconnect 幂等（无副作用）', () => {
    const { client, factory } = makeHarness({}, { autoConnect: false });
    client.disconnect();
    expect(client.phase).toBe('idle');
    expect(factory).not.toHaveBeenCalled();
  });

  test('invoke 超时（默认 10s）→ cmd.timeout reject + pending 清理', async () => {
    const { client, ws, gateway } = makeHarness();
    client.connect();
    ws.emitOpen();
    const p = gateway.invoke('remote.getStatus', {});
    jest.advanceTimersByTime(DEFAULT_INVOKE_TIMEOUT_MS);
    await expect(p).rejects.toMatchObject({
      code: 'cmd.timeout',
      retryable: true,
    });
    expect(gateway.pendingCount()).toBe(0);
  });

  test('token 构造注入（R2-03 接线占位）透出读取', () => {
    const { client } = makeHarness({ token: 'tok-1' });
    expect(client.token).toBe('tok-1');
  });
});
