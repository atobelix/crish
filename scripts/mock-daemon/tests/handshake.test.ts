// =======================================================================
// mock daemon v0（R0-06）——握手与心跳测试（auth.hello / heartbeat / 相位）
// =======================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, TestClient, waitOpen, errorOf } from './helpers.js';
import type { TestServer } from './helpers.js';

describe('握手（auth.hello → auth.hello.ok）', () => {
  let t: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    t = await startTestServer();
    client = new TestClient(t.url);
    await waitOpen(client);
  });

  afterAll(async () => {
    client.close();
    await t.server.close();
  });

  it('版本协商成功：返回协议版本 + manifest + serverTime', async () => {
    client.send('auth.hello', {
      protocolVersions: [1],
      capabilities: ['approval', 'fileRead'],
      appVersion: '0.1.0',
      platform: 'ios',
    });
    const helloOk = await client.waitFor('auth.hello.ok');
    expect(helloOk.body['protocolVersion']).toBe(1);
    expect(helloOk.body['minProtocolVersion']).toBe(1);
    expect(helloOk.body['desktopId']).toBe('desktop-mock-0001');
    expect(typeof helloOk.body['serverTime']).toBe('number');
    const manifest = helloOk.body['manifest'] as { contractVersion?: string; commands?: unknown[] };
    expect(manifest.contractVersion).toBe('1.0.0');
    expect(Array.isArray(manifest.commands)).toBe(true);
    expect((manifest.commands as { name: string }[]).some((c) => c.name === 'approve')).toBe(true);
  });

  it('不兼容协议版本 → version_mismatch 错误帧', async () => {
    client.send('auth.hello', {
      protocolVersions: [99],
      capabilities: [],
      appVersion: '0.1.0',
      platform: 'other',
    });
    const errFrame = await client.waitFor((f) => f.kind === 'error');
    expect(errorOf(errFrame).code).toBe('version_mismatch');
  });

  it('握手成功后心跳 → heartbeat.ok（serverTime 时钟校准）', async () => {
    client.send('heartbeat', { ts: 1754700000000, deviceTimeMs: Date.now() });
    const ok = await client.waitFor('heartbeat.ok');
    expect(ok.body['ts']).toBe(1754700000000);
    expect(typeof ok.body['serverTime']).toBe('number');
  });
});

describe('相位约束（会话期消息早于握手）', () => {
  let t: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    t = await startTestServer();
    client = new TestClient(t.url);
    await waitOpen(client);
  });

  afterAll(async () => {
    client.close();
    await t.server.close();
  });

  it('未握手先订阅 → 拒绝并回错误帧', async () => {
    client.send('events.subscribe', { sessions: ['s-1'], lastSequences: {} });
    const errFrame = await client.waitFor((f) => f.kind === 'error');
    expect(errorOf(errFrame).code).toBe('auth.unknown_device');
  });
});
