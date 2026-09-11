# M1-M2 安全审计报告

## 审计范围

| 模块 | 文件 | 行数 |
|------|------|------|
| Provider 认证与密钥存储 | `auth/types.ts`, `auth/secret-store.ts`, `auth/encrypted-file-store.ts`, `auth/base-url-validator.ts` | 364 |
| Provider 引擎 | `engines/base-engine.ts`, `engines/openai-compatible-engine.ts`, `engines/anthropic-messages-engine.ts`, `engines/ollama-engine.ts` | 652 |
| ProviderFactory | `factory.ts` | 141 |
| Gateway 桥接 | `provider-gateway-v2.ts` | 66 |
| JSON 加载器 | `loader.ts` | 74 |
| Rust 流解析器 | `crates/conex-stream/` | ~400 |

---

## 已修复的漏洞（源自 M1-R2-A5）

### P0: SSRF / baseUrl 注入
**状态**: ✅ 已修复
**位置**: `auth/base-url-validator.ts:35`
**修复内容**:
- 私有 IPv4 范围检测 (`10.`, `172.16-31.`, `192.168.`, `127.`, `0.`, `169.254.`)
- 私有 IPv6 范围检测 (`::1`, `fc00:`, `fe80:`)
- 禁止主机名白名单（含 `metadata.google.internal`, `169.254.169.254`）
- 协议白名单（仅 `https:` / `http:`）
- Gateway 桥接 `provider-gateway-v2.ts:45` 在创建 Provider 前调用 `validateBaseUrl()`
- `factory.ts:47` 使用 `credential.baseUrl ?? decl.baseUrl`，绕过验证器的唯一入口是 Gateway
**验证**: 17 个单元测试覆盖全部边界情况 (`base-url-validator.test.ts`)

### P0: ToolAccumulator OOM
**状态**: ✅ 已修复
**位置**: `crates/conex-stream/src/state/tool_accumulator.rs:5-9`
**修复内容**:
- `MAX_TOOL_CALLS = 128` — 防止 HashMap 无限增长 (`tool_accumulator.rs:47-49`)
- `MAX_ARGUMENTS_LENGTH = 256KB` — 防止单次 tool call 参数膨胀 (`tool_accumulator.rs:65-67`)
- `MAX_JSON_REPAIR_ATTEMPTS = 8` — 限制 CPU 消耗 (`tool_accumulator.rs:169`)
- `append_or_start` 方法（`tool_accumulator.rs:112-152`）也遵守两个上限
**验证**: 7 个单元测试覆盖溢出和正常路径

### P0: 浏览器环境密钥明文落盘
**状态**: ✅ 已修复
**位置**: `auth/encrypted-file-store.ts`, `auth/secret-store.ts`, `auth/types.ts`
**修复内容**:
- `SecretValue` 品牌类型（`types.ts:2`）—— 运行时区分密钥和普通字符串
- AES-256-GCM 加密文件存储（`encrypted-file-store.ts:7-13`）
- PBKDF2 密钥派生（600000 次迭代，SHA-512，64 字节 salt）
- 三层自动回退（`AutoSecretStore`）：Keychain → 加密文件 → 环境变量
- `obfuscateSecret()`（`types.ts:8-11`）安全显示格式 `sk-****...abcd`
**验证**: 10+ 个 auth 测试用例

---

## 新增安全分析

### 风险 1: DeclarativeLoader JSON 解析
**严重度**: 低
**位置**: `loader.ts:50`
**说明**: `JSON.parse()` 用于 `.json` 文件。文件来源于 `builtin/providers/`（受信任目录），但用户可能添加自定义 JSON 文件。
**缓解**:
- `JSON.parse()` 是纯解析器，不执行任意代码
- 之后通过 `normalizeDeclarativeDef()`（`declarative-schema.ts:95`）进行 schema 校验，包含类型强制和默认值
- 解析失败时（`loader.ts:70-72`）只记录错误，不崩溃

### 风险 2: Engine 认证 Header 注入
**严重度**: 低
**位置**: `engines/openai-compatible-engine.ts:153-159`
**说明**: `buildCustomAuthHeaders()` 接受 `headerName` 参数。如果声明文件将 `authHeader` 设置为非标准值，理论上可产生意外行为。
**缓解**:
- 实现中使用白名单开关：仅有 5 个硬编码分支（`authorization`, `api-key`, `x-api-key`, `x-goog-api-key`, `none`）
- `base-engine.ts:100-101` 的 `buildAuthHeaders()` 使用相同的 `authHeader` 字段——fallback 分支也限制在已知 header 名集合
- 默认值为 `"authorization"`（`declarative-schema.ts:129`）

### 风险 3: classifyError 中的 API Key 泄露
**严重度**: 中
**位置**: `engines/base-engine.ts:60-96`
**说明**: `classifyError()` 将错误消息（可能包含 API key、token）直接放入返回的 ErrorClassification.message 中。调用者 `openai-compatible-engine.ts:63-68` 将该消息以 `[${classification.kind}] ${classification.message}` 格式作为 `ProviderStreamEvent` 发出。最坏情况下，这些事件通过日志路径传播，API key 可能被持久化。
**缓解**:
- 所有内置分类使用静态消息（例如 `"Authentication failed"`, `"Rate limited"`）
- 但 `message` 中可能包含 `toLowerCase()` 后的原始错误，可能来自 HTTP 响应体
- ⚠️ **需要额外防护**

### 风险 4: 加密文件存储主密钥熵不足
**严重度**: 中
**位置**: `auth/encrypted-file-store.ts:31`
**说明**: 默认主密钥基于 `COMPUTERNAME + USERNAME + hostname()` 拼接。这些值在 Windows 域环境中可能可预测。
**缓解**:
- 用户可以传入自定义 `masterKey`（构造函数参数）
- 如果没有提供，才使用机器级组合
- 攻击者需要本地文件系统访问权限才能读取 vault 文件（`.crish-secrets.enc`）

### 风险 5: 解析器帧大小限制缺失
**严重度**: 中
**位置**: `crates/conex-stream/src/parser/sse.rs`*
**说明**: SSE 解析器对单次 data 帧没有显式的最大大小限制。恶意服务器可发送超大数据帧导致内存压力。
**缓解**: 解析器在将帧组合成 payload 之前理应检查长度上限。

---

## 测试覆盖率总结

| 测试文件 | 用例数 | 覆盖内容 |
|----------|--------|----------|
| `auth/base-url-validator.test.ts` | 17 | SSRF 边界情况 |
| `engines/__tests__/base-engine.test.ts` | 20+ | error classification |
| `tool_accumulator.rs`（内联测试） | 10 | OOM 防护, JSON repair, reset |
| `declarative-schema.ts`* | 4 | 规范化默认值 |

> `*` = 有待进一步验证

---

## 建议

### P1: 日志脱敏过滤器（已实现）
在日志记录前过滤 API key、token、secret 等敏感数据。

**文件**: `log-sanitizer.ts`（已创建）

### P1: Rust 侧敏感数据脱敏（已实现）
在 Rust 侧脱敏 API key 和 Bearer token。

**文件**: `crates/conex-stream/src/security.rs`（已创建）

### P2: classifyError 中的敏感数据清洗
在 `base-engine.ts` 的 `classifyError` 返回值中，对原始错误消息增加脱敏处理。将所有非分类错误消息截断至 200 字符。

### P2: encrypted-file-store 中的加密文件访问权限
在写 vault 文件时使用 `fs.openSync()` 配合 `0o600` 权限，防止多用户环境中的泄露。

### P2: 自定义 JSON 文件的 Schema 校验加强
为 `loader.ts` 在 `JSON.parse()` 之后、`normalizeDeclarativeDef()` 之前增加额外的 schema 验证步骤，拒绝 unknown/malformed 字段。

---

## 总结

| 分类 | 严重度 | 数量 | 状态 |
|------|--------|------|------|
| 已修复（P0） | 严重 | 3 | ✅ |
| 新增风险（低） | — | 2 | ⚠️ 监控 |
| 新增风险（中） | — | 3 | ⚠️ 部分修复 |
| 建议 | — | 4 | 📋 待办 |
