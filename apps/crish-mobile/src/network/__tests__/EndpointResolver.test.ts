// 端点解析单测：WS URL 构造与 token 注入。
import {
  DEFAULT_GATEWAY_PORT,
  buildAuthenticatedWsUrl,
  resolveWsUrl,
} from '../EndpointResolver';

describe('resolveWsUrl', () => {
  test('默认 wss + 8765 + /v1/events', () => {
    expect(resolveWsUrl('192.168.1.10')).toBe(
      'wss://192.168.1.10:8765/v1/events'
    );
    expect(resolveWsUrl('192.168.1.5', DEFAULT_GATEWAY_PORT, true)).toBe(
      'wss://192.168.1.5:8765/v1/events'
    );
  });

  test('携带 token 参数', () => {
    expect(resolveWsUrl('192.168.1.5', 8765, true, 'token_xyz')).toBe(
      'wss://192.168.1.5:8765/v1/events?token=token_xyz'
    );
    expect(resolveWsUrl('host.local', 8765, false, 'abc 123')).toBe(
      'ws://host.local:8765/v1/events?token=abc%20123'
    );
  });
});

describe('buildAuthenticatedWsUrl', () => {
  test('注入 token', () => {
    expect(
      buildAuthenticatedWsUrl('wss://192.168.1.100:8765', { token: 'tok_abc' })
    ).toBe('wss://192.168.1.100:8765?token=tok_abc');
  });

  test('已有 query 时使用 &', () => {
    expect(
      buildAuthenticatedWsUrl('wss://192.168.1.100:8765?v=1', {
        token: 'tok_abc',
      })
    ).toBe('wss://192.168.1.100:8765?v=1&token=tok_abc');
  });

  test('已有 token / 无 token 时原样返回', () => {
    expect(
      buildAuthenticatedWsUrl('wss://h:1?token=existing', { token: 'new' })
    ).toBe('wss://h:1?token=existing');
    expect(buildAuthenticatedWsUrl('wss://h:1', {})).toBe('wss://h:1');
  });
});
