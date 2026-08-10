// =======================================================================
// mock daemon v0（R0-06）——订阅与事件推送测试（subscribe / push / 场景）
// =======================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, TestClient, waitOpen, eventOf } from './helpers.js';
import type { TestServer } from './helpers.js';
import { runTerminal, turnStart } from '../src/fixtures/events.js';

async function connectAndHello(t: TestServer, deviceId: string): Promise<TestClient> {
  const c = new TestClient(t.url, deviceId);
  await waitOpen(c);
  c.send('auth.hello', { protocolVersions: [1], capabilities: [], appVersion: '0.1.0', platform: 'other' });
  await c.waitFor('auth.hello.ok');
  return c;
}

describe('订阅与推送（idle 场景 + 手动发射）', () => {
  let t: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    t = await startTestServer();
    client = await connectAndHello(t, 'dev-sub-1');
  });

  afterAll(async () => {
    client.close();
    await t.server.close();
  });

  it('订阅 → subscribe.ok 携带逐会话 nextSequence/stale', async () => {
    client.send('events.subscribe', { sessions: ['s-1'], lastSequences: { 's-1': 0 } });
    const ok = await client.waitFor('events.subscribe.ok');
    const sessions = ok.body['sessions'] as { sessionId: string; nextSequence: number; stale: boolean }[];
    expect(sessions).toEqual([{ sessionId: 's-1', nextSequence: 0, stale: false }]);
  });

  it('订阅会话后收到 events.push（一帧一事件，含 sequence）', async () => {
    await t.server.emitEvent('s-1', turnStart('s-1', 'r-1', 0), false);
    const push = await client.waitFor((f) => f.kind === 'events.push');
    expect(push.body['sessionId']).toBe('s-1');
    expect(push.body['preview']).toBeUndefined();
    expect(eventOf(push)['type']).toBe('turn-start');
    expect(eventOf(push)['sequence']).toBe(1);
  });

  it('未订阅的会话不推送（隔离性）', async () => {
    const before = client.bufferSize();
    await t.server.emitEvent('s-other', runTerminal('s-other', 'r-x', 'completed'), false);
    // 无新帧到达：缓冲不增长（等待 200ms 观察）
    await new Promise((r) => setTimeout(r, 200));
    expect(client.bufferSize()).toBe(before);
  });

  it('订阅上限校验：sessions 空数组 → cmd.invalid', async () => {
    client.send('events.subscribe', { sessions: [], lastSequences: {} });
    const errFrame = await client.waitFor((f) => f.kind === 'error');
    expect(errFrame.body['code']).toBe('cmd.invalid');
  });

  it('subscribeAll 静默登记（协议无 ack；不报错即可）', async () => {
    client.send('events.subscribeAll', { events: ['security-audit', 'timer-fired', 'device.*'] });
    // 无响应帧：等待 150ms 确认无 error
    await new Promise((r) => setTimeout(r, 150));
    expect(client.peekBuffer().some((f) => f.kind === 'error')).toBe(false);
  });
});

describe('审批场景（交互式时间线）', () => {
  let t: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    t = await startTestServer({ pairMode: false, scenario: 'approval', scenarioSpeed: 0 });
    client = await connectAndHello(t, 'dev-approval-1');
    client.send('events.subscribe', { sessions: ['s-mock-approval'], lastSequences: {} });
    await client.waitFor('events.subscribe.ok');
  });

  afterAll(async () => {
    client.close();
    await t.server.close();
  });

  it('订阅场景会话 → 时间线启动 → 依次推送至 approval-requested', async () => {
    const seen: string[] = [];
    let push: Awaited<ReturnType<TestClient['waitFor']>> | undefined;
    // 连续消费直至 approval-requested
    for (;;) {
      push = await client.waitFor((f) => f.kind === 'events.push');
      const type = String(eventOf(push)['type']);
      seen.push(type);
      if (type === 'approval-requested') break;
    }
    expect(seen).toContain('agent-start');
    expect(seen).toContain('turn-start');
    expect(seen[seen.length - 1]).toBe('approval-requested');
    // 审批参数投影：request.toolCallId / summary 保留（隐私红线：parameters 不下发）
    expect(push!.body['sessionId']).toBe('s-mock-approval');
    const request = eventOf(push!)['request'] as { toolCallId: string; summary: string };
    expect(request.toolCallId).toBe('tc-mock-approve-1');
    expect(request.summary).toContain('npm test');
  });

  it('时间线事件写入会话存储（供续传/查询）', () => {
    const store = t.server.state.store('s-mock-approval');
    expect(store.maxSequence()).toBeGreaterThanOrEqual(4);
    const types = store.all().map((it) => String((it.event as Record<string, unknown>)['type']));
    expect(types).toContain('approval-requested');
  });
});
