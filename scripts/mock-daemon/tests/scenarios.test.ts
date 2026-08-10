// =======================================================================
// mock daemon v0（R0-06）——run / cache 场景时间线测试（夹具漂移防线）
//
// 目标：场景时间线发射的每一帧都经生成解析器自检（出站自检），
// 且序列完整（run 生命周期收口 / 缓存指标三事件齐备）。
// =======================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, TestClient, waitOpen, eventOf } from './helpers.js';
import type { TestServer } from './helpers.js';

async function connectAndSubscribe(t: TestServer, deviceId: string, sessionId: string): Promise<TestClient> {
  const c = new TestClient(t.url, deviceId);
  await waitOpen(c);
  c.send('auth.hello', { protocolVersions: [1], capabilities: [], appVersion: '0.1.0', platform: 'other' });
  await c.waitFor('auth.hello.ok');
  c.send('events.subscribe', { sessions: [sessionId], lastSequences: {} });
  await c.waitFor('events.subscribe.ok');
  return c;
}

/** 连续消费 events.push 直至命中收口类型，返回全部事件类型序列 */
async function collectUntil(c: TestClient, stopType: string): Promise<string[]> {
  const types: string[] = [];
  for (;;) {
    const push = await c.waitFor((f) => f.kind === 'events.push');
    const type = String(eventOf(push)['type']);
    types.push(type);
    if (type === stopType) break;
  }
  return types;
}

describe('run 生命周期场景', () => {
  let t: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    t = await startTestServer({ scenario: 'run', scenarioSpeed: 0 });
    client = await connectAndSubscribe(t, 'dev-run-1', 's-mock-run');
  });

  afterAll(async () => {
    client.close();
    await t.server.close();
  });

  it('时间线完整：agent-start → 消息流 → 工具调用 → run-terminal 收口', async () => {
    const types = await collectUntil(client, 'run-terminal');
    expect(types[0]).toBe('agent-start');
    expect(types).toContain('turn-start');
    expect(types).toContain('message-delta');
    expect(types).toContain('message-end');
    expect(types).toContain('tool-start');
    expect(types).toContain('tool-end');
    expect(types).toContain('agent-end');
    expect(types[types.length - 1]).toBe('run-terminal');
    // 事件全部入库：续传可拉
    expect(t.server.state.store('s-mock-run').maxSequence()).toBeGreaterThanOrEqual(types.length);
  });
});

describe('缓存指标场景', () => {
  let t: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    t = await startTestServer({ scenario: 'cache', scenarioSpeed: 0 });
    client = await connectAndSubscribe(t, 'dev-cache-1', 's-mock-cache');
  });

  afterAll(async () => {
    client.close();
    await t.server.close();
  });

  it('三事件齐备：cold-cache-warning → cache-waste-alert → cache-stats-updated', async () => {
    const types = await collectUntil(client, 'cache-stats-updated');
    expect(types).toContain('cold-cache-warning');
    expect(types).toContain('cache-waste-alert');
    expect(types).toContain('cache-stats-updated');
    expect(types).toContain('run-terminal');
    // cache-stats-updated 在 run 收口后发射（收口轨语义：收口后一次）
    const terminalIdx = types.indexOf('run-terminal');
    const statsIdx = types.indexOf('cache-stats-updated');
    expect(statsIdx).toBeGreaterThan(terminalIdx);
  });
});
