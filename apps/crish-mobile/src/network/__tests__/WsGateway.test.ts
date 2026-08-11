// WsGateway 帧编解码单测（R2-02）：编解码往返 / 非法帧拒绝 / 未知 kind 策略 / 载荷校验
import {
  MAX_FRAME_BYTES,
  decodeFrame,
  encodeFrame,
  FrameEncodeError,
} from '../WsGateway';
import type { OutboundEnvelope } from '../WsEnvelope';
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
