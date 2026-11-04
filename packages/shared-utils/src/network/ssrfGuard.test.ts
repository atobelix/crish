import { describe, expect, it } from 'vitest';
import {
  isBlockedHostSuffix,
  isIpv4Reserved,
  isIpv6Reserved,
  isLocalHostname,
  isLoopbackIp,
  ipv6ToV4Mapped,
  parseIpv4,
  parseIpv6,
  validateSafeWebUrl,
} from './ssrfGuard';

describe('ssrfGuard - IPv4 解析与保留段门禁', () => {
  it('正确解析合法点分十进制 IPv4', () => {
    expect(parseIpv4('192.168.1.1')).toEqual([192, 168, 1, 1]);
    expect(parseIpv4('8.8.8.8')).toEqual([8, 8, 8, 8]);
    expect(parseIpv4('0.0.0.0')).toEqual([0, 0, 0, 0]);
    expect(parseIpv4('255.255.255.255')).toEqual([255, 255, 255, 255]);
  });

  it('严格拒绝格式非法与前导零八进制混淆', () => {
    expect(parseIpv4('1.2.3')).toBeNull();
    expect(parseIpv4('1.2.3.4.5')).toBeNull();
    expect(parseIpv4('256.1.1.1')).toBeNull();
    expect(parseIpv4('-1.0.0.1')).toBeNull();
    expect(parseIpv4('0177.0.0.1')).toBeNull(); // 前导 0 阻断
    expect(parseIpv4('192.168.01.1')).toBeNull();
    expect(parseIpv4('not-an-ip')).toBeNull();
  });

  it('准确判定 IPv4 保留段与内网段（对齐 Rust ip_class.rs）', () => {
    // 0.0.0.0/8
    expect(isIpv4Reserved('0.0.0.0')).toBe(true);
    expect(isIpv4Reserved('0.255.255.255')).toBe(true);

    // 10.0.0.0/8 (私有 A 类)
    expect(isIpv4Reserved('10.0.0.1')).toBe(true);
    expect(isIpv4Reserved('10.255.255.254')).toBe(true);

    // 100.64.0.0/10 (CGNAT 运营商级 NAT: 100.64.0.0 - 100.127.255.255)
    expect(isIpv4Reserved('100.64.0.1')).toBe(true);
    expect(isIpv4Reserved('100.100.50.25')).toBe(true);
    expect(isIpv4Reserved('100.127.255.255')).toBe(true);
    expect(isIpv4Reserved('100.63.255.255')).toBe(false);
    expect(isIpv4Reserved('100.128.0.0')).toBe(false);

    // 127.0.0.0/8 (回环)
    expect(isIpv4Reserved('127.0.0.1')).toBe(true);
    expect(isIpv4Reserved('127.255.255.255')).toBe(true);

    // 169.254.0.0/16 (链路本地 / 云元数据)
    expect(isIpv4Reserved('169.254.169.254')).toBe(true);
    expect(isIpv4Reserved('169.254.1.1')).toBe(true);
    expect(isIpv4Reserved('169.253.255.255')).toBe(false);
    expect(isIpv4Reserved('169.255.0.0')).toBe(false);

    // 172.16.0.0/12 (私有 B 类: 172.16.0.0 - 172.31.255.255)
    expect(isIpv4Reserved('172.16.0.1')).toBe(true);
    expect(isIpv4Reserved('172.24.1.1')).toBe(true);
    expect(isIpv4Reserved('172.31.255.255')).toBe(true);
    expect(isIpv4Reserved('172.15.255.255')).toBe(false);
    expect(isIpv4Reserved('172.32.0.0')).toBe(false);

    // 192.168.0.0/16 (私有 C 类)
    expect(isIpv4Reserved('192.168.0.1')).toBe(true);
    expect(isIpv4Reserved('192.168.1.1')).toBe(true);
    expect(isIpv4Reserved('192.168.255.255')).toBe(true);
    expect(isIpv4Reserved('192.167.255.255')).toBe(false);
    expect(isIpv4Reserved('192.169.0.0')).toBe(false);

    // 198.18.0.0/15 (基准测试段: 198.18.0.0 - 198.19.255.255)
    expect(isIpv4Reserved('198.18.0.1')).toBe(true);
    expect(isIpv4Reserved('198.19.255.255')).toBe(true);
    expect(isIpv4Reserved('198.17.255.255')).toBe(false);
    expect(isIpv4Reserved('198.20.0.0')).toBe(false);

    // 224.0.0.0/4 (组播) 与 240.0.0.0/4 (保留广播)
    expect(isIpv4Reserved('224.0.0.1')).toBe(true);
    expect(isIpv4Reserved('239.255.255.255')).toBe(true);
    expect(isIpv4Reserved('240.0.0.1')).toBe(true);
    expect(isIpv4Reserved('255.255.255.255')).toBe(true);

    // 公网正常 IP 放行
    expect(isIpv4Reserved('8.8.8.8')).toBe(false);
    expect(isIpv4Reserved('1.1.1.1')).toBe(false);
    expect(isIpv4Reserved('142.250.190.46')).toBe(false);
  });
});

describe('ssrfGuard - IPv6 解析与保留段门禁', () => {
  it('正确解析标准与压缩 IPv6 地址', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6('fc00::1')).toEqual([0xfc00, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('fe80::2')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 2]);
    expect(parseIpv6('2001:4860:4860::8888')).toEqual([
      0x2001, 0x4860, 0x4860, 0, 0, 0, 0, 0x8888,
    ]);
  });

  it('正确处理 IPv4 映射地址（::ffff:0:0/96）', () => {
    const segments = parseIpv6('::ffff:192.168.1.1');
    expect(segments).not.toBeNull();
    const mappedV4 = ipv6ToV4Mapped(segments!);
    expect(mappedV4).toEqual([192, 168, 1, 1]);
    expect(isIpv6Reserved(segments!)).toBe(true);

    const publicMapped = parseIpv6('::ffff:8.8.8.8');
    expect(publicMapped).not.toBeNull();
    expect(ipv6ToV4Mapped(publicMapped!)).toEqual([8, 8, 8, 8]);
    expect(isIpv6Reserved(publicMapped!)).toBe(false);
  });

  it('准确判定 IPv6 保留段', () => {
    // ::1 回环
    expect(isIpv6Reserved('::1')).toBe(true);
    expect(isIpv6Reserved('[::1]')).toBe(true);

    // fc00::/7 ULA
    expect(isIpv6Reserved('fc00::1')).toBe(true);
    expect(isIpv6Reserved('fd12:3456:789a::1')).toBe(true);

    // fe80::/10 链路本地
    expect(isIpv6Reserved('fe80::1')).toBe(true);
    expect(isIpv6Reserved('febf:ffff::1')).toBe(true);

    // ff00::/8 组播
    expect(isIpv6Reserved('ff02::1')).toBe(true);

    // 公网合法 IPv6 放行
    expect(isIpv6Reserved('2001:4860:4860::8888')).toBe(false);
    expect(isIpv6Reserved('2606:4700:4700::1111')).toBe(false);
  });
});

describe('ssrfGuard - 回环与本地主机名判定', () => {
  it('识别各类回环 IP', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true);
    expect(isLoopbackIp('127.1.2.3')).toBe(true);
    expect(isLoopbackIp('::1')).toBe(true);
    expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackIp('192.168.1.1')).toBe(false);
    expect(isLoopbackIp('8.8.8.8')).toBe(false);
  });

  it('识别本地主机名与被阻断私有后缀', () => {
    expect(isLocalHostname('localhost')).toBe(true);
    expect(isLocalHostname('localhost.localdomain')).toBe(true);
    expect(isLocalHostname('app.localhost')).toBe(true);
    expect(isLocalHostname('google.com')).toBe(false);

    expect(isBlockedHostSuffix('router.local')).toBe(true);
    expect(isBlockedHostSuffix('metadata.internal')).toBe(true);
    expect(isBlockedHostSuffix('nas.lan')).toBe(true);
    expect(isBlockedHostSuffix('myhost.localdomain')).toBe(true);
    expect(isBlockedHostSuffix('github.com')).toBe(false);
  });
});

describe('ssrfGuard - validateSafeWebUrl 综合端到端安全校验', () => {
  it('阻断十进制/十六进制/八进制纯数字与畸形 IP 变形', () => {
    // 十进制整数 IP: 2130706433 即 127.0.0.1
    const resDecimal = validateSafeWebUrl('http://2130706433/');
    expect(resDecimal.isSafe).toBe(false);
    expect(resDecimal.safe).toBe(false);
    expect(resDecimal.reason).toContain('十进制纯数字 IP 变形');

    // 十六进制 IP
    const resHex = validateSafeWebUrl('http://0x7f000001/');
    expect(resHex.isSafe).toBe(false);
    expect(resHex.reason).toContain('十六进制 IP 变形');

    // 八进制 IP
    const resOctal = validateSafeWebUrl('http://017700000001/');
    expect(resOctal.isSafe).toBe(false);
    expect(resOctal.reason).toContain('八进制 IP 变形');

    // 点分前导零
    const resLeadingZero = validateSafeWebUrl('http://0177.0.0.1/');
    expect(resLeadingZero.isSafe).toBe(false);
    expect(resLeadingZero.reason).toContain('前导零或八进制');

    // 缩写 IP (如 127.1)
    const resShortened = validateSafeWebUrl('http://127.1/');
    expect(resShortened.isSafe).toBe(false);
    expect(resShortened.reason).toContain('非标准缩写 IP 格式');
  });

  it('刚性阻断内网 IPv4 与保留段', () => {
    const urls = [
      'http://192.168.1.1/admin',
      'http://10.0.0.1/private',
      'http://172.16.0.1/dashboard',
      'http://169.254.169.254/latest/meta-data',
      'http://100.64.0.1/cgnat',
      'http://198.18.0.1/benchmark',
      'http://0.0.0.0/',
    ];

    for (const url of urls) {
      const res = validateSafeWebUrl(url);
      expect(res.isSafe, `URL ${url} 应当被阻断`).toBe(false);
      expect(res.reason).toContain('私有内网或保留 IPv4 段');
    }
  });

  it('刚性阻断内网 IPv6 与保留段', () => {
    const urls = [
      'http://[fc00::1]/admin',
      'http://[fe80::1]/test',
      'http://[::ffff:192.168.1.1]/gateway',
      'http://[::ffff:10.0.0.1]/',
      'http://[ff02::1]/',
    ];

    for (const url of urls) {
      const res = validateSafeWebUrl(url);
      expect(res.isSafe, `IPv6 URL ${url} 应当被阻断`).toBe(false);
    }
  });

  it('默认阻断回环地址，但支持 allowLoopback 放行', () => {
    // 默认阻断
    expect(validateSafeWebUrl('http://127.0.0.1:8080/').isSafe).toBe(false);
    expect(validateSafeWebUrl('http://[::1]:3000/').isSafe).toBe(false);
    expect(validateSafeWebUrl('http://localhost:5173/').isSafe).toBe(false);

    // 显式允许回环
    const safeV4 = validateSafeWebUrl('http://127.0.0.1:8080/', {
      allowLoopback: true,
    });
    expect(safeV4.isSafe).toBe(true);
    expect(safeV4.normalizedUrl).toBe('http://127.0.0.1:8080/');

    const safeV6 = validateSafeWebUrl('http://[::1]:3000/', {
      allowLoopback: true,
    });
    expect(safeV6.isSafe).toBe(true);

    const safeHost = validateSafeWebUrl('http://localhost:5173/', {
      allowLoopback: true,
    });
    expect(safeHost.isSafe).toBe(true);
  });

  it('阻断局域网与内部主机名后缀（.local, .internal, .lan）', () => {
    expect(validateSafeWebUrl('http://printer.local/').isSafe).toBe(false);
    expect(validateSafeWebUrl('http://service.internal/api').isSafe).toBe(
      false
    );
    expect(validateSafeWebUrl('http://nas.lan/').isSafe).toBe(false);
  });

  it('阻断内联用户凭据', () => {
    const res = validateSafeWebUrl('https://admin:password123@google.com/');
    expect(res.isSafe).toBe(false);
    expect(res.reason).toContain('凭据');
  });

  it('严格执行协议白名单', () => {
    expect(validateSafeWebUrl('javascript:alert(1)').isSafe).toBe(false);
    expect(validateSafeWebUrl('data:text/html,<h1>test</h1>').isSafe).toBe(
      false
    );
    expect(validateSafeWebUrl('file:///etc/passwd').isSafe).toBe(false);
    expect(validateSafeWebUrl('ftp://ftp.example.com/').isSafe).toBe(false);

    // 自定义允许协议
    const res = validateSafeWebUrl('ftp://ftp.example.com/', {
      allowedProtocols: ['ftp:'],
    });
    expect(res.isSafe).toBe(true);
  });

  it('支持域名黑名单与白名单策略', () => {
    // 黑名单拦截
    const blockedRes = validateSafeWebUrl(
      'https://malicious.example.com/test',
      {
        blocklist: ['*.example.com'],
      }
    );
    expect(blockedRes.isSafe).toBe(false);
    expect(blockedRes.reason).toContain('黑名单');

    // 白名单放行与未命中阻断
    const allowedRes = validateSafeWebUrl('https://api.github.com/repos', {
      allowlist: ['*.github.com'],
    });
    expect(allowedRes.isSafe).toBe(true);

    const rejectedRes = validateSafeWebUrl('https://google.com/search', {
      allowlist: ['*.github.com'],
    });
    expect(rejectedRes.isSafe).toBe(false);
    expect(rejectedRes.reason).toContain('白名单');
  });

  it('对公网合法 URL 顺利放行并输出规范化信息', () => {
    const res1 = validateSafeWebUrl('https://www.google.com/search?q=test');
    expect(res1.isSafe).toBe(true);
    expect(res1.safe).toBe(true);
    expect(res1.hostname).toBe('www.google.com');
    expect(res1.normalizedUrl).toBe('https://www.google.com/search?q=test');

    const res2 = validateSafeWebUrl('https://8.8.8.8/dns-query');
    expect(res2.isSafe).toBe(true);
    expect(res2.hostname).toBe('8.8.8.8');

    const res3 = validateSafeWebUrl('https://[2001:4860:4860::8888]/');
    expect(res3.isSafe).toBe(true);
    expect(res3.hostname).toBe('[2001:4860:4860::8888]');
  });
});
