# M1-M4 Provider 系统集成审计报告

**审计日期**: 2026-07-23
**审计范围**: M1 Gateway / M2 Store / M3 Engine–Gateway / M4 Auth + 模型路由 + 导出 + 文档一致性
**审计方法**: 静态源码分析 + 接口契约验证

---

## 1. Gateway 集成

| 检查项 | 状态 | 说明 |
|--------|------|------|
| `provider-gateway.ts` → `GatewayV2Bridge` 导入 | ✅ 通过 | `provider-gateway.ts:12` 正确 import `GatewayV2Bridge` |
| `initProviderEngine()` 是否定义 | ✅ 通过 | 定义于 `provider-gateway.ts:913`，创建单例 `GatewayV2Bridge` |
| `initProviderEngine()` 是否被调用 | ❌ 失败 | **没有任何 daemon/session 初始化代码调用 `initProviderEngine()`**。仅在 `provider-gateway.ts` 中定义，其余代码从未 import 它。运行时 `_gatewayBridge` 始终为 null，`getGatewayBridge()` 会抛出"未初始化"异常。 |
| `resolveProviderViaBridge()` 是否正确处理 `ProviderRoutePlan` | ✅ 通过 | `provider-gateway.ts:930-940` 逻辑正确：获取 bridge → `getProviderFactory()` → 调用 factory(plan) → 返回 `AgentProvider` |
| `getProviderFactory()` 中 `validateBaseUrl` 使用 | ✅ 通过 | `provider-gateway-v2.ts:46` 在返回 factory 回调内进行 SSRF 校验 |
| SSRF 在 credential 解析路径中的覆盖 | ✅ 通过 | `provider-gateway.ts:429,452` 两处均调用 `validateBaseUrl` |

### 修复建议

**P0** — 在 daemon 初始化入口（如 `runtime-components/` 或 `session.ts`）添加 `initProviderEngine()` 调用。当前系统无人初始化 gateway bridge，导致 `resolveProviderViaBridge()` 在生产路径上永远返回 null。

---

## 2. Store 集成

| 检查项 | 状态 | 说明 |
|--------|------|------|
| `providerStore` (Zustand) 定义 | ✅ 通过 | `apps/crish-desktop/src/store/provider/providerStore.ts:49` |
| Store key 名称 | ✅ 通过 | 使用 `crish_provider_store_v2`（line 99） |
| `migrateFromV1()` 定义 | ✅ 通过 | `apps/crish-desktop/src/store/provider/migration.ts:16` |
| V1 key 名称正确 | ✅ 通过 | 读取 `crish_provider_profiles_v1`（line 3） |
| V1 → V2 格式转换逻辑 | ✅ 通过 | 将 OldProviderProfile → ProviderConfig，engineType 映射正确 |
| `migrateFromV1()` 是否正确导出 | ✅ 通过 | `provider/index.ts:2` 导出 `migrateFromV1` |
| Store 是否有自动迁移触发器 | ⚠️ 警告 | **无**。Store 创建时不会自动检测 localStorage 中是否存在 v1 数据。调用方需手动执行 `migrateFromV1()` 后逐个 `addProvider()`。 |
| V1 旧代码是否同时写两个 key | ⚠️ 警告 | `providerProfiles.ts:66` 仍在读写 `crish_provider_profiles_v1`。存在双写不同步风险。 |

### 修复建议

**P1** — 在 `providerStore.ts` 的 `create()` 回调中添加初始化逻辑：
```ts
const oldData = localStorage.getItem("crish_provider_profiles_v1");
if (oldData) {
  const migrated = migrateFromV1();
  for (const p of migrated) state.providers.set(p.id, p);
  localStorage.removeItem("crish_provider_profiles_v1");
}
```

**P2** — 审查 `providerProfiles.ts` 是否应双写 v2 store，或完全废弃 v1 代码路径。

---

## 3. Engine → Gateway 集成

| 检查项 | 状态 | 说明 |
|--------|------|------|
| `OpenAICompatibleEngine` 注册 | ✅ 通过 | `factory.ts:15` — `this.registerEngine(new OpenAICompatibleEngine())` |
| `AnthropicMessagesEngine` 注册 | ✅ 通过 | `factory.ts:16` |
| `OllamaEngine` 注册 | ✅ 通过 | `factory.ts:17` |
| Engine 接口实现完整性 | ✅ 通过 | 三者均实现 `Engine` 接口：`buildRequest()` + `parseStream()` + `parseResponse()` |
| `EngineProvider.stream()` 调用 `engine.buildRequest()` | ✅ 通过 | `factory.ts:106` |
| `EngineProvider.stream()` 调用 `fetchWithRetry()` | ✅ 通过 | `factory.ts:110` |
| `EngineProvider` 实现 `AgentProvider` 接口 | ✅ 通过 | `factory.ts:80` — 含 `readonly id` + `stream()` |
| `ProviderFactory` 构造时接收 `ProviderRegistry` | ✅ 通过 | `factory.ts:13-14` |
| gateway-v2 的 `getProviderFactory()` 返回工厂函数 | ✅ 通过 | `provider-gateway-v2.ts:39-55` |

### 修复建议

无。Engine 注册链路完全正确。

---

## 4. Auth 集成

| 检查项 | 状态 | 说明 |
|--------|------|------|
| `AuthMethod` 类型定义 | ✅ 通过 | `auth/types.ts:13-22` — 9 种类型（含 `chain`） |
| `AuthMethod` 是否被 `provider-gateway.ts` 使用 | ❌ 失败 | `provider-gateway.ts` **未导入/依赖** `AuthMethod`。gateway 使用自己的 `ProviderCredentialSource` / `ResolvedProviderCredential` 类型，与 `AuthMethod` 彼此独立且无转换桥接 |
| `SecretStore` 接口定义 | ✅ 通过 | `auth/secret-store.ts:6-11` |
| `AutoSecretStore` 实现 | ✅ 通过 | `auth/secret-store.ts:69-126` — 3 层（keychain, encrypted-file, env-var） |
| `AutoSecretStore` 是否在 daemon 初始化时被调用 | ❌ 失败 | **没有任何代码实例化 `AutoSecretStore`**。整个 `agent-runtime` 和 `apps/` 中无 `new AutoSecretStore` 调用。credential 解析走的 `provider-gateway.ts` 直接 `apiKey` 字段路径，完全绕过了 SecretStore |
| `CredentialResolver` 是否连接 SecretStore | ✅ 通过 | `auth/credential-resolver.ts:37-46` 支持 `secretStore.load()` |
| `CredentialResolver` 是否被使用 | ❌ 失败 | `CredentialResolver` 类未被 `provider-gateway.ts` 或 `GatewayV2Bridge` 使用 |
| `base-url-validator.ts` 是否在 `provider-gateway.ts` 中使用 | ✅ 通过 | `provider-gateway.ts:11` import，在 `resolveCredential()` 中两次调用 |
| `base-url-validator.ts` 是否在 `GatewayV2Bridge` 中使用 | ✅ 通过 | `provider-gateway-v2.ts:5` import，在 `getProviderFactory()` 中调用 |
| `base-url-validator.test.ts` 存在性 | ✅ 通过 | `auth/base-url-validator.test.ts` — 18 个测试用例 |
| SSRF 规则完善度 | ✅ 通过 | 覆盖 private IPv4/IPv6、localhost、metadata 服务、link-local、unsupported scheme |

### 修复建议

**P1** — `AuthMethod` 与 `ProviderCredentialSource` 之间存在 type gap。建议在 `provider-gateway.ts` 中添加 `authMethodToCredentialSource()` 转换函数，或统一两种类型体系。

**P1** — 在 daemon 初始化路径中创建 `AutoSecretStore` 实例（例如 `new AutoSecretStore(path.join(homeDir, '.crish-secrets'))`），并注入到 `DefaultProviderGateway` 的 `credentialResolver` 中。

---

## 5. 模型路由集成

| 检查项 | 状态 | 说明 |
|--------|------|------|
| `ModelCatalog` 类定义 | ✅ 通过 | `model-catalog/types.ts:45-108` — 含 `lookup()` / `loadFromLiteLLM()` |
| `enrichProfileFromCatalog()` 定义 | ✅ 通过 | `model-routing.ts:505-535` — 正确调用 `catalog.lookup()` |
| `scoreProfileWithCost()` 定义 | ✅ 通过 | `model-routing-enhanced.ts:19-71` — 正确调用 `scoreProfile()` |
| `scoreProfile()` 定义 | ✅ 通过 | `model-routing.ts:656-723` — 9 维评分 |
| `allocateModelRoles()` 定义 | ✅ 通过 | `model-routing-roles.ts:215-243` — 5 种角色映射 |
| `provider-gateway.ts` 是否调用 `enrichProfileFromCatalog()` | ⚠️ 警告 | **否**。`provider-gateway.ts` 的 `planRoute()` 直接使用 `ProviderRouteOffer.modelProfile` 字段（外部传入），不主动从 catalog 补充能力/定价 |
| `callWithFallbackChain()` 定义 | ✅ 通过 | `fallback-chain/engine.ts:43-105` |
| `callWithFallbackChain()` 是否兼容 `AgentProvider.stream()` | ✅ 通过 | 接收 `AgentProvider`，调用 `currentProvider.stream(request)`，返回 `AsyncIterable<ProviderStreamEvent>` |
| `callWithFallbackChain()` 的 fallback 选择 | ⚠️ 警告 | 仅取 `fallbackList[0]`（第一个兜底）。不考虑多级 fallback 列表、健康评分或并发重试 |
| `allocateModelRoles()` 的降级逻辑 | ⚠️ 警告 | 当无候选时返回 `profiles[0]`（原始列表第一个），而非 `null` 或 sentinel。调用方无法区分"匹配成功"和"无匹配取默认" |

### 修复建议

**P2** — 在 `provider-gateway.ts` 的 `planRoute()` 中或 route 构造阶段，添加 `enrichProfileFromCatalog()` 调用链路，使 `ProviderRouteOffer.modelProfile` 能够携带 `capabilityFlags` 和 `pricing`。

**P2** — `callWithFallbackChain` 的各级 fallback 策略仅取 `fallbackList[0]`，建议支持遍历整个 fallback list。

**P3** — `allocateModelRoles` 当无匹配时应返回 `undefined` 而非 `profiles[0]`，避免静默降级。

---

## 6. 新模块导出

| 检查项 | 状态 | 说明 |
|--------|------|------|
| `provider/index.ts` 导出 `DeclarativeProviderDef` | ✅ 通过 | line 1 |
| `provider/index.ts` 导出 `normalizeDeclarativeDef` | ✅ 通过 | line 2 |
| `provider/index.ts` 导出 `ProviderRegistry` | ✅ 通过 | line 4 |
| `provider/index.ts` 导出 `DeclarativeLoader` | ✅ 通过 | line 5 |
| `provider/index.ts` 导出 `ProviderFactory` / `EngineProvider` | ✅ 通过 | line 6 |
| `provider/index.ts` 导出 `Engine` 类型 | ✅ 通过 | line 7 |
| `provider/index.ts` 导出 `GatewayV2Bridge` | ✅ 通过 | line 8 |
| `provider/index.ts` 导出三种 Engine 类 | ✅ 通过 | lines 11-17 |
| `provider/index.ts` 导出 `AuthMethod` / `SecretValue` | ✅ 通过 | lines 29-31 |
| `provider/index.ts` 导出 `AutoSecretStore` | ✅ 通过 | line 24 |
| `provider/index.ts` 导出 `validateBaseUrl` | ✅ 通过 | line 27 |
| `provider/index.ts` 导出 CLI 函数 | ✅ 通过 | lines 40-44 |
| `provider/index.ts` 导出 `registerBuiltinProviders` | ✅ 通过 | line 48 |
| `src/index.ts` 包含 `export * from './provider'` | ✅ 通过 | line 102 |
| `src/index.ts` 包含旧 provider-gateway 兼容导出 | ✅ 通过 | lines 35-36（`./provider-gateway`, `./provider-cache-hints`） |
| Engine 的 barrel export (`engines/index.ts`) | ✅ 通过 | 正确重导出四种 engine |
| Auth 的 barrel export (`auth/index.ts`) | ✅ 通过 | 正确重导出所有 auth 模块 |
| CLI 的 barrel export (`cli/index.ts`) | ✅ 通过 | 正确重导出所有 CLI 函数 |
| 内置 provider 注册 (`builtin/index.ts`) | ✅ 通过 | 扫描目录 + 逐个调用 `registerFromFile` |

### 修复建议

无。模块导出体系完整且正确。

---

## 7. 文档与实际代码的一致性

| 检查项 | 状态 | 说明 |
|--------|------|------|
| `ARCHITECTURE.md` 文件结构 vs 实际目录 | ✅ 通过 | 列出的 16 个文件/子目录完整匹配 |
| `ARCHITECTURE.md` 核心流图 vs 代码逻辑 | ✅ 通过 | Startup Sequence 和 Request Flow 匹配代码 |
| `ARCHITECTURE.md` 描述的 Engine 接口 | ✅ 通过 | 三个引擎，接口方法一致 |
| `ARCHITECTURE.md` 描述 `AuthMethod` 8 种 | ⚠️ 警告 | 实际代码定义 **9 种**（含 `chain`）。文档缺 `chain` |
| `CONTRIBUTING-PROVIDERS.md` JSON schema `id` 字段 | ❌ 失败 | 文档使用 `id`（line 57），实际 `DeclarativeProviderDef` 使用 **`providerId`** |
| `CONTRIBUTING-PROVIDERS.md` JSON schema `version` 字段 | ❌ 失败 | 文档要求 `version: "1.0"`，实际 schema **无 `version` 字段** |
| `CONTRIBUTING-PROVIDERS.md` 引擎名称 | ❌ 失败 | 文档使用 `"anthropic"` + `"gemini"`，实际引擎为 **`"anthropic-messages"`**，且**不存在 `gemini` 引擎**（新系统中 Gemini 走 `openai-compatible`） |
| `CONTRIBUTING-PROVIDERS.md` `auth.method` vs 实际 `auth.type` | ❌ 失败 | 文档用 `method`（line 132），实际 schema 用 **`type`** |
| `CONTRIBUTING-PROVIDERS.md` `auth.apiKeyEnv` vs 实际 `auth.defaultEnvVar` | ❌ 失败 | 文档用 `apiKeyEnv`（line 133），实际 schema 用 **`defaultEnvVar`** |
| `CONTRIBUTING-PROVIDERS.md` 模板文件路径 | ✅ 通过 | `templates/provider.openai-compatible.json` 存在（但模板格式是**旧 schema**，与新 `DeclarativeProviderDef` 不匹配） |
| `CONTRIBUTING-PROVIDERS.md` CLI 命令 | ⚠️ 警告 | 文档写 `npx crish provider validate`（line 38），实际 CLI 入口是 **`npx tsx packages/agent-runtime/src/provider/cli/main.ts validate`**。`crish` CLI 可能不存在或未正确路由到此脚本 |
| `ARCHITECTURE.md` CLI 命令路径 | ⚠️ 警告 | `ARCHITECTURE.md:276` 写 `npx tsx packages/agent-runtime/src/provider/cli/provider-validate.ts`，但实际 CLI **main.ts** 优先，直接调用 `provider-validate.ts` 绕过 main 的 registry 初始化 |
| 文档描述的内置 provider 数量 | ✅ 通过 | ARCHITECTURE.md 说"12+ providers"，实际有 **33 个** JSON 文件（超预期，无问题） |

### 修复建议

**P0** — 重写 `CONTRIBUTING-PROVIDERS.md` 使其匹配新的 `DeclarativeProviderDef` schema（使用 `providerId`、`auth.type`、`auth.defaultEnvVar`、`engine: "anthropic-messages"` 等）。删除 `gemini` 引擎示例，或说明 Gemini 通过 `openai-compatible` 引擎接入。

**P1** — 更新 `templates/provider.*.json` 使其与新 schema 一致，或移除旧格式模板。当前模板使用旧 `id`/`version`/`pathPrefix`/`auth.method` 格式，与 `DeclarativeProviderDef` 不兼容。

**P2** — 修复 `ARCHITECTURE.md` AuthMethod 数量（8 → 9）。

**P2** — 确认 `crish` CLI 是否已注册 `provider` 子命令。如未注册，需在 package.json 的 `bin` 字段中添加或提供 `npx tsx` 调用方式。

---

## 汇总

| 集成域 | ✅ 通过 | ⚠️ 警告 | ❌ 失败 | 关键问题 |
|--------|--------|---------|--------|----------|
| 1. Gateway | 5 | 0 | 1 | `initProviderEngine()` 未被调用 |
| 2. Store | 6 | 2 | 0 | 无自动迁移触发器；v1 旧代码仍在写 |
| 3. Engine→Gateway | 8 | 0 | 0 | — |
| 4. Auth | 5 | 0 | 3 | `AuthMethod` 未接入 gateway；SecretStore 未初始化；CredentialResolver 未使用 |
| 5. 模型路由 | 6 | 3 | 0 | catalog 与 gateway 未连接；fallback 策略过浅 |
| 6. 导出 | 20 | 0 | 0 | — |
| 7. 文档一致性 | 5 | 3 | 6 | CONTRIBUTING-PROVIDERS.md 严重过时 |
| **总计** | **55** | **8** | **10** | |

### P0 行动项（影响运行时正确性）

1. **Gateway 未初始化** — 添加 daemon 入口调用 `initProviderEngine()`
2. **文档 schema 严重过时** — 重写 `CONTRIBUTING-PROVIDERS.md` 匹配新的 `DeclarativeProviderDef`

### P1 行动项（影响功能和可维护性）

1. **Store 自动迁移** — providerStore 初始化时自动检测并迁移 v1 数据
2. **AuthSecret 未连接** — daemon 初始化 `AutoSecretStore` 并注入 credential resolver
3. **AuthMethod 类型 gap** — 统一 `AuthMethod` 与 `ProviderCredentialSource`
4. **模板文件更新** — 同步 `templates/provider.*.json` 格式

### P2 行动项（优化和降级风险）

1. **模型路由 → gateway 链路** — `planRoute()` 中调用 `enrichProfileFromCatalog()`
2. **FallbackChain 策略** — 支持多级 fallback 列表遍历
3. **`allocateModelRoles` 降级** — 返回 `undefined` 而非 `profiles[0]`
4. **CLI 注册** — 确认 `crish provider` 子命令可用
