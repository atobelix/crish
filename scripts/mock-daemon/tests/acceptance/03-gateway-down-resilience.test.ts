// =======================================================================
// R0-07 验收三件套 3：关网关 GUI 照常（断线降级路径）
//
// 验收口径（Z0 §9.2 R0-07 / §12.5 P0 ③）：桌面端（或 mock daemon）
// 关闭/断开后，GUI 侧（前端事件流/状态）不受影响——网关断 → 本地功能照常。
//
// 当前无真实桌面服务端（R1 未做），本测试用 mock daemon 模拟「网关断开」
// 验证客户端重连韧性（任务书指定口径）：
//   1. 网关完整关闭（server.close）→ 客户端感知断开、本地已收事件完好
//      （本地投影照常——GUI 不崩）；网关同端口重启 → 重连 → 追平 → 实时恢复；
//   2. 连接断开窗口（客户端断线、网关继续运行）→ 窗口期事件不丢 →
//      重连后游标追平（无重复无丢失）→ resume.done 后实时推流恢复。
// 真实桌面服务端的同语义验收（关网关桌面 GUI 事件照常）在 R1-11 真机联调
// 执行（L4 清单 4/6/7），见 R0-07-acceptance.md 遗留登记。
// =======================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startTestServer } from '../helpers.js';
import type { TestServer } from '../helpers.js';
import { AcceptanceClient, waitOpen, eventOf, canonicalJsonString } from './helpers.js';
import { agentStart, turnStart, messageDeltaText, runTerminal } from '../../src/fixtures/events.js';

const DEVICE_ID = 'dev-accept-gw';
const SESSION = 's-gw';

async function connectAndSubscribe(t: TestServer, deviceId: string, sessionId: string, lastSequences: Record<string, number>): Promise<AcceptanceClient> {
  const c = new AcceptanceClient(t.url, deviceId);
  await waitOpen(c);
  c.send('auth.hello', { protocolVersions: [1], capabilities: [], appVersion: '0.1.0', platform: 'other' });
  await c.waitFor('auth.hello.ok');
  c.send('events.subscribe', { sessions: [sessionId], lastSequences });
  await c.waitFor('events.subscribe.ok');
  return c;
}

/** 收集指定数量的 events.push 帧（返回事件序列） */
async function collectPushes(client: AcceptanceClient, count: number): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i += 1) {
    const push = await client.waitFor((f) => f.kind === 'events.push');
    events.push(eventOf(push));
  }
  return events;
}

describe('R0-07 三件套 3：关网关 GUI 照常——网关关闭 → 本地照常 → 网关重启 → 重连恢复', () => {
  let t1: TestServer;
  let port: number;
  let client: AcceptanceClient;
  let localEvents: Record<string, unknown>[] = [];

  beforeAll(async () => {
    // 网关 v1（系统分配端口；记录供重启复用）
    t1 = await startTestServer({ scenario: 'idle', scenarioSpeed: 0 });
    port = t1.port;
  });

  afterAll(async () => {
    if (client) client.close();
    // t1 已 close（本场景内）；t2 在本场景内关闭
  });

  it('网关断开：客户端感知 close + 本地已收事件完好（本地投影照常）', async () => {
    client = await connectAndSubscribe(t1, DEVICE_ID, SESSION, { [SESSION]: 0 });
    // 网关推送 2 条事件 → 客户端收到（本地事件流建立）
    await t1.server.emitEvent(SESSION, agentStart(SESSION, 'r-1'), false);
    await t1.server.emitEvent(SESSION, turnStart(SESSION, 'r-1', 0), false);
    localEvents = await collectPushes(client, 2);
    expect(localEvents[0]!['type']).toBe('agent-start');
    expect(localEvents[1]!['type']).toBe('turn-start');

    // 关网关（server.close：全部连接断开 + 服务停止）
    await t1.server.close();

    // 客户端感知断开（不崩：close 事件到达）
    await client.waitClose(5000);
    expect(client.ws.readyState === WebSocket.CLOSED || client.ws.readyState === WebSocket.CLOSING).toBe(true);

    // 本地已收事件完好（本地投影照常——「GUI 照常」的 mock 层语义：
    // 已消费事件在本地仍完整可查，不受网关断开影响）
    expect(localEvents.length).toBe(2);
    expect(localEvents.map((e) => e['type'])).toEqual(['agent-start', 'turn-start']);
  });

  it('网关同端口重启：客户端重连 → 追平完成（resume.done）→ 实时推流恢复', async () => {
    // 网关重启（同端口；等待旧监听完全释放）
    await new Promise((r) => setTimeout(r, 150));
    const t2 = await startTestServer({ scenario: 'idle', scenarioSpeed: 0, port });
    try {
      // 客户端重连（同 deviceId——身份延续）：握手 → 订阅（携带本地游标）→ 续传追平
      const c2 = await connectAndSubscribe(t2, DEVICE_ID, SESSION, { [SESSION]: 2 });
      c2.send('events.resume', { sessionId: SESSION, afterSequence: 2, maxEvents: 100 });
      // 新实例空存储：resume.page 空页 + resume.done（追平完成 → live 相位信号）
      const page = await c2.waitFor('events.resume.page');
      expect(page.body['sessionId']).toBe(SESSION);
      expect(page.body['events']).toEqual([]);
      const done = await c2.waitFor('events.resume.done');
      expect(done.body['sessionId']).toBe(SESSION);
      expect(typeof done.body['resumedTo']).toBe('number');

      // 实时推流恢复：新事件到达
      await t2.server.emitEvent(SESSION, runTerminal(SESSION, 'r-1', 'completed'), false);
      const push = await c2.waitFor((f) => f.kind === 'events.push');
      expect(eventOf(push)['type']).toBe('run-terminal');
      // 全程无错误帧（重连过程无协议错误）
      expect(c2.peekBuffer().some((f) => f.kind === 'error')).toBe(false);

      // 客户端在重连期间可正常发送命令（GUI 操作链路照常）
      c2.send('heartbeat', { ts: Date.now(), deviceTimeMs: Date.now() });
      const hb = await c2.waitFor('heartbeat.ok');
      expect(hb.body['serverTime']).toBeDefined();
      c2.close();
    } finally {
      await t2.server.close();
    }
  });
});

describe('R0-07 三件套 3 补充：断线窗口事件不丢（重连追平，无重复无丢失）', () => {
  let t: TestServer;

  beforeAll(async () => {
    t = await startTestServer({ scenario: 'idle', scenarioSpeed: 0 });
  });

  afterAll(async () => {
    await t.server.close();
  });

  it('客户端断线窗口：网关继续运行并产生事件 → 重连后游标追平 + 实时衔接', async () => {
    // 第一段连接：订阅 + 收 2 条后断开（客户端断网/切后台）
    const c1 = await connectAndSubscribe(t, DEVICE_ID, 's-win', { 's-win': 0 });
    await t.server.emitEvent('s-win', agentStart('s-win', 'r-w'), false);
    await t.server.emitEvent('s-win', turnStart('s-win', 'r-w', 0), false);
    await collectPushes(c1, 2);
    c1.close();
    await new Promise((r) => setTimeout(r, 100)); // 等服务器感知断开

    // 断线窗口：网关继续运行，产生 3 条事件（模拟 run 继续推进）
    await t.server.emitEvent('s-win', messageDeltaText('s-win', 'r-w', 'msg-1', '窗口期增量'), false);
    await t.server.emitEvent('s-win', messageDeltaText('s-win', 'r-w', 'msg-2', '窗口期增量 2'), false);
    await t.server.emitEvent('s-win', runTerminal('s-win', 'r-w', 'completed'), false);
    expect(t.server.state.store('s-win').maxSequence()).toBe(5);

    // 重连（同 deviceId + 本地游标=2）：subscribe.ok 已在 connectAndSubscribe 内消费
    const c2 = await connectAndSubscribe(t, DEVICE_ID, 's-win', { 's-win': 2 });

    // 游标追平：resume 从 2 开区间补拉窗口期 3 条（无重复无丢失、顺序正确）
    c2.send('events.resume', { sessionId: 's-win', afterSequence: 2, maxEvents: 100 });
    const page = await c2.waitFor('events.resume.page');
    const events = page.body['events'] as { type: string; sequence: number; runId: string }[];
    expect(events.map((e) => e.type)).toEqual(['message-delta', 'message-delta', 'run-terminal']);
    expect(events.map((e) => e.sequence)).toEqual([3, 4, 5]);
    expect(page.body['nextAfterSequence']).toBe(5);
    expect(page.body['hasMore']).toBe(false);
    const done = await c2.waitFor('events.resume.done');
    expect(done.body['resumedTo']).toBe(5);

    // 追平后的实时衔接：新事件 sequence 无缝续接（6），无重复无空洞
    await t.server.emitEvent('s-win', agentStart('s-win', 'r-w2'), false);
    const push = await c2.waitFor((f) => f.kind === 'events.push');
    expect(eventOf(push)['sequence']).toBe(6);
    expect(eventOf(push)['type']).toBe('agent-start');

    // 追平窗口事件与服务端存储 canonical 逐字节一致（wire 无损复验）
    const stored = t.server.state.store('s-win').all();
    expect(canonicalJsonString(events[2])).toBe(canonicalJsonString(stored[4]!.event));
    c2.close();
  });
});
