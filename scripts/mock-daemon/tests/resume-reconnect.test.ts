// =======================================================================
// mock daemon v0（R0-06）——断线重连续传测试（resume / 游标追平）
// =======================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, TestClient, waitOpen, eventOf } from './helpers.js';
import type { TestServer } from './helpers.js';
import { turnStart, runTerminal, agentStart } from '../src/fixtures/events.js';

async function connectAndHello(t: TestServer, deviceId: string): Promise<TestClient> {
  const c = new TestClient(t.url, deviceId);
  await waitOpen(c);
  c.send('auth.hello', { protocolVersions: [1], capabilities: [], appVersion: '0.1.0', platform: 'other' });
  await c.waitFor('auth.hello.ok');
  return c;
}

describe('断线续传（同 deviceId 重连 → resume 追平）', () => {
  let t: TestServer;

  beforeAll(async () => {
    t = await startTestServer();
  });

  afterAll(async () => {
    await t.server.close();
  });

  it('断线期间事件不丢：重连 + subscribe(lastSequences) + resume 补齐', async () => {
    // 第一段连接：订阅 + 接收 3 条事件后断开
    const c1 = await connectAndHello(t, 'dev-reconnect-1');
    c1.send('events.subscribe', { sessions: ['s-reconnect'], lastSequences: { 's-reconnect': 0 } });
    await c1.waitFor('events.subscribe.ok');
    await t.server.emitEvent('s-reconnect', agentStart('s-reconnect', 'r-1'), false);
    await t.server.emitEvent('s-reconnect', turnStart('s-reconnect', 'r-1', 0), false);
    await c1.waitFor((f) => f.kind === 'events.push');
    await c1.waitFor((f) => f.kind === 'events.push');
    c1.close();
    // 等服务器感知断开
    await new Promise((r) => setTimeout(r, 100));

    // 断线期间产生新事件（模拟离线窗口）
    await t.server.emitEvent('s-reconnect', runTerminal('s-reconnect', 'r-1', 'completed'), false);
    expect(t.server.state.store('s-reconnect').maxSequence()).toBe(3);

    // 第二段连接：同 deviceId 重连，携带本地游标 → 续传
    const c2 = await connectAndHello(t, 'dev-reconnect-1');
    c2.send('events.subscribe', {
      sessions: ['s-reconnect'],
      lastSequences: { 's-reconnect': 2 },
    });
    const ok = await c2.waitFor('events.subscribe.ok');
    const sessions = ok.body['sessions'] as { sessionId: string; nextSequence: number; stale: boolean }[];
    expect(sessions).toEqual([{ sessionId: 's-reconnect', nextSequence: 3, stale: false }]);

    // 游标追平：resume 从 2 开区间拉取
    c2.send('events.resume', { sessionId: 's-reconnect', afterSequence: 2, maxEvents: 10 });
    const page = await c2.waitFor('events.resume.page');
    expect(page.body['sessionId']).toBe('s-reconnect');
    const events = page.body['events'] as { type: string; sequence: number }[];
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('run-terminal');
    expect(events[0]!.sequence).toBe(3);
    expect(page.body['nextAfterSequence']).toBe(3);
    expect(page.body['hasMore']).toBe(false);
    // 末页收口信号
    const done = await c2.waitFor('events.resume.done');
    expect(done.body['resumedTo']).toBe(3);
    c2.close();
  });

  it('events.resume 分页：hasMore=true 时续拉至 done', async () => {
    const c = await connectAndHello(t, 'dev-reconnect-2');
    c.send('events.subscribe', { sessions: ['s-reconnect'], lastSequences: {} });
    await c.waitFor('events.subscribe.ok');
    // 从 0 分页（maxEvents=2）→ 2 条 + hasMore → 再拉 → done
    c.send('events.resume', { sessionId: 's-reconnect', afterSequence: 0, maxEvents: 2 });
    const p1 = await c.waitFor('events.resume.page');
    expect((p1.body['events'] as unknown[]).length).toBe(2);
    expect(p1.body['hasMore']).toBe(true);
    c.send('events.resume', { sessionId: 's-reconnect', afterSequence: p1.body['nextAfterSequence'] as number, maxEvents: 2 });
    const p2 = await c.waitFor('events.resume.page');
    expect((p2.body['events'] as unknown[]).length).toBe(1);
    expect(p2.body['hasMore']).toBe(false);
    await c.waitFor('events.resume.done');
    c.close();
  });

  it('预览帧不推进游标、不进续传（preview=true 语义）', async () => {
    const c = await connectAndHello(t, 'dev-reconnect-3');
    c.send('events.subscribe', { sessions: ['s-preview'], lastSequences: {} });
    await c.waitFor('events.subscribe.ok');
    await t.server.emitEvent('s-preview', turnStart('s-preview', 'r-p', 0), true); // 预览帧
    const push = await c.waitFor((f) => f.kind === 'events.push');
    expect(push.body['preview']).toBe(true);
    expect(eventOf(push)['sequence']).toBeUndefined();
    expect(t.server.state.store('s-preview').maxSequence()).toBe(0);
    // 续传不含预览帧
    c.send('events.resume', { sessionId: 's-preview', afterSequence: 0 });
    const page = await c.waitFor('events.resume.page');
    expect(page.body['events']).toEqual([]);
    c.close();
  });
});
