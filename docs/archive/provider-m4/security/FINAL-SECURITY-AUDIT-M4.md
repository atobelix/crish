# M1-M4 全量 Provider 系统最终安全审计报告

**审计日期**: 2026-07-23
**审计范围**: Provider 认证系统、OAuth 流程、密钥管理、SSRF 防护、输入验证、错误处理、依赖安全
**审计方法**: 源码审计 + 依赖扫描

---

## 1. 密钥管理

| # | 检查项 | 状态 | 证据 |
|---|--------|------|------|
| 1.1 | SecretValue 品牌类型在所有 API key 使用处生效 | ⚠️ **部分生效** | `auth/types.ts:2` 定义 `SecretValue` 品牌类型；全部 `AuthMethod` 联合类型使用 `SecretValue`。但 **`EngineOptions.apiKey` (`types.ts:16`)** 和 **`factory.ts:27` `credential.apiKey`** 类型为 `string` 而非 `SecretValue`，品牌在进入引擎层时丢失 |
| 1.2 | 加密文件存储使用 AES-256-GCM | ✅ **通过** | `encrypted-file-store.ts:7`: `const ALGORITHM = "aes-256-gcm"` |
| 1.3 | PBKDF2 迭代次数 >= 600000 | ✅ **通过** | `encrypted-file-store.ts:12`: `const PBKDF2_ITERATIONS = 600000` |
| 1.4 | localStorage 不包含明文 API key | ✅ **通过** | Provider auth 系统使用加密文件/环境变量/OS Keychain；桌面 App localStorage 仅存储 UI 配置和偏好，无 API key 明文 |
| 1.5 | 日志脱敏过滤器已实现 | ⚠️ **已实现但未集成** | `log-sanitizer.ts` 定义 `sanitizeForLog()` 和 `sanitizeHeaders()`；但 **`factory.ts:119,128` 错误处理路径未调用脱敏函数** |

### 密钥管理剩余风险

1. **EngineOptions.apiKey 类型安全缺口**: `SecretValue` 品牌在 `EngineOptions` 层丢失。`openai-compatible-engine.ts:140` 的 `apiKey` 是 `string` 类型。建议将 `EngineOptions.apiKey` 改为 `SecretValue` 类型，并在 engine 各环节传递品牌类型。

2. **日志脱敏未在所有路径生效**: `factory.ts:119` 直接 `String(err)` 输出原始错误；`:128` 输出 `body.slice(0, 200)` 可能包含 provider 返回的 API key。需注入 `sanitizeForLog()` 调用。

3. **默认主密钥熵不足**（M1M2 Risk 4 未修复）：`encrypted-file-store.ts:31` 的 fallback 主密钥基于 `COMPUTERNAME + USERNAME + hostname()`，在域环境中可预测。

4. **加密文件无权限锁**（M1M2 P2 未修复）：`encrypted-file-store.ts:70-81` 的 `writeVault()` 未设置文件权限 (`0o600`)，多用户系统上其他用户可读取 vault。

---

## 2. SSRF 防护

| # | 检查项 | 状态 | 证据 |
|---|--------|------|------|
| 2.1 | 所有 baseUrl 输入经过 validateBaseUrl 校验 | ⚠️ **部分覆盖** | `provider-gateway-v2.ts:46` Gateway 路径调用 `validateBaseUrl()`；但 `factory.ts:47` 在 `buildEngineOptions()` 中直接使用 `credential.baseUrl ?? decl.baseUrl`，**绕过验证器** |
| 2.2 | 私有 IP 范围被阻止 | ✅ **通过** | `base-url-validator.ts:3-10` 覆盖 IPv4 (127./10./172.16-31./192.168./0./169.254.) 和 IPv6 (::1/fc00:/fe80:) |
| 2.3 | 云元数据端点被阻止 | ✅ **通过** | `base-url-validator.ts:13-14` 包含 `metadata.google.internal` 和 `169.254.169.254` |
| 2.4 | 协议白名单（仅 http/https） | ✅ **通过** | `base-url-validator.ts:21`: `ALLOWED_SCHEMES = ["https:", "http:"]` |

### SSRF 剩余风险

1. **工厂直连绕行风险**: `factory.createProvider()` 可被外部直接调用，存在 SSRF 绕行路径。`GatewayV2Bridge` 是官方入口（有验证），但 `ProviderFactory` 本身无校验。建议在 `factory.ts:47` 处添加 `validateBaseUrl()` 调用作为防御深度。

2. **DNS rebinding 风险**: 当前验证基于主机名字符串比较，不防御 DNS rebinding 攻击。

---

## 3. OAuth 安全

| # | 检查项 | 状态 | 证据 |
|---|--------|------|------|
| 3.1 | PKCE 使用 S256 | ✅ **通过** | `oauth-flow.ts:42`: `code_challenge_method: "S256"` |
| 3.2 | code_verifier >= 256 bits | ✅ **通过** | `pkce.ts:2`: `new Uint8Array(32)` = 256 bits |
| 3.3 | state 参数用于 CSRF 保护 | ❌ **缺陷** | `pkce.ts:27-31` 生成 state；`oauth-flow.ts:33` 包含在 authorization URL；但 **`exchangeCode()` (`oauth-flow.ts:52-81`) 未接受或验证 state 参数**。The `LocalCallbackServer` 收到的 state 未被检查是否与原始值匹配。CSRF 攻击者可劫持 OAuth 回调 |
| 3.4 | redirect_uri 固定 | ✅ **通过** | `oauth-flow.ts:37-38`: redirect_uri 从构造函数 options 传入，固定不变 |
| 3.5 | 跨进程文件锁使用 O_EXCL | ✅ **通过** | `cross-process-lock.ts:43`: `fs.openSync(this.lockFilePath, "wx")` 使用 `O_EXCL` 标志 |
| 3.6 | generation CAS 防止竞争 | ✅ **通过** | `cross-process-lock.ts:39-41`: 获取锁前检查 generation；`:73-88`: release 时更新 generation |

### OAuth 剩余风险

1. **P0: state 参数未验证 (CSRF)**: `oauth-flow.ts` 的 `exchangeCode()` 方法不接收 state 参数，无法验证回调与原始请求的绑定关系。攻击者可构造恶意回调 URL 并诱使用户访问，实现 token 劫持。
   - **修复方案**: 将 `state` 参数传入 `exchangeCode()`，在发送 token 请求前验证 state 与 `startPKCE()` 返回的一致性。
   - 文件位置: `oauth-flow.ts:52-81`

2. **AccountStore 持久化令牌**: `account-store.ts:29-37` 的 `load()` 返回的 `ChatGPTAccount` 中 `accessToken` 和 `refreshToken` 字段在反序列化后为 `"***"`（因为 `save()` 写入了脱敏值），导致 token 被永久丢失。这是功能缺陷而非安全缺陷，但需注意。

---

## 4. 输入验证

| # | 检查项 | 状态 | 证据 |
|---|--------|------|------|
| 4.1 | JSON Schema 验证在注册时执行 | ⚠️ **部分实现** | `normalizeDeclarativeDef()` (`declarative-schema.ts:95-142`) 提供默认值填充但不拒绝未知/畸形字段；`provider-validate.ts` CLI 工具验证必需字段存在性 |
| 4.2 | Invalid JSON 被优雅拒绝 | ✅ **通过** | `loader.ts:70-72` catch 块仅 `console.error`，不崩溃 |
| 4.3 | 模型 ID 长度限制 | ❌ **未实现** | `declarative-schema.ts:19` 中 `id: string` 无长度限制 |
| 4.4 | Provider ID 字符白名单 | ❌ **未实现** | `declarative-schema.ts:2` 中 `providerId: string` 无字符白名单 |

### 输入验证剩余风险

1. **无模式防护**: 用户自定义 provider JSON 文件注入恶意长 `providerId` 或 `model.id` 可能导致 registry 数据结构膨胀、日志注入或 SQLite 兼容性问题。

2. **normalizeDeclarativeDef 接受未知字段**: 不拒绝 `additionalProperties`，不符合"默认拒绝"原则。

---

## 5. 错误处理

| # | 检查项 | 状态 | 证据 |
|---|--------|------|------|
| 5.1 | 敏感信息不在错误消息中泄露 | ⚠️ **部分修复** | `classifyError` 已知分类使用静态消息 ✅；但 `base-engine.ts:95` 未知错误返回原始 message；`factory.ts:119` 直接 `String(err)`；`:128` 输出 `body.slice(0, 200)` 可能泄露 API key ❌ |
| 5.2 | API key 不在日志中明文记录 | ⚠️ **过滤函数存在但未全路径使用** | `sanitizeForLog()` 定义于 `log-sanitizer.ts`；Rust 侧 `security.rs` 有 `redact_sensitive()`；但 `factory.ts` 错误路径未使用 |
| 5.3 | 堆栈跟踪不暴露给用户 | ✅ **通过** | 所有 catch 块使用 `(err as Error).message` 而非 `stack` |

### 错误处理剩余风险

1. **P1: factory.ts HTTP 错误体未脱敏**: `factory.ts:124-128` 在 HTTP 非 2xx 时将 `body.slice(0, 200)` 放入 `ProviderStreamEvent.error`。部分 provider 错误响应（如 `"error": "Invalid API key: sk-proj-xxx..."`）可能包含完整 API key。需加 `sanitizeForLog()` 过滤。

2. **classifyError unknown 分支**: 未知错误类型返回原始 `message`，可包含 provider 返回的敏感数据。

---

## 6. 依赖安全

| # | 检查项 | 状态 | 证据 |
|---|--------|------|------|
| 6.1 | npm audit 无 high/critical 漏洞 | ✅ **通过** | 检出 1 low, 2 moderate（`@hono/node-server` 路径遍历、`esbuild` 文件读取），**无 high/critical** |
| 6.2 | cargo audit 无 advisories | ❌ **未配置** | `cargo-audit` 工具未安装，无法运行 |

### 依赖安全剩余风险

1. **cargo audit 不可用**: 建议添加 `cargo-audit` 到 CI 流程。Rust 依赖中 `regex-lite = "0.1"` 为预发布版本，建议定期检查 advisory。

2. **两个 moderate npm 漏洞**:
   - `@hono/node-server` < 2.0.5 — 影响 `@modelcontextprotocol/sdk`
   - `esbuild` 0.27.3-0.28.0 — Windows 路径遍历
   - 建议在月底发布窗口升级修复。

---

## 7. 与 M2-R3-A4（M1-M2 审计）改进对比

| M1-M2 审计条目 | M1-M2 状态 | M4 状态 | 进展 |
|----------------|-----------|---------|------|
| P0: SSRF/baseUrl 注入 | ✅ 已修复 | ✅ 维持，新增工厂直连绕行风险 | 🔄 需防御深度 |
| P0: ToolAccumulator OOM | ✅ 已修复 | ✅ `MAX_FRAME_SIZE=1MiB` 在 `sse.rs:4` 实现 | 🆕 已修复 |
| P0: 浏览器环境密钥明文落盘 | ✅ 已修复 | ✅ 维持 | ➖ |
| Risk 1: JSON 解析无 Schema | 低风险 | ⚠️ normalize 仍不拒绝未知字段 | ➖ 未进展 |
| Risk 2: Header 注入 | 低风险 | ✅ `buildCustomAuthHeaders` 5 分支白名单 | ➖ |
| Risk 3: classifyError API key 泄露 | 中风险，需额外防护 | ⚠️ `sanitizeForLog` 存在但未在 `factory.ts` 使用 | 🔄 部分修复 |
| Risk 4: 加密文件主密钥熵不足 | 中风险 | ⚠️ 未修复 | ➖ |
| Risk 5: SSE 帧大小限制 | 中风险 | ✅ `MAX_FRAME_SIZE = 1024 * 1024` + 单元测试 | 🆕 **已修复** |
| P1: 日志脱敏过滤器 | 已实现 | ⚠️ 已实现但未集成到错误路径 | 🔄 |
| P1: Rust 侧敏感数据脱敏 | 已实现 | ✅ `security.rs` 实现 | 🆕 |
| P2: classifyError 数据清洗 | 待办 | ⚠️ 未完全解决 | ➖ |
| P2: 加密文件权限 0o600 | 待办 | ⚠️ `writeVault()` 未设置权限 | ➖ |
| P2: 自定义 JSON Schema 加强 | 待办 | ⚠️ 未增强 | ➖ |

**新增问题（本审计发现）**:

| 严重度 | 问题 | 位置 |
|--------|------|------|
| **P0** | OAuth state 参数未验证（CSRF） | `oauth-flow.ts:52-81` |
| **P1** | `EngineOptions.apiKey` 类型为 `string` 而非 `SecretValue` | `types.ts:16` |
| **P1** | `factory.ts` HTTP 错误体未脱敏 | `factory.ts:124-128` |
| **P2** | Provider ID 无字符白名单 | `declarative-schema.ts:2` |
| **P2** | 模型 ID 无长度限制 | `declarative-schema.ts:19` |
| **P3** | `cargo audit` 未配置 | CI 缺失 |

---

## 8. 剩余风险总览

| 分类 | 严重度 | 数量 | 当前状态 |
|------|--------|------|---------|
| 已修复（原 P0） | 严重 | 3 | ✅ 全部验证 |
| 已修复（新增） | — | 2 | ✅ SSE 帧限制 + 日志脱敏 |
| 待修复（P0） | 严重 | 1 | ❌ OAuth CSRF |
| 待修复（P1） | 高 | 2 | ⚠️ SecretValue 类型缺口 + 错误体脱敏 |
| 待修复（P2） | 中 | 4 | ⚠️ 输入白名单、文件权限、Schema 校验、Rust 审计 |
| 待修复（P3） | 低 | 2 | ⚠️ cargo audit CI 配置、npm moderate 修复 |

## 9. 建议后续改进

1. **立即修复（P0）**: `oauth-flow.ts:52-81` 的 `exchangeCode()` 增加 state 参数验证。
2. **高优先级（P1）**: 将 `EngineOptions.apiKey` 类型改为 `SecretValue`，修复 factory 错误路径的敏感信息泄露。
3. **防御深度**: `factory.ts:47` 增加 `validateBaseUrl()` 调用，不依赖 Gateway 单点验证。
4. **CI 加固**: 安装 `cargo-audit` 并加入 CI 流水线；执行 `npm audit fix` 修复 moderate 漏洞。
5. **长期**: 为 providerId 和 modelId 增加长度限制和字符白名单；实现自建 provider JSON 的完整 JSON Schema 校验。
