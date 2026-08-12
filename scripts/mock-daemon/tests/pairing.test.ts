// =======================================================================
// mock daemon v0（R0-06）——配对流程测试（pair.hello → verify → ok）
// =======================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, TestClient, waitOpen, errorOf } from './helpers.js';
import type { TestServer } from './helpers.js';
import { MOCK_PAIR_TOKEN } from '../src/envelope.js';

describe('配对流程（pairMode=开）', () => {
  let t: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    t = await startTestServer({
      pairMode: true,
      pairCode: 'CXN-7K4P-Q2MB-9XRT',
    });
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

    client.send('pair.verify', {
      challengeSig: 'sig-1',
      devicePubSig: 'sig-2',
    });
    const ok = await client.waitFor('pair.ok');
    expect(ok.body['desktopId']).toBe('desktop-mock-0001');
    expect(ok.body['ttl']).toBe(86400);
    // pair.ok 含 token 明文扩展（与 Rust pair_ok_body {desktopId, ttl, token}
    // 对齐，pair_endpoint.rs:177-186；对拍裁决 2026-08-11）
    expect(ok.body['token']).toBe(MOCK_PAIR_TOKEN);
    expect(ok.body['token']).toMatch(/^[0-9a-f]{64}$/);
    const ready = await client.waitFor('device.ready');
    expect(ready.body['deviceId']).toBe('dev-test-0001');
  });

  it('wire 形态配对码（12 位无前缀）→ 配对成功（normalize 容错，对拍裁决 2026-08-11）', async () => {
    // 移动端 wire 形态 code 无前缀无分隔符（device-protocol.json:856 注册表
    // 口径；Rust PairCode 反序列化自动 normalize 容错，pair.rs:105-109）
    client.send('pair.hello', {
      code: '7K4PQ2MB9XRT',
      deviceId: 'dev-test-0003',
      mobilePub: 'p',
      mobileLongPub: 'q',
      deviceName: '测试手机 3',
    });
    const challenge = await client.waitFor('pair.challenge');
    expect(challenge.body['desktopId']).toBe('desktop-mock-0001');
    client.send('pair.verify', {
      challengeSig: 'sig-1',
      devicePubSig: 'sig-2',
    });
    const ok = await client.waitFor('pair.ok');
    expect(ok.body['desktopId']).toBe('desktop-mock-0001');
    expect(ok.body['token']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('全容错形态配对码（小写 + 前缀 + 分隔符 + 空白）→ 配对成功（normalize 容错，对拍裁决 2026-08-11）', async () => {
    client.send('pair.hello', {
      code: ' cxn-7k4p-q2mb-9xrt ',
      deviceId: 'dev-test-0005',
      mobilePub: 'p',
      mobileLongPub: 'q',
      deviceName: '测试手机 5',
    });
    const challenge = await client.waitFor('pair.challenge');
    expect(challenge.body['desktopId']).toBe('desktop-mock-0001');
    client.send('pair.verify', {
      challengeSig: 'sig-1',
      devicePubSig: 'sig-2',
    });
    const ok = await client.waitFor('pair.ok');
    expect(ok.body['desktopId']).toBe('desktop-mock-0001');
    expect(ok.body['token']).toBe(MOCK_PAIR_TOKEN);
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

  it('非法格式配对码（混淆字符 O）→ pair.invalid_code 错误帧', async () => {
    // 标准化后含字符集外字符 → 格式非法（pair.rs:68-72 InvalidChar 语义；
    // 对拍裁决 2026-08-11：非法格式必须拒绝）
    client.send('pair.hello', {
      code: 'CXN-7K4P-Q2MB-9XRO',
      deviceId: 'dev-test-0004',
      mobilePub: 'p',
      mobileLongPub: 'q',
      deviceName: '测试手机 4',
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
