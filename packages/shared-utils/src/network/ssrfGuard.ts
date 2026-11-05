/**
 * packages/shared-utils/src/network/ssrfGuard.ts
 *
 * 纯 TypeScript 编写的 SSRF 门禁防御纯函数。
 * 100% 对齐 Rust crates/conex-browser-tools/src/gate/ip_class.rs 与 pattern.rs。
 * 零第三方依赖，纯位运算与字符串解析。
 */

export interface SafeUrlCheckOptions {
  /** 是否允许回环地址（127.0.0.1 / ::1 / localhost 等），本地测试模式下可置为 true */
  readonly allowLoopback?: boolean | undefined;
  /** 允许的协议，缺省仅允许 ['http:', 'https:'] */
  readonly allowedProtocols?: readonly string[] | undefined;
  /** 域名白名单（命中直接放行） */
  readonly allowlist?: readonly string[] | undefined;
  /** 域名黑名单（命中绝对阻断） */
  readonly blocklist?: readonly string[] | undefined;
}

export interface SafeUrlCheckResult {
  readonly isSafe: boolean;
  /** 兼容性字段，与 isSafe 保持相同布尔值 */
  readonly safe: boolean;
  readonly reason?: string | undefined;
  readonly normalizedUrl?: string | undefined;
  readonly hostname?: string | undefined;
}

/**
 * 解析 IPv4 点分十进制字符串为 4 字节元组，非法格式返回 null。
 * 严格拒绝前导零（防八进制解析混淆与绕过）。
 */
export function parseIpv4(ip: string): [number, number, number, number] | null {
  const clean = ip.trim();
  const parts = clean.split('.');
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) {
      // 拒绝前导 0，防八进制绕过解析
      return null;
    }
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }

  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/**
 * 判定 IPv4 是否属于保留或内网段（对齐 crates/conex-browser-tools/src/gate/ip_class.rs:6-19）：
 * - 0.0.0.0/8（本网络/保留段）
 * - 127.0.0.0/8（回环）
 * - 10.0.0.0/8（私有 A 类）
 * - 169.254.0.0/16（链路本地 Link-Local，AWS/GCP 云元数据）
 * - 172.16.0.0/12（私有 B 类 172.16.0.0 - 172.31.255.255）
 * - 192.168.0.0/16（私有 C 类）
 * - 100.64.0.0/10（CGNAT 运营商级 NAT 100.64.0.0 - 100.127.255.255）
 * - 198.18.0.0/15（基准测试段 198.18.0.0 - 198.19.255.255）
 * - 224.0.0.0/4（组播段 224.0.0.0 - 239.255.255.255）
 * - 240.0.0.0/4（保留/广播段 240.0.0.0 - 255.255.255.255）
 */
export function isIpv4Reserved(
  ip: string | [number, number, number, number]
): boolean {
  const octets = typeof ip === 'string' ? parseIpv4(ip) : ip;
  if (!octets) return false;

  const [a, b] = octets;
  return (
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 169 && b === 254) ||
    (a === 172 && (b & 0xf0) === 16) || // 16..=31
    (a === 192 && b === 168) ||
    (a === 100 && (b & 0xc0) === 64) || // 64..=127
    (a === 198 && (b & 0xfe) === 18) || // 18..=19
    a >= 224 // 224.0.0.0/4 组播与 240.0.0.0/4 保留广播段
  );
}

/**
 * 解析 IPv6 地址为 8 个 16 位整数元组（segments），非法返回 null。
 * 兼容 :: 缩写以及末尾内嵌的 IPv4 映射（::ffff:192.168.1.1）。
 */
export function parseIpv6(
  ip: string
): [number, number, number, number, number, number, number, number] | null {
  let clean = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!clean) return null;

  // 1. 处理末尾内嵌 IPv4 映射段（如 ::ffff:192.168.1.1）
  const lastColon = clean.lastIndexOf(':');
  if (lastColon !== -1) {
    const after = clean.slice(lastColon + 1);
    if (after.includes('.')) {
      const v4 = parseIpv4(after);
      if (!v4) return null;
      const w6 = (((v4[0] << 8) | v4[1]) >>> 0).toString(16);
      const w7 = (((v4[2] << 8) | v4[3]) >>> 0).toString(16);
      clean = clean.slice(0, lastColon) + ':' + w6 + ':' + w7;
    }
  }

  // 2. 处理双冒号 :: 展开
  const doubleColonIdx = clean.indexOf('::');
  let hexParts: string[];

  if (doubleColonIdx !== -1) {
    if (clean.indexOf('::', doubleColonIdx + 2) !== -1) {
      // 出现多个 :: 非法
      return null;
    }
    const leftStr = clean.slice(0, doubleColonIdx);
    const rightStr = clean.slice(doubleColonIdx + 2);
    const left = leftStr.length > 0 ? leftStr.split(':') : [];
    const right = rightStr.length > 0 ? rightStr.split(':') : [];

    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    const mid = new Array<string>(missing).fill('0');
    hexParts = [...left, ...mid, ...right];
  } else {
    hexParts = clean.split(':');
  }

  if (hexParts.length !== 8) return null;

  const segments: number[] = [];
  for (const part of hexParts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    segments.push(parseInt(part, 16));
  }

  return [
    segments[0]!,
    segments[1]!,
    segments[2]!,
    segments[3]!,
    segments[4]!,
    segments[5]!,
    segments[6]!,
    segments[7]!,
  ];
}

/**
 * 提取 IPv6 中的 IPv4 映射段目标（::ffff:0:0/96）
 * 对齐 ip_class.rs:53-65 v4_mapped_of。
 */
export function ipv6ToV4Mapped(
  segments: [number, number, number, number, number, number, number, number]
): [number, number, number, number] | null {
  if (
    segments[0] === 0 &&
    segments[1] === 0 &&
    segments[2] === 0 &&
    segments[3] === 0 &&
    segments[4] === 0 &&
    segments[5] === 0xffff
  ) {
    const s6 = segments[6];
    const s7 = segments[7];
    return [(s6 >> 8) & 0xff, s6 & 0xff, (s7 >> 8) & 0xff, s7 & 0xff];
  }
  return null;
}

/**
 * 判定 IPv6 是否属于保留或内网段（对齐 ip_class.rs:21-25）：
 * - ::1（回环）与 ::（未指定）
 * - fc00::/7（唯一本地地址 ULA，涵盖 fc00:: 至 fdff:...）
 * - fe80::/10（链路本地 Link-Local，涵盖 fe80:: 至 febf:...）
 * - ::ffff:0:0/96（IPv4 映射地址，解包后递归判定 IPv4 保留段）
 * - ff00::/8（组播地址）
 */
export function isIpv6Reserved(
  ip: string | [number, number, number, number, number, number, number, number]
): boolean {
  const segments = typeof ip === 'string' ? parseIpv6(ip) : ip;
  if (!segments) return false;

  const [w0, w1, w2, w3, w4, w5, w6, w7] = segments;

  // 1. ::1 回环或 :: 未指定
  const allZeroExceptLast =
    w0 === 0 &&
    w1 === 0 &&
    w2 === 0 &&
    w3 === 0 &&
    w4 === 0 &&
    w5 === 0 &&
    w6 === 0;
  if (allZeroExceptLast && (w7 === 1 || w7 === 0)) {
    return true;
  }

  // 2. fc00::/7 (ULA 唯一本地地址, 涵盖 fc00..=fdff)
  if ((w0 & 0xfe00) === 0xfc00) {
    return true;
  }

  // 3. fe80::/10 (链路本地地址, 涵盖 fe80..=febf)
  if ((w0 & 0xffc0) === 0xfe80) {
    return true;
  }

  // 4. ff00::/8 (组播)
  if ((w0 & 0xff00) === 0xff00) {
    return true;
  }

  // 5. ::ffff:0:0/96 IPv4 映射地址
  const mappedV4 = ipv6ToV4Mapped(segments);
  if (mappedV4) {
    return isIpv4Reserved(mappedV4);
  }

  return false;
}

/**
 * 本机回环 IP 判定（对齐 ip_class.rs:38-45）
 * - IPv4: 127.0.0.0/8
 * - IPv6: ::1
 * - IPv4-mapped: ::ffff:127.x.x.x
 */
export function isLoopbackIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) {
    return v4[0] === 127;
  }

  const v6 = parseIpv6(ip);
  if (v6) {
    const isV6Loopback =
      v6[0] === 0 &&
      v6[1] === 0 &&
      v6[2] === 0 &&
      v6[3] === 0 &&
      v6[4] === 0 &&
      v6[5] === 0 &&
      v6[6] === 0 &&
      v6[7] === 1;
    if (isV6Loopback) return true;

    const mappedV4 = ipv6ToV4Mapped(v6);
    if (mappedV4 && mappedV4[0] === 127) {
      return true;
    }
  }

  return false;
}

/**
 * 本机主机名判定（对齐 ip_class.rs:48-50）
 * localhost 及其常见变体
 */
export function isLocalHostname(host: string): boolean {
  const h = host.toLowerCase().trim();
  return (
    h === 'localhost' ||
    h === 'localhost.localdomain' ||
    h === 'localhost.local' ||
    h.endsWith('.localhost')
  );
}

/**
 * 阻断局域网与内部 DNS 顶级后缀
 * - .local (mDNS / Bonjour)
 * - .internal (云厂商/局域网私有解析)
 * - .lan
 * - .localdomain
 */
export function isBlockedHostSuffix(host: string): boolean {
  const h = host.toLowerCase().trim();
  return (
    h === 'local' ||
    h.endsWith('.local') ||
    h === 'internal' ||
    h.endsWith('.internal') ||
    h === 'lan' ||
    h.endsWith('.lan') ||
    h.endsWith('.localdomain')
  );
}

/**
 * 提取 URL 中协议后、第一个 '/'、'?'、'#' 之前的原始 host 文本
 * 用于在 URL 解析器将其自动规范化之前拦截非标准 IP 变形。
 */
function extractRawHost(url: string): string | null {
  const m = url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
  if (!m || !m[1]) return null;

  let auth = m[1];
  const atIdx = auth.lastIndexOf('@');
  if (atIdx !== -1) {
    auth = auth.slice(atIdx + 1);
  }

  // 处理 IPv6 中括弧字面量
  if (auth.startsWith('[')) {
    const bracketEnd = auth.indexOf(']');
    return bracketEnd !== -1 ? auth.slice(0, bracketEnd + 1) : auth;
  }

  // 处理端口
  const colonIdx = auth.indexOf(':');
  return colonIdx !== -1 ? auth.slice(0, colonIdx) : auth;
}

/**
 * 域名通配模式匹配器（对齐 pattern.rs）
 * 支持 '*'、'*.example.com' 与精确全等。
 */
function matchHostPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase().trim();
  const p = pattern.toLowerCase().trim();
  if (p === '*' || p === '**') return true;
  if (p.startsWith('*.')) {
    const root = p.slice(2);
    return h === root || h.endsWith('.' + root);
  }
  return h === p;
}

/**
 * 综合安全 Web URL 校验器（纯函数，跨端安全第一道刚性防线）
 *
 * 阻断规则矩阵：
 * 1. 协议白名单门禁：缺省仅允许 http: 与 https:
 * 2. 凭据阻断：禁止 user:pass@ 形式内联凭据防钓鱼
 * 3. 非标准变形 IP 阻断：十进制整数、十六进制、八进制、带前导零、缩写 IP
 * 4. 内网与保留 IPv4 阻断（含 CGNAT 100.64/10、基准 198.18/15、链路本地 169.254/16）
 * 5. 内网与保留 IPv6 阻断（含 ULA fc00::/7、链路本地 fe80::/10、::ffff:0:0/96 映射）
 * 6. 本地主机名阻断：localhost 族（可在 allowLoopback 时放行）
 * 7. 局域网后缀阻断：.local、.internal、.lan
 * 8. 黑白名单策略执行（黑名单优先阻断）
 */
export function validateSafeWebUrl(
  rawUrl: string,
  options: SafeUrlCheckOptions = {}
): SafeUrlCheckResult {
  const allowedProtocols = options.allowedProtocols ?? ['http:', 'https:'];
  const allowLoopback = options.allowLoopback ?? false;

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { isSafe: false, safe: false, reason: 'URL 不能为空' };
  }

  // 1. 原始 Host 格式变形检查（在被 WHATWG URL 规范化前拦截）
  const rawHost = extractRawHost(trimmed);
  if (rawHost) {
    // 拦截十六进制 IP（如 http://0x7f000001/）
    if (/^0x[0-9a-fA-F]+$/i.test(rawHost)) {
      return {
        isSafe: false,
        safe: false,
        reason: `禁止使用十六进制 IP 变形: ${rawHost}`,
      };
    }
    // 拦截八进制 IP（如 http://017700000001/，多于 1 位且以 0 开头）
    if (/^0[0-7]+$/.test(rawHost) && rawHost.length > 1) {
      return {
        isSafe: false,
        safe: false,
        reason: `禁止使用八进制 IP 变形: ${rawHost}`,
      };
    }
    // 拦截十进制纯数字 IP（如 http://2130706433/ 即 127.0.0.1）
    if (/^\d+$/.test(rawHost)) {
      return {
        isSafe: false,
        safe: false,
        reason: `禁止使用十进制纯数字 IP 变形: ${rawHost}`,
      };
    }
    // 拦截点分 IP 中含有前导零（八进制混淆）
    if (/^(\d+\.){1,3}\d+$/.test(rawHost)) {
      const parts = rawHost.split('.');
      if (parts.length < 4) {
        return {
          isSafe: false,
          safe: false,
          reason: `禁止使用非标准缩写 IP 格式: ${rawHost}`,
        };
      }
      for (const p of parts) {
        if (p.length > 1 && p.startsWith('0')) {
          return {
            isSafe: false,
            safe: false,
            reason: `禁止在 IP 地址中使用前导零或八进制表示法: ${rawHost}`,
          };
        }
      }
    }
  }

  // 2. URL 结构解析
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    return {
      isSafe: false,
      safe: false,
      reason: `URL 格式无效: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 3. 协议检查
  if (!allowedProtocols.includes(parsed.protocol)) {
    return {
      isSafe: false,
      safe: false,
      reason: `协议受限: 仅允许 ${allowedProtocols.join(', ')}，收到 ${parsed.protocol}`,
    };
  }

  // 4. 禁止内联用户名或密码凭证（防钓鱼混淆）
  if (parsed.username || parsed.password) {
    return {
      isSafe: false,
      safe: false,
      reason: '禁止在 URL 中包含用户名或密码凭据',
    };
  }

  const hostname = parsed.hostname.toLowerCase().trim();
  if (!hostname) {
    return {
      isSafe: false,
      safe: false,
      reason: 'URL 缺少有效主机名',
    };
  }

  // 5. 黑名单优先检查
  if (options.blocklist && options.blocklist.length > 0) {
    for (const blocked of options.blocklist) {
      if (matchHostPattern(hostname, blocked)) {
        return {
          isSafe: false,
          safe: false,
          reason: `域名命中黑名单: ${hostname}`,
          hostname,
        };
      }
    }
  }

  // 6. 白名单显式命中（若命中则直接放行）
  if (options.allowlist && options.allowlist.length > 0) {
    const hitAllowlist = options.allowlist.some((allowed) =>
      matchHostPattern(hostname, allowed)
    );
    if (hitAllowlist) {
      return {
        isSafe: true,
        safe: true,
        normalizedUrl: parsed.href,
        hostname,
      };
    }
    return {
      isSafe: false,
      safe: false,
      reason: `域名不在白名单允许面: ${hostname}`,
      hostname,
    };
  }

  // 7. 本机回环主机名检查（localhost 族）
  if (isLocalHostname(hostname)) {
    if (allowLoopback) {
      return {
        isSafe: true,
        safe: true,
        normalizedUrl: parsed.href,
        hostname,
      };
    }
    return {
      isSafe: false,
      safe: false,
      reason: `禁止访问本机回环主机名: ${hostname}`,
      hostname,
    };
  }

  // 8. 内部局域网域名后缀检查（.local, .internal, .lan）
  if (isBlockedHostSuffix(hostname)) {
    return {
      isSafe: false,
      safe: false,
      reason: `禁止访问内部局域网或私有域名: ${hostname}`,
      hostname,
    };
  }

  // 9. IPv4 字面量判定与保留段阻断
  const v4Octets = parseIpv4(hostname);
  if (v4Octets) {
    if (isLoopbackIp(hostname)) {
      if (allowLoopback) {
        return {
          isSafe: true,
          safe: true,
          normalizedUrl: parsed.href,
          hostname,
        };
      }
      return {
        isSafe: false,
        safe: false,
        reason: `禁止访问本机回环 IP: ${hostname}`,
        hostname,
      };
    }
    if (isIpv4Reserved(v4Octets)) {
      return {
        isSafe: false,
        safe: false,
        reason: `禁止访问私有内网或保留 IPv4 段: ${hostname}`,
        hostname,
      };
    }
    return {
      isSafe: true,
      safe: true,
      normalizedUrl: parsed.href,
      hostname,
    };
  }

  // 10. IPv6 字面量判定与保留段阻断
  if (hostname.includes(':')) {
    const v6Clean = hostname.replace(/^\[|\]$/g, '');
    const v6Segments = parseIpv6(v6Clean);
    if (!v6Segments) {
      return {
        isSafe: false,
        safe: false,
        reason: `非法 IPv6 字面量: ${hostname}`,
        hostname,
      };
    }

    if (isLoopbackIp(v6Clean)) {
      if (allowLoopback) {
        return {
          isSafe: true,
          safe: true,
          normalizedUrl: parsed.href,
          hostname,
        };
      }
      return {
        isSafe: false,
        safe: false,
        reason: `禁止访问本机回环 IPv6: ${hostname}`,
        hostname,
      };
    }

    if (isIpv6Reserved(v6Segments)) {
      const isV4Mapped = ipv6ToV4Mapped(v6Segments) !== null;
      return {
        isSafe: false,
        safe: false,
        reason: isV4Mapped
          ? `禁止访问私有内网或保留 IPv6 段 (IPv4 映射): ${hostname}`
          : `禁止访问私有内网或保留 IPv6 段: ${hostname}`,
        hostname,
      };
    }

    return {
      isSafe: true,
      safe: true,
      normalizedUrl: parsed.href,
      hostname,
    };
  }

  // 11. 普通合法公网域名放行
  return {
    isSafe: true,
    safe: true,
    normalizedUrl: parsed.href,
    hostname,
  };
}

/**
 * 别名：统一对外暴露 `validateSafeUrl`，对齐移动端与桌面端调用契约。
 */
export const validateSafeUrl = validateSafeWebUrl;
