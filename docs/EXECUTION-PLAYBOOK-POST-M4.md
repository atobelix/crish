# Provider 系统后续执行手册 (Playbook)

> 基于 `PLAN-SYSTEMATIC-POST-M4.md` + 集成审计 + 安全审计生成。
> 用于多 Agent 调度：每项独立可执行，按逻辑依赖序排列。

---

## A. 运行时健全性（其他一切的基础）

### [A1] `initProviderEngine()` 调用点

**状态**: ✅ 已在 M4-R2 P0 修复轮次完成

**验证**: `packages/agent-daemon/src/index.ts:148` — `startDaemon()` 入口已调用 `initProviderEngine()`

---

### [A2] `factory.ts` 添加 `validateBaseUrl` 防御深度校验

**目标**: 使 `ProviderFactory` 不依赖 Gateway 单点验证 baseUrl

**源起**: 安全审计 §2.1 — SSRF 防护仅 `GatewayV2Bridge` 路径生效，`factory.createProvider()` 直连绕行；集成审计 §1 验证 `factory.ts:47` 绕过验证器

**涉及文件**:
- `packages/agent-runtime/src/provider/factory.ts:47` — `buildEngineOptions()` 中 `credential.baseUrl ?? decl.baseUrl` 处添加 `validateBaseUrl()` 调用
- `packages/agent-runtime/src/provider/auth/base-url-validator.ts` — 已有（被调用方）

**代码变更要点**:
1. 在 `factory.ts` 顶部添加 `import { validateBaseUrl } from "./auth/base-url-validator"`
2. 在 `buildEngineOptions()` 中 `const baseUrl = ...` 之后、使用之前，调用 `validateBaseUrl(baseUrl)` 并抛出配置错误
3. 错误由 `createProvider()` 调用方捕获

**验证方式**:
- 单元测试: `factory.test.ts` 添加 baseUrl 校验测试（合法/非法 URL）
- 集成测试: 通过 `GatewayV2Bridge` 调用 `factory.createProvider`，验证非法 baseUrl 被阻止

**前置依赖**: A1（Gateway 初始化）

---

### [A3] `AutoSecretStore` 实例化并注入

**目标**: daemon 初始化时创建 `AutoSecretStore`，使 credential 解析经过三层密钥存储

**源起**: 集成审计 §4 — "没有任何代码实例化 `AutoSecretStore`"

**涉及文件**:
- `packages/agent-daemon/src/index.ts` — 初始化路径
- `packages/agent-runtime/src/provider/auth/secret-store.ts` — `AutoSecretStore` 类（已有）
- `packages/agent-runtime/src/provider-gateway.ts` — 注入 `SecretStore` 到 `DefaultProviderGateway`

**代码变更要点**:
1. 在 daemon 初始化中创建 `new AutoSecretStore(path.join(homeDir, '.crish-secrets'))`
2. 将其传入 `LocalProviderCatalog` 或 `DefaultProviderGateway` 构造
3. `DefaultProviderGateway` 内部将 `SecretStore` 传给 `CredentialResolver`

**验证方式**:
- 单元测试: 验证 `AutoSecretStore` 实例化后 `store/load` 正确
- 集成测试: `provider-gateway.test.ts` 验证带 `SecretStore` 的 credential 解析路径

**前置依赖**: A1（Gateway 初始化）

---

### [A4] `CredentialResolver` 接入 provider-gateway

**目标**: gateway 的 credential 解析经过三层密钥存储而非直读 `apiKey` 字段

**源起**: 集成审计 §4 — "`CredentialResolver` 类未被 `provider-gateway.ts` 或 `GatewayV2Bridge` 使用"

**涉及文件**:
- `packages/agent-runtime/src/provider/auth/credential-resolver.ts` — 已有实现
- `packages/agent-runtime/src/provider-gateway.ts` — `resolveCredential()` 路径
- `packages/agent-runtime/src/provider/provider-gateway-v2.ts` — `getProviderFactory()` 路径

**代码变更要点**:
1. `DefaultProviderGateway` 构造时接收可选的 `CredentialResolver`
2. `resolveCredential()` 中先尝试 `credentialResolver.resolve()`，fallback 到直读 `apiKey` 字段
3. `GatewayV2Bridge.getProviderFactory()` 类似处理

**验证方式**:
- 单元测试: 验证 `CredentialResolver.resolve()` 在 secret store 命中 / 未命中时的行为
- 集成测试: 验证 `planRoute` + `resolveProvider` 全链路通过 `CredentialResolver`

**前置依赖**: A3（AutoSecretStore 实例化）

---

### [A5] `AuthMethod` 类型与 `ProviderCredentialSource` 类型统一桥接

**目标**: 消除 type gap，使两种类型体系可互转

**源起**: 集成审计 §4 — "`AuthMethod` 与 `ProviderCredentialSource` 之间存在 type gap"

**涉及文件**:
- `packages/agent-runtime/src/provider/auth/types.ts` — `AuthMethod` 定义
- `packages/agent-runtime/src/provider-gateway.ts:14-30` — `ProviderCredentialSource` 定义
- 新建或 `provider-gateway.ts` 中添加 `authMethodToCredentialSource()`

**代码变更要点**:
1. 在 `provider-gateway.ts` 或 `auth/types.ts` 中添加 `authMethodToCredentialSource(method: AuthMethod): ProviderCredentialSource`
2. 在 gateway credential 解析路径中调用此函数

**验证方式**:
- 单元测试: 验证 9 种 `AuthMethod` 到 `ProviderCredentialSource` 映射
- TypeScript 编译检查: 无类型错误

**前置依赖**: A1, A3

---

### [A6] `EngineOptions.apiKey` 类型改为 `SecretValue`

**状态**: ✅ 已在 M4 完成

**验证**: `packages/agent-runtime/src/provider/types.ts:17` — `apiKey?: SecretValue` 品牌类型已生效

---

### [A7] `factory.ts` HTTP 错误体经 `sanitizeForLog()` 脱敏

**目标**: 防止 provider 错误响应中的 API key 泄露到 `ProviderStreamEvent.error`

**源起**: 安全审计 §5.1 — `factory.ts:128` 输出 `body.slice(0, 200)` 可能包含 API key

**涉及文件**:
- `packages/agent-runtime/src/provider/factory.ts:124-130` — 非 2xx 响应处理
- `packages/agent-runtime/src/provider/auth/log-sanitizer.ts` — `sanitizeForLog()` 函数

**代码变更要点**:
1. 在 `factory.ts` 顶部添加 `import { sanitizeForLog } from "./auth/log-sanitizer"`
2. 第 129 行: `error: \`[${this.id}] ${response.status}: ${body.slice(0, 200)}\`` → `error: \`[${this.id}] ${response.status}: ${sanitizeForLog(body.slice(0, 200))}\``

**验证方式**:
- 单元测试: 模拟含 API key 的 provider 错误响应，验证脱敏后 error 消息
- 安全测试: 确认 `sk-proj-xxx` 模式被 `sanitizeForLog` 替换

**前置依赖**: 无

---

### [A8] `classifyError` 中未知错误类型 message 经 `sanitizeForLog()` 清洗

**目标**: 防止未知错误类型泄露 provider 返回的原始敏感数据

**源起**: 安全审计 §5.2 — `base-engine.ts:95` 未知错误返回原始 message；`factory.ts:119` 直接 `String(err)`

**涉及文件**:
- `packages/agent-runtime/src/provider/engines/base-engine.ts:95` — `classifyError` 未知分支
- `packages/agent-runtime/src/provider/factory.ts:119-121` — `catch` 块 `String(err)` 输出
- `packages/agent-runtime/src/provider/auth/log-sanitizer.ts`

**代码变更要点**:
1. `base-engine.ts` `classifyError` 的 unknown 分支: 返回消息前 `sanitizeForLog()`
2. `factory.ts:120`: `String(err)` → `sanitizeForLog(String(err))`

**验证方式**:
- 单元测试: 模拟含敏感数据的未知错误，验证 `classifyError` 返回脱敏消息
- 单元测试: 同 `factory.ts` catch 块

**前置依赖**: 无

---

## B. 数据持久化与迁移（存储层健全）

### [B1] `providerStore` 初始化时自动检测并迁移 v1 数据

**目标**: store 创建时自动检测 localStorage 中 `crish_provider_profiles_v1`，调用 `migrateFromV1()` 并清理旧 key

**源起**: 集成审计 §2 — "Store 创建时不会自动检测 localStorage 中是否存在 v1 数据"

**涉及文件**:
- `apps/crish-desktop/src/store/provider/providerStore.ts` — Zustand store
- `apps/crish-desktop/src/store/provider/migration.ts` — `migrateFromV1()`

**代码变更要点**:
1. 在 `providerStore.ts` 的 `create()` 回调中添加初始化逻辑
2. 检测 `crish_provider_profiles_v1` 是否存在
3. 存在则调用 `migrateFromV1()` 获取 `ProviderConfig[]`
4. 逐个 `addProvider()` 到 store
5. 删除旧 key: `localStorage.removeItem("crish_provider_profiles_v1")`

**验证方式**:
- 单元测试: 模拟 localStorage 含 v1 数据，验证 store 初始化后自动迁移
- 集成测试: store 初始化后查询 `providerStore` 包含迁移后的 provider

**前置依赖**: 无

---

### [B2] 审查 `providerProfiles.ts` 的双写路径

**目标**: 决定废弃 v1 代码或同步写 v2 store，消除双写不同步风险

**源起**: 集成审计 §2 — "`providerProfiles.ts:66` 仍在读写 `crish_provider_profiles_v1`"

**涉及文件**:
- `apps/crish-desktop/src/api/providerProfiles.ts:66` — `PROFILES_KEY = 'crish_provider_profiles_v1'`
- `apps/crish-desktop/src/store/provider/providerStore.ts` — v2 store key `crish_provider_store_v2`

**决策选项**:
- **选项 A**: 将 `providerProfiles.ts` 的 key 改为 v2，统一读写路径（推荐）— 但需评估 `providerProfiles.ts` 的 UI 调用方
- **选项 B**: `providerProfiles.ts` 写时同步写 v2 store，双写过渡
- **选项 C**: 标注 `providerProfiles.ts` 为 "待废弃"，引导调用方迁移到 Zustand store

**验证方式**:
- 审查后输出决策文档片段，标注在代码注释中
- 遵循决策执行代码变更

**前置依赖**: B1（v1→v2 迁移机制稳定后）

---

### [B3] `AccountStore.save()` 对敏感字段加密存储

**目标**: 真实加密存储 `accessToken` 和 `refreshToken`，当前存 `"***"` 导致 token 永久丢失

**源起**: 安全审计 §3.2 — "`save()` 写入了脱敏值，导致 token 被永久丢失"

**涉及文件**:
- `packages/agent-runtime/src/provider/auth/oauth/account-store.ts:20-24` — `save()` 中 `"***"` 占位
- `packages/agent-runtime/src/provider/auth/secret-store.ts` — `AutoSecretStore`
- `packages/agent-runtime/src/provider/auth/encrypted-file-store.ts` — `EncryptedFileSecretStore`

**代码变更要点**:
1. `AccountStore.save()` 使用 `SecretStore` 加密存储真实 token
2. token key 命名空间: `account:${accountId}:accessToken`、`account:${accountId}:refreshToken`
3. `save()` 中不再写入 `"***"` ，改为写入 hasKey 标记 + 密文存 SecretStore

**验证方式**:
- 单元测试: `AccountStore.save()` 后文件无明文 token
- 单元测试: `AccountStore.load()` 从 SecretStore 解密恢复
- 集成测试: 全链路 save → load → token 可用

**前置依赖**: A3（AutoSecretStore 实例化）

---

### [B4] `AccountStore.load()` 从 `SecretStore` 解密恢复 token

**目标**: `load()` 返回的 `ChatGPTAccount` 包含真实 token，而非 `"***"` 或 `null`

**源起**: 安全审计 §3.2 — "load() 返回的 ChatGPTAccount 中 accessToken 和 refreshToken 字段为 '***'"

**涉及文件**:
- `packages/agent-runtime/src/provider/auth/oauth/account-store.ts:29-37` — `load()`
- 同 B3 涉及的 SecretStore 文件

**代码变更要点**:
1. `AccountStore.load()` 在解析 JSON 后，调用 `SecretStore.load()` 获取真实 token
2. 回填 accessToken、refreshToken 到返回对象

**验证方式**:
- 单元测试: `save()` 后 `load()` 返回完整 token
- 边界: SecretStore 中 key 不存在时的 fallback 行为（如跨机器迁移场景）

**前置依赖**: B3（加密写入逻辑）

---

## C. 模型路由完备（路由决策链）

### [C1] `provider-gateway.ts` 的 `planRoute()` 中调用 `enrichProfileFromCatalog()`

**目标**: 使 `ProviderRouteOffer.modelProfile` 携带 `capabilityFlags` 和 `pricing`

**源起**: 集成审计 §5 — "`planRoute()` 直接使用 `ProviderRouteOffer.modelProfile` 字段（外部传入），不主动从 catalog 补充能力/定价"

**涉及文件**:
- `packages/agent-runtime/src/provider-gateway.ts:248-347` — `planWithRoute()`
- `packages/agent-runtime/src/model-routing.ts:505-535` — `enrichProfileFromCatalog()`

**代码变更要点**:
1. 在 `planWithRoute()` 中，对每个候选 route 的 `modelProfile` 调用 `enrichProfileFromCatalog(route.modelProfile, catalog)`
2. 更新后的 profile 回填到 route
3. ModelCatalog 实例需可访问（`DefaultProviderGateway` 已有 `catalog` 属性）

**验证方式**:
- 单元测试: `provider-gateway.test.ts` 验证 `planRoute` 后 `modelProfile` 含 `capabilityFlags` 和 `pricing`
- 集成测试: 通过 mock ModelCatalog 验证 enrich 调用

**前置依赖**: 无

---

### [C2] `callWithFallbackChain` 支持遍历完整 fallback list

**目标**: 当 `fallbackList[0]` 失败时尝试 `[1]`、`[2]`，而非立即终止

**源起**: 集成审计 §5 — "仅取 `fallbackList[0]`，不考虑多级 fallback"

**涉及文件**:
- `packages/agent-runtime/src/fallback-chain/engine.ts:54-104` — `callWithFallbackChain()`
- `packages/agent-runtime/src/fallback-chain/types.ts` — `FallbackConfig`

**代码变更要点**:
1. 维护 `fallbackListIndex` 替代硬编码 `[0]`
2. 每次 fallback 迭代：`nextId = fallbackList[fallbackListIndex]`，递增索引
3. `attemptedModels` 集合跟踪已试过的 provider，避免循环
4. 当 `fallbackListIndex >= fallbackList.length` 时停止

**验证方式**:
- 单元测试: 配置 3 级 fallback list，验证 3 次 fallback 尝试
- 边界测试: 重复 provider id 被跳过

**前置依赖**: 无

---

### [C3] `allocateModelRoles` 在无匹配时返回 `undefined` 而非 `profiles[0]`

**目标**: 使调用方能区分"匹配成功"和"无匹配取默认"

**源起**: 集成审计 §5 — "当无候选时返回 `profiles[0]`，调用方无法区分匹配状态"

**涉及文件**:
- `packages/agent-runtime/src/model-routing-roles.ts:215-243` — `allocateModelRoles()`
- 调用方：如 `model-routing.ts` 或 session 层

**代码变更要点**:
1. 当 `roleMap` 不存在或所有 `selectBestFit` 返回 `undefined` 时，将 `MultiModelAssignment.primary` 设为 `undefined`
2. 更新 `MultiModelAssignment` 类型使 `primary` 可选
3. 调用方检查 `primary === undefined` 并采取适当行动（如降级、报错）

**验证方式**:
- 单元测试: 传入空 `availableProfiles`，验证返回 `primary: undefined`
- 单元测试: 调用方正确处理 `undefined` 分支

**前置依赖**: 无

---

### [C4] `ModelCatalog` 默认 sourceUrl 配置

**目标**: 为内置 providers 添加 LiteLLM 同步 URL

**源起**: PLAN 规划 — "为内置 providers 添加 LiteLLM 同步 URL"

**涉及文件**:
- `packages/agent-runtime/src/model-catalog/types.ts` — `ModelCatalog` 类
- 可能配置文件或 `ModelCatalog` 构造参数

**代码变更要点**:
1. 在 `ModelCatalog` 构造函数或初始化中添加默认 `sourceUrl`（如 `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`）
2. 提供 `setDefaultSourceUrl()` 方法可在构造后覆盖
3. 内置 providers 注册时自动关联默认 sourceUrl

**验证方式**:
- 单元测试: 验证 `ModelCatalog` 初始化后 `sourceUrl` 默认值
- 集成测试: 远程同步后 `lookup()` 返回正确数据

**前置依赖**: 无

---

### [C5] 远程同步集成到 daemon 启动流程

**目标**: 异步初始化 `ModelCatalog` 的远程同步，缓存回退，可配置间隔

**源起**: PLAN 规划

**涉及文件**:
- `packages/agent-daemon/src/index.ts` — daemon 启动入口
- `packages/agent-runtime/src/model-catalog/types.ts` — `loadFromLiteLLM()`

**代码变更要点**:
1. 在 `startDaemon()` 中异步启动 `ModelCatalog.loadFromLiteLLM()`
2. 失败静默，使用本地缓存
3. 缓存文件路径: `path.join(daemonDataDir, 'model-catalog-cache.json')`
4. 可配置同步间隔（默认 24h）

**验证方式**:
- 单元测试: 模拟网络失败，验证 fallback 到缓存
- 集成测试: 完整 daemon 启动 → 模型路由使用远程数据

**前置依赖**: C4（sourceUrl 配置）

---

## D. OAuth 与账号管理（用户侧交互）

### [D1] OAuth PKCE 前端流程

**状态**: ✅ CSRF 防护已在 `oauth-flow.ts:52-54` 实现 — `exchangeCode()` 接受 `expectedState` 并验证

**说明**: 安全审计标记的 P0（state 未验证）已不存在。实际代码 `oauth-flow.ts:30-84` 中 `startPKCE()` 返回 `state`，`exchangeCode()` 参数签名已包含 `expectedState` 和 `receivedState` 并做比对。

---

### [D2] `AccountSettingsTab` 连接 `ChatGPTAccountPool` 后端

**目标**: UI 账号设置标签页具备添加/删除/刷新/状态查询能力

**源起**: PLAN 规划 — D2

**涉及文件**:
- `apps/crish-desktop/src/.../AccountSettingsTab.tsx` — UI 组件（位置待确认）
- `packages/agent-runtime/src/provider/auth/oauth/chatgpt-pool.ts` — `ChatGPTAccountPool`
- `packages/agent-runtime/src/provider/auth/oauth/account-store.ts` — `AccountStore`

**代码变更要点**:
1. `AccountSettingsTab` 组件调用 `ChatGPTAccountPool` 的公开 API
2. 添加账号: 调用 `pool.addAccount()`
3. 删除账号: 调用 `pool.removeAccount()`
4. 刷新: 调用 `pool.refreshToken()`
5. 状态查询: 调用 `pool.getStatus()`

**验证方式**:
- 单元测试: 验证池管理操作
- E2E: 点击 UI 的添加/删除按钮，验证状态变化

**前置依赖**: D3（状态实时反映）

---

### [D3] 账号状态实时反映到 UI

**目标**: Token 过期时间、用量状态、冷却状态实时更新

**源起**: PLAN 规划 — D3

**涉及文件**:
- 同 D2 的 UI 组件
- `packages/agent-runtime/src/provider/auth/oauth/chatgpt-pool.ts`
- store 层（Zustand 或类似）

**代码变更要点**:
1. 定义 `AccountStatus` 接口（含 `expiresAt`、`quotaRemaining`、`cooldownUntil` 等）
2. `ChatGPTAccountPool` 提供 `onStatusChange` 事件或 polling API
3. UI 订阅状态并渲染

**验证方式**:
- 单元测试: mock 池状态更新，验证事件分发
- E2E: 查看 UI 中状态字段随后端变化

**前置依赖**: D2（池连接）

---

### [D4] OAuth 回退机制

**目标**: 浏览器回调端口被阻断时提供手动粘贴 token 的 fallback

**源起**: PLAN 规划 — D4

**涉及文件**:
- `packages/agent-runtime/src/provider/auth/oauth/oauth-flow.ts` — OAuth 流程
- UI 组件 — 手动输入 token 面板

**代码变更要点**:
1. 在 OAuth 流程中添加"手动输入"模式
2. `exchangeCode()` 调用前检测本地回调服务器是否可用
3. 不可用时，显示 token 输入框供用户粘贴
4. 直接调用 `exchangeCode()` 的等效方法（将 code 设为用户输入值）

**验证方式**:
- 单元测试: 手动模式跳过回调服务器直接交换 token
- 集成测试: 阻断回调端口后流程仍可完成

**前置依赖**: D2

---

### [D5] `AccountStore` 持久化配置与 daemon 配置管道集成

**目标**: 通过 `update-config` WebSocket 同步账号数据

**源起**: PLAN 规划 — D5

**涉及文件**:
- `packages/agent-runtime/src/provider/auth/oauth/account-store.ts`
- `packages/agent-daemon/src/ws/update-config.ts` — WebSocket 配置更新

**代码变更要点**:
1. 账号状态变化时触发 `update-config` 事件
2. daemon 侧 `AccountStore` 监听事件并持久化
3. 反方向：daemon 启动时加载持久化账号状态

**验证方式**:
- 集成测试: 账号增删操作后 daemon 重启，状态恢复
- E2E: WebSocket 消息触发配置同步

**前置依赖**: B3, B4（AccountStore 加密存储）

---

## E. 流式执行与多模态（核心业务管线）

### [E1] `StreamingToolExecutor` 嵌入 `agent-session-loop` 主循环

**目标**: 流式 `tool_call` delta 到达时立即分发执行，无需等待完整响应

**源起**: PLAN 规划 — E1

**涉及文件**:
- `packages/agent-runtime/src/provider/streaming-tool-executor.ts` — 待确认是否存在/需新建
- `packages/agent-runtime/src/session/session-loop.ts` — 会话主循环
- `packages/agent-runtime/src/provider/engines/openai-compatible-engine.ts`

**代码变更要点**:
1. 创建或确认 `StreamingToolExecutor` 类，接收 `tool_call` delta 流
2. 在 `session-loop` 中，当流式事件类型为 `tool_call_delta` 时立即调用 executor
3. executor 结果缓存到会话上下文
4. 完整流结束后消费缓存结果

**验证方式**:
- 单元测试: mock streaming 事件，验证 tool_call delta 边收边分
- 集成测试: 通过 mock server 验证流式 tool 执行

**前置依赖**: 无

---

### [E2] 执行结果在流结束前回注后续 LLM 轮次

**目标**: 延迟降低

**源起**: PLAN 规划 — E2

**涉及文件**:
- `packages/agent-runtime/src/session/session-loop.ts`
- `packages/agent-runtime/src/provider/streaming-tool-executor.ts`

**代码变更要点**:
1. 在流结束前，将已完成的 tool 执行结果注入 LLM 下一轮请求
2. 保证执行结果按序回注

**验证方式**:
- 单元测试: 验证流结束前回注逻辑

**前置依赖**: E1

---

### [E3] 断路器

**目标**: 超时放弃、结果缓存、重试策略集成

**源起**: PLAN 规划 — E3

**涉及文件**:
- `packages/agent-runtime/src/provider/streaming-tool-executor.ts`
- `packages/agent-runtime/src/fallback-chain/engine.ts` — 已有重试/分类逻辑

**代码变更要点**:
1. 每个 tool 执行设置超时
2. 结果缓存（相同 tool+args 可复用）
3. 断路器状态：CLOSED / OPEN / HALF_OPEN

**验证方式**:
- 单元测试: 超时触发熔断、缓存命中跳过执行

**前置依赖**: E1

---

### [E4] 多模态管线在 `OpenAICompatibleEngine` 层统一处理

**目标**: image/audio/video content part 预处理

**源起**: PLAN 规划 — E4

**涉及文件**:
- `packages/agent-runtime/src/provider/engines/openai-compatible-engine.ts`
- `packages/agent-runtime/src/provider/engines/anthropic-messages-engine.ts`

**代码变更要点**:
1. 在 `buildRequest()` 中检测 `content` array 中的非 text part
2. 根据 provider 能力标志决定是否处理/转换
3. 统一预处理管线（如 base64 编码、URL 转换）

**验证方式**:
- 单元测试: mock 多模态请求，验证 buildRequest 输出

**前置依赖**: E6（能力标志控制路由）

---

### [E5] 多模态用量统计

**目标**: token 估算接入引擎层记账

**源起**: PLAN 规划 — E5

**涉及文件**:
- `packages/agent-runtime/src/provider/engines/base-engine.ts` — `estimateTokens()`
- `packages/agent-runtime/src/provider/factory.ts` — 或更上层

**代码变更要点**:
1. 在引擎层添加多模态 token 估算（image 按分辨率换算 token）
2. 结果计入 `ProviderStreamEvent` 用量信息

**验证方式**:
- 单元测试: 验证 image token 估算公式

**前置依赖**: E4

---

### [E6] provider 能力标志中的 `vision`/`multimodal` 控制路由选择

**目标**: 路由决策根据模型的 `vision`/`multimodal` 能力标志过滤候选

**源起**: PLAN 规划 — E6

**涉及文件**:
- `packages/agent-runtime/src/model-routing.ts` — `scoreProfile()`
- `packages/agent-runtime/src/provider-gateway.ts` — `planRoute()`
- `packages/agent-runtime/src/provider/declarative-schema.ts` — `capabilities` 字段

**代码变更要点**:
1. 在 `planRoute()` 能力匹配中检查 `capabilityFlags.vision` 和 `capabilityFlags.multimodal`
2. 若请求需多模态支持，过滤掉无对应标志的候选

**验证方式**:
- 单元测试: 含 vision 请求 vs 不含 vision 的 route 过滤

**前置依赖**: C1（catalog 连接）

---

## F. 安全加固（纵深防御）

### [F1] `providerId` 字符白名单

**目标**: 限制只允许 `[a-zA-Z0-9_-]`

**源起**: 安全审计 §4.4 — "declarative-schema.ts:2 中 `providerId: string` 无字符白名单"

**涉及文件**:
- `packages/agent-runtime/src/provider/declarative-schema.ts:2` — `DeclarativeProviderDef.providerId`

**代码变更要点**:
1. 在 `normalizeDeclarativeDef()` 中添加 `providerId` 校验
2. 不匹配 `^[a-zA-Z0-9_-]{1,64}$` 时抛出验证错误

**验证方式**:
- 单元测试: 合法/非法 providerId 分别验证

**前置依赖**: 无

---

### [F2] `model.id` 长度限制

**目标**: 最大 128 字符

**源起**: 安全审计 §4.3 — "declarative-schema.ts:19 中 `id: string` 无长度限制"

**涉及文件**:
- `packages/agent-runtime/src/provider/declarative-schema.ts:19` — `models[].id`

**代码变更要点**:
1. 在 `normalizeDeclarativeDef()` 中的 models.map() 回调内
2. 对 `m.id` 添加长度校验（`<= 128`）

**验证方式**:
- 单元测试: 超长 model id 被拒绝

**前置依赖**: 无

---

### [F3] `normalizeDeclarativeDef` 拒绝未知字段

**目标**: 添加 `additionalProperties: false` 校验

**源起**: 安全审计 §4.2 — "normalizeDeclarativeDef 接受未知字段，不符合'默认拒绝'原则"

**涉及文件**:
- `packages/agent-runtime/src/provider/declarative-schema.ts:95-142` — `normalizeDeclarativeDef()`

**代码变更要点**:
1. 在函数开头检测 `raw` 对象中是否存在 `DeclarativeProviderDef` 接口之外的字段
2. 发现未知字段时抛出验证错误（或 console.warn + 忽略）

**验证方式**:
- 单元测试: 传入含未知字段的 raw def，验证抛出错误

**前置依赖**: 无

---

### [F4] 加密文件权限 `0o600`

**目标**: `EncryptedFileStore.writeVault()` 设置文件权限

**源起**: 安全审计 §1.4 — "未设置文件权限，多用户系统上其他用户可读取 vault"

**涉及文件**:
- `packages/agent-runtime/src/provider/auth/encrypted-file-store.ts:70-81` — `writeVault()`

**代码变更要点**:
1. `fs.writeFileSync()` 后调用 `fs.chmodSync(this.vaultPath(), 0o600)`
2. Windows 上仅设置 owner 读写，组和其他用户无权限

**验证方式**:
- 单元测试: 创建 vault 后检查文件权限（POSIX: `fs.statSync().mode`）

**前置依赖**: 无

---

### [F5] 加密文件默认主密钥熵增强

**目标**: 替代基于 `COMPUTERNAME + USERNAME + hostname()` 的可预测 fallback

**源起**: 安全审计 §1.3 — "在域环境中可预测"

**涉及文件**:
- `packages/agent-runtime/src/provider/auth/encrypted-file-store.ts:30-32` — `get password()`

**代码变更要点**:
1. 移除 `COMPUTERNAME + USERNAME + hostname()` 拼接
2. 替换为随机生成并持久化的主密钥（首次运行时生成 32 字节随机值，存入 `~/.crish-master-key`）
3. 旧密钥文件自动迁移

**验证方式**:
- 单元测试: 验证新主密钥为 32 字节随机值
- 迁移测试: 有旧 vault 文件时能正常读取

**前置依赖**: 无

---

### [F6] `cargo-audit` 集成到 CI

**目标**: 在 CI pipeline 中添加 Rust 依赖安全审计

**源起**: 安全审计 §6.2 — "cargo audit 不可用"

**涉及文件**:
- `.github/workflows/` — 对应 workflow YAML
- 可能需 `Cargo.toml` 添加 `[workspace.metadata]` 配置

**代码变更要点**:
1. 在 CI workflow 中添加 step: `cargo install cargo-audit && cargo audit`
2. 配置 `--deny warnings` 使 advisory 导致构建失败

**验证方式**:
- 手动运行 `cargo audit` 验证无 advisory
- 触发 CI 确认步骤执行

**前置依赖**: 无

---

### [F7] `npm audit fix` 修复 existing moderate 漏洞

**目标**: 修复 `@hono/node-server` 和 `esbuild` 的 moderate 漏洞

**源起**: 安全审计 §6.1

**涉及文件**:
- `package.json` / `yarn.lock` / `package-lock.json` — 依赖版本

**代码变更要点**:
1. 运行 `npm audit fix` 或手动升级依赖到修复版本
2. `@hono/node-server` ≥ 2.0.5
3. `esbuild` > 0.28.0

**验证方式**:
- `npm audit` 确认漏洞消失
- 构建和测试通过

**前置依赖**: 无

---

### [F8] DNS rebinding 防护评估

**目标**: 评估当前字符串比较不防御 DNS rebinding 的风险

**源起**: 安全审计 §2.2 — "当前验证基于主机名字符串比较，不防御 DNS rebinding"

**涉及文件**:
- `packages/agent-runtime/src/provider/auth/base-url-validator.ts`
- 评估后可能的修复文件

**评估内容**:
1. 研究 Conex 使用场景中 DNS rebinding 攻击的实际可行性
2. 确定是否需要二次验证（如建立连接后 IP 回检）
3. 输出评估结论

**验证方式**:
- 评估文档记录在安全审计附件中

**前置依赖**: 无

---

## G. 文档与模板（开发者体验）

### [G1] `CONTRIBUTING-PROVIDERS.md` 已验证与最新 schema 一致

**状态**: ✅ 已在 M4-R2 P0 修复轮次完成

**验证**: 文档内容已匹配 `DeclarativeProviderDef` 新 schema（使用 `providerId`、`auth.type`、`auth.defaultEnvVar`、`engine: "anthropic-messages"` 等）

---

### [G2] `templates/provider.*.json` 更新到 `DeclarativeProviderDef` 新 schema

**目标**: 当前模板使用旧 `id`/`version`/`pathPrefix`/`auth.method` 格式，与新的 `DeclarativeProviderDef` 不兼容

**源起**: 集成审计 §7 — P1 建议

**涉及文件**:
- `templates/provider.openai-compatible.json`
- `templates/provider.ollama.json`
- `templates/provider.anthropic.json`

**代码变更要点** (每个模板文件):
1. 替换 `id` → `providerId`
2. 移除 `version`
3. `auth.method` → `auth.type`
4. `auth.apiKeyEnv` → `auth.defaultEnvVar`
5. 移除 `pathPrefix`（已废弃）
6. 使用 `models[].id` 规格
7. 使用 `capabilities` 对象替代 `features`
8. 添加 `metadata` 等新字段

**验证方式**:
- `provider-validate.ts` 对新模板文件通过验证
- `normalizeDeclarativeDef()` 模板后无错误

**前置依赖**: 无

---

### [G3] `ARCHITECTURE.md` AuthMethod 数量修正为 9

**目标**: 文档写 8 种，实际代码定义 9 种（含 `chain`）

**源起**: 集成审计 §7

**涉及文件**:
- `docs/ARCHITECTURE.md` — AuthMethod 数量描述

**代码变更要点**:
1. 搜索 `"8 种"` 或 `"eight"` 替换为 `"9 种"`
2. 在 AuthMethod 列表中增加 `chain` 说明

**验证方式**:
- grep 确认文档中无 "8 种 AuthMethod" 字样

**前置依赖**: 无

---

### [G4] 确认 `crish` CLI 是否注册 `provider` 子命令

**目标**: 如未注册，在 package.json `bin` 中添加

**源起**: 集成审计 §7 — "`crish` CLI 可能不存在或未正确路由到此脚本"

**涉及文件**:
- `packages/agent-runtime/package.json` — `bin` 字段
- `packages/agent-runtime/src/provider/cli/main.ts` — CLI 入口

**代码变更要点**:
1. 检查 `package.json` 中 `bin` 字段是否包含 `crish-provider` 或类似子命令
2. 如缺少，添加:
   ```json
   "bin": {
     "crish": "./dist/cli/main.js"
   }
   ```
3. 确保 `main.ts` 解析子命令 `provider validate`、`provider test` 等

**验证方式**:
- `npx crish provider validate --help` 输出正确
- `npx crish provider test --help` 输出正确

**前置依赖**: 无

---

## H. CI 与自动化测试（质量保障）

### [H1] `LlmApiMockServer` E2E 测试集成到 CI pipeline

**目标**: 测试文件存在但未编排，需集成到 CI

**源起**: PLAN 规划 — H1

**涉及文件**:
- `packages/agent-runtime/src/__tests__/e2e/llm-api-mock-server.test.ts` — 待确认
- `.github/workflows/` — CI workflow YAML

**代码变更要点**:
1. 确认测试文件位置和运行命令
2. 在 CI workflow 中添加 E2E job
3. 确保 mock server 在测试前启动

**验证方式**:
- CI pipeline 中 E2E job 通过
- 本地 `npm run test:e2e` 通过

**前置依赖**: 无

---

### [H2] 启用在 M2-R3-A1 创建的 `provider-validation.yml` workflow

**目标**: 该 workflow 文件已存在但未启用

**源起**: PLAN 规划 — H2

**涉及文件**:
- `.github/workflows/provider-validation.yml`

**代码变更要点**:
1. 检查 workflow 的 `on:` 触发条件
2. 确保在 `pull_request` 和 `push` 到 main 时触发
3. 验证 job 配置正确

**验证方式**:
- PR 创建后自动触发 workflow
- workflow 步骤: `provider-validate.ts` + `provider-test.ts`

**前置依赖**: 无

---

### [H3] E2E job 覆盖全部三家引擎

**目标**: OpenAI/Anthropic/Ollama 的 mock 场景

**源起**: PLAN 规划 — H3

**涉及文件**:
- `packages/agent-runtime/src/__tests__/e2e/` — E2E 测试
- `.github/workflows/` — CI workflow

**代码变更要点**:
1. 创建或扩展 E2E 测试覆盖三家引擎的 mock 场景
2. 每个场景至少包含: 流式响应、工具调用、错误处理
3. CI 中并行运行

**验证方式**:
- CI pipeline 三家引擎 mock 测试全部通过

**前置依赖**: H1（mock server 就绪）

---

### [H4] Rust 基准测试 `cargo bench -p conex-stream` CI 步骤

**目标**: 在 CI 中运行 Rust 基准测试，防止性能退化

**源起**: PLAN 规划 — H4

**涉及文件**:
- `.github/workflows/benchmark.yml` 或 CI workflow
- `Cargo.toml` — `[dev-dependencies]` 含 `criterion`

**代码变更要点**:
1. 在 CI 中添加 bench step
2. 使用 `cargo bench -p conex-stream` 运行
3. 可选: 与基准分支对比

**验证方式**:
- CI pipeline 中 bench 步骤执行成功
- 输出性能指标

**前置依赖**: 无

---

### [H5] TypeScript 基准测试 `vitest bench` CI 步骤

**目标**: 在 CI 中运行 TypeScript 基准测试，防止性能退化

**源起**: PLAN 规划 — H5

**涉及文件**:
- `.github/workflows/benchmark.yml` 或 CI workflow
- `vitest.config.ts` — benche 配置

**代码变更要点**:
1. 在 CI 中添加 bench step
2. 使用 `npx vitest bench` 运行
3. 确保配置文件包含 `@vitest/bench` 插件

**验证方式**:
- CI pipeline 中 bench 步骤执行成功
- 输出性能指标

**前置依赖**: 无

---

## I. 生态建设（面向社区）

### [I1] `community/providers/` 目录建立

**目标**: 接受 PR 提交新 Provider JSON

**源起**: PLAN 规划 — I1

**涉及文件**:
- `community/providers/` — 新建目录
- 可能需 README.md 说明提交流程

**代码变更要点**:
1. 创建目录 `community/providers/`
2. 添加 `.gitkeep` 或初始 JSON 示例
3. 添加目录说明

**验证方式**:
- `ls community/providers/` 存在

**前置依赖**: 无

---

### [I2] CI 自动运行 `provider-validate.ts` + `provider-test.ts` 验证 PR

**目标**: PR 提交新 Provider JSON 时自动验证

**源起**: PLAN 规划 — I2

**涉及文件**:
- `.github/workflows/provider-validation.yml` — 同 H2

**代码变更要点**:
1. 在 workflow 中添加路径过滤: `community/providers/**`
2. 对新提交或修改的 JSON 文件运行 `provider-validate.ts`
3. 运行 `provider-test.ts` 进行功能测试

**验证方式**:
- PR 修改 `community/providers/` 下的 JSON 时 workflow 触发

**前置依赖**: H2（workflow 启用）, I1（目录就绪）

---

### [I3] `conex provider install <id>` 命令行支持远程市场安装

**目标**: 从远程市场索引安装 Provider

**源起**: PLAN 规划 — I3

**涉及文件**:
- `packages/agent-runtime/src/provider/cli/main.ts` — CLI 入口
- `packages/agent-runtime/src/provider/cli/provider-install.ts` — 新建

**代码变更要点**:
1. 注册 `install` 子命令
2. 从 `providers.conex.dev/index.json` 获取索引
3. 下载对应 JSON 并注册到本地 provider registry

**验证方式**:
- `conex provider install <id>` 下载并注册
- 单元测试: mock 远程索引

**前置依赖**: I5（远程索引）

---

### [I4] 兼容性矩阵 HTML/JSON 报告生成

**目标**: 生成 Provider 兼容性报告

**源起**: PLAN 规划 — I4

**涉及文件**:
- `packages/agent-runtime/src/provider/cli/provider-compatibility.ts` — 新建
- 输出目录: `reports/`

**代码变更要点**:
1. 遍历所有已注册 provider
2. 对每个 provider 测试模拟请求
3. 生成兼容性矩阵（HTML + JSON 格式）

**验证方式**:
- `conex provider compatibility` 生成 HTML 报告

**前置依赖**: 无

---

### [I5] 远程 Provider 索引 `providers.conex.dev/index.json`

**目标**: 建立远程索引供 `install` 命令使用

**源起**: PLAN 规划 — I5

**涉及文件**:
- 远程服务 `providers.conex.dev/index.json`
- 或本地构建脚本生成

**代码变更要点**:
1. 定义索引 JSON 结构
2. CI 中自动从 `community/providers/` 构建索引
3. 部署到 `providers.conex.dev`

**验证方式**:
- `curl providers.conex.dev/index.json` 返回有效 JSON

**前置依赖**: I1（community/providers/ 目录）

---

## 附录: 跨类别依赖图

```
A1 (done)
 ├─→ A2 ──→ (防御深度)
 ├─→ A3 ──→ A4 ──→ A5
 └─→ (基础)
A7, A8 (独立)
B1 ──→ B2
B3 (依赖 A3) ──→ B4 ──→ D5
C1, C2, C3 (并行)
C4 ──→ C5
D2 ──→ D3 ──→ D4 ──→ D5
E1 ──→ E2 ──→ E3
E4 ──→ E5 ──→ E6 (依赖 C1)
F1, F2, F3, F4, F5, F6, F7, F8 (独立)
G2, G3, G4 (独立)
H1, H2, H3 (串行)
H4, H5 (独立)
I1 ──→ I2 ──→ I3 ──→ I5
I4 (独立)
```

### 执行顺序建议

| Pass | 条目 | 理由 |
|------|------|------|
| **Pass 1** | A2, A3, A7, A8, F1–F5, F7 | A 类基础安全 + 独立安全加固 |
| **Pass 2** | B1, B3, C1–C3, G2–G4 | 依赖 Pass 1 后的核心功能补全 |
| **Pass 3** | C5, D2, E1, H1–H2 | 需核心运行时稳定后接入 |
| **Pass 4** | B2, B4, D3–D5, C4, E2–E6 | 依赖 Pass 2+3 |
| **Pass 5** | F6, F8, H3–H5, I1–I5 | 生态 + CI 加固（靠后但独立） |
