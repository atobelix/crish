# Conex 认证与渠道系统安全架构设计

## 1. 文件结构

```
packages/secure-auth/
├── src/
│   ├── index.ts                          # 公共导出
│   │
│   ├── types/
│   │   ├── auth-method.ts                # AuthMethod 统一类型系统
│   │   ├── secret.ts                     # Secret 值类型 + 脱敏协议
│   │   ├── channel.ts                    # Channel 抽象层类型
│   │   └── oauth.ts                      # OAuth 流程类型 + 状态机
│   │
│   ├── storage/
│   │   ├── secret-store.ts               # SecretStorage 三层抽象接口
│   │   ├── layer1-os-keychain.ts         # OS Keychain (Win Credential Manager / macOS Keychain / Linux secret-tool)
│   │   ├── layer2-encrypted-file.ts      # AES-256-GCM 加密文件 (参考 Continue SecretStorage)
│   │   ├── layer3-env.ts                 # 环境变量回退
│   │   └── auto-selector.ts             # 自动选择策略
│   │
│   ├── auth/
│   │   ├── auth-method.ts               # AuthMethod 运行时 + 签名器注册表
│   │   ├── auth-provider.ts             # AuthProvider trait
│   │   ├── no-auth.ts                   # NoAuth 实现
│   │   ├── bearer.ts                    # Bearer Token
│   │   ├── api-key.ts                   # ApiKey (X-Api-Key / api-key)
│   │   ├── basic.ts                     # Basic Auth
│   │   ├── aws-sig-v4.ts               # AWS Signature V4
│   │   ├── azure-api-key.ts            # Azure API Key (x-api-key header)
│   │   ├── oauth.ts                     # OAuth2 (delegates to OAuthEngine)
│   │   ├── custom.ts                    # Custom Auth (用户自定义函数)
│   │   ├── chain.ts                     # Chain Auth (多方法链式组合)
│   │   └── registry.ts                 # AuthMethodRegistry
│   │
│   ├── oauth/
│   │   ├── oauth-engine.ts              # OAuthEngine 统一入口
│   │   ├── flows/
│   │   │   ├── pkce.ts                  # PKCE 浏览器流程
│   │   │   ├── device-code.ts           # Device Code 终端流程
│   │   │   └── client-credentials.ts    # Client Credentials M2M
│   │   ├── token-cache.ts              # Token 缓存 + generation CAS
│   │   ├── token-refresher.ts          # 自动刷新器 (single-flight + 定时器)
│   │   ├── state-machine.ts            # 状态机: NoToken→TryRefresh→NeedAuth→Exchanging→HasToken→Error
│   │   └── file-lock.ts               # 跨进程文件锁
│   │
│   ├── chatgpt/
│   │   ├── account-pool.ts             # ChatGPT Plus 账号池
│   │   ├── account-route.ts            # 账号路由 (亲和性 + 最低使用率 + 故障转移)
│   │   ├── token-guardian.ts           # Token Guardian 后台守护刷新
│   │   └── quota-monitor.ts            # 配额监控 (>80% 自动切换)
│   │
│   ├── channel/
│   │   ├── channel-types.ts            # ChannelType discriminated union
│   │   ├── channel-router.ts           # 多渠道路由器 (优先级+权重+健康检查+故障转移)
│   │   ├── tls-client.ts              # TLS 客户端证书 (mTLS)
│   │   └── health-checker.ts          # 健康检查
│   │
│   └── china-market/
│       ├── gateway-proxy.ts            # API 中转站模式
│       ├── account-rotation.ts         # 多账号轮转 (限流自动切换)
│       ├── xunfei-signature.ts        # 讯飞星火自定义签名
│       └── compliance-adapter.ts      # 合规适配器
│
├── crates/secure-auth-core/           # Rust 侧核心
│   ├── src/
│   │   ├── lib.rs
│   │   ├── types.rs                   # Rust 侧 AuthMethod (ts-rs 同步)
│   │   ├── secret.rs                  # Secret 加密/脱敏
│   │   ├── storage.rs                 # 三层存储 Rust 实现
│   │   ├── oauth_state.rs            # OAuth 状态机 Rust 侧
│   │   └── aws_sig_v4.rs             # AWS SigV4 签名 (ring crate)
│
├── ts-rs.json                         # TS←→Rust 类型同步配置
```

---

## 2. AuthMethod 统一类型系统

### 2.1 TypeScript discriminated union

```typescript
// ============================================================
// types/auth-method.ts
// ============================================================

/**
 * 所有 AuthMethod 的 base interface，包含公共元数据。
 */
export interface AuthMethodBase {
  /** 全局唯一 ID，用于缓存/日志/审计 */
  id: string;
  /** 显示名称（如 "OpenAI API Key"） */
  label?: string;
  /** 凭证来源描述（用于 UI 展示） */
  credentialSource?: CredentialSourceInfo;
}

export type CredentialSourceInfo =
  | { type: "keychain"; service: string; account: string }
  | { type: "encrypted-file"; path: string }
  | { type: "env"; varName: string }
  | { type: "inline"; described: boolean }; // described = 已脱敏

/**
 * Discriminated union 认证方法类型。
 * kind 字段作为 discriminator，确保 exhaustiveness check。
 */
export type AuthMethod =
  | AuthMethodNoAuth
  | AuthMethodBearer
  | AuthMethodApiKey
  | AuthMethodBasic
  | AuthMethodAwsSigV4
  | AuthMethodAzureApiKey
  | AuthMethodOAuth
  | AuthMethodCustom
  | AuthMethodChain;

// ---- 9 种具体类型 ----

export interface AuthMethodNoAuth extends AuthMethodBase {
  kind: "no-auth";
}

export interface AuthMethodBearer extends AuthMethodBase {
  kind: "bearer";
  token: SecretValue;
}

export interface AuthMethodApiKey extends AuthMethodBase {
  kind: "api-key";
  key: SecretValue;
  /** 请求头名称（默认 "X-Api-Key"） */
  headerName?: string; // "x-api-key" | "api-key" | "Authorization"
  /** 可选的 param 参数（用于 query param 形式） */
  queryParamName?: string; // e.g. "api_key"
}

export interface AuthMethodBasic extends AuthMethodBase {
  kind: "basic";
  username: string;
  password: SecretValue;
}

export interface AuthMethodAwsSigV4 extends AuthMethodBase {
  kind: "aws-sig-v4";
  accessKeyId: SecretValue;
  secretAccessKey: SecretValue;
  region: string;
  service: string; // e.g. "bedrock"
  sessionToken?: SecretValue; // 临时凭证
}

export interface AuthMethodAzureApiKey extends AuthMethodBase {
  kind: "azure-api-key";
  key: SecretValue;
  /** Azure 默认用 x-api-key header */
  headerName?: string;
}

export interface AuthMethodOAuth extends AuthMethodBase {
  kind: "oauth";
  flow: OAuthFlow; // PKCE | DeviceCode | ClientCredentials
  clientId: string;
  clientSecret?: SecretValue;
  scopes: string[];
  /** token 端点 */
  tokenUrl: string;
  authUrl?: string;            // 仅 PKCE
  deviceAuthUrl?: string;      // 仅 Device Code
  refreshUrl?: string;         // 可选，默认同 tokenUrl
  /** 额外的请求参数 */
  extraParams?: Record<string, string>;
  /** 关联的 OAuthTokenCache 引用 key */
  tokenCacheKey: string;
}

export interface AuthMethodCustom extends AuthMethodBase {
  kind: "custom";
  /** 用户自定义签名函数 ID（在 AuthMethodRegistry 中注册） */
  handlerId: string;
  /** 签名函数的配置参数 */
  config: Record<string, SecretValue | string>;
}

export interface AuthMethodChain extends AuthMethodBase {
  kind: "chain";
  /** 按顺序尝试，第一个成功的返回 */
  methods: AuthMethod[];
  /** 失败的阈值（超过后整体标记失败） */
  maxAttempts?: number;
}
```

### 2.2 Secret 类型系统

```typescript
// ============================================================
// types/secret.ts
// ============================================================

/**
 * Secret 值：自动脱敏 + 加密存储。
 * SecretValue 本身不包含明文——明文存储在 SecretStorage 中。
 */
export interface SecretValue {
  /** 引用 ID（查 SecretStorage 用） */
  ref: string;
  /** 脱敏展示文本（前4后4字符保留，其余 *） */
  display: string;
  /** 值长度（用于 UI 展示） */
  length: number;
  /** 创建时间 */
  createdAt: number;
  /** 过期时间（可选，仅 OAuth token 等有时效性的） */
  expiresAt?: number;
  /** 元数据 */
  metadata?: SecretMetadata;
}

export interface SecretMetadata {
  kind: "api-key" | "token" | "password" | "certificate" | "custom";
  source: CredentialSourceInfo["type"];
}

/**
 * SecretReference 用于序列化到配置文件（从不出现在版本控制中直接暴露的值）。
 * 配置文件引用方式：
 *   - $env:VAR_NAME → 从环境变量读取
 *   - $file:./path → 从文件读取
 *   - $keychain:service/account → 从 OS Keychain 读取
 *   - $secret:ref → 从加密存储读取
 */
export type SecretReference =
  | { type: "env"; varName: string }
  | { type: "file"; path: string }
  | { type: "keychain"; service: string; account: string }
  | { type: "secret"; ref: string };
```

### 2.3 Rust 侧同步类型

```rust
// crates/secure-auth-core/src/types.rs
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind")]
pub enum AuthMethod {
    #[serde(rename = "no-auth")]
    NoAuth { id: String, label: Option<String> },

    #[serde(rename = "bearer")]
    Bearer { id: String, label: Option<String>, token: SecretValue },

    #[serde(rename = "api-key")]
    ApiKey { id: String, label: Option<String>, key: SecretValue, header_name: Option<String> },

    #[serde(rename = "basic")]
    Basic { id: String, label: Option<String>, username: String, password: SecretValue },

    #[serde(rename = "aws-sig-v4")]
    AwsSigV4 {
        id: String, label: Option<String>,
        access_key_id: SecretValue, secret_access_key: SecretValue,
        region: String, service: String, session_token: Option<SecretValue>,
    },

    #[serde(rename = "azure-api-key")]
    AzureApiKey { id: String, label: Option<String>, key: SecretValue },

    #[serde(rename = "oauth")]
    OAuth { id: String, label: Option<String>, token_cache_key: String, .. },

    #[serde(rename = "custom")]
    Custom { id: String, label: Option<String>, handler_id: String, config: HashMap<String, JsonValue> },

    #[serde(rename = "chain")]
    Chain { id: String, label: Option<String>, methods: Vec<AuthMethod>, max_attempts: Option<u32> },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SecretValue {
    pub ref_id: String,
    pub display: String,
    pub length: u32,
    pub created_at: i64,
    pub expires_at: Option<i64>,
}
```

---

## 3. 密钥安全存储三层架构

### 3.1 架构概览

```
┌────────────────────────────────────────────────────────┐
│                   SecretStorage                        │
│  ┌────────────────────────────────────────────────┐   │
│  │  AutoSelector                                   │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐     │   │
│  │  │ Layer 1  │  │ Layer 2  │  │ Layer 3  │     │   │
│  │  │OS Keychain│→│AES-256-  │→│Env Var   │     │   │
│  │  │          │  │GCM File  │  │Fallback  │     │   │
│  │  └──────────┘  └──────────┘  └──────────┘     │   │
│  └────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────┘
```

### 3.2 存储接口

```typescript
// ============================================================
// storage/secret-store.ts
// ============================================================

export interface SecretStoreConfig {
  /** 存储基目录（加密文件路径） */
  basePath: string;
  /** 应用名称（用于 Keychain） */
  appName: string;
  /** 是否强制使用指定层（默认 auto） */
  forceLayer?: "keychain" | "file" | "env";
  /** AES-256-GCM 主密钥（若为 undefined 则自动从 OS Keychain 派生/生成） */
  masterKey?: Buffer;
  /** 环境变量名前缀（默认 "CONEX_"） */
  envPrefix?: string;
}

export interface SecretStorageProvider {
  /** 读密钥 */
  read(ref: string): Promise<string | null>;
  /** 写密钥 */
  write(ref: string, value: string): Promise<void>;
  /** 删除密钥 */
  delete(ref: string): Promise<void>;
  /** 列出所有密钥 ref */
  list(): Promise<string[]>;
  /** 健康检查 */
  health(): Promise<{ ok: boolean; latency: number; details?: string }>;
}

export class SecretStorage implements SecretStorageProvider {
  private layers: SecretStorageProvider[];
  private autoSelector: AutoSelector;

  constructor(config: SecretStoreConfig) {
    this.layers = [
      new Layer1OsKeychain(config),
      new Layer2EncryptedFile(config),
      new Layer3Env(config),
    ];
    this.autoSelector = new AutoSelector(this.layers);
  }

  async read(ref: string): Promise<string | null> {
    return this.autoSelector.read(ref);
  }

  async write(ref: string, value: string): Promise<void> {
    return this.autoSelector.write(ref, value);
  }

  async delete(ref: string): Promise<void> {
    return this.autoSelector.delete(ref);
  }

  async list(): Promise<string[]> {
    return this.autoSelector.list();
  }

  async health(): Promise<{ ok: boolean; latency: number; details?: string }> {
    return this.autoSelector.health();
  }
}
```

### 3.3 自动选择策略

```typescript
// ============================================================
// storage/auto-selector.ts
// ============================================================

/**
 * 自动选择策略：
 *   write: 优先写入最高可用层（Layer1→Layer2→Layer3），同时写入所有可用层
 *   read:  按 Layer1→Layer2→Layer3 依次查询，返回第一个命中
 *   failover: 写失败自动降级（Layer1 不可用→Layer2→Layer3）
 */
export class AutoSelector {
  constructor(private readonly layers: SecretStorageProvider[]) {}

  async write(ref: string, value: string): Promise<void> {
    const errors: Error[] = [];
    let anySucceeded = false;

    for (const layer of this.layers) {
      try {
        await layer.write(ref, value);
        anySucceeded = true;
      } catch (e) {
        errors.push(e as Error);
      }
    }

    if (!anySucceeded) {
      throw new AggregateError(errors, "All secret storage layers failed to write");
    }
  }

  async read(ref: string): Promise<string | null> {
    for (const layer of this.layers) {
      try {
        const value = await layer.read(ref);
        if (value !== null) return value;
      } catch {
        // 继续查询下一层
      }
    }
    return null;
  }

  async delete(ref: string): Promise<void> {
    for (const layer of this.layers) {
      try {
        await layer.delete(ref);
      } catch {
        // 尽力删除
      }
    }
  }

  async list(): Promise<string[]> {
    const seen = new Set<string>();
    const all: string[] = [];
    for (const layer of this.layers) {
      for (const key of await layer.list()) {
        if (!seen.has(key)) {
          seen.add(key);
          all.push(key);
        }
      }
    }
    return all;
  }

  async health(): Promise<{ ok: boolean; latency: number; details?: string }> {
    const results = await Promise.all(this.layers.map((l) => l.health()));
    const ok = results.some((r) => r.ok);
    return {
      ok,
      latency: results.reduce((a, r) => a + r.latency, 0),
      details: results.map((r, i) => `Layer${i+1}: ${r.ok ? "ok" : "fail"}`).join("; "),
    };
  }
}
```

### 3.4 AES-256-GCM 加密文件（参考 Continue SecretStorage）

```typescript
// ============================================================
// storage/layer2-encrypted-file.ts
// ============================================================

import { createCipheriv, createDecipheriv, randomBytes, createHash, pbkdf2Sync } from "node:crypto";

export class Layer2EncryptedFile implements SecretStorageProvider {
  private readonly masterKey: Buffer;
  private readonly filePath: string;

  constructor(config: SecretStoreConfig) {
    // 主密钥来源：OS Keychain 派生 | 配置文件 | 自动生成
    this.masterKey = config.masterKey ?? this.deriveMasterKey(config);
    this.filePath = join(config.basePath, "secrets.enc");
  }

  private deriveMasterKey(config: SecretStoreConfig): Buffer {
    // 用机器指纹 + appName 通过 PBKDF2 派生 256-bit 密钥
    // 若不依赖外部，则写入 OS Keychain 一份主密钥
    const fingerprint = machineFingerprint();
    return pbkdf2Sync(fingerprint, config.appName, 100_000, 32, "sha512");
  }

  async write(ref: string, value: string): Promise<void> {
    // 读取现有 vault
    const vault = await this.readVault();
    // AES-256-GCM 加密
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    vault.set(ref, {
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: encrypted.toString("base64"),
      createdAt: Date.now(),
    });

    await this.writeVault(vault);
  }

  async read(ref: string): Promise<string | null> {
    const vault = await this.readVault();
    const entry = vault.get(ref);
    if (!entry) return null;

    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.masterKey,
      Buffer.from(entry.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    return decipher.update(Buffer.from(entry.data, "base64"), undefined, "utf8") + decipher.final("utf8");
  }

  // 文件格式：每行一个 JSON（JSONL），带文件锁 + CRC32 校验
  private async readVault(): Promise<Map<string, EncryptedEntry>> { /* ... */ }
  private async writeVault(vault: Map<string, EncryptedEntry>): Promise<void> { /* ... */ }
}
```

### 3.5 Rust 侧实现

```rust
// crates/secure-auth-core/src/storage.rs

pub enum SecretStoreLayer {
    OsKeychain(OsKeychainProvider),
    EncryptedFile(EncryptedFileProvider),
    Env(EnvProvider),
}

pub trait SecretStorage: Send + Sync {
    fn read(&self, ref_id: &str) -> Result<Option<String>>;
    fn write(&self, ref_id: &str, value: &str) -> Result<()>;
    fn delete(&self, ref_id: &str) -> Result<()>;
}

// Windows: DPAPI + Credential Manager (已有 credentials.rs 模式扩展)
// macOS: Security Framework (SecKeychain)
// Linux: secret-tool (DBus Secret Service) or libsecret

pub struct OsKeychainProvider {
    #[cfg(target_os = "windows")]
    dpapi: DpapiStore,
    #[cfg(target_os = "macos")]
    mac_keychain: MacKeychain,
    #[cfg(target_os = "linux")]
    secret_service: SecretService,
}

// 加密文件: AES-256-GCM (ring + aes-gcm crate)
pub struct EncryptedFileProvider {
    path: PathBuf,
    master_key: [u8; 32], // PBKDF2 derived
}

// 环境变量
pub struct EnvProvider {
    prefix: String,
}
```

---

## 4. OAuth 通用框架

### 4.1 状态机

```
                    ┌──────────┐
                    │ No Token │
                    └────┬─────┘
                         │
                    ┌────▼──────┐
              ┌─────│Try Refresh│◄──────────────┐
              │     └────┬──────┘               │
              │          │ 失败                  │
              │     ┌────▼──────┐               │
              │     │ Need Auth │               │
              │     └────┬──────┘               │
              │          │ 发起                  │
              │     ┌────▼──────┐               │
              │     │Exchanging │               │
              │     └────┬──────┘               │
              │          │ 成功                  │
              │     ┌────▼──────┐   过期/即将    │
              │     │ Has Token │───────────────┘
              │     └────┬──────┘
              │          │ 永久失败
              │     ┌────▼──────┐
              └─────│   Error   │
                    └───────────┘
```

### 4.2 OAuthEngine

```typescript
// ============================================================
// oauth/oauth-engine.ts
// ============================================================

export type OAuthStateTag = "no-token" | "try-refresh" | "need-auth" | "exchanging" | "has-token" | "error";

export interface OAuthState {
  tag: OAuthStateTag;
  token?: OAuthToken;
  error?: string;
  retryCount: number;
  generation: number; // CAS 版本号
}

export interface OAuthToken {
  accessToken: SecretValue;
  refreshToken?: SecretValue;
  expiresAt: number;
  tokenType: string;
  scope?: string;
  issuedAt: number;
}

export interface OAuthFlows {
  pkce: PkceFlow;
  deviceCode: DeviceCodeFlow;
  clientCredentials: ClientCredentialsFlow;
}

export interface OAuthPKCEConfig {
  kind: "pkce";
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeChallengeMethod: "S256";
  scopes: string[];
  extraParams?: Record<string, string>;
}

export interface OAuthDeviceCodeConfig {
  kind: "device-code";
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scopes: string[];
}

export interface OAuthClientCredentialsConfig {
  kind: "client-credentials";
  tokenEndpoint: string;
  clientId: string;
  clientSecret: SecretValue;
  scopes: string[];
}

export type OAuthFlow = OAuthPKCEConfig | OAuthDeviceCodeConfig | OAuthClientCredentialsConfig;

export class OAuthEngine {
  private stateMachine: OAuthStateMachine;
  private tokenCache: OAuthTokenCache;
  private tokenRefresher: OAuthTokenRefresher;

  constructor(
    private readonly config: OAuthFlow,
    private readonly storage: SecretStorage,
    private readonly fileLock: CrossProcessFileLock,
  ) {}

  async getToken(forceRefresh?: boolean): Promise<OAuthToken> {
    // 1. 先查缓存 + generation CAS
    // 2. 状态机推进
    // 3. 必要时刷新/重新认证
    // 4. 写回缓存（CAS 冲突时回退重试）
  }
}
```

### 4.3 PKCE 流程

```typescript
// ============================================================
// oauth/flows/pkce.ts
// ============================================================

/**
 * PKCE (Proof Key for Code Exchange):
 * 1. client generates code_verifier (random 128 bytes → base64url)
 * 2. client computes code_challenge = SHA256(code_verifier) → base64url
 * 3. open browser: authorizationEndpoint + code_challenge
 * 4. redirect back with authorization_code
 * 5. exchange: authorization_code + code_verifier → access_token + refresh_token
 * 6. store tokens
 */
export class PkceFlow {
  async initiate(config: OAuthPKCEConfig): Promise<{ authUrl: string; state: string }> {
    const codeVerifier = base64urlEncode(crypto.getRandomValues(new Uint8Array(128)));
    const codeChallenge = base64urlEncode(await sha256(codeVerifier));
    const state = crypto.randomUUID();

    // 存储 code_verifier + state → 等待回调
    await this.storage.write(`oauth:pkce:${state}`, JSON.stringify({ codeVerifier, config }));

    const authUrl = new URL(config.authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", config.clientId);
    authUrl.searchParams.set("redirect_uri", config.redirectUri);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("scope", config.scopes.join(" "));

    return { authUrl: authUrl.toString(), state };
  }

  async exchange(code: string, state: string): Promise<OAuthToken> {
    const stored = JSON.parse(await this.storage.read(`oauth:pkce:${state}`));
    const { codeVerifier } = stored;

    // POST tokenEndpoint with code + code_verifier
    const response = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        code_verifier: codeVerifier,
      }),
    });

    const tokens = await response.json();
    return this.parseTokenResponse(tokens, config);
  }
}
```

### 4.4 跨进程安全（文件锁 + generation CAS）

```typescript
// ============================================================
// oauth/file-lock.ts
// ============================================================

/**
 * 跨进程文件锁：
 * - 使用 lockfile (npm:proper-lockfile) 或自建 FLOCK 方案
 * - 支持共享锁（读）/互斥锁（写）
 * - 可配置超时和重试
 */
export class CrossProcessFileLock {
  async acquire(key: string, exclusive: boolean): Promise<LockGuard> {
    // 写锁：exclusive=true → 其他进程不可读写
    // 读锁：exclusive=false → 其他进程可读不可写
    // 实现：lockfile.lock(lockFilePath, { realpath: false, retries: { retries: 5, minTimeout: 100 } })
  }
}

// ============================================================
// oauth/token-cache.ts
// ============================================================

/**
 * Token 缓存 + generation 乐观并发控制 (CAS)：
 * - generation 是一个单调递增的数字，每次更新时原子递增
 * - 写入时检查 generation 是否匹配（cas 操作）
 * - 解决多进程同时刷新 token 的 race condition
 */
export class OAuthTokenCache {
  private readonly cacheFile: string;

  async read(): Promise<{ token: OAuthToken; generation: number } | null> {
    using lock = await this.fileLock.acquire("token-cache", false); // 共享锁
    const raw = await readFile(this.cacheFile, "utf8").catch(() => null);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { token: parsed.token, generation: parsed.generation };
  }

  async write(token: OAuthToken, expectedGeneration?: number): Promise<void> {
    using lock = await this.fileLock.acquire("token-cache", true); // 互斥锁
    const current = await this.read();

    // CAS: 如果 expectedGeneration 不匹配 → 其他人已更新 → 放弃写入
    if (expectedGeneration !== undefined && current?.generation !== expectedGeneration) {
      throw new CasConflictError(expectedGeneration, current?.generation);
    }

    const newGeneration = (current?.generation ?? 0) + 1;
    await atomicWrite(this.cacheFile, JSON.stringify({ token, generation: newGeneration }));
  }
}
```

### 4.5 Token 自动刷新

```typescript
// ============================================================
// oauth/token-refresher.ts
// ============================================================

/**
 * Token 自动刷新器：
 * - single-flight dedup: 同一 token 同时只发起一次刷新
 * - 提前 5 分钟静默刷新 (REFRESH_BUFFER_MS)
 * - 指数退避重试
 * - 刷新失败标记为 NeedAuth（触发 UI 重新登录）
 */
export class OAuthTokenRefresher {
  private refreshPromises = new Map<string, Promise<OAuthToken>>();
  private refreshTimers = new Map<string, NodeJS.Timeout>();

  async refresh(tokenCacheKey: string): Promise<OAuthToken> {
    const existing = this.refreshPromises.get(tokenCacheKey);
    if (existing) return existing;

    const promise = this.doRefresh(tokenCacheKey);
    this.refreshPromises.set(tokenCacheKey, promise);
    promise.finally(() => this.refreshPromises.delete(tokenCacheKey));

    return promise;
  }

  private async doRefresh(tokenCacheKey: string): Promise<OAuthToken> {
    const cache = await this.tokenCache.read();
    if (!cache?.token.refreshToken) throw new Error("No refresh token available");

    const response = await fetch(tokenUrl, { /* ... refresh body ... */ });
    const newToken = parseTokenResponse(await response.json());

    await this.tokenCache.write(newToken, cache.generation);
    this.scheduleNext(tokenCacheKey, newToken);
    return newToken;
  }

  scheduleNext(tokenCacheKey: string, token: OAuthToken): void {
    const now = Date.now();
    const refreshTime = token.expiresAt - REFRESH_BUFFER_MS; // 提前 5min
    const delay = Math.max(0, refreshTime - now);
    this.refreshTimers.set(tokenCacheKey, setTimeout(() => this.refresh(tokenCacheKey), delay));
  }
}
```

---

## 5. ChatGPT Plus 账号池

### 5.1 完整 OAuth PKCE 流

```typescript
// ============================================================
// chatgpt/account-pool.ts
// ============================================================

/**
 * ChatGPT Plus 账号池：
 * - 使用 OAuth PKCE 登录 chatgpt.com
 * - client_id: app_EMoamEEZ73f0CkXaXp7hrann (ChatGPT Plus OAuth App)
 * - 支持多账号管理
 */
export const CHATGPT_OAUTH_CONFIG: OAuthPKCEConfig = {
  kind: "pkce",
  authorizationEndpoint: "https://auth0.openai.com/authorize",
  tokenEndpoint: "https://auth0.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  redirectUri: "com.chatgpt://oauth/callback", // 桌面版 or http://localhost/callback
  codeChallengeMethod: "S256",
  scopes: ["openid", "email", "profile", "offline_access"],
  extraParams: {
    audience: "https://api.openai.com/v1",
    prompt: "login",
  },
};

export interface ChatGPTAccount {
  id: string;
  label: string;           // 显示名（如 "Plus-1"）
  email?: string;
  oauthEngine: OAuthEngine;
  quota: QuotaState;
  enabled: boolean;
  priority: number;
}
```

### 5.2 多账号路由

```typescript
// ============================================================
// chatgpt/account-route.ts
// ============================================================

/**
 * 账号路由策略（参考 Hermes credential_pool.py + OpenCodex routing.ts）：
 *
 * 1. 亲和性路由 (Affinity Routing):
 *    同一 session/request 尽量使用同一账号（缓存 session_key）
 *    通过 session_id → account_id 映射表实现
 *
 * 2. 最低使用率优先 (Least-Used):
 *    基于 quota.usagePercent（已用 / 总量 × 100）
 *    选择使用率最低的可用账号
 *
 * 3. 加权随机 (Weighted Random):
 *    根据账号 priority + 历史成功率加权
 *
 * 4. 故障转移 (Failover):
 *    当前账号出错 → 自动切换到下一个可用账号
 *    并标记为 cooldown（指数退避）
 */
export class ChatGPTAccountRouter {
  private accounts: ChatGPTAccount[];
  private affinityMap = new Map<string, string>(); // sessionId → accountId
  private cooldowns = new Map<string, number>();   // accountId → cooldownUntil

  selectAccount(sessionId?: string): ChatGPTAccount {
    // 1. 亲和性：同一 session 尽量使用同一账号
    if (sessionId) {
      const pinnedId = this.affinityMap.get(sessionId);
      if (pinnedId) {
        const account = this.accounts.find((a) => a.id === pinnedId && this.isAvailable(a));
        if (account) return account;
        // 亲和账号不可用 → 回退
        this.affinityMap.delete(sessionId);
      }
    }

    // 2. 过滤可用账号
    const available = this.accounts.filter((a) => this.isAvailable(a));
    if (available.length === 0) throw new Error("No available ChatGPT Plus accounts");

    // 3. 最低使用率优先 + 加权
    available.sort((a, b) => {
      const scoreA = this.accountScore(a);
      const scoreB = this.accountScore(b);
      return scoreB - scoreA; // 降序
    });

    const selected = available[0];
    if (sessionId) {
      this.affinityMap.set(sessionId, selected.id);
    }
    return selected;
  }

  private accountScore(account: ChatGPTAccount): number {
    const usagePenalty = account.quota.usagePercent / 100; // 0~1
    const cooldownPenalty = this.cooldowns.has(account.id) ? 100 : 0;
    const priorityScore = account.priority; // 1~100
    return priorityScore - usagePenalty * 50 - cooldownPenalty;
  }

  private isAvailable(account: ChatGPTAccount): boolean {
    if (!account.enabled) return false;
    const cooldownUntil = this.cooldowns.get(account.id);
    if (cooldownUntil && Date.now() < cooldownUntil) return false;
    return true;
  }

  recordFailure(accountId: string, cooldownMs?: number): void {
    this.cooldowns.set(accountId, Date.now() + (cooldownMs ?? 30_000));
  }

  release(sessionId: string): void {
    this.affinityMap.delete(sessionId);
  }
}
```

### 5.3 Token Guardian 后台守护刷新

```typescript
// ============================================================
// chatgpt/token-guardian.ts
// ============================================================

/**
 * Token Guardian:
 * - 后台定期检查所有账号的 token 状态
 * - 即将过期（< 30min）自动刷新
 * - 刷新失败发送告警
 * - 守护间隔 5 分钟
 *
 * 参考 OpenCodex token_refresh_guardian.py
 */
export class TokenGuardian {
  private timer?: NodeJS.Timeout;
  private readonly CHECK_INTERVAL = 5 * 60_000; // 5min
  private readonly REFRESH_THRESHOLD = 30 * 60_000; // 30min

  start(accounts: ChatGPTAccount[]): void {
    this.timer = setInterval(async () => {
      for (const account of accounts) {
        const token = await account.oauthEngine.getToken();
        if (token.expiresAt - Date.now() < this.REFRESH_THRESHOLD) {
          try {
            await account.oauthEngine.refresh();
          } catch (e) {
            console.error(`[TokenGuardian] Refresh failed for ${account.label}:`, e);
          }
        }
      }
    }, this.CHECK_INTERVAL);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
```

### 5.4 配额监控

```typescript
// ============================================================
// chatgpt/quota-monitor.ts
// ============================================================

export interface QuotaState {
  used: number;           // 已用配额 (tokens/requests)
  limit: number;          // 总量上限
  usagePercent: number;   // 使用率 (used/limit * 100)
  periodStart: number;    // 周期开始时间戳
  periodEnd: number;      // 周期结束时间戳 (reset time)
}

export class QuotaMonitor {
  private readonly THRESHOLD = 80; // >80% 自动切换

  checkAndSwitch(account: ChatGPTAccount, router: ChatGPTAccountRouter): ChatGPTAccount | null {
    if (account.quota.usagePercent > this.THRESHOLD) {
      // 标记冷却（直至周期重置）
      router.recordFailure(account.id, account.quota.periodEnd - Date.now());
      // 选下一个可用账号
      try {
        return router.selectAccount();
      } catch {
        return null; // 无可用账号
      }
    }
    return account;
  }
}
```

---

## 6. Channel 抽象层

### 6.1 ChannelType

```typescript
// ============================================================
// channel/channel-types.ts
// ============================================================

/**
 * Channel（渠道）是对 API 端点和访问方式的抽象。
 * 每个 Channel 聚合了：
 *   - baseUrl
 *   - AuthMethod
 *   - 限流/重试/超时策略
 *   - TLS 配置
 *   - 协议适配器
 */
export type ChannelType =
  | { kind: "direct"; baseUrl: string }
  | { kind: "openai-compatible"; baseUrl: string; apiVersion?: string }
  | { kind: "azure"; baseUrl: string; apiVersion: string; deploymentId: string }
  | { kind: "aws-bedrock"; region: string; modelId: string }
  | { kind: "ollama"; baseUrl: string }
  | { kind: "lm-studio"; baseUrl: string }
  | { kind: "reverse-proxy"; baseUrl: string; upstreamHeaders?: Record<string, string> }
  | { kind: "api-gateway"; baseUrl: string; gatewayType: "aws" | "gcp" | "azure" | "custom" }
  | { kind: "openrouter"; baseUrl?: string; extraHeaders?: Record<string, string> }
  | { kind: "china-relay"; relayType: "zhipu" | "baidu" | "ali" | "xunfei" | "moonshot" | "generic"; baseUrl: string };

export interface Channel {
  id: string;
  type: ChannelType;
  authMethod: AuthMethod;
  timeout: ChannelTimeouts;
  retry: ChannelRetryPolicy;
  rateLimit: RateLimitConfig;
  tls?: TLSConfig;
  health?: HealthCheckConfig;
  metadata?: Record<string, unknown>;
}

export interface ChannelTimeouts {
  request: number;      // 请求超时 ms
  firstByte: number;    // 首字节超时 ms
  idle: number;         // 流式空闲超时 ms
}

export interface ChannelRetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  totalBudgetMs: number;
  jitterRatio: number;
  retryableStatuses: number[]; // [429, 502, 503, 504]
}

export interface TLSConfig {
  clientCert?: SecretValue;   // TLS 客户端证书 (mTLS)
  clientKey?: SecretValue;    // TLS 客户端私钥
  caCert?: SecretValue;       // 自定义 CA
  insecureSkipVerify?: boolean;
}

export interface HealthCheckConfig {
  enabled: boolean;
  intervalMs: number;
  timeoutMs: number;
  path?: string;
  expectedStatus?: number;
}
```

### 6.2 多渠道路由

```typescript
// ============================================================
// channel/channel-router.ts
// ============================================================

export interface RouteRule {
  id: string;
  /** 模型匹配模式（glob/minimatch） */
  modelPattern: string;
  /** 渠道 ID 列表（按优先级排序） */
  channelIds: string[];
  /** 权重配置 */
  weights?: Record<string, number>; // channelId → weight
  /** 健康检查阈值：连续失败次数超过后标记 unhealthy */
  failureThreshold?: number;
  /** 冷却期 */
  cooldownMs?: number;
}

export class ChannelRouter {
  private rules: RouteRule[];
  private channels: Map<string, Channel>;
  private healthStatus: Map<string, ChannelHealth>;

  selectChannel(model: string, sessionId?: string): { channel: Channel; routeRule: RouteRule } {
    // 1. 匹配规则（按定义顺序）
    const rule = this.rules.find((r) => minimatch(model, r.modelPattern));
    if (!rule) throw new Error(`No route rule for model: ${model}`);

    // 2. 过滤健康渠道
    const candidates = rule.channelIds
      .map((id) => ({ id, channel: this.channels.get(id) }))
      .filter(({ id, channel }) => channel && this.isHealthy(id))
      .map(({ id, channel }) => ({
        channel: channel!,
        weight: rule.weights?.[id] ?? 1,
        priority: this.getPriority(id),
      }));

    if (candidates.length === 0) throw new Error(`No healthy channel for model: ${model}`);

    // 3. 加权随机选择
    const selected = weightedRandom(candidates, (c) => c.weight * c.priority);
    return { channel: selected.channel, routeRule: rule };
  }

  recordResult(channelId: string, ok: boolean, latencyMs?: number): void {
    const health = this.healthStatus.get(channelId) ?? this.newHealth();
    if (ok) {
      health.consecutiveFailures = 0;
      health.lastSuccessAt = Date.now();
      health.successCount++;
    } else {
      health.consecutiveFailures++;
      health.lastFailureAt = Date.now();
      health.failureCount++;
      if (health.consecutiveFailures >= (health.failureThreshold ?? 5)) {
        health.cooldownUntil = Date.now() + this.cooldownMs(health.consecutiveFailures);
      }
    }
    health.lastLatencyMs = latencyMs;
    this.healthStatus.set(channelId, health);
  }
}
```

### 6.3 TLS 客户端证书支持

```typescript
// ============================================================
// channel/tls-client.ts
// ============================================================

/**
 * mTLS 支持：
 * - 加载 PEM/DER 格式的客户端证书和私钥
 * - 创建 HTTPS Agent with cert/key
 * - 支持 PKCS#12 (.p12/.pfx) 格式
 *
 * 适用于企业内网 API Gateway / Reverse Proxy 场景。
 */
export class TLSClient {
  createAgent(tls: TLSConfig): https.Agent {
    const options: https.AgentOptions = {};
    if (tls.clientCert) {
      options.cert = this.loadCert(tls.clientCert);
      options.key = this.loadKey(tls.clientKey!);
    }
    if (tls.caCert) {
      options.ca = this.loadCA(tls.caCert);
    }
    if (tls.insecureSkipVerify) {
      options.rejectUnauthorized = false;
    }
    return new https.Agent(options);
  }
}
```

---

## 7. 国内市场特殊支持

### 7.1 API 中转站模式

```typescript
// ============================================================
// china-market/gateway-proxy.ts
// ============================================================

/**
 * 国内 API 中转站模式：
 * - 用户配置一个中转站 baseUrl
 * - 中转站转发到 智谱/百度/阿里 等
 * - 通过 path / header 指定目标服务商
 *
 * 典型配置：
 * {
 *   relayType: "generic",
 *   baseUrl: "https://api.gpt-school.com/v1",
 *   authMethod: { kind: "bearer", token: ... }
 * }
 */

export class ChinaGatewayProxy {
  adaptChannel(channel: Channel): Channel {
    if (channel.type.kind !== "china-relay") return channel;

    // 根据 relayType 添加额外的 path prefix / headers
    const adapted: Channel = {
      ...channel,
      authMethod: this.resolveRelayAuth(channel),
    };
    return adapted;
  }

  private resolveRelayAuth(channel: Channel): AuthMethod {
    const relay = channel.type as ChinaRelayType;
    switch (relay.relayType) {
      case "zhipu":
        return { kind: "bearer", token: channel.authMethod["key"] };
      case "baidu":
        return { kind: "bearer", token: channel.authMethod["key"] };
      case "ali":
        return { kind: "bearer", token: channel.authMethod["key"] };
      case "xunfei":
        return createXunfeiAuth(channel);
      case "moonshot":
        return { kind: "bearer", token: channel.authMethod["key"] };
      default:
        return channel.authMethod;
    }
  }
}
```

### 7.2 讯飞星火自定义签名

```typescript
// ============================================================
// china-market/xunfei-signature.ts
// ============================================================

/**
 * 讯飞星火 API 认证：
 * 使用 RFC 3986 规范的 HMAC-SHA256 签名
 * 请求头：Authorization: apikey ${apiKey}=${base64(HMAC-SHA256(signingKey, stringToSign))}
 */
export class XunfeiSignature {
  sign(method: string, url: string, body: string, apiKey: string, apiSecret: string): Record<string, string> {
    const now = new Date();
    const date = now.toUTCString();

    // 1. 构建 signature string
    const uri = new URL(url);
    const path = uri.pathname;
    const query = uri.searchParams.toString();
    const stringToSign = `${method}\n${path}\n${query}\n${date}`;

    // 2. HMAC-SHA256
    const hmac = crypto.createHmac("sha256", apiSecret);
    hmac.update(stringToSign);
    const signature = hmac.digest("base64");

    // 3. Authorization header
    const authorization = `apikey ${apiKey}=${signature}`;

    return {
      Authorization: authorization,
      Date: date,
    };
  }
}
```

### 7.3 多账号轮转

```typescript
// ============================================================
// china-market/account-rotation.ts
// ============================================================

/**
 * 国内服务商多账号轮转：
 * 遇到 429 / 401 时自动切换到下一个账号
 * 支持账号冷却（避免账号被 Ban）
 *
 * 参考 Hermes credential_pool.py
 */
export class ChinaAccountRotation {
  private accounts: Map<string, ChinaProviderAccount[]>; // providerId → accounts
  private currentIndex: Map<string, number>;             // providerId → current index

  async executeWithRotation<T>(
    providerId: string,
    fn: (account: ChinaProviderAccount) => Promise<T>,
  ): Promise<T> {
    const accounts = this.accounts.get(providerId);
    if (!accounts?.length) throw new Error(`No accounts for provider: ${providerId}`);

    const startIndex = this.currentIndex.get(providerId) ?? 0;
    const errors: Error[] = [];

    for (let i = 0; i < accounts.length; i++) {
      const idx = (startIndex + i) % accounts.length;
      const account = accounts[idx]!;

      if (this.isCooldown(account)) continue;

      try {
        const result = await fn(account);
        this.currentIndex.set(providerId, (idx + 1) % accounts.length);
        return result;
      } catch (e) {
        const err = e as Error;
        errors.push(err);
        if (isRateLimitError(err) || isAuthError(err)) {
          this.cooldown(account, 30_000); // 冷却 30s
          continue;
        }
        throw err; // 非限流错误直接抛出
      }
    }

    throw new AggregateError(errors, `All accounts exhausted for ${providerId}`);
  }
}
```

---

## 8. AuthProvider Trait 系统

### 8.1 TypeScript 侧

```typescript
// ============================================================
// auth/auth-provider.ts
// ============================================================

/**
 * AuthProvider 是认证方法的运行时接口。
 *
 * sign(request): 将认证信息注入到 HTTP 请求中（headers / query / body）
 * refresh():     刷新凭证（OAuth token refresh / API key rotation）
 * validate():    验证凭证是否有效
 */
export interface AuthProvider {
  readonly method: AuthMethod;
  readonly id: string;

  /** 注入认证信息到请求 */
  sign(request: HttpRequest): Promise<HttpRequest>;

  /** 刷新凭证（如果支持） */
  refresh(): Promise<void>;

  /** 验证凭证有效性 */
  validate(): Promise<ValidationResult>;

  /** 克隆（用于 chain 中的方法） */
  clone(): AuthProvider;
}

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  expiresAt?: number;
}

// ============================================================
// auth/registry.ts
// ============================================================

/**
 * AuthMethodRegistry：
 * - 注册 AuthProvider 工厂函数
 * - 支持自定义 AuthProvider 注册（AuthMethodCustom）
 * - 从 AuthMethod 类型创建 AuthProvider 实例
 */
export class AuthMethodRegistry {
  private providers = new Map<string, AuthProviderFactory>();
  private customHandlers = new Map<string, CustomAuthHandler>();

  register(kind: AuthMethod["kind"], factory: AuthProviderFactory): void;
  registerCustom(handlerId: string, handler: CustomAuthHandler): void;

  create(method: AuthMethod, options?: { storage: SecretStorage; httpClient?: HttpClient }): AuthProvider;
}

export type AuthProviderFactory = (method: AuthMethod, deps: AuthDependencies) => AuthProvider;

export interface CustomAuthHandler {
  sign(request: HttpRequest, config: Record<string, unknown>): Promise<HttpRequest>;
}
```

### 8.2 Rust 侧

```rust
// crates/secure-auth-core/src/lib.rs

#[async_trait]
pub trait AuthProvider: Send + Sync {
    fn method(&self) -> &AuthMethod;
    fn id(&self) -> &str;

    async fn sign(&self, request: &mut HttpRequest) -> Result<()>;
    async fn refresh(&mut self) -> Result<()>;
    async fn validate(&self) -> Result<ValidationResult>;
}

pub struct HttpRequest {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
}

pub struct ValidationResult {
    pub ok: bool,
    pub error: Option<String>,
    pub expires_at: Option<i64>,
}

// 各实现
pub struct BearerProvider { token: SecretValue }
pub struct ApiKeyProvider { key: SecretValue, header_name: String }
pub struct BasicProvider { username: String, password: SecretValue }
pub struct AwsSigV4Provider { ... }
pub struct AzureApiKeyProvider { key: SecretValue }
pub struct OAuthProvider { engine: OAuthEngine }
pub struct CustomProvider { handler_id: String, config: HashMap<String, JsonValue> }
pub struct ChainProvider { methods: Vec<Box<dyn AuthProvider>>, max_attempts: u32 }
```

---

## 9. 与现有 AccountCenterProviderClient 的集成方案

### 9.1 现状分析

现有 `provider-gateway.ts` 中：
- `ProviderCredentialSource`: `"account" | "api-key"` 两种类型
- `ProviderRouteOffer.credentialSource`: 每个路由的凭证源
- `ProviderCredentialResolver`: 解析凭证的回调

### 9.2 集成策略

```typescript
// ============================================================
// 集成适配器 (adapter.ts)
// ============================================================

import type { AuthMethod, AuthProvider, Channel } from "@crish/secure-auth";
import type { ProviderRouteOffer, ProviderFactoryPlan } from "@crish/agent-runtime";

/**
 * 将 AuthMethod + Channel 适配到现有 ProviderGateway 系统。
 *
 * 向后兼容：旧的 "api-key" credentialSource 自动转为 AuthMethodBearer。
 *
 * 保留字段：credentialSource 新增 type: "auth-method" 以引用 AuthMethod。
 */
export class AuthChannelAdapter {
  toRouteCredentialSource(authMethod: AuthMethod): ProviderCredentialSource {
    return {
      type: "auth-method",
      authMethodId: authMethod.id,
      // 保持向后兼容
      apiKey: authMethod.kind === "bearer" ? (authMethod as AuthMethodBearer).token : undefined,
    };
  }

  toProviderOptions(authProvider: AuthProvider, channel: Channel): Partial<OpenAICompatibleProviderOptions> {
    return {
      baseUrl: channelBaseUrl(channel),
      authHeader: authProviderToHeaderType(authProvider),
      headers: customHeaders ?? {},
      tlsConfig: channel.tls,
    };
  }
}

/**
 * CredentialResolver 适配器：
 * 将 AuthMethod 解析为现有的 ResolvedProviderCredential。
 */
export class AuthMethodCredentialResolver implements ProviderCredentialResolver {
  constructor(
    private readonly secretStorage: SecretStorage,
    private readonly authRegistry: AuthMethodRegistry,
  ) {}

  async resolveCredential(context: ProviderCredentialResolutionContext): Promise<ResolvedProviderCredential | null> {
    const source = context.credentialSource;
    if (source.type !== "auth-method") return null; // 向后兼容

    const authProvider = await this.authRegistry.createById(source.authMethodId);
    const method = authProvider.method;

    // 为 OpenAICompatibleProvider 构建标准 credential
    switch (method.kind) {
      case "bearer":
        return {
          id: method.id,
          source: "auth-method",
          providerId: context.route.providerId,
          apiKey: await this.secretStorage.read((method as AuthMethodBearer).token.ref),
          headers: { authorization: `Bearer ${apiKey}` },
        };

      case "api-key":
        const apiKeyMethod = method as AuthMethodApiKey;
        const key = await this.secretStorage.read(apiKeyMethod.key.ref);
        const headerName = apiKeyMethod.headerName ?? "x-api-key";
        return {
          id: method.id,
          source: "auth-method",
          providerId: context.route.providerId,
          apiKey: key,
          headers: { [headerName]: key },
        };

      case "aws-sig-v4":
        // AWS SigV4 需要 special provider（非 OpenAICompatibleProvider）
        // 使用 AwsBedrockProvider 替代
        return {
          id: method.id,
          source: "auth-method",
          providerId: context.route.providerId,
          metadata: { awsSigV4: true, ...(method as AuthMethodAwsSigV4) },
        };

      default:
        // OAuth / Custom / Chain → 返回特殊的 provider factory plan
        return {
          id: method.id,
          source: "auth-method",
          providerId: context.route.providerId,
          metadata: {
            useSecureAuthProvider: true,
            authMethodId: method.id,
          },
        };
    }
  }
}

/**
 * Provider Factory 适配：
 * 当 metadata.useSecureAuthProvider 为 true 时，
 * 使用 SecureAuthProvider（支持所有认证方式）替代 OpenAICompatibleProvider。
 */
export class SecureAuthProviderFactory {
  async create(plan: ProviderFactoryPlan): Promise<AgentProvider> {
    if (plan.credential.metadata?.useSecureAuthProvider) {
      const authProvider = await this.authRegistry.createById(plan.credential.metadata.authMethodId);
      return new SecureAuthWrappedProvider(authProvider, plan);
    }
    // 回退到现有 provider
    return new OpenAICompatibleProvider(plan.credential);
  }
}
```

### 9.3 SecureAuthWrappedProvider

```typescript
/**
 * SecureAuthWrappedProvider 是一个 AgentProvider 包装器，
 * 在每次 HTTP 请求之前调用 authProvider.sign() 注入认证信息。
 *
 * 这确保所有 9 种认证方式都能透明地工作。
 */
export class SecureAuthWrappedProvider implements AgentProvider {
  readonly id: string;

  constructor(
    private readonly authProvider: AuthProvider,
    private readonly plan: ProviderFactoryPlan,
  ) {}

  async *stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent> {
    // 1. 每次请求前调用 authProvider.sign() 注入动态认证
    const httpRequest = await this.authProvider.sign({
      url: this.resolveUrl(request),
      method: "POST",
      headers: {},
      body: JSON.stringify(this.buildRequestBody(request)),
    });

    // 2. 发起带认证的 HTTP 请求
    const response = await fetch(httpRequest.url, {
      method: httpRequest.method,
      headers: httpRequest.headers,
      body: httpRequest.body,
      signal: request.signal,
    });

    // 3. 解析流式响应
    yield* this.parseResponse(response);
  }

  private async refreshIfNeeded(response: Response): Promise<void> {
    if (response.status === 401 || response.status === 403) {
      await this.authProvider.refresh();
    }
  }
}
```

### 9.4 配置格式

```typescript
// 新的 providers.json 配置格式示例
{
  "providers": [
    {
      "id": "my-azure-openai",
      "authMethod": {
        "kind": "azure-api-key",
        "key": { "ref": "azure-openai-key" },
        "headerName": "api-key"
      },
      "channel": {
        "kind": "azure",
        "baseUrl": "https://my-resource.openai.azure.com",
        "apiVersion": "2024-02-15-preview",
        "deploymentId": "gpt-4"
      }
    },
    {
      "id": "my-aws-bedrock",
      "authMethod": {
        "kind": "aws-sig-v4",
        "accessKeyId": { "ref": "aws-access-key" },
        "secretAccessKey": { "ref": "aws-secret-key" },
        "region": "us-east-1",
        "service": "bedrock"
      },
      "channel": {
        "kind": "aws-bedrock",
        "region": "us-east-1",
        "modelId": "anthropic.claude-v3-sonnet"
      }
    },
    {
      "id": "chatgpt-pool",
      "authMethod": {
        "kind": "oauth",
        "flow": {
          "kind": "pkce",
          "clientId": "app_EMoamEEZ73f0CkXaXp7hrann",
          "scopes": ["openid", "email", "profile", "offline_access"]
        },
        "tokenCacheKey": "chatgpt-plus-1"
      },
      "channel": {
        "kind": "openai-compatible",
        "baseUrl": "https://api.openai.com/v1"
      }
    },
    {
      "id": "xunfei-spark",
      "authMethod": {
        "kind": "custom",
        "handlerId": "xunfei-signature",
        "config": {
          "apiKey": { "ref": "xunfei-api-key" },
          "apiSecret": { "ref": "xunfei-api-secret" },
          "appId": { "ref": "xunfei-app-id" }
        }
      },
      "channel": {
        "kind": "china-relay",
        "relayType": "xunfei",
        "baseUrl": "wss://spark-api.xf-yun.com/v3.1/chat"
      }
    }
  ],

  "routeRules": [
    {
      "id": "gpt4-route",
      "modelPattern": "gpt-4*",
      "channelIds": ["my-azure-openai", "chatgpt-pool"],
      "weights": { "my-azure-openai": 3, "chatgpt-pool": 1 }
    },
    {
      "id": "claude-route",
      "modelPattern": "claude-*",
      "channelIds": ["my-aws-bedrock"]
    },
    {
      "id": "spark-route",
      "modelPattern": "spark-*",
      "channelIds": ["xunfei-spark"]
    }
  ],

  "secrets": {
    "azure-openai-key": { "type": "keychain", "service": "conex", "account": "azure-openai" },
    "aws-access-key": { "type": "env", "varName": "AWS_ACCESS_KEY_ID" },
    "xunfei-api-key": { "type": "file", "path": "./secrets/xunfei.key" }
  }
}
```

---

## 10. 签名实现矩阵

| AuthMethod | 签名方式 | Header/位置 |
|---|---|---|
| **NoAuth** | 无 | — |
| **Bearer** | `Bearer ${token}` | `Authorization` |
| **ApiKey** | `${key}` | `X-Api-Key` / `api-key` / `Authorization` / query param |
| **Basic** | `Basic ${base64(username:password)}` | `Authorization` |
| **AwsSigV4** | AWS Signature V4 (`AWS4-HMAC-SHA256`) | `Authorization` + `X-Amz-Date` + `X-Amz-Security-Token` |
| **AzureApiKey** | `${key}` | `api-key` |
| **OAuth** | `Bearer ${accessToken}` | `Authorization` (动态注入) |
| **Custom** | 用户定义 | 用户定义 |
| **Chain** | 多方法按顺序 | 按第一个成功的方法 |

---

## 11. 实施路线

### Phase 1: Core AuthTypes + SecretStorage (Week 1-2)
- [ ] `secure-auth` package scaffold (TypeScript + Rust)
- [ ] `AuthMethod` discriminated union types + ts-rs export
- [ ] `SecretValue` / `SecretReference` types
- [ ] `SecretStorage` 三层架构实现（Layer2 AES-256 优先 + Layer3 后备）
- [ ] `AuthMethodRegistry` + `AuthProvider` trait

### Phase 2: OAuth Framework (Week 3-4)
- [ ] `OAuthEngine` + 状态机
- [ ] PKCE 流程（浏览器重定向）
- [ ] Device Code 流程（终端场景）
- [ ] Client Credentials 流程（M2M）
- [ ] Token 缓存 + CAS 跨进程安全
- [ ] 自动刷新器（single-flight + 定时器）

### Phase 3: ChatGPT Plus 账号池 (Week 5-6)
- [ ] ChatGPT OAuth PKCE 接入（client_id: `app_EMoamEEZ73f0CkXaXp7hrann`）
- [ ] 多账号路由（亲和性 + 最低使用率 + 故障转移）
- [ ] Token Guardian 后台守护
- [ ] 配额监控

### Phase 4: Channel 抽象 + 国内市场 (Week 7-8)
- [ ] Channel 类型系统 + 多渠道路由
- [ ] TLS mTLS 支持
- [ ] AWS SigV4 签名（Rust `ring` crate）
- [ ] 讯飞星火自定义签名
- [ ] 国内中转站模式 + 多账号轮转
- [ ] 合规适配

### Phase 5: 集成 + 迁移 (Week 9-10)
- [ ] `AuthChannelAdapter` 集成到 `provider-gateway.ts`
- [ ] `SecureAuthWrappedProvider` 替代 `OpenAICompatibleProvider` 方案
- [ ] 配置格式迁移
- [ ] 向后兼容层
- [ ] 全面测试 + 安全审计
