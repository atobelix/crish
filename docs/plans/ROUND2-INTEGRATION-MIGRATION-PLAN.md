# Round 2 集成与迁移计划

> 基于 Round 1 五个设计方案，将 Provider 后端、UI 设置页、认证渠道、模型适配、路由能力整合到现有 Conex 代码库。

---

## 目录

1. [依赖关系图与模块集成](#1-依赖关系图与模块集成)
2. [四里程碑渐进迁移策略](#2-四里程碑渐进迁移策略)
3. [兼容层设计](#3-兼容层设计)
4. [Feature Flags 机制](#4-feature-flags-机制)
5. [文件变更清单](#5-文件变更清单)

---

## 1. 依赖关系图与模块集成

### 1.1 总体包依赖（防止循环依赖）

```
packages/shared-types          (纯类型：无运行时依赖)
       ↑
packages/shared-utils          (纯工具函数：无内部依赖)
       ↑
packages/agent-runtime         (核心运行时：provider / stream / routing / model)
       ↑                               ↑
packages/decision-engine       (路由策略)  packages/agent-daemon   (daemon 协议)
       ↑                               ↑
packages/agent-orchestrator    (编排层)
       ↑
apps/crish-desktop             (桌面 UI)
```

**关键规则**：
- `agent-runtime` 不可依赖 `decision-engine`、`agent-daemon`、`agent-orchestrator`
- `decision-engine` 可依赖 `agent-runtime`（仅类型导入，不循环）
- `agent-orchestrator` 可依赖 `agent-runtime` + `decision-engine`
- UI 层只依赖 `agent-runtime`（类型）+ 自身 `api/` 目录

### 1.2 模块内部依赖图

```
┌─────────────────────────────────────────────────────┐
│                  ProviderRegistry                    │
│  register(id, EngineProvider)                        │
│  get(id): EngineProvider                             │
│  listEngines(): EngineProviderMeta[]                 │
└──────────────────┬──────────────────────────────────┘
                   │ 引用 EngineProvider 接口
                   ▼
┌─────────────────────────────────────────────────────┐
│                EngineProvider 接口                    │
│  + id: string                                       │
│  + stream(req): AsyncIterable<ProviderStreamEvent>   │
└──────────────────┬──────────────────────────────────┘
          ┌────────┼────────────┐
          ▼        ▼            ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  OpenAIEngine    │ │ AnthropicEngine │ │  OllamaEngine    │
│  (新)            │ │ (新)            │ │ (新)            │
│  基于            │ │ 原生 Messages   │ │ 原生 Ollama      │
│  openai-req-build│ │  API           │ │  API            │
└─────────────────┘ └─────────────────┘ └─────────────────┘
          │                │                  │
          └────────────────┼──────────────────┘
                           ▼
┌──────────────────────────────────────────────────────┐
│                 ProviderGateway (新)                  │
│  接收 ProviderRouteOffer → 路由选择 → 凭证解析        │
│  → 调用 ProviderRegistry.get(engineId) → 实例化      │
│                                                      │
│  旧 provider-gateway.ts → 保持兼容 → 逐步迁移        │
└─────────────────────┬────────────────────────────────┘
                      │ 引用 ModelProfile
                      ▼
┌──────────────────────────────────────────────────────┐
│                    ModelCatalog                       │
│  + 声明式 JSON 填充                                 │
│  + 混合检测（静态 profile + 运行时检测）             │
│  + 成本感知评分                                      │
│  + 多模型角色                                        │
│  + FallbackChainEngine                               │
└─────────────────────┬────────────────────────────────┘
                      │ 消费 AuthMethod
                      ▼
┌──────────────────────────────────────────────────────┐
│              AuthChannelAdapter                       │
│  包装 EngineProvider，在 stream() 调用前注入凭证      │
│  引用 9 种 AuthMethod（api-key / oauth2 / account.. ）│
│  3 层密钥存储（session → Tauri DPAPI → LS fallback） │
└─────────────────────┬────────────────────────────────┘
                      │ 产出 ProviderStreamEvent
                      ▼
┌──────────────────────────────────────────────────────┐
│              StreamParser (6 种)                      │
│  OpenAI | Anthropic | Gemini | Ollama | AWS Bedrock  │
│  | 多模态管线                                         │
│  + ThinkingConfig + ToolStream                       │
│  + StreamingToolExecutor                              │
└──────────────────────────────────────────────────────┘
```

### 1.3 关键集成点

#### 1.3.1 ProviderFactory → ProviderGateway

```
旧 provider-factory.ts（已标记 @deprecated）:
  - register(kind, class) → create(kind, config)
  - 宽接口 AgentProvider（stream/complete/embed/health）
  - 与 types.AgentProvider 不一致

新设计:
  ProviderRegistry.register(id, EngineProviderFactory)
  ProviderGateway.resolveProvider(request) → 内部调用:
    1. catalog.listRoutes(request) → 得到 ProviderRouteOffer
    2. credentialResolver.resolveCredential(route, request)
    3. ProviderRegistry.get(offer.providerId).create(plan)
    4. AuthChannelAdapter.wrap(engine) → 返回 AgentProvider

集成方式:
  - 新建 src/provider-registry.ts
  - 新建 src/provider-gateway-v2.ts
  - provider-factory.ts 标记清除目标: M4
  - M1–M3: provider-factory.ts 保留，新 Gateway 调用 Registry
```

#### 1.3.2 ModelCatalog → ModelProfile

```
旧 model-routing.ts:
  - routeModelByCapability(profiles, request, policy)
  - ModelProfile 接口
  - profileFromProviderRouteOffer(offer)

新 ModelCatalog:
  - 从声明式 JSON 填充 ModelProfile[]
  - 混合检测（扫描 provider 的 /v1/models 端点 → 补充 profile）
  - 成本感知评分（按 token 价格自动计算 costTier）
  - 返回 ModelRouteDecision（复用已有类型）

集成方式:
  - 新建 src/model-catalog.ts
  - 扩展已有 ModelProfile（新增 pricePer1KPromptTokens 等字段）
  - 复用 model-routing.ts 的 routeModelByCapability()
  - profileFromProviderRouteOffer() 作为兼容桥
```

#### 1.3.3 AuthChannelAdapter → EngineProvider

```
当前现状:
  - providerProfiles.ts: AuthType / OAuthConfig / OAuthTokenData 类型已定义
  - setProfileKey() / resolveProfileApiKey() 处理密钥存储
  - 3 层密钥: session Map → Tauri DPAPI → LS 明文 fallback
  - 密钥在 EngineConfigUpdate 时通过 updateEngineConfig 推给 daemon

新 AuthChannelAdapter:
  - 接收 ProviderRouteOffer → 解析 credentialSource
  - 调用 AuthResolver.resolve(credentialSource)
  - 组装 fetch headers（Authorization / x-api-key / Cookie 等）
  - 返回包装后的 EngineProvider（在 stream() 前注入凭证）

集成方式:
  - 新建 src/auth/auth-channel-adapter.ts
  - 新建 src/auth/auth-resolver.ts（引用 providerProfiles 的 resolveProfileApiKey）
  - 新建 src/auth/auth-method-types.ts（9 种 AuthMethod 类型定义）
  - 现有 providerProfiles.ts 的密钥路径保持不动 + 新增 OAuth 流程
  - 适配注意: AuthChannelAdapter 运行在 daemon/agent-runtime 侧，不可直接引用 UI 的 localStorage
```

#### 1.3.4 StreamParser 替代旧 stream-parse 模块

```
现有模块:
  - openai-stream-parse.ts   (332 行，SSE 分帧 + JSON 解析)
  - anthropic-stream-parse.ts (395 行，Anthropic 事件 → ProviderStreamEvent)
  - gemini-stream-parse.ts
  - tool-stream/tool-stream.ts (332 行，工具调用累积引擎)

新 StreamParser 架构（统一接口）:
  interface StreamParser {
    parse(response: Response, signal?: AbortSignal): AsyncIterable<ProviderStreamEvent>;
  }

具体的 6 个实现:
  - OpenAIChatStreamParser     (包装 openai-stream-parse + 增量解析)
  - OpenAIResponsesStreamParser (新: Responses API 格式)
  - AnthropicStreamParser      (包装 anthropic-stream-parse)
  - GeminiStreamParser         (包装 gemini-stream-parse)
  - OllamaStreamParser         (新: 原生 Ollama API)
  - MultimodalStreamParser     (新: 多模态管线)

集成方式:
  - 新建 src/stream-parser/ 目录，含 parser-interface.ts + 6 个实现
  - 旧文件保持不动（过渡期被新 parser import）
  - EngineProvider 内部调用 parser.parse()
  - M4: 旧的 stream-parse.ts 迁移到新目录后删除原文件
```

### 1.4 循环依赖预防矩阵

| 导入方 \ 被导入方 | types | provider-registry | provider-gateway-v2 | model-catalog | auth-channel | stream-parser |
|---|---|---|---|---|---|---|
| provider-registry | ✅ | - | ❌ | ❌ | ❌ | ❌ |
| provider-gateway-v2 | ✅ | ✅ | - | ✅ (type) | ✅ | ❌ |
| model-catalog | ✅ | ❌ | ❌ | - | ❌ | ❌ |
| auth-channel | ✅ | ❌ | ❌ | ❌ | - | ❌ |
| stream-parser | ✅ | ❌ | ❌ | ❌ | ❌ | - |
| engine-* | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## 2. 四里程碑渐进迁移策略

### 2.1 总览路线图

```
M1 (1-2 周)      M2 (2-3 周)      M3 (2-3 周)       M4 (1-2 周)
──────────      ──────────      ──────────        ──────────
基础设施         引擎迁移          高级功能           全量上线

Registry        Engine 接入      ChatGPT 账号池     OAuth 框架
Engine 框架      Gateway v2      回退链引擎         30+ 声明式供应商
声明式 JSON      路由整合          多模态管线          路由规则 UI
AuthMethod 类型  设置 UI 基础      思考模式            旧代码清理
                旧 Gateway 兼容    StreamingTool      provider-factory
                桥                Executor v2        删除
                ModelCatalog v1
```

### 2.2 M1：基础设施（1-2 周）

**目标**：建立 ProviderRegistry + EngineProvider 接口 + 声明式 JSON Schema + AuthMethod 类型体系。

#### 新增文件

| 文件路径 | 说明 |
|---|---|
| `packages/agent-runtime/src/provider-registry.ts` | ProviderRegistry 实现 |
| `packages/agent-runtime/src/engine-provider.ts` | EngineProvider 接口定义 |
| `packages/agent-runtime/src/engine-openai.ts` | OpenAI 引擎（从 provider-openai-compatible.ts 提取核心） |
| `packages/agent-runtime/src/engine-anthropic.ts` | Anthropic 引擎（包装 provider-anthropic.ts） |
| `packages/agent-runtime/src/engine-ollama.ts` | Ollama 原生引擎（新） |
| `packages/agent-runtime/src/declarative/declarative-schema.ts` | 声明式 JSON Schema 类型 |
| `packages/agent-runtime/src/declarative/declarative-parser.ts` | 声明式 JSON → ProviderRouteOffer[] |
| `packages/agent-runtime/src/declarative/builtin-providers.ts` | 内置 10 个声明式供应商 |
| `packages/agent-runtime/src/auth/auth-method-types.ts` | 9 种 AuthMethod 类型 |
| `packages/agent-runtime/src/auth/auth-resolver.ts` | 凭证解析（session → DPAPI → LS） |
| `packages/agent-runtime/src/stream-parser/parser-interface.ts` | StreamParser 接口 |

#### 修改文件

| 文件路径 | 变更 |
|---|---|
| `packages/agent-runtime/src/types.ts` | 新增 EngineProvider 类型（或独立文件） |
| `packages/agent-runtime/src/provider-gateway.ts` | 新增 `engineId` 字段到 ProviderRouteOffer |
| `packages/shared-types/src/index.ts` | 导出新类型 |
| `packages/agent-runtime/package.json` | 更新导出映射 |

#### 测试文件

| 文件路径 | 说明 |
|---|---|
| `packages/agent-runtime/src/provider-registry.test.ts` | Registry 注册/查找/生命周期 |
| `packages/agent-runtime/src/declarative/declarative-parser.test.ts` | JSON 解析验证 |
| `packages/agent-runtime/src/auth/auth-resolver.test.ts` | 凭证解析链路 |
| `packages/agent-runtime/src/engine-openai.test.ts` | OpenAI 引擎单元测试 |

#### Feature Flag

```typescript
// packages/agent-runtime/src/feature-flags.ts
export const FEATURE_FLAGS = {
  M1_PROVIDER_REGISTRY: true,   // M1 默认启用
  M2_GATEWAY_V2: false,         // M2 启用
  M3_ACCOUNT_POOL: false,       // M3 启用
  M3_FALLBACK_CHAIN: false,     // M3 启用
  M4_OAUTH_FRAMEWORK: false,    // M4 启用
  M4_CLEANUP: false,            // M4 启用
};
```

#### 验证标准

- [ ] `ProviderRegistry.register()` / `get()` / `list()` 通过测试
- [ ] OpenAI 引擎可通过 Registry 创建并完成 stream() 调用
- [ ] 声明式 JSON 可解析为 ProviderRouteOffer[]
- [ ] 9 种 AuthMethod 类型编译通过
- [ ] 所有旧测试用例仍然通过

### 2.3 M2：引擎迁移（2-3 周）

**目标**：现有 provider 迁移到新 Engine 体系 + ProviderGateway v2 + 模型路由整合 + 设置 UI 基础。

#### 新增文件

| 文件路径 | 说明 |
|---|---|
| `packages/agent-runtime/src/provider-gateway-v2.ts` | 新一代 ProviderGateway |
| `packages/agent-runtime/src/model-catalog.ts` | ModelCatalog（声明式 + 混合检测） |
| `packages/agent-runtime/src/compat/route-offer-compat.ts` | 新旧 ProviderRouteOffer 兼容桥 |
| `packages/agent-runtime/src/compat/gateway-compat.ts` | 旧 Gateway → 新 Gateway 适配器 |
| `packages/agent-runtime/src/compat/engine-compat.ts` | 旧 AgentProvider → EngineProvider 适配器 |
| `apps/crish-desktop/src/components/ProviderSettingsTab.tsx` | 新 Provider 设置拆分面板 |
| `apps/crish-desktop/src/components/RoutingSettingsTab.tsx` | 路由规则设置页 |
| `apps/crish-desktop/src/components/AccountSettingsTab.tsx` | 账户设置页 |
| `apps/crish-desktop/src/components/settings/SettingsSidebar.tsx` | 设置侧边栏组件 |
| `apps/crish-desktop/src/api/providerStore.ts` | 新 ProviderStore（替代部分 localStorage） |
| `apps/crish-desktop/src/api/modelCatalogApi.ts` | 模型目录 API 前端调用 |

#### 修改文件

| 文件路径 | 变更 |
|---|---|
| `packages/agent-runtime/src/provider-openai-compatible.ts` | 内部调用 OpenAIEngine（保持导出兼容） |
| `packages/agent-runtime/src/provider-anthropic.ts` | 内部调用 AnthropicEngine（保持导出兼容） |
| `packages/agent-runtime/src/provider-gateway.ts` | 添加 `@deprecated` 标记，委托到 v2 |
| `packages/agent-runtime/src/model-routing.ts` | 新增 `modelProfileFromDeclarative()` 函数 |
| `packages/agent-runtime/src/index.ts` | 导出新模块 |
| `apps/crish-desktop/src/components/ModelsSettingsTab.tsx` | 添加 feature flag 检测，新面板启用时展示 |
| `apps/crish-desktop/src/components/SettingsPanel.tsx` | 添加新 tab 入口 |
| `apps/crish-desktop/src/api/providerProfiles.ts` | 新增 ProviderStore 同步钩子 |

#### 兼容桥核心代码设计

```typescript
// compat/route-offer-compat.ts
// 旧 ProviderRouteOffer（provider-gateway.ts） → 新 ProviderRouteOffer
export function toNewRouteOffer(old: OldProviderRouteOffer): NewProviderRouteOffer {
  return {
    id: old.id,
    model: old.model,
    providerId: old.providerId,
    engineId: resolveEngineId(old), // openai-compatible → builtin:openai
    // ... 字段映射
  };
}

// compat/gateway-compat.ts
// 旧 ProviderGateway 接口包装新 Gateway
export class CompatGateway implements OldProviderGateway {
  constructor(private v2: NewProviderGateway) {}
  async planRoute(req: OldRequest): Promise<OldPlan> {
    const v2Plan = await this.v2.planRoute(adaptRequest(req));
    return adaptPlan(v2Plan);
  }
  // ...
}
```

#### Feature Flag

```typescript
export const FEATURE_FLAGS = {
  M1_PROVIDER_REGISTRY: true,
  M2_GATEWAY_V2: true,           // M2 启用
  M2_ROUTING_UI: true,           // 路由规则 UI
  M3_ACCOUNT_POOL: false,
  M3_FALLBACK_CHAIN: false,
  M4_OAUTH_FRAMEWORK: false,
  M4_CLEANUP: false,
};
```

**回退方案**：`M2_GATEWAY_V2=false` 时，整体回退到旧 `provider-gateway.ts` + `provider-factory.ts` 路径。ModelCatalog 不可用时走旧 `model-routing.ts` 的 `routeModelByCapability()`。

#### 验证标准

- [ ] OpenAI、Anthropic 引擎通过 Registry + Gateway v2 正常调用
- [ ] 新旧 ProviderRouteOffer 双向转换无信息丢失
- [ ] 旧 provider-gateway.ts 的所有消费者可切换到兼容桥
- [ ] ProviderSettingsTab 加载现有 profile 并展示
- [ ] RoutingSettingsTab 展示基本路由规则列表
- [ ] 模型路由：ModelCatalog 从声明式 JSON 填充 + 运行时检测补充

### 2.4 M3：高级功能（2-3 周）

**目标**：ChatGPT 账号池 + 回退链引擎 + 多模态管线 + 思考模式 + ToolStream 与 StreamingToolExecutor 增强。

#### 新增文件

| 文件路径 | 说明 |
|---|---|
| `packages/agent-runtime/src/auth/chatgpt-account-pool.ts` | ChatGPT 账号池管理器 |
| `packages/agent-runtime/src/auth/account-pool-scheduler.ts` | 账号调度（负载均衡 + 频率限制） |
| `packages/agent-runtime/src/routing/fallback-chain-engine.ts` | 回退链引擎 |
| `packages/agent-runtime/src/routing/fallback-chain.test.ts` | 回退链测试 |
| `packages/agent-runtime/src/routing/cost-aware-router.ts` | 成本感知路由 |
| `packages/agent-runtime/src/routing/multi-role-router.ts` | 多模型角色路由 |
| `packages/agent-runtime/src/stream-parser/multimodal-stream-parser.ts` | 多模态流解析 |
| `packages/agent-runtime/src/stream-parser/ollama-stream-parser.ts` | Ollama 流解析 |
| `packages/agent-runtime/src/stream-parser/thinking-config.ts` | 思考模式配置 |
| `packages/agent-runtime/src/stream-parser/thinking-stream.ts` | 思考流事件管道 |
| `packages/agent-runtime/src/stream-parser/tool-stream-parser.ts` | 工具流解析增强 |
| `packages/agent-runtime/src/model-catalog-hybrid.ts` | 混合检测（静态 + 运行时扫描） |
| `packages/agent-runtime/src/model-provider-syncer.ts` | 供应商/模型同步器 |
| `apps/crish-desktop/src/components/AccountPoolSettingsTab.tsx` | 账号池设置 UI |
| `apps/crish-desktop/src/components/FallbackChainEditor.tsx` | 回退链编辑器 UI |
| `packages/agent-runtime/src/routing/index.ts` | 路由模块导出 |

#### 修改文件

| 文件路径 | 变更 |
|---|---|
| `packages/agent-runtime/src/provider-gateway-v2.ts` | 集成 FallbackChainEngine |
| `packages/agent-runtime/src/auth/auth-channel-adapter.ts` | 集成 ChatGPT 账号池认证 |
| `packages/agent-runtime/src/stream/streaming-tool-executor.ts` | 升级 v2：支持工具流并行 + 进度排序 |
| `packages/agent-runtime/src/model-catalog.ts` | 集成混合检测逻辑 |
| `packages/agent-runtime/src/runtime-components/conversation-engine.ts` | 可选：集成 ThinkingConfig |
| `apps/crish-desktop/src/components/RoutingSettingsTab.tsx` | 新增回退链编辑 |
| `apps/crish-desktop/src/components/ModelsSettingsTab.tsx` | 新增思考模式配置入口 |

#### Feature Flag

```typescript
export const FEATURE_FLAGS = {
  M1_PROVIDER_REGISTRY: true,
  M2_GATEWAY_V2: true,
  M2_ROUTING_UI: true,
  M3_ACCOUNT_POOL: true,         // 默认启用
  M3_FALLBACK_CHAIN: true,       // 默认启用
  M3_MULTIMODAL: true,           // 多模态管线
  M3_THINKING: true,             // 思考模式
  M4_OAUTH_FRAMEWORK: false,
  M4_CLEANUP: false,
};
```

**回退方案**：
- `M3_ACCOUNT_POOL=false` → ChatGPT 账号池禁用，回退到 API Key 认证
- `M3_FALLBACK_CHAIN=false` → 回退到旧单路由选择
- `M3_THINKING=false` → 不发出 `thought-delta` 事件

#### 验证标准

- [ ] ChatGPT 账号池可管理多个账号、自动切换
- [ ] 回退链引擎在首选失败后自动化 fallback
- [ ] 成本感知路由按 token 价格排序
- [ ] 多模态管线正确处理图像输入
- [ ] 思考模式下 thought-delta 正确输出
- [ ] ToolStream + StreamingToolExecutor v2 并行执行工具

### 2.5 M4：全量上线（1-2 周）

**目标**：OAuth 框架 + 30+ 声明式供应商 + 路由规则 UI 完善 + 旧代码清理。

#### 新增文件

| 文件路径 | 说明 |
|---|---|
| `packages/agent-runtime/src/auth/oauth-framework.ts` | OAuth 2.0 通用框架 |
| `packages/agent-runtime/src/auth/oauth-flow.ts` | OAuth 授权码流程 |
| `packages/agent-runtime/src/auth/oauth-provider-configs.ts` | 预置 OAuth 供应商配置 |
| `packages/agent-runtime/src/auth/oauth-token-refresh.ts` | Token 自动刷新 |
| `packages/agent-runtime/src/declarative/declarative-vendors-30.ts` | 30+ 声明式供应商 |
| `apps/crish-desktop/src/components/OAuthCallbackHandler.tsx` | OAuth 回调处理组件 |
| `apps/crish-desktop/src/components/RoutingRuleEditor.tsx` | 路由规则编辑器（完善） |
| `apps/crish-desktop/src/components/RoutingRuleList.tsx` | 路由规则列表 |
| `apps/crish-desktop/src/api/routingRuleStore.ts` | 路由规则存储 |

#### 修改文件

| 文件路径 | 变更 |
|---|---|
| `packages/agent-runtime/src/index.ts` | 更新导出 |
| `packages/agent-runtime/src/provider-factory.ts` | **删除**（已完成历史使命） |
| `apps/crish-desktop/src/api/providerProfiles.ts` | 清理旧兼容代码 |
| `apps/crish-desktop/src/components/ModelsSettingsTab.tsx` | 可选：删除旧代码或标注退役 |
| `apps/crish-desktop/src/components/SettingsPanel.tsx` | 最终 tab 布局定稿 |

#### 删除文件

| 文件路径 | 说明 |
|---|---|
| `packages/agent-runtime/src/provider-factory.ts` | 被 ProviderRegistry 取代 |
| `packages/agent-runtime/src/provider-gateway.ts` | 被 provider-gateway-v2.ts 取代（如旧引用已迁移完毕） |
| `packages/agent-runtime/src/compat/` | 所有兼容桥（过渡结束） |

#### Feature Flag

```typescript
export const FEATURE_FLAGS = {
  M1_PROVIDER_REGISTRY: true,
  M2_GATEWAY_V2: true,
  M2_ROUTING_UI: true,
  M3_ACCOUNT_POOL: true,
  M3_FALLBACK_CHAIN: true,
  M3_MULTIMODAL: true,
  M3_THINKING: true,
  M4_OAUTH_FRAMEWORK: true,     // 启用
  M4_CLEANUP: true,             // 启用：删除旧代码
};
```

**回退方案**：
- 旧代码删除前保留 git tag `pre-m4-cleanup`
- `M4_OAUTH_FRAMEWORK=false` → OAuth 流程不激活，回退到 api-key 认证
- 关键回退: git checkout 旧文件或 `M4_CLEANUP=false` 保留所有旧代码

#### 验证标准

- [ ] OAuth 全流程（授权 → 回调 → token 存储 → 刷新）通过
- [ ] 30+ 声明式供应商全部可解析与展示
- [ ] 路由规则编辑器完整可用（添加/编辑/删除/排序）
- [ ] 所有旧 provider-factory 引用已迁移
- [ ] 无运行时 `@deprecated` 警告（原旧代码的 deprecated 标记已移除）
- [ ] 全量测试通过

---

## 3. 兼容层设计

### 3.1 兼容总体策略

```
旧路径（过渡期）              新路径（M2+）

provider-openai-compatible.ts  →  engine-openai.ts
provider-anthropic.ts          →  engine-anthropic.ts
provider-factory.ts            →  provider-registry.ts
provider-gateway.ts            →  provider-gateway-v2.ts
model-routing.ts               →  model-catalog.ts
openai-stream-parse.ts         →  stream-parser/ (被包装)
anthropic-stream-parse.ts      →  stream-parser/ (被包装)

兼容模式: 旧文件包装新实现，M4 删除旧文件
```

### 3.2 旧 ProviderRouteOffer → 新 ProviderRouteOffer

```typescript
// 旧 (provider-gateway.ts:65)
interface ProviderRouteOffer {
  id: string;
  model: string;
  providerId: string;
  credentialSource: ProviderCredentialSource;
  providerFactory?: AgentProviderFactory;
  // ...
}

// 新 (provider-gateway-v2.ts)
interface ProviderRouteOfferV2 {
  id: string;
  model: string;
  providerId: string;
  engineId: string;              // 新增：指向 EngineProvider
  credentialSource: CredentialSourceV2;
  authMethod: AuthMethodType;    // 新增：认证方法类型
  profiles: ModelProfile[];      // 新增：内联 profile
  // ...
}

// 兼容桥: compat/route-offer-compat.ts
// 使用策略:
//   - 旧 → 新: toNewRouteOffer() 自动填充 engineId（按 providerId 映射）
//   - 新 → 旧: toOldRouteOffer() 构建兼容 providerFactory
//
// 过渡期: 新 Gateway 同时接受两种格式
```

### 3.3 `provider-openai-compatible.ts` 过渡共存策略

```
M1: provider-openai-compatible.ts（原封不动，生产路径不变）
    - engine-openai.ts（新文件，从原文件提取核心 stream() 逻辑）
    - engine-openai.ts 内部 import openai-stream-parse.ts 等依赖

M2: provider-openai-compatible.ts → 包装 engine-openai.ts
    - 导出一个兼容类 OpenAICompatibleProvider
    - 内部 this.engine = new OpenAIEngine(options)
    - stream() 委托给 this.engine.stream()
    - 原文件保留所有导出类型（不破坏 import）

M3: provider-openai-compatible.ts → 标记 @deprecated
    - 所有新引用指向 engine-openai.ts
    - 旧引用可通过 lint 规则检测

M4: provider-openai-compatible.ts → **删除**
    - 保留重导出: export { OpenAIEngine } from './engine-openai'
```

### 3.4 `provider-gateway.ts` 逐步迁移

```
M1: provider-gateway.ts（完全不变）
    - DefaultProviderGateway 仍是主入口

M2: provider-gateway-v2.ts（新增）
    - provider-gateway.ts 添加委托构造:
      class DefaultProviderGateway {
        constructor(opts) {
          if (featureFlags.M2_GATEWAY_V2) {
            this.delegate = new GatewayV2(opts);
          }
        }
        async planRoute(request) {
          if (this.delegate) return this.delegate.planRoute(request);
          // 旧逻辑
        }
      }

M3: provider-gateway.ts 默认委托到 v2
    - 旧逻辑仅当 M2_GATEWAY_V2=false 时运行

M4: provider-gateway.ts 删除，重命名 v2 为正式
```

### 3.5 数据迁移：旧 localStorage → ProviderStore

```
当前 LS 结构:
  - crish_provider_profiles_v1       (ProviderProfile[])
  - crish_active_profile_id           (string)
  - crish_active_model_id             (string)
  - crish_settings / conex_pi_settings (Settings)
  - SESSION_SECRETS (运行时 Map)

新 ProviderStore:
  - 兼容读取旧格式
  - 写入时使用新格式（添加 engineId、authMethod 等字段）
  - 写入时保留旧字段（双向兼容）

迁移流程:
  1. loadProfiles() 检测旧格式 → 自动迁移到新格式
  2. 迁移标记写入 LS: crish_provider_profiles_migrated = true
  3. 新 ProviderStore 写回时使用新格式
  4. 回退: 删除迁移标记即可回退到旧代码读取

具体字段映射:
  旧 ProviderProfile → 新 ProviderStoreEntry
    id               → id (不变)
    name             → displayName
    baseUrl          → baseUrl (不变)
    apiKey           → credentials.apiKey
    authType         → authMethod (映射: api_key→api-key, oauth2→oauth2)
    oauthConfig      → credentials.oauth
    models           → models (不变)
    hasKey           → credentials.hasValue
    enabled          → status (enabled/disabled)
    新增             → engineId: 从 baseUrl 启发式推断
    新增             → profiles: ModelProfile[]
```

---

## 4. Feature Flags 机制

### 4.1 定义文件

```typescript
// packages/agent-runtime/src/feature-flags.ts

export type FeatureFlagKey =
  | 'M1_PROVIDER_REGISTRY'
  | 'M2_GATEWAY_V2'
  | 'M2_ROUTING_UI'
  | 'M3_ACCOUNT_POOL'
  | 'M3_FALLBACK_CHAIN'
  | 'M3_MULTIMODAL'
  | 'M3_THINKING'
  | 'M4_OAUTH_FRAMEWORK'
  | 'M4_CLEANUP';

/**
 * RUNTIME 环境覆盖：
 * 1. localStorage.getItem('crish_feature_<key>') 优先
 * 2. 环境变量 process.env.CRISH_FEATURE_<KEY> 其次
 * 3. 默认值（里程碑默认启用/禁用）
 */
export const DEFAULT_FEATURE_FLAGS: Record<FeatureFlagKey, boolean> = {
  M1_PROVIDER_REGISTRY: true,   // M1 起稳定
  M2_GATEWAY_V2: false,         // M2 起启用
  M2_ROUTING_UI: false,         // M2 起启用
  M3_ACCOUNT_POOL: false,       // M3 起启用
  M3_FALLBACK_CHAIN: false,     // M3 起启用
  M3_MULTIMODAL: false,         // M3 起启用
  M3_THINKING: false,           // M3 起启用
  M4_OAUTH_FRAMEWORK: false,    // M4 起启用
  M4_CLEANUP: false,            // M4 旧代码清理
};

export function isFeatureEnabled(key: FeatureFlagKey): boolean {
  try {
    const stored = localStorage.getItem(`crish_feature_${key}`);
    if (stored !== null) return stored === '1' || stored === 'true';
  } catch { /* 忽略 */ }

  if (typeof process !== 'undefined' && process.env) {
    const envVal = process.env[`CRISH_FEATURE_${key}`];
    if (envVal !== undefined) return envVal === '1' || envVal.toLowerCase() === 'true';
  }

  return DEFAULT_FEATURE_FLAGS[key];
}

/** 控制台临时切换（开发调试用） */
export function setFeatureFlag(key: FeatureFlagKey, value: boolean): void {
  try {
    localStorage.setItem(`crish_feature_${key}`, value ? '1' : '0');
  } catch { /* 忽略 */ }
}

export function resetFeatureFlag(key: FeatureFlagKey): void {
  try {
    localStorage.removeItem(`crish_feature_${key}`);
  } catch { /* 忽略 */ }
}
```

### 4.2 里程碑开启时间表

```
里程碑      M1          M2          M3          M4
────────────────────────────────────────────────────
M1_REGISTRY  █████████  █████████  █████████  █████████
M2_GATEWAY              ████████   █████████  █████████
M2_ROUTING              ████████   █████████  █████████
M3_POOL                             █████████  █████████
M3_CHAIN                             █████████  █████████
M3_MULTIMODAL                        █████████  █████████
M3_THINKING                          █████████  █████████
M4_OAUTH                                        █████████
M4_CLEANUP                                      █████████
```

### 4.3 回退决策表

| 异常场景 | 回退操作 | 影响范围 |
|---|---|---|
| ProviderRegistry 初始化失败 | `M1_PROVIDER_REGISTRY=false`，回退到 provider-factory | 新增引擎不可用，旧引擎不变 |
| Gateway v2 路由选择错误 | `M2_GATEWAY_V2=false`，回退到旧 DefaultProviderGateway | 无路由增强，功能正常 |
| 新设置 UI 白屏 | `M2_ROUTING_UI=false`，回退到旧 ModelsSettingsTab | 恢复旧设置页 |
| ChatGPT 账号池认证失败 | `M3_ACCOUNT_POOL=false`，回退 api-key 认证 | 账号池不可用，API Key 可用 |
| 回退链连续误判 | `M3_FALLBACK_CHAIN=false`，回退单路由 | 无自动 fallback，手动选择 |
| 多模态管线解析错误 | `M3_MULTIMODAL=false`，回退纯文本 | 图像功能降级 |
| 思考模式导致兼容问题 | `M3_THINKING=false`，隐藏 thought-delta | 无思考展示，对话正常 |
| OAuth 授权流程异常 | `M4_OAUTH_FRAMEWORK=false`，回退 api-key 输入 | OAuth 供应商不可用 |
| 旧代码删除后回归 | `M4_CLEANUP=false`，git checkout 旧文件 | 保留旧实现 |

---

## 5. 文件变更清单

### 5.1 M1 变更清单

#### 新增（10 文件）

| # | 路径 | 说明 |
|---|---|---|
| 1 | `packages/agent-runtime/src/feature-flags.ts` | Feature Flag 定义与运行时检测 |
| 2 | `packages/agent-runtime/src/provider-registry.ts` | `ProviderRegistry` 类 |
| 3 | `packages/agent-runtime/src/engine-provider.ts` | `EngineProvider` 接口 |
| 4 | `packages/agent-runtime/src/engine-openai.ts` | OpenAI 引擎 |
| 5 | `packages/agent-runtime/src/engine-anthropic.ts` | Anthropic 引擎 |
| 6 | `packages/agent-runtime/src/engine-ollama.ts` | Ollama 引擎 |
| 7 | `packages/agent-runtime/src/declarative/declarative-schema.ts` | 声明式 JSON Schema |
| 8 | `packages/agent-runtime/src/declarative/declarative-parser.ts` | 声明式 JSON 解析器 |
| 9 | `packages/agent-runtime/src/declarative/builtin-providers.ts` | 内置供应商声明（10 个） |
| 10 | `packages/agent-runtime/src/auth/auth-method-types.ts` | 9 种 AuthMethod 类型 |

#### 修改（4 文件）

| # | 路径 | 变更 |
|---|---|---|
| 1 | `packages/agent-runtime/src/types.ts` | 导出 `EngineProvider` 类型 |
| 2 | `packages/agent-runtime/src/provider-gateway.ts` | `ProviderRouteOffer` 加 `engineId` 可选字段 |
| 3 | `packages/shared-types/src/index.ts` | 更新导出 |
| 4 | `packages/agent-runtime/package.json` | 更新 `exports` 映射 |

#### 测试（4 文件）

| # | 路径 | 说明 |
|---|---|---|
| 1 | `packages/agent-runtime/src/provider-registry.test.ts` | Registry 测试 |
| 2 | `packages/agent-runtime/src/declarative/declarative-parser.test.ts` | 声明式解析测试 |
| 3 | `packages/agent-runtime/src/auth/auth-resolver.test.ts` | 认证解析测试 |
| 4 | `packages/agent-runtime/src/engine-openai.test.ts` | OpenAI 引擎测试 |

### 5.2 M2 变更清单

#### 新增（10 文件）

| # | 路径 | 说明 |
|---|---|---|
| 1 | `packages/agent-runtime/src/provider-gateway-v2.ts` | 新一代 Gateway |
| 2 | `packages/agent-runtime/src/model-catalog.ts` | ModelCatalog |
| 3 | `packages/agent-runtime/src/compat/route-offer-compat.ts` | 新旧 RouteOffer 兼容桥 |
| 4 | `packages/agent-runtime/src/compat/gateway-compat.ts` | 新旧 Gateway 兼容桥 |
| 5 | `packages/agent-runtime/src/compat/engine-compat.ts` | AgentProvider ↔ EngineProvider 适配器 |
| 6 | `apps/crish-desktop/src/components/ProviderSettingsTab.tsx` | Provider 设置拆分面板 |
| 7 | `apps/crish-desktop/src/components/RoutingSettingsTab.tsx` | 路由规则设置页（基础） |
| 8 | `apps/crish-desktop/src/components/AccountSettingsTab.tsx` | 账户设置页 |
| 9 | `apps/crish-desktop/src/api/providerStore.ts` | 新 ProviderStore |
| 10 | `apps/crish-desktop/src/api/modelCatalogApi.ts` | 模型目录 API |

#### 修改（9 文件）

| # | 路径 | 变更 |
|---|---|---|
| 1 | `packages/agent-runtime/src/provider-openai-compatible.ts` | 内部委托到 OpenAIEngine |
| 2 | `packages/agent-runtime/src/provider-anthropic.ts` | 内部委托到 AnthropicEngine |
| 3 | `packages/agent-runtime/src/provider-gateway.ts` | 加 `@deprecated` + 可选委托到 v2 |
| 4 | `packages/agent-runtime/src/model-routing.ts` | 新增 `modelProfileFromDeclarative()` |
| 5 | `packages/agent-runtime/src/index.ts` | 导出新模块 |
| 6 | `apps/crish-desktop/src/components/ModelsSettingsTab.tsx` | Feature flag 检测 |
| 7 | `apps/crish-desktop/src/components/SettingsPanel.tsx` | 新 tab 入口 |
| 8 | `apps/crish-desktop/src/api/providerProfiles.ts` | 新增 ProviderStore 同步钩子 |
| 9 | `apps/crish-desktop/src/store/settingsUiStore.ts` | 新增 provider/routing/account tab state |

### 5.3 M3 变更清单

#### 新增（14 文件）

| # | 路径 | 说明 |
|---|---|---|
| 1 | `packages/agent-runtime/src/auth/chatgpt-account-pool.ts` | ChatGPT 账号池 |
| 2 | `packages/agent-runtime/src/auth/account-pool-scheduler.ts` | 账号调度器 |
| 3 | `packages/agent-runtime/src/routing/fallback-chain-engine.ts` | 回退链引擎 |
| 4 | `packages/agent-runtime/src/routing/cost-aware-router.ts` | 成本感知路由 |
| 5 | `packages/agent-runtime/src/routing/multi-role-router.ts` | 多模型角色路由 |
| 6 | `packages/agent-runtime/src/routing/index.ts` | 路由模块导出 |
| 7 | `packages/agent-runtime/src/stream-parser/multimodal-stream-parser.ts` | 多模态流解析 |
| 8 | `packages/agent-runtime/src/stream-parser/ollama-stream-parser.ts` | Ollama 流解析 |
| 9 | `packages/agent-runtime/src/stream-parser/thinking-config.ts` | 思考模式配置 |
| 10 | `packages/agent-runtime/src/stream-parser/thinking-stream.ts` | 思考流事件管道 |
| 11 | `packages/agent-runtime/src/stream-parser/tool-stream-parser.ts` | 工具流解析 |
| 12 | `packages/agent-runtime/src/model-catalog-hybrid.ts` | 混合检测 |
| 13 | `apps/crish-desktop/src/components/AccountPoolSettingsTab.tsx` | 账号池设置 |
| 14 | `apps/crish-desktop/src/components/FallbackChainEditor.tsx` | 回退链编辑器 |

#### 修改（8 文件）

| # | 路径 | 变更 |
|---|---|---|
| 1 | `packages/agent-runtime/src/provider-gateway-v2.ts` | 集成 FallbackChainEngine |
| 2 | `packages/agent-runtime/src/auth/auth-channel-adapter.ts` | 集成账号池 |
| 3 | `packages/agent-runtime/src/stream/streaming-tool-executor.ts` | v2 升级 |
| 4 | `packages/agent-runtime/src/model-catalog.ts` | 集成混合检测 |
| 5 | `packages/agent-runtime/src/tool-stream/tool-stream.ts` | 跨厂商增强 |
| 6 | `apps/crish-desktop/src/components/RoutingSettingsTab.tsx` | 回退链编辑入口 |
| 7 | `apps/crish-desktop/src/components/ModelsSettingsTab.tsx` | 思考模式配置 |
| 8 | `packages/agent-runtime/src/runtime-components/conversation-engine.ts` | 思考流集成 |

#### 测试（5 文件）

| # | 路径 | 说明 |
|---|---|---|
| 1 | `packages/agent-runtime/src/routing/fallback-chain.test.ts` | 回退链测试 |
| 2 | `packages/agent-runtime/src/auth/chatgpt-account-pool.test.ts` | 账号池测试 |
| 3 | `packages/agent-runtime/src/stream-parser/multimodal-stream-parser.test.ts` | 多模态测试 |
| 4 | `packages/agent-runtime/src/stream-parser/thinking-config.test.ts` | 思考模式测试 |
| 5 | `packages/agent-runtime/src/model-catalog-hybrid.test.ts` | 混合检测测试 |

### 5.4 M4 变更清单

#### 新增（8 文件）

| # | 路径 | 说明 |
|---|---|---|
| 1 | `packages/agent-runtime/src/auth/oauth-framework.ts` | OAuth 通用框架 |
| 2 | `packages/agent-runtime/src/auth/oauth-flow.ts` | OAuth 授权码流程 |
| 3 | `packages/agent-runtime/src/auth/oauth-provider-configs.ts` | OAuth 供应商配置 |
| 4 | `packages/agent-runtime/src/auth/oauth-token-refresh.ts` | Token 刷新 |
| 5 | `packages/agent-runtime/src/declarative/declarative-vendors-30.ts` | 30+ 声明式供应商 |
| 6 | `apps/crish-desktop/src/components/OAuthCallbackHandler.tsx` | OAuth 回调 |
| 7 | `apps/crish-desktop/src/components/RoutingRuleEditor.tsx` | 路由规则编辑器 |
| 8 | `apps/crish-desktop/src/api/routingRuleStore.ts` | 路由规则存储 |

#### 修改（4 文件）

| # | 路径 | 变更 |
|---|---|---|
| 1 | `packages/agent-runtime/src/index.ts` | 更新导出 |
| 2 | `apps/crish-desktop/src/components/SettingsPanel.tsx` | 最终 tab 布局 |
| 3 | `packages/agent-runtime/src/provider-gateway-v2.ts` | 重命名为正式 gateway |
| 4 | `packages/agent-runtime/src/feature-flags.ts` | 所有 flag 设为 true |

#### 删除（5 文件）

| # | 路径 | 说明 |
|---|---|---|
| 1 | `packages/agent-runtime/src/provider-factory.ts` | 被 Registry 取代 |
| 2 | `packages/agent-runtime/src/provider-gateway.ts` | 被 v2 取代（确认无引用后） |
| 3 | `packages/agent-runtime/src/compat/route-offer-compat.ts` | 过渡结束 |
| 4 | `packages/agent-runtime/src/compat/gateway-compat.ts` | 过渡结束 |
| 5 | `packages/agent-runtime/src/compat/engine-compat.ts` | 过渡结束 |

### 5.5 总计统计

```
里程碑      新增   修改   删除   测试    总计
──────────────────────────────────────────
M1          10     4      0      4      18
M2          10     9      0      0      19
M3          14     8      0      5      27
M4          8      4      5      0      17
──────────────────────────────────────────
总计        42     25     5      9      81
```

---

## 附录 A：依赖升级时间线

```
现有文件                       M1        M2        M3        M4
────────────────────────────────────────────────────────────────
provider-factory.ts           ⚪保留     ⚪保留     ⚪保留     ❌删除
provider-gateway.ts           ⚪保留     🔶委托    🔶委托    ❌删除
provider-openai-compatible.ts ⚪保留     🔶包装     🔶depr    ❌删除
provider-anthropic.ts         ⚪保留     🔶包装     🔶depr    ❌删除
openai-stream-parse.ts        ⚪保留     ⚪保留     🔶被包装   🔶被包装
anthropic-stream-parse.ts     ⚪保留     ⚪保留     🔶被包装   🔶被包装
model-routing.ts              ⚪保留     🔶扩展     🔶扩展     ⚪保留
types.ts                      ✅扩展     ⚪保留     ⚪保留     ⚪保留
ModelsSettingsTab.tsx         ⚪保留     🔶flag     🔶思考入口  ⚪退役标记
providerProfiles.ts           ⚪保留     🔶同步      ⚪保留     ⚪保留
settingsStorage.ts            ⚪保留     ⚪保留     ⚪保留     ⚪保留

图例: ✅新增  🔶修改  ⚪不变  ❌删除
```

---

## 附录 B：关键接口签名

### EngineProvider

```typescript
// packages/agent-runtime/src/engine-provider.ts (M1)
export interface EngineProvider {
  readonly id: string;
  readonly providerId: string;
  readonly metadata: EngineProviderMeta;

  stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent>;
  abort(): void;
}

export interface EngineProviderMeta {
  label: string;
  family: 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'bedrock';
  capabilities: ModelCapabilityTag[];
  supportedAuthMethods: AuthMethodType[];
  homepage?: string;
  docsUrl?: string;
}

export type EngineProviderFactory = (options: EngineProviderOptions) => EngineProvider;
```

### ProviderRegistry

```typescript
// packages/agent-runtime/src/provider-registry.ts (M1)
export class ProviderRegistry {
  register(engineId: string, factory: EngineProviderFactory, meta: EngineProviderMeta): void;
  get(engineId: string): { factory: EngineProviderFactory; meta: EngineProviderMeta };
  list(): Array<{ engineId: string; meta: EngineProviderMeta }>;
  has(engineId: string): boolean;
}

export const globalProviderRegistry: ProviderRegistry;
```

### ModelCatalog

```typescript
// packages/agent-runtime/src/model-catalog.ts (M2)
export class ModelCatalog {
  constructor(vendors: DeclarativeVendor[]);

  /** 从声明式 JSON 加载供应商定义 */
  loadDeclarative(vendors: DeclarativeVendor[]): void;

  /** 运行时检测补充（扫描 /v1/models） */
  async hybridDetect(engineProvider: EngineProvider): Promise<ModelProfile[]>;

  /** 路由决策（复用 model-routing.ts 的 routeModelByCapability） */
  route(request: TaskCapabilityRequest, policy?: ModelRoutePolicy): ModelRouteDecision;

  /** 获取所有 profile */
  getProfiles(): ModelProfile[];

  /** 成本感知填充 price 信息 */
  enrichWithCostData(priceData: ProviderPricing[]): void;
}
```

### FallbackChainEngine

```typescript
// packages/agent-runtime/src/routing/fallback-chain-engine.ts (M3)
export class FallbackChainEngine {
  constructor(catalog: ModelCatalog);

  /** 执行回退链 */
  async executeChain(
    request: ProviderRouteRequest,
    chain: FallbackChain
  ): Promise<FallbackChainResult>;

  /** 构建默认回退链 */
  buildDefaultChain(preferred: ModelProfile[]): FallbackChain;
}

export interface FallbackChain {
  id: string;
  steps: FallbackStep[];
  onAllFailed: 'throw' | 'last-error' | 'graceful';
}

export interface FallbackStep {
  profileId: string;
  providerId: string;
  condition?: 'on-error' | 'on-timeout' | 'on-rate-limit';
  maxRetries?: number;
  cooldownMs?: number;
}
```

---

*本文档由 Round 2 集成架构师生成，基于 Round 1 的五份设计方案。*
*建议在每次里程碑完成时更新本文档的状态字段。*
