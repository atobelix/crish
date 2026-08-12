// WsGateway 帧编解码单测（R2-02）：编解码往返 / 非法帧拒绝 / 未知 kind 策略 / 载荷校验
// + R2-02 部分 2：invoke/on 请求-响应分发（msgId 配对 / 超时 / 错误帧 / 订阅广播）
import {
  DEFAULT_INVOKE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  GatewayError,
  WsGateway,
  decodeFrame,
  encodeFrame,
  FrameEncodeError,
  nextMsgId,
} from '../WsGateway';
import type {
  InboundEnvelope,
  OutboundEnvelope,
  OutgoingEnvelope,
} from '../WsEnvelope';
import type { JsonValue } from '../../../../../packages/shared-types/src/primitive-types';

/** 构造出站信封（heartbeat 形态；auth 可省略用于配对期场景） */
function buildFrame(
  kind: OutboundEnvelope['kind'],
  body: JsonValue,
  extra: Partial<OutboundEnvelope> = {}
): OutboundEnvelope {
  return {
    v: 1,
    kind,
    msgId: 'm-test-0001',
    ts: 1754651200000,
    from: 'mobile',
    to: 'desktop',
    auth: {
      deviceId: 'dev-01HZ',
      ts: 1754651200000,
      nonce: 'nonce-abcdef',
      sig: 'mock-sig-placeholder',
    },
    body,
    ...extra,
  };
}

function decode(raw: string) {
  return decodeFrame(raw);
}

describe('encodeFrame / decodeFrame 编解码往返', () => {
  test('心跳帧编码 → 解码往返（带 auth）', () => {
    const frame = buildFrame('heartbeat', {
      ts: 1754651200000,
      deviceTimeMs: 1754651199500,
    });
    const raw = encodeFrame(frame);
    const result = decode(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame.kind).toBe('heartbeat');
      expect(result.frame.msgId).toBe('m-test-0001');
      expect(result.frame.v).toBe(1);
      expect(result.frame.from).toBe('mobile');
      expect(result.frame.to).toBe('desktop');
      expect(result.frame.auth?.deviceId).toBe('dev-01HZ');
      expect(result.frame.body).toEqual({
        ts: 1754651200000,
        deviceTimeMs: 1754651199500,
      });
    }
  });

  test('编码为紧凑 JSON（无空格，与 serde_json 字节形态对齐）', () => {
    const raw = encodeFrame(
      buildFrame('heartbeat', { ts: 1, deviceTimeMs: 2 })
    );
    expect(raw).not.toContain(' ');
    expect(raw.startsWith('{"v":1,"kind":"heartbeat"')).toBe(true);
  });

  test('配对期无 auth 帧放行（D3 §5.2 auth 可选）', () => {
    const frame = buildFrame(
      'pair.hello',
      {
        code: 'CXN-7K4P-Q2MB-9XRT',
        deviceId: 'dev-01HZ',
        mobilePub: 'mpub',
        mobileLongPub: 'mlpub',
        deviceName: '测试手机',
      },
      { auth: undefined }
    );
    const result = decode(encodeFrame(frame));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.frame.auth).toBeUndefined();
  });

  test('events.push 帧（桌面 → 移动）往返', () => {
    const frame = buildFrame(
      'events.push',
      {
        sessionId: 's-001',
        event: { type: 'agent-start', sessionId: 's-001', timestamp: 1 },
      },
      {
        from: 'desktop',
        to: 'mobile',
      }
    );
    const result = decode(encodeFrame(frame));
    expect(result.ok).toBe(true);
  });
});

describe('decodeFrame 非法帧拒绝', () => {
  test('非 JSON 文本 → cmd.invalid 宽容丢弃', () => {
    const result = decode('not-json{');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('cmd.invalid');
      expect(result.error.drop).toBe(true);
    }
  });

  test('JSON 数组/标量 → cmd.invalid', () => {
    expect(decode('[1,2]').ok).toBe(false);
    expect(decode('"str"').ok).toBe(false);
    expect(decode('null').ok).toBe(false);
  });

  test('版本不匹配（v=2）→ version_mismatch，拒绝不兼容', () => {
    const raw = encodeFrame(
      buildFrame('heartbeat', { ts: 1, deviceTimeMs: 2 })
    ).replace('"v":1', '"v":2');
    const result = decode(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('version_mismatch');
  });

  test('未知 kind → 宽容丢弃（D3 §10.3 不回 error 帧）', () => {
    const raw = JSON.stringify({
      v: 1,
      kind: 'future.message',
      msgId: 'm-001',
      ts: 1,
      from: 'desktop',
      to: 'mobile',
      body: {},
    });
    const result = decode(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('cmd.unknown');
      expect(result.error.drop).toBe(true);
    }
  });

  test('from/to 非法值 → cmd.invalid', () => {
    const raw = encodeFrame(
      buildFrame('heartbeat', { ts: 1, deviceTimeMs: 2 })
    ).replace('"from":"mobile"', '"from":"pc"');
    const result = decode(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('cmd.invalid');
  });

  test('to 非法值 → cmd.invalid', () => {
    const raw = encodeFrame(
      buildFrame('heartbeat', { ts: 1, deviceTimeMs: 2 })
    ).replace('"to":"desktop"', '"to":"pc"');
    const result = decode(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('cmd.invalid');
  });

  test('信封 ts 非整数/负值 → cmd.invalid', () => {
    const a = decode(
      encodeFrame(
        buildFrame('heartbeat', { ts: 1, deviceTimeMs: 2 }, { ts: 1.5 })
      )
    );
    expect(a.ok).toBe(false);
    const b = decode(
      encodeFrame(
        buildFrame('heartbeat', { ts: 1, deviceTimeMs: 2 }, { ts: -1 })
      )
    );
    expect(b.ok).toBe(false);
    if (!a.ok) expect(a.error.code).toBe('cmd.invalid');
  });

  test('msgId 缺失 → cmd.invalid', () => {
    const raw = JSON.stringify({
      v: 1,
      kind: 'heartbeat',
      ts: 1,
      from: 'mobile',
      to: 'desktop',
      body: { ts: 1, deviceTimeMs: 2 },
    });
    expect(decode(raw).ok).toBe(false);
  });
});

describe('decodeFrame 载荷校验（生成解析器 parseDeviceMessage）', () => {
  test('heartbeat body 缺必填字段 → 拒绝', () => {
    // heartbeat 必填 ts/deviceTimeMs；缺 deviceTimeMs 应被生成解析器拒绝
    const frame = buildFrame('heartbeat', { ts: 1754651200000 });
    const result = decode(encodeFrame(frame));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('cmd.invalid');
      expect(result.error.message).toContain('body 解析失败');
    }
  });

  test('pair.hello body 缺必填字段（mobilePub 等）→ 拒绝', () => {
    const frame = buildFrame(
      'pair.hello',
      { code: 'CXN-7K4P-Q2MB-9XRT' },
      { auth: undefined }
    );
    const result = decode(encodeFrame(frame));
    expect(result.ok).toBe(false);
  });

  test('body 字段类型错误（deviceTimeMs 为字符串）→ 拒绝', () => {
    const frame = buildFrame('heartbeat', { ts: 1, deviceTimeMs: '1000' });
    expect(decode(encodeFrame(frame)).ok).toBe(false);
  });
});

describe('encodeFrame 帧大小上限', () => {
  test('超 MAX_FRAME_BYTES → frame_too_large（D3 §5.5 断链语义）', () => {
    const big = 'x'.repeat(MAX_FRAME_BYTES + 100);
    const frame = buildFrame('events.push', {
      sessionId: 's-001',
      event: {
        type: 'message-delta',
        sessionId: 's-001',
        timestamp: 1,
        messageId: 'm',
        block: { text: big },
      },
    });
    expect(() => encodeFrame(frame)).toThrow(FrameEncodeError);
    try {
      encodeFrame(frame);
    } catch (e) {
      expect((e as FrameEncodeError).code).toBe('frame_too_large');
    }
  });

  test('恰在上限内可编码', () => {
    const frame = buildFrame('heartbeat', { ts: 1, deviceTimeMs: 2 });
    const raw = encodeFrame(frame);
    expect(raw.length).toBeLessThan(MAX_FRAME_BYTES);
  });
});

// ── R2-02 部分 2：invoke/on 请求-响应分发（D3 §5.4 msgId 配对）──────────────

/** 构造入站信封（直传 dispatchFrame，纯分发路径不经过编码） */
function inboundFrame(
  kind: InboundEnvelope['kind'],
  body: JsonValue,
  extra: Partial<InboundEnvelope> = {}
): InboundEnvelope {
  return {
    v: 1,
    kind,
    msgId: 'srv-0001',
    ts: 1754651200000,
    from: 'desktop',
    to: 'mobile',
    body,
    ...extra,
  };
}

/** result.<name> 成功响应帧 */
function resultFrame(reqMsgId: string, result: JsonValue): InboundEnvelope {
  return inboundFrame('result.getStatus', { reqMsgId, ok: true, result });
}

/** 从发送记录取首个请求的 msgId */
function lastSentMsgId(send: jest.Mock): string {
  const raw = send.mock.calls[send.mock.calls.length - 1]?.[0];
  return (JSON.parse(raw ?? '') as { msgId: string }).msgId;
}

describe('WsGateway.invoke 请求-响应分发（msgId 配对，D3 §5.4 / M6 §6.1）', () => {
  test('invoke 发送带 msgId 的请求帧 → 响应帧按 reqMsgId 回填 resolve', async () => {
    const send = jest.fn();
    const gw = new WsGateway({ send });
    const p = gw.invoke<{ initialized: boolean }>('remote.getStatus', {});
    const sent = JSON.parse(send.mock.calls[0]?.[0] ?? '') as {
      kind: string;
      msgId: string;
      from: string;
      to: string;
      v: number;
    };
    expect(sent.kind).toBe('remote.getStatus');
    expect(sent.v).toBe(1);
    expect(sent.from).toBe('mobile');
    expect(sent.to).toBe('desktop');
    expect(sent.msgId).toMatch(/^m-mob-\d{4}-[a-z0-9]{6}$/);
    gw.dispatchFrame(resultFrame(sent.msgId, { initialized: true }));
    await expect(p).resolves.toEqual({ initialized: true });
    expect(gw.pendingCount()).toBe(0);
  });

  test('invoke 未接线（无 send）→ 立即 reject transport.closed', async () => {
    const gw = new WsGateway();
    await expect(gw.invoke('remote.getStatus', {})).rejects.toMatchObject({
      code: 'transport.closed',
      retryable: true,
    });
  });

  test('error 帧按 reqMsgId reject（错误码归一化：code/retryable/detail）', async () => {
    const send = jest.fn();
    const gw = new WsGateway({ send });
    const p = gw.invoke('remote.approve', { toolCallId: 'tc-1' });
    const msgId = lastSentMsgId(send);
    gw.dispatchFrame(
      inboundFrame('error', {
        reqMsgId: msgId,
        code: 'cmd.approval_mismatch',
        message: '该请求已被其他设备处理或已过期',
        retryable: false,
        detail: { existingDecision: 'approved' },
      })
    );
    await expect(p).rejects.toBeInstanceOf(GatewayError);
    await expect(p).rejects.toMatchObject({
      code: 'cmd.approval_mismatch',
      retryable: false,
      detail: { existingDecision: 'approved' },
    });
    expect(gw.pendingCount()).toBe(0);
  });

  test('result.ok=false → 用 body.error 拒绝（M6 §6.1 三态信封 error 态）', async () => {
    const send = jest.fn();
    const gw = new WsGateway({ send });
    const p = gw.invoke('remote.deny', { toolCallId: 'tc-2' });
    const msgId = lastSentMsgId(send);
    gw.dispatchFrame(
      inboundFrame('result.deny', {
        reqMsgId: msgId,
        ok: false,
        error: { code: 'cmd.denied', message: '白名单拒绝', retryable: false },
      })
    );
    await expect(p).rejects.toMatchObject({
      code: 'cmd.denied',
      retryable: false,
    });
  });

  test('未知 reqMsgId 响应帧 → 丢弃（不 resolve 不广播）', async () => {
    jest.useFakeTimers();
    try {
      const send = jest.fn();
      const gw = new WsGateway({ send });
      const spy = jest.fn();
      gw.on('result.getStatus', spy);
      gw.on('*', spy);
      const p = gw.invoke('remote.getStatus', {});
      gw.dispatchFrame(resultFrame('m-ghost-0001-aaaaaa', { x: 1 }));
      expect(gw.pendingCount()).toBe(1); // 挂起未被消费
      expect(spy).not.toHaveBeenCalled(); // 响应帧不广播
      jest.advanceTimersByTime(DEFAULT_INVOKE_TIMEOUT_MS);
      await expect(p).rejects.toMatchObject({ code: 'cmd.timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('并发多请求乱序响应 → 各回各的（pending 按 msgId 隔离）', async () => {
    const send = jest.fn();
    const gw = new WsGateway({ send });
    const p1 = gw.invoke<{ a: number }>('remote.getStatus', {});
    const p2 = gw.invoke<{ b: number }>('remote.listSessions', {});
    const p3 = gw.invoke<{ c: number }>('remote.listDir', {});
    expect(gw.pendingCount()).toBe(3);
    const ids = send.mock.calls.map(
      (c) => (JSON.parse(String(c[0])) as { msgId: string }).msgId
    );
    expect(ids).toHaveLength(3);
    // 乱序响应：先回 p3 → 再回 p1 → 最后回 p2
    gw.dispatchFrame(resultFrame(ids[2]!, { c: 3 }));
    gw.dispatchFrame(resultFrame(ids[0]!, { a: 1 }));
    gw.dispatchFrame(resultFrame(ids[1]!, { b: 2 }));
    await expect(p3).resolves.toEqual({ c: 3 });
    await expect(p1).resolves.toEqual({ a: 1 });
    await expect(p2).resolves.toEqual({ b: 2 });
    expect(gw.pendingCount()).toBe(0);
  });

  test('buildRequest 注入（R2-03 签名接线点）：请求帧经构建器产出含 auth', async () => {
    const send = jest.fn();
    const build = jest.fn(
      (
        kind: string,
        msgId: string,
        body: JsonValue,
        ts: number
      ): OutgoingEnvelope => ({
        v: 1,
        kind,
        msgId,
        ts,
        from: 'mobile',
        to: 'desktop',
        body,
        auth: { deviceId: 'dev-01HZ', ts, nonce: 'n-1', sig: 'sig-1' },
      })
    );
    const gw = new WsGateway({ send, buildRequest: build, now: () => 42 });
    const p = gw.invoke('remote.getStatus', { include: [] });
    const sent = JSON.parse(send.mock.calls[0]?.[0] ?? '');
    expect(build).toHaveBeenCalledTimes(1);
    expect(sent.auth).toEqual({
      deviceId: 'dev-01HZ',
      ts: 42,
      nonce: 'n-1',
      sig: 'sig-1',
    });
    expect(sent.ts).toBe(42);
    gw.dispatchFrame(
      resultFrame((sent as { msgId: string }).msgId, { ok: true })
    );
    await expect(p).resolves.toEqual({ ok: true });
  });

  test('send 推流（heartbeat 等无响应帧）→ 带 msgId 编码帧；未接线静默丢弃', () => {
    const send = jest.fn();
    const gw = new WsGateway({ send });
    gw.send('heartbeat', { ts: 1, deviceTimeMs: 2 });
    const sent = JSON.parse(send.mock.calls[0]?.[0] ?? '') as {
      kind: string;
      msgId: string;
    };
    expect(sent.kind).toBe('heartbeat');
    expect(sent.msgId).toMatch(/^m-mob-/);
    expect(send).toHaveBeenCalledTimes(1);
    const gw2 = new WsGateway();
    expect(() =>
      gw2.send('heartbeat', { ts: 1, deviceTimeMs: 2 })
    ).not.toThrow();
  });

  test('buildRequest 抛错（构建器异常）→ invoke reject 且不残留 pending', async () => {
    const send = jest.fn();
    const boom = new Error('构建器炸了');
    const gw = new WsGateway({
      send,
      buildRequest: () => {
        throw boom;
      },
    });
    const p = gw.invoke('remote.getStatus', {});
    await expect(p).rejects.toBe(boom);
    expect(gw.pendingCount()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  test('send 抛错（帧超限等）→ invoke reject + pending 清理（不残留 timer）', async () => {
    const gw = new WsGateway({
      send: () => {
        throw new FrameEncodeError('frame_too_large', '超限');
      },
    });
    const p = gw.invoke('remote.getStatus', {});
    await expect(p).rejects.toBeInstanceOf(FrameEncodeError);
    expect(gw.pendingCount()).toBe(0);
  });

  test('abortAllPending → 全部挂起 reject 同一错误 + 清表（断线清理）', async () => {
    const send = jest.fn();
    const gw = new WsGateway({ send });
    const p1 = gw.invoke('remote.a', {});
    const p2 = gw.invoke('remote.b', {});
    expect(gw.pendingCount()).toBe(2);
    const err = new GatewayError('transport.closed', '连接被关闭', true);
    gw.abortAllPending(err);
    await expect(p1).rejects.toBe(err);
    await expect(p2).rejects.toBe(err);
    expect(gw.pendingCount()).toBe(0);
  });

  test('nextMsgId：格式（M6 §3.3）＋前缀＋唯一递增', () => {
    const a = nextMsgId('dev7');
    const b = nextMsgId('dev7');
    const c = nextMsgId();
    expect(a).toMatch(/^m-dev7-\d{4}-[a-z0-9]{6}$/);
    expect(a).not.toBe(b);
    expect(c).toMatch(/^m-mob-\d{4}-[a-z0-9]{6}$/);
  });
});

describe('WsGateway.invoke 超时（M6 §6.2.2 cmd.timeout）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('超时 reject cmd.timeout（retryable）且不残留 pending', async () => {
    const send = jest.fn();
    const gw = new WsGateway({ send });
    const p = gw.invoke('remote.getStatus', {}, 1000);
    expect(gw.pendingCount()).toBe(1);
    jest.advanceTimersByTime(999);
    expect(gw.pendingCount()).toBe(1);
    jest.advanceTimersByTime(1);
    await expect(p).rejects.toMatchObject({
      code: 'cmd.timeout',
      retryable: true,
    });
    expect(gw.pendingCount()).toBe(0);
  });

  test('默认超时 = DEFAULT_INVOKE_TIMEOUT_MS（10s，可经 options 覆盖）', async () => {
    const send = jest.fn();
    const gw = new WsGateway({ send, defaultTimeoutMs: 500 });
    const p = gw.invoke('remote.getStatus', {});
    jest.advanceTimersByTime(499);
    jest.advanceTimersByTime(1);
    await expect(p).rejects.toMatchObject({ code: 'cmd.timeout' });
  });

  test('超时后迟到的响应帧 → 丢弃（不 resolve 已超时请求）', async () => {
    const send = jest.fn();
    const gw = new WsGateway({ send });
    const p = gw.invoke('remote.getStatus', {}, 1000);
    const msgId = lastSentMsgId(send);
    jest.advanceTimersByTime(1000);
    await expect(p).rejects.toMatchObject({ code: 'cmd.timeout' });
    gw.dispatchFrame(resultFrame(msgId, { late: true })); // 迟到响应：静默丢弃
    expect(gw.pendingCount()).toBe(0);
  });
});

describe('WsGateway.on 订阅分发（精确 kind + 通配 + 错误帧路由）', () => {
  test('精确 kind 订阅 → dispatch 触发；退订后不再触发', () => {
    const gw = new WsGateway();
    const h = jest.fn();
    const off = gw.on('events.push', h);
    const frame = inboundFrame('events.push', {
      sessionId: 's-1',
      event: { type: 'agent-start', sessionId: 's-1', timestamp: 1 },
    });
    gw.dispatchFrame(frame);
    expect(h).toHaveBeenCalledWith(frame);
    off();
    gw.dispatchFrame(frame);
    expect(h).toHaveBeenCalledTimes(1);
  });

  test('通配 * 接收全部广播帧（事件 + 会话广播）', () => {
    const gw = new WsGateway();
    const w = jest.fn();
    gw.on('*', w);
    gw.dispatchFrame(
      inboundFrame('events.push', {
        sessionId: 's-1',
        event: { type: 'agent-start', sessionId: 's-1', timestamp: 1 },
      })
    );
    gw.dispatchFrame(
      inboundFrame('session.updated', { session: { id: 's-1', updatedAt: 1 } })
    );
    gw.dispatchFrame(inboundFrame('device.revoked', { deviceId: 'd-1' }));
    expect(w).toHaveBeenCalledTimes(3);
  });

  test('error 帧无 reqMsgId → 广播给 error 订阅者 + 通配（D3 §5.4 推送路径错误）', () => {
    const gw = new WsGateway();
    const e = jest.fn();
    const w = jest.fn();
    gw.on('error', e);
    gw.on('*', w);
    const err = inboundFrame('error', {
      code: 'internal',
      message: '推送路径失败',
      retryable: true,
    });
    gw.dispatchFrame(err);
    expect(e).toHaveBeenCalledWith(err);
    expect(w).toHaveBeenCalledWith(err);
  });

  test('error 帧命中 pending → 只 reject 不广播', async () => {
    const send = jest.fn();
    const gw = new WsGateway({ send });
    const e = jest.fn();
    gw.on('error', e);
    const p = gw.invoke('remote.approve', { toolCallId: 'tc-1' });
    const msgId = lastSentMsgId(send);
    gw.dispatchFrame(
      inboundFrame('error', {
        reqMsgId: msgId,
        code: 'cmd.denied',
        message: 'x',
        retryable: false,
      })
    );
    await expect(p).rejects.toMatchObject({ code: 'cmd.denied' });
    expect(e).not.toHaveBeenCalled();
  });

  test('result 帧未命中 pending → 丢弃不广播（响应帧不进入事件流）', () => {
    const gw = new WsGateway();
    const h = jest.fn();
    gw.on('*', h);
    gw.dispatchFrame(
      inboundFrame('result.getStatus', {
        reqMsgId: 'ghost',
        ok: true,
        result: {},
      })
    );
    expect(h).not.toHaveBeenCalled();
  });

  test('响应帧命中 pending → 消费不广播（通配收不到 result）', async () => {
    const send = jest.fn();
    const gw = new WsGateway({ send });
    const w = jest.fn();
    gw.on('*', w);
    const p = gw.invoke('remote.getStatus', {});
    gw.dispatchFrame(resultFrame(lastSentMsgId(send), { ok: true }));
    await expect(p).resolves.toEqual({ ok: true });
    expect(w).not.toHaveBeenCalled();
  });
});
