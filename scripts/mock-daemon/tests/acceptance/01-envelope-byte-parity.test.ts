// =======================================================================
// R0-07 验收三件套 1：事件信封逐字节断言
//
// 验收口径（Z0 §9.2 R0-07 / §12.5 P0 ①）：跨端事件推送的 DeviceEnvelope
// 载荷与 fixtures 样例逐字节一致。双侧对拍（Rust 序列化 vs 样例 /
// TS parser 解析 vs 样例）已由 R0-05 覆盖；本测试做**验收级**断言：
// mock daemon **实际推送**的 events.push 信封，经真实 WS 传输到达客户端后
// 逐字段校验——外层 8 字段 + auth 4 字段（对照样例 08 形状契约）、
// event 载荷与样例 08/09 骨架逐字段同构、wire 透传无损（客户端收到事件
// 与服务端存储事件 canonical 逐字节一致）、preview 帧语义（样例 09 基准）。
//
// 口径说明：canonical JSON（键码点升序递归排序）为逐字节等价断言基础，
// 与 device/parity.test.ts 同一语义（对拍 README「消费规则」第 1 条）。
// =======================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer } from '../helpers.js';
import type { TestServer } from '../helpers.js';
import { AcceptanceClient, waitOpen, canonicalJsonString, fixtureSample, assertEnvelopeFields, eventOf } from './helpers.js';
import { parseDeviceFrame } from '../../../../packages/shared-types/src/generated/device/parser';
import { parseEngineEvent } from '../../../../packages/shared-types/src/generated/engine/parser';
import { DEVICE_EVENTS } from '../../../../packages/shared-types/src/generated/device/events';
import { messageDeltaThought } from '../../src/fixtures/events.js';

/** mock 固定桌面身份（envelope.ts 导出值；样例 08 的 auth.deviceId 为客户端侧 id，注意区分） */
const MOCK_DESKTOP_ID = 'desktop-mock-0001';
const MOCK_SIG = 'mock-sig-placeholder';
const MOCK_NONCE = 'mock-nonce';

/** 连续消费 events.push 直至命中收口类型，返回全部推送帧（保序） */
async function collectPushesUntil(client: AcceptanceClient, stopType: string): Promise<{ frame: Awaited<ReturnType<AcceptanceClient['waitFor']>>; event: Record<string, unknown> }[]> {
  const collected: { frame: Awaited<ReturnType<AcceptanceClient['waitFor']>>; event: Record<string, unknown> }[] = [];
  for (;;) {
    const push = await client.waitFor((f) => f.kind === 'events.push');
    const event = eventOf(push);
    collected.push({ frame: push, event });
    if (String(event['type']) === stopType) break;
  }
  return collected;
}

describe('R0-07 三件套 1：事件信封逐字段断言（mock 实际推送 vs fixtures 样例）', () => {
  let t: TestServer;
  let client: AcceptanceClient;
  /** 样例 08（持久 events.push 帧）与 09（preview 帧）的形状基准 */
  let sample08: Record<string, unknown>;
  let sample09: Record<string, unknown>;

  beforeAll(async () => {
    sample08 = fixtureSample('08-events-push.json');
    sample09 = fixtureSample('09-events-push-preview.json');
    t = await startTestServer({ scenario: 'run', scenarioSpeed: 0 });
    client = new AcceptanceClient(t.url, 'dev-accept-1');
    await waitOpen(client);
    client.send('auth.hello', { protocolVersions: [1], capabilities: [], appVersion: '0.1.0', platform: 'other' });
    await client.waitFor('auth.hello.ok');
    client.send('events.subscribe', { sessions: ['s-mock-run'], lastSequences: {} });
    await client.waitFor('events.subscribe.ok');
  });

  afterAll(async () => {
    client.close();
    await t.server.close();
  });

  it('首帧逐字段（样例 08 基准）：外层信封八字段 + auth 四字段 + event 骨架同构 + 双侧解析', async () => {
    // 实际推送的第一帧（run 场景 agent-start）
    const first = await client.waitFor((f) => f.kind === 'events.push');
    const event = eventOf(first);
    expect(event['type']).toBe('agent-start');

    // 外层信封逐字段（含字段集合与样例 08 完全一致）
    assertEnvelopeFields(first, 'events.push', { from: 'desktop', to: 'mobile', authDeviceId: MOCK_DESKTOP_ID });
    expect(first.auth.nonce).toBe(MOCK_NONCE);
    expect(first.auth.sig).toBe(MOCK_SIG);

    // 与样例 08 形状契约比对：外层字段集合逐项一致（样例 = wire 形态基准）
    expect(Object.keys(first).sort()).toEqual(Object.keys(sample08).sort());
    expect(Object.keys(first.auth).sort()).toEqual(Object.keys(sample08['auth'] as Record<string, unknown>).sort());
    expect(first.v).toBe(sample08['v']);
    expect(first.kind).toBe(sample08['kind']);
    expect(first.from).toBe(sample08['from']);
    expect(first.to).toBe(sample08['to']);

    // event 骨架逐字段（样例 08 公共骨架字段逐一存在且类型正确）
    const sampleEvent = (sample08['body'] as { event: Record<string, unknown> })['event'];
    const skeletonKeys = ['type', 'runId', 'sequence', 'schemaVersion', 'sessionId', 'timestamp'];
    for (const key of skeletonKeys) {
      expect(event[key], `event 缺少样例骨架字段 ${key}`).toBeDefined();
    }
    expect(event['runId']).toBe('r-mock-run-1');
    expect(event['sessionId']).toBe('s-mock-run');
    expect(event['schemaVersion']).toBe(1);
    expect(typeof event['sequence']).toBe('number');
    expect(event['sequence']).toBeGreaterThan(0);
    expect(typeof event['timestamp']).toBe('string');

    // 事件 type 在 41 变体注册表内（与样例 08 同源注册表）
    const registeredTypes = DEVICE_EVENTS.map((e) => e.type);
    expect(registeredTypes).toContain(event['type']);
    expect(registeredTypes).toContain(sampleEvent['type']);

    // 双侧同一解析器：样例 08 的 event 与 mock 实际推送的 event 都能全量解析
    const sampleParsed = parseEngineEvent(sampleEvent);
    expect(sampleParsed.ok, `样例 08 event 解析失败：${sampleParsed.ok ? '' : sampleParsed.error}`).toBe(true);
    const pushedParsed = parseEngineEvent(event);
    expect(pushedParsed.ok, `mock 实际推送 event 解析失败：${pushedParsed.ok ? '' : pushedParsed.error}`).toBe(true);

    // 样例公共骨架字段集合 ⊆ 实际推送 event 字段集合（骨架字段全量透传，零裁剪零新增；
    // 事件专属字段（如 approval-requested 的 request）按各自 type 分别构造，不做跨 type 断言）
    for (const key of skeletonKeys) {
      expect(Object.keys(event), `实际推送 event 缺失样例骨架字段 ${key}`).toContain(key);
    }

    // 生成解析器全帧解析通过（注册表级校验：未知字段/缺字段即失败）
    const frameJson = JSON.parse(JSON.stringify({
      v: first.v,
      kind: first.kind,
      msgId: first.msgId,
      ts: first.ts,
      from: first.from,
      to: first.to,
      auth: first.auth,
      body: first.body,
    }));
    const parsed = parseDeviceFrame(frameJson);
    expect(parsed.ok, `实际推送帧必须通过生成解析器：${parsed.ok ? '' : parsed.error}`).toBe(true);

    // 首帧同时完成 wire 透传无损复核：与服务端存储 sequence=1 条目 canonical 逐字节一致
    const storedFirst = t.server.state.store('s-mock-run').all()[0];
    expect(storedFirst).toBeDefined();
    expect(storedFirst!.sequence).toBe(1);
    expect(canonicalJsonString(event)).toBe(canonicalJsonString(storedFirst!.event));
  });

  it('逐字节断言：wire 透传无损——客户端收到的 event ≡ 服务端存储事件（canonical 一致）', async () => {
    // 收集 run 场景完整生命周期（至 run-terminal 收口；首帧已在前一用例消费，
    // 这里从 sequence=2 续收——单调递增断言以首帧为基准，逐字节断言按 sequence 映射）
    const collected = await collectPushesUntil(client, 'run-terminal');
    expect(collected.length).toBeGreaterThanOrEqual(11);

    // 每帧信封逐字段（对全部收集帧抽查首/中/尾各帧）
    for (const idx of [0, Math.floor(collected.length / 2), collected.length - 1]) {
      assertEnvelopeFields(collected[idx]!.frame, 'events.push', { from: 'desktop', to: 'mobile', authDeviceId: MOCK_DESKTOP_ID });
    }

    // sequence 单调递增（无重复无空洞；首帧为 2，因为 sequence=1 已被首帧用例消费）
    const sequences = collected.map((c) => c.event['sequence'] as number);
    const base = sequences[0]!;
    sequences.forEach((seq, i) => {
      expect(Number.isInteger(seq)).toBe(true);
      expect(seq).toBe(base + i);
    });

    // 逐字节（canonical）断言：客户端收到的事件与服务端会话存储逐条一致（按 sequence 映射；
    // sequence=1 已由「首帧逐字段」用例完成 canonical 复核，此处覆盖其余全部条目）
    const bySequence = new Map<number, Record<string, unknown>>();
    collected.forEach((c) => bySequence.set(c.event['sequence'] as number, c.event));
    const stored = t.server.state.store('s-mock-run').all();
    expect(stored.length).toBe(bySequence.size + 1); // 首帧已被前序用例消费
    stored.forEach((item) => {
      if (item.sequence === 1) return; // 首帧 canonical 复核在前序用例
      const pushed = bySequence.get(item.sequence);
      expect(pushed, `服务端 sequence=${item.sequence} 的事件客户端必须收到`).toBeDefined();
      expect(canonicalJsonString(pushed)).toBe(canonicalJsonString(item.event));
    });
  });

  it('preview 帧（样例 09 基准）：preview=true、sequence 省略语义、不推进游标', async () => {
    // 样例 09 基准：preview 帧 parseDeviceFrame + parseEngineEvent 双侧解析通过
    const sampleParsed = parseDeviceFrame(sample09);
    expect(sampleParsed.ok, `样例 09 解析失败：${sampleParsed.ok ? '' : sampleParsed.error}`).toBe(true);
    const sampleEvent = sample09['body'] as { event: Record<string, unknown> };
    const sampleEventParsed = parseEngineEvent(sampleEvent['event']);
    expect(sampleEventParsed.ok, `样例 09 event 解析失败：${sampleEventParsed.ok ? '' : sampleEventParsed.error}`).toBe(true);

    // mock 实际发射预览帧（message-delta 思考块；引擎序列化纪律：sequence=None 省略，
    // 与样例 09 的显式 null 同为「不推进游标」语义——消费端两种形态均接受）
    const beforeSeq = t.server.state.store('s-mock-run').maxSequence();
    await t.server.emitEvent('s-mock-run', messageDeltaThought('s-mock-run', 'r-mock-run-1', 'msg-preview-1'), true);
    const push = await client.waitFor((f) => f.kind === 'events.push');
    expect(push.body['preview']).toBe(true);
    expect(push.body['sessionId']).toBe('s-mock-run');
    const ev = eventOf(push);
    expect(ev['type']).toBe('message-delta');
    expect(ev['sequence']).toBeUndefined(); // 预览帧不推进游标：sequence 省略（引擎跳过注入）
    // 不落库、不推进游标（与 resume-reconnect 预览帧语义一致）
    expect(t.server.state.store('s-mock-run').maxSequence()).toBe(beforeSeq);
    // 预览帧载荷同样通过生成解析器
    const pushedParsed = parseEngineEvent(ev);
    expect(pushedParsed.ok, `预览帧 event 解析失败：${pushedParsed.ok ? '' : pushedParsed.error}`).toBe(true);
  });

  it('入站信封逐字段：客户端帧服务器逐字段解析成功（auth 四字段齐备）', async () => {
    // 客户端发送完整入站信封（heartbeat 会话期帧），服务器必须正常回执
    const before = client.bufferSize();
    client.send('heartbeat', { ts: Date.now(), deviceTimeMs: Date.now() });
    const ok = await client.waitFor('heartbeat.ok');
    expect(ok.body['serverTime']).toBeDefined();
    // 会话期帧无错误应答：缓冲无 error 帧
    expect(client.peekBuffer().some((f) => f.kind === 'error')).toBe(false);
    expect(client.bufferSize()).toBe(before);
    // 客户端入站信封字段（send 构造）：v/kind/msgId/ts/from/to/auth 齐备——由服务器
    // parseInbound 严格解析（parseDeviceMessage body 校验）证明字段形状合法
  });
});

describe('R0-07 三件套 1 补充：订阅面信封（subscribe.ok 逐字段，样例 07 基准）', () => {
  let t: TestServer;
  let client: AcceptanceClient;

  beforeAll(async () => {
    t = await startTestServer({ scenario: 'idle', scenarioSpeed: 0 });
    client = new AcceptanceClient(t.url, 'dev-accept-2');
    await waitOpen(client);
  });

  afterAll(async () => {
    client.close();
    await t.server.close();
  });

  it('订阅回执信封逐字段（样例 07-events-subscribe 同形状）', async () => {
    client.send('auth.hello', { protocolVersions: [1], capabilities: [], appVersion: '0.1.0', platform: 'other' });
    const helloOk = await client.waitFor('auth.hello.ok');
    assertEnvelopeFields(helloOk, 'auth.hello.ok', { from: 'desktop', to: 'mobile', authDeviceId: MOCK_DESKTOP_ID });
    // hello.ok body 逐字段：protocolVersion/minProtocolVersion/desktopId/serverTime/capabilities/manifest
    expect(helloOk.body['protocolVersion']).toBe(1);
    expect(helloOk.body['minProtocolVersion']).toBe(1);
    expect(helloOk.body['desktopId']).toBe(MOCK_DESKTOP_ID);
    expect(typeof helloOk.body['serverTime']).toBe('number');
    expect(helloOk.body['capabilities']).toBeDefined();
    expect(helloOk.body['manifest']).toBeDefined();

    client.send('events.subscribe', { sessions: ['s-1'], lastSequences: { 's-1': 0 } });
    const ok = await client.waitFor('events.subscribe.ok');
    assertEnvelopeFields(ok, 'events.subscribe.ok', { from: 'desktop', to: 'mobile', authDeviceId: MOCK_DESKTOP_ID });
    const sessions = ok.body['sessions'] as { sessionId: string; nextSequence: number; stale: boolean }[];
    expect(sessions).toEqual([{ sessionId: 's-1', nextSequence: 0, stale: false }]);
  });
});
