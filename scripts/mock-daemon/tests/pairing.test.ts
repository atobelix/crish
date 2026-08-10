// =======================================================================
// mock daemon v0（R0-06）——配对流程测试（pair.hello → verify → ok）
// =======================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, TestClient, waitOpen, errorOf } from './helpers.js';
import type { TestServer } from './helpers.js';

describe('配对流程（pairMode=开）', () => {
  let t: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    t = await startTestServer({ pairMode: true, pairCode: 'CXN-7K4P-Q2MB-9XRT' });
    client = new TestClient(t.url);
    await waitOpen(client);
  });

  afterAll(async () => {
    client.close();
    await t.server.close();
  });

  it('pair.hello 正确配对码 → pair.challenge（含桌面公钥/证书指纹）→ pair.ok + device.ready', async () => {
    client.send('pair.hello', {
      code: 'CXN-7K4P-Q2MB-9XRT',
      deviceId: 'dev-test-0001',
      mobilePub: 'mock-mobile-pub',
      mobileLongPub: 'mock-mobile-long-pub',
      deviceName: '测试手机',
      platform: 'android',
    });

    const challenge = await client.waitFor('pair.challenge');
    expect(challenge.body['desktopId']).toBe('desktop-mock-0001');
    expect(typeof challenge.body['challenge']).toBe('string');
    expect(challenge.body['challenge']).not.toBe('');
    expect(typeof challenge.body['desktopPub']).toBe('string');
    expect(typeof challenge.body['tlsFingerprint']).toBe('string');
    expect(challenge.body['tlsFingerprint']).not.toBe('');

    client.send('pair.verify', { challengeSig: 'sig-1', devicePubSig: 'sig-2' });
    const ok = await client.waitFor('pair.ok');
    expect(ok.body['desktopId']).toBe('desktop-mock-0001');
    expect(ok.body['ttl']).toBe(86400);
    const ready = await client.waitFor('device.ready');
    expect(ready.body['deviceId']).toBe('dev-test-0001');
  });

  it('错误配对码 → pair.invalid_code 错误帧', async () => {
    client.send('pair.hello', {
      code: 'CXN-AAAA-BBBB-CCCC',
      deviceId: 'dev-test-0002',
      mobilePub: 'p',
      mobileLongPub: 'q',
      deviceName: '测试手机 2',
    });
    const errFrame = await client.waitFor((f) => f.kind === 'error');
    expect(errorOf(errFrame).code).toBe('pair.invalid_code');
  });

  it('缺挑战签名的 pair.verify → pair.challenge_mismatch 错误帧', async () => {
    client.send('pair.verify', { challengeSig: '', devicePubSig: 'sig' });
    const errFrame = await client.waitFor((f) => f.kind === 'error');
    expect(errorOf(errFrame).code).toBe('pair.challenge_mismatch');
  });
});

describe('配对模式开关（pairMode=关）', () => {
  let t: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    t = await startTestServer({ pairMode: false });
    client = new TestClient(t.url);
    await waitOpen(client);
  });

  afterAll(async () => {
    client.close();
    await t.server.close();
  });

  it('关闭配对模式：auth.hello 直接握手成功（跳过配对）', async () => {
    client.send('auth.hello', {
      protocolVersions: [1],
      capabilities: ['approval'],
      appVersion: '0.1.0',
      platform: 'android',
    });
    const helloOk = await client.waitFor('auth.hello.ok');
    expect(helloOk.body['protocolVersion']).toBe(1);
    expect(helloOk.body['desktopId']).toBe('desktop-mock-0001');
  });
});

describe('配对模式强制（pairMode=开，未配对握手）', () => {
  let t: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    t = await startTestServer({ pairMode: true });
    client = new TestClient(t.url);
    await waitOpen(client);
  });

  afterAll(async () => {
    client.close();
    await t.server.close();
  });

  it('未配对设备 auth.hello → auth.unknown_device 错误帧', async () => {
    client.send('auth.hello', {
      protocolVersions: [1],
      capabilities: [],
      appVersion: '0.1.0',
      platform: 'other',
    });
    const errFrame = await client.waitFor((f) => f.kind === 'error');
    expect(errorOf(errFrame).code).toBe('auth.unknown_device');
  });
});
