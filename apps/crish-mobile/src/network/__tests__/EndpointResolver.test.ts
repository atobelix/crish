// EndpointResolver 单测（R2-02）：URL 映射 / 端口范围候选 / 平台默认 / 端点选择 / 中继占位
import {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_RELAY_PORT,
  GATEWAY_PORT_RANGE_MAX,
  GATEWAY_PORT_RANGE_MIN,
  candidateEndpoints,
  defaultHosts,
  resolveHttpUrl,
  resolveRelayUrl,
  resolveWsUrl,
  selectEndpoint,
  buildAuthenticatedWsUrl,
} from '../EndpointResolver';

describe('resolveWsUrl / resolveHttpUrl（wss/https 同端口映射，D4 §6.3）', () => {
  test('默认 wss + 默认端口 8765 + /v1/events', () => {
    expect(resolveWsUrl('192.168.1.10')).toBe('wss://192.168.1.10:8765/v1/events');
    expect(resolveWsUrl('192.168.1.5', 8765, true)).toBe(
      'wss://192.168.1.5:8765/v1/events'
    );
  });

  test('显式携带 token 参数追加 ?token=xxx', () => {
    expect(resolveWsUrl('192.168.1.5', 8765, true, 'token_xyz')).toBe(
      'wss://192.168.1.5:8765/v1/events?token=token_xyz'
    );
    expect(resolveWsUrl('host.local', 8765, false, 'abc 123')).toBe(
      'ws://host.local:8765/v1/events?token=abc%20123'
    );
  });

  test('显式端口 + 非 TLS 降级（仅限可信局域网，D4 §6.1.5）', () => {
    expect(resolveWsUrl('192.168.1.10', 9000, false)).toBe(
      'ws://192.168.1.10:9000/v1/events'
    );
    expect(resolveHttpUrl('192.168.1.10', 9000, false)).toBe(
      'http://192.168.1.10:9000'
    );
  });

  test('HTTP 与 WS 同端口映射（配对握手 / 令牌刷新走 https 同端口）', () => {
    expect(resolveHttpUrl('192.168.1.10')).toBe('https://192.168.1.10:8765');
    expect(resolveHttpUrl('192.168.1.10', 8770)).toBe(
      'https://192.168.1.10:8770'
    );
  });
});

describe('candidateEndpoints（端口范围 8765-8775 探测候选，纯函数）', () => {
  test('hosts × 端口范围笛卡尔积全量（2 hosts × 11 端口 = 22 候选）', () => {
    const candidates = candidateEndpoints(['10.0.2.2', '192.168.1.10']);
    expect(candidates.length).toBe(
      2 * (GATEWAY_PORT_RANGE_MAX - GATEWAY_PORT_RANGE_MIN + 1)
    );
    const first = candidates[0];
    expect(first).toBeDefined();
    expect(first).toMatchObject({ host: '10.0.2.2', port: 8765, tls: true });
    expect(first!.wsUrl).toBe('wss://10.0.2.2:8765/v1/events');
    expect(first!.httpUrl).toBe('https://10.0.2.2:8765');
    // 每个端口至少出现一次（对每个 host）
    for (
      let port = GATEWAY_PORT_RANGE_MIN;
      port <= GATEWAY_PORT_RANGE_MAX;
      port++
    ) {
      expect(
        candidates.some((c) => c.host === '192.168.1.10' && c.port === port)
      ).toBe(true);
    }
  });

  test('自定义端口范围与 tls 选项', () => {
    const candidates = candidateEndpoints(['h1'], {
      portRange: [9000, 9001],
      tls: false,
    });
    expect(candidates.map((c) => c.wsUrl)).toEqual([
      'ws://h1:9000/v1/events',
      'ws://h1:9001/v1/events',
    ]);
    expect(candidates.map((c) => c.httpUrl)).toEqual([
      'http://h1:9000',
      'http://h1:9001',
    ]);
  });

  test('空 hosts → 空候选', () => {
    expect(candidateEndpoints([])).toEqual([]);
  });

  test('端口范围常量：默认端口 8765 在范围内且为下界', () => {
    expect(GATEWAY_PORT_RANGE_MIN).toBe(DEFAULT_GATEWAY_PORT);
    expect(GATEWAY_PORT_RANGE_MAX).toBe(8775);
  });
});

describe('defaultHosts（平台默认候选主机，D8 §6.2 env 优先）', () => {
  test('android → 模拟器宿主机 10.0.2.2 + localhost', () => {
    expect(defaultHosts('android')).toEqual(['10.0.2.2', 'localhost']);
  });

  test('ios → localhost（模拟器共享宿主机网络）', () => {
    expect(defaultHosts('ios')).toEqual(['localhost']);
  });

  test('other（真机/未知）→ 无默认（须 env EXPO_PUBLIC_ENGINE_URL 或手动输入）', () => {
    expect(defaultHosts('other')).toEqual([]);
  });

  test('extra 附加主机去重', () => {
    expect(defaultHosts('other', ['192.168.1.10', '192.168.1.10'])).toEqual([
      '192.168.1.10',
    ]);
    expect(defaultHosts('android', ['localhost'])).toEqual([
      '10.0.2.2',
      'localhost',
    ]);
  });
});

describe('selectEndpoint（探测结果纯选择逻辑）', () => {
  test('全不可达 → null（上层转离线/提示重新配对）', () => {
    expect(
      selectEndpoint([
        { wsUrl: 'wss://h:8765', reachable: false },
        { wsUrl: 'wss://h:8766', reachable: false },
      ])
    ).toBeNull();
  });

  test('有可达 → 取最小延迟（与输入顺序无关）', () => {
    const probes = [
      { wsUrl: 'wss://h:8766', reachable: true, latencyMs: 30 },
      { wsUrl: 'wss://h:8765', reachable: true, latencyMs: 12 },
      { wsUrl: 'wss://h:8767', reachable: false },
    ];
    expect(selectEndpoint(probes)?.wsUrl).toBe('wss://h:8765');
  });

  test('无可达延迟信息时保留首个可达', () => {
    const probes = [
      { wsUrl: 'wss://h:8766', reachable: true },
      { wsUrl: 'wss://h:8765', reachable: true },
    ];
    expect(selectEndpoint(probes)?.wsUrl).toBe('wss://h:8766');
  });
});

describe('resolveRelayUrl（中继构造与票据支持）', () => {
  test('占位接口可用（wss + 中继默认端口）', () => {
    expect(resolveRelayUrl('relay.crish.example')).toBe(
      `wss://relay.crish.example:${DEFAULT_RELAY_PORT}`
    );
    expect(resolveRelayUrl('relay.crish.example', 443)).toBe(
      'wss://relay.crish.example:443'
    );
  });

  test('携带 ticket 时追加 /relay 路径与查询参数', () => {
    expect(
      resolveRelayUrl('relay.flowbit.me', 443, true, 'tkt-123456')
    ).toBe('wss://relay.flowbit.me:443/relay?ticket=tkt-123456&role=client');
  });
});

describe('buildAuthenticatedWsUrl（安全注入鉴权参数）', () => {
  test('注入 token 参数', () => {
    expect(
      buildAuthenticatedWsUrl('wss://192.168.1.100:8765', { token: 'tok_abc' })
    ).toBe('wss://192.168.1.100:8765?token=tok_abc');
  });

  test('已有 query 参数时使用 & 连接', () => {
    expect(
      buildAuthenticatedWsUrl('wss://192.168.1.100:8765?v=1', { token: 'tok_abc' })
    ).toBe('wss://192.168.1.100:8765?v=1&token=tok_abc');
  });

  test('注入中继 ticket 和 role', () => {
    expect(
      buildAuthenticatedWsUrl('wss://relay.flowbit.me:443/relay', {
        ticket: 'tkt_xyz',
        role: 'client',
      })
    ).toBe('wss://relay.flowbit.me:443/relay?ticket=tkt_xyz&role=client');
  });
});
