# DNS Rebinding 防护评估

## 1. 风险分析

### baseUrl 来源

Conex 的 `baseUrl` 来自以下渠道：

| 来源 | 说明 | 示例 |
|------|------|------|
| **用户配置** | 通过 `GatewayV2Bridge` 传入的 `credential.baseUrl`，或 Provider Factory 的 `credential` 参数 | `provider-gateway-v2.ts:51`, `factory.ts:50` |
| **声明式 JSON** | `DeclarativeLoader` 从 `builtin/providers/` 加载的 `.json` 文件，包含 `defaultBaseUrl` | `loader.ts:61` |
| **API 发现** | `CredentialResolver` 返回的 `baseUrl` 字段 | `provider-gateway.ts:437-438` |
| **CLI 参数** | `provider-validate.ts`, `provider-test.ts` 直接传入的 baseUrl | `provider-validate.ts:33` |
| **AuthMethod 桥接** | `authMethodToCredentialSource()` 从 `AuthMethod` 对象解析 baseUrl | `provider-gateway-v2.ts:57` |

### DNS rebinding 对 Conex 的实际威胁级别：**中**

攻击场景：

1. **攻击者控制域名**（如 `malicious-provider.example`），该域名在 DNS 中配置了极短的 TTL
2. 第一阶段：域名解析到公共 IP（如 `1.2.3.4`），通过 `validateBaseUrl()` 校验
3. 用户配置该域名为 provider 的 `baseUrl`
4. 第二阶段：攻击者修改 DNS 记录，指向内网 IP（如 `10.0.0.1`）
5. 受害者的 Conex 实例在后续请求中重新解析域名，连接到内网服务

威胁评估：

- **攻击面有限**：攻击者需要控制域名或能操纵 DNS 响应。Conex 用户通常使用知名的 AI provider（OpenAI, Anthropic, Gemini），这些域名受攻击者控制的可能性极低
- **本地网络风险**：攻击者若已获得中间人位置（如公共 Wi-Fi），可通过伪造 DNS 响应实现 rebinding
- **云环境 SSRF 升级**：在 CI/CD 或云环境中运行的 Conex 实例若配置了自定义 provider，DNS rebinding 可被用于访问云 metadata 服务（`169.254.169.254`）

### 攻击利用路径

```
用户配置 baseUrl → validateBaseUrl() 通过 → HTTP 请求发送前
DNS 重新解析 → 域名指向私有 IP → reqwest/fetch 连接内网
```

## 2. 当前防护

### `validateBaseUrl()` 工作方式

```typescript
// base-url-validator.ts:35
export function validateBaseUrl(urlString: string): ValidationResult
```

- 解析 URL，提取 hostname
- 将 hostname 与 `FORBIDDEN_HOSTNAMES` 列表字符串比较
- 将 hostname 与 `PRIVATE_IP_PATTERNS` / `PRIVATE_IPV6_PATTERNS` 正则匹配
- 在校验通过后，URL 作为 `baseUrl` 传入 engine 层，最终通过 `reqwest::Client`（Rust）或 `fetch`（TypeScript）发起 HTTP 请求

调用链：

- `factory.ts:51` — Provider 创建时单次校验
- `provider-gateway.ts:438, 468` — Credential 解析后校验
- `provider-gateway-v2.ts:70` — GatewayV2 桥接校验
- `provider-validate.ts:33` — CLI 校验

### 为什么字符串比较不防御 DNS rebinding

`validateBaseUrl()` 是**配置时校验**，仅分析 URL 字符串本身：

- 不发起 DNS 查询
- 不建立 TCP 连接
- 不检查实际连接的对端 IP

它假设 hostname 字符串包含了所有必要信息来判断目标是否合法。DNS rebinding 的核心攻击向量正是利用**域名解析结果的变化**来绕过这种假设：

```
配置时：域名 → 1.2.3.4（公共 IP） → validateBaseUrl 通过
请求时：域名 → 10.0.0.1（私有 IP） → 直连内网
```

此外，`reqwest::Client`（Rust 侧）在 `agent-provider-http/src/main.rs:98` 通过 `client.request(method, url)` 发起请求，DNS 解析由 reqwest 内部自动完成（使用系统 DNS），Conex 不干预解析过程。TypeScript 侧的 `fetch` 同样依赖 Node.js 运行时/DNS 解析。

## 3. 可选防护方案

### 方案 A: 连接后 IP 验证（推荐）

在 TCP 连接建立后、HTTPS 请求发送前，获取实际连接的对端 IP，与私有 IP 规则比较。

**Rust reqwest 实现方式**：

reqwest 0.12 默认不暴露底层 socket 的 peer IP。可通过以下方式实现：

- 使用 `TcpStream::connect()` + `peer_addr()` 先建立 TCP 连接，检查 IP，再将连接传递给 reqwest 的自定义 `Connector`
- 或使用 `tokio::net::TcpStream` 配合 `HttpsConnector::from()` 构建自定义 connector
- 或利用 reqwest 的 `Client::builder().dns_resolver()` 在 DNS 解析时记录并校验 IP

```rust
// 伪代码 — reqwest 自定义 Connector
async fn check_peer_ip(url: &str) -> Result<()> {
    let host = url.host_str().unwrap();
    let port = url.port_or_known_default().unwrap_or(443);
    let stream = TcpStream::connect((host, port)).await?;
    let addr = stream.peer_addr()?;
    if is_private_ip(&addr.ip()) {
        return Err(SSRF);
    }
    // 将 stream 传递给 reqwest 继续 TLS 握手
}
```

**TypeScript fetch 实现方式**：

标准 `fetch` API 不暴露底层连接信息。需使用：

- `node:dns` 模块的 `resolve4()`/`resolve6()` 在请求前手动解析 DNS
- 将解析结果与私有 IP 规则比较
- 用 resolved IP 替换 hostname 发起请求（需处理 TLS SNI 问题）
- 或使用 Node.js 的 `net.connect()` + `tls.connect()` 手动管理连接

```typescript
// 伪代码 — fetch 前预检 IP
import { resolve4 } from "node:dns/promises";

async function validateResolvedIp(hostname: string): Promise<void> {
    const ips = await resolve4(hostname);
    for (const ip of ips) {
        if (isPrivateIp(ip)) throw new Error("SSRF");
    }
}
```

**优点**：
- 直接防御 DNS rebinding 的核心攻击向量
- 即使在 DNS 结果变化的情况下也能拦截
- 兼容现有 `validateBaseUrl()` 的地址校验逻辑（可复用 IP 模式）

**缺点**：
- 需要修改 HTTP 客户端层（Rust reqwest Connector 或 TypeScript fetch wrapper）
- 增加了 DNS 查询 + IP 校验的延迟（约 5-50ms）
- 自定义 Connector 方案复杂度较高

### 方案 B: DNS 解析缓存

将域名与首次 DNS 解析结果绑定，后续请求使用缓存 IP 而非重新解析。

**实现方式**：

```rust
// 伪代码 — reqwest Client 级 DNS 缓存
let client = reqwest::Client::builder()
    .dns_resolver(my_cached_resolver)
    .build()?;
```

- 在 `agent-provider-http/src/main.rs` 构建 `reqwest::Client` 时注入自定义 `DnsResolver`
- 在 TypeScript 侧使用 `node:dns` 手动解析并缓存，然后用 IP 直连

**优点**：
- 实现较简单（修改 Rust 侧的 Client 构建）
- 不影响正常请求的延迟

**缺点**：
- 不完全防御：攻击者如果在第一次 DNS 解析时即返回私有 IP（未使用 validateBaseUrl 时），缓存机制无法区分
- 对合法的 DNS 轮询/故障转移会有影响（域名解析结果可能合法变化）
- reqwest 0.12 的 `dns_resolver()` API 仍在演进，跨版本兼容性需关注

### 方案 C: HTTP 代理 + 固定解析

强制所有 provider 请求通过一个内部 DNS 代理解析，该代理只返回公共 IP 或拒绝私有 IP。

**实现方式**：

- 运行一个 `dnsmasq` 或 `trust-dns` 实例，配置为过滤私有 IP 的响应
- Conex 的 HTTP 客户端配置为使用该代理进行 DNS 解析（`AGENT_PROVIDER_HTTP_COMMAND` 环境变量或自定义 fetch 实现）

**优点**：
- 彻底：在网络层拦截所有私有 IP 连接
- 独立于 Conex 代码变更

**缺点**：
- 需要额外基础设施（DNS 代理进程）
- 增加部署复杂性，尤其在 CI/CD 或无特权容器中
- 对用户体验影响大：用户需要配置系统 DNS 或代理

## 4. 推荐实现方案

选择**方案 A（连接后 IP 验证）**，并分两个阶段实施。

### 阶段 1：DNS 预检（短期，低侵入）

在 `validateBaseUrl()` 基础上增加 DNS 解析检查：

```typescript
// 扩展 validateBaseUrl()，新增 resolve 模式
export async function validateBaseUrlResolved(urlString: string): Promise<ValidationResult> {
    const staticCheck = validateBaseUrl(urlString);
    if (!staticCheck.valid) return staticCheck;

    const parsed = new URL(urlString);
    const hostname = parsed.hostname;

    // 如果已经是 IP 字面量，无需 DNS 检查
    if (isIPAddress(hostname)) return staticCheck;

    // DNS 解析并校验解析结果
    const ips = await resolveHostname(hostname);
    for (const ip of ips) {
        if (isPrivateIP(ip)) {
            return { valid: false, error: `Resolved private IP: ${ip}` };
        }
    }
    return { valid: true };
}
```

**集成到 `fetchWithRetry`**：

```typescript
// factory.ts 中 fetchWithRetry 调用前
export async function fetchWithRetry(url: string, init: RequestInit & { timeoutMs?: number }, signal: AbortSignal): Promise<Response> {
    const parsed = new URL(url);
    if (parsed.hostname) {
        const result = await validateBaseUrlResolved(url);
        if (!result.valid) throw new ProviderError(result.error, "SSRF", false);
    }
    // ... 现有 fetch 逻辑
}
```

### 阶段 2：Rust 侧 Connector 拦截（长期，彻底）

在 `agent-provider-http/src/main.rs` 中集成连接后 IP 检查：

```rust
// agent-provider-http — 自定义 TCP connector
use reqwest::dns::{Addrs, DnsResolver, Name, Resolve};
use std::net::SocketAddr;
use tokio::net::TcpStream;

struct SsrfAwareResolver;

impl DnsResolver for SsrfAwareResolver {
    fn resolve(&self, name: Name) -> Resolve {
        let resolver = reqwest::dns::System::default();
        let addrs = resolver.resolve(name.clone());
        Box::pin(async move {
            let addrs = addrs.await?;
            let filtered: Vec<SocketAddr> = addrs
                .filter(|addr| !is_private_ip(addr.ip()))
                .collect();
            if filtered.is_empty() {
                Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "SSRF: all resolved IPs are private",
                )) as Box<dyn std::error::Error + Send + Sync>)
            } else {
                Ok(Box::new(filtered.into_iter()) as Box<dyn Iterator<Item = SocketAddr> + Send>)
            }
        })
    }
}
```

### 性能影响估计

| 操作 | 延迟 | 说明 |
|------|------|------|
| 现有 `validateBaseUrl()` | < 0.1ms | 纯字符串操作 |
| DNS 预检（阶段 1） | + 5-50ms | 一次 DNS 查询（系统缓存命中时更短） |
| Rust Connector 过滤（阶段 2） | + 0.01ms | 仅在 DNS 回调中增加 IP 检查，无额外网络延迟 |
| **总影响** | **+ 5-50ms** | 仅首次请求，后续 DNS 缓存命中后影响可忽略 |

## 5. 结论

### 当前威胁级别评估

| 维度 | 评级 |
|------|------|
| 攻击者需控制域名 | 低概率 |
| 攻击者需操纵 DNS 响应 | 低概率（可信网络）/ 中概率（公共 Wi-Fi） |
| 潜在影响（SSRF 到内网） | 高 |
| **综合风险** | **中** |

### 处置建议

**立即实施阶段 1（DNS 预检）**：
- 改动范围小，仅在 `base-url-validator.ts` 增加异步 DNS 检查函数
- 修改 `fetchWithRetry` 在每次 HTTP 请求前调用该函数
- 与现有 `validateBaseUrl()` 调用点兼容
- 新增 5-10 个单元测试覆盖 DNS 预检路径

**后续改进（阶段 2 + 方案 B 子集）**：
- 在 `agent-provider-http/src/main.rs` 集成 `SsrfAwareResolver`（低优先级 P3）
- 考虑在 Rust 侧增加 DNS 缓存绑定（可选）

### 未覆盖的残余风险

- **IPv6 DNS rebinding**: 攻击者可通过 AAAA 记录返回 IPv6 私有地址（`fc00::/7`, `fe80::/10`），方案 A 同样覆盖
- **DNS rebinding 到云 metadata 服务**: 即使域名 `metadata.google.internal` 被禁止，攻击者可通过 rebinding 使其他域名指向 `169.254.169.254`
- **TLS 层面**: HTTPS 场景下，即使 IP 校验通过，仍可能遭受中间人攻击（但这是 TLS 的职责范围）
