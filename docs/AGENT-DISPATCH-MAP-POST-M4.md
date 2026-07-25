# Agent 调度图谱：Provider 系统后续改进

> 基于 `PLAN-SYSTEMATIC-POST-M4.md`（A-I 共 46 个条目）生成。
> 每个**轮次**包含可并行执行的 3-5 个 Agent；轮次之间按逻辑依赖排序。
> Agent 命名遵循 `{类别字母}{条目编号}` 格式。
>
> **已完成项标记**：✅ A1（`initProviderEngine()` 调用点已在 daemon 入口添加）

---

## 轮次 1: 运行时安全加固（4 个 Agent）

| Agent | 任务 | 涉及文件 |
|-------|------|----------|
| A2 | `buildEngineOptions()` 路径添加 `validateBaseUrl()` 防御深度校验 | `packages/agent-runtime/src/provider/factory.ts` |
| A6 | `EngineOptions.apiKey` 类型已改为 `SecretValue`，验证全链路传递不丢失品牌类型 | `packages/agent-runtime/src/provider/factory.ts` + 各 engine 构造调用点 |
| A7 | HTTP 错误体经 `sanitizeForLog()` 脱敏（`body.slice(0,200)` 输出前过滤敏感数据） | `packages/agent-runtime/src/provider/factory.ts:128` |
| A8 | `classifyError` 中未知错误类型的原始 message 经 `sanitizeForLog()` 清洗 | `packages/agent-runtime/src/provider/engines/base-engine.ts` |

**前置依赖**: ✅ A1 已完成，无阻塞
**输出**: 4 个代码变更 + 至少 4 个单元测试更新

---

## 轮次 2: SecretStore 基础设施（3 个 Agent）

| Agent | 任务 | 涉及文件 |
|-------|------|----------|
| A3 | `AutoSecretStore` 实例化 —— 在 daemon 初始化路径创建 `new AutoSecretStore(path)` 并注入凭据解析链 | `packages/agent-daemon/src/index.ts` → `packages/agent-runtime/src/provider/auth/secret-store.ts` |
| A4 | `CredentialResolver` 接入 provider-gateway —— 凭据解析经过三层密钥存储而非直读 `apiKey` 字段 | `packages/agent-runtime/src/provider-gateway.ts` + `packages/agent-runtime/src/provider/auth/credential-resolver.ts` |
| A5 | `AuthMethod` 类型与 `ProviderCredentialSource` 类型的统一桥接 —— 添加 `authMethodToCredentialSource()` 转换函数 | `packages/agent-runtime/src/provider-gateway.ts` + `packages/agent-runtime/src/provider/auth/types.ts` |

**前置依赖**: 轮次 1（SecretValue 类型就绪后 A3-A5 才能正确消费）
**输出**: 3 个代码变更 + 3 个单元测试（secret-store、credential-resolver、类型桥接）

---

## 轮次 3: 数据持久化与迁移（4 个 Agent）

| Agent | 任务 | 涉及文件 |
|-------|------|----------|
| B2 | 审查 `providerProfiles.ts` 的双写路径 —— 决策废弃 v1 代码或同步写 v2 store（**决策先行**） | `apps/crish-desktop/src/api/providerProfiles.ts` |
| B1 | `providerStore` 初始化时自动检测旧 `crish_provider_profiles_v1` 并调用 `migrateFromV1()` 迁移（依赖 B2 决策） | `apps/crish-desktop/src/store/provider/migration.ts` |
| B3 | `AccountStore.save()` 对敏感字段的实际加密（当前存 `"***"` 导致 token 丢失）—— 使用 `SecretStore` 加密存储真实 token | `packages/agent-runtime/src/provider/auth/oauth/account-store.ts` |
| B4 | `AccountStore.load()` 从 `SecretStore` 解密恢复 token | `packages/agent-runtime/src/provider/auth/oauth/account-store.ts` |

**前置依赖**: 轮次 2（A3-A5 SecretStore 就绪后 B3/B4 才可接入）；B2 决策 → B1
**输出**: 4 个代码变更 + 4 个测试（迁移逻辑、加密存/解密读）

---

## 轮次 4: 模型路由完备（5 个 Agent）

| Agent | 任务 | 涉及文件 |
|-------|------|----------|
| C1 | `provider-gateway.ts` 的 `planRoute()` 中调用 `enrichProfileFromCatalog()` —— 使 `ProviderRouteOffer.modelProfile` 携带 `capabilityFlags` 和 `pricing` | `packages/agent-runtime/src/provider-gateway.ts` + `packages/agent-runtime/src/model-routing.ts:505` |
| C2 | `callWithFallbackChain` 支持遍历完整 fallback list —— 当前只取 `fallbackList[0]` | `packages/agent-runtime/src/fallback-chain/engine.ts` |
| C3 | `allocateModelRoles` 在无匹配时返回 `undefined` 而非 `profiles[0]` —— 调用方区分"匹配成功"和"无匹配取默认" | `packages/agent-runtime/src/model-routing-roles.ts:215` |
| C4 | `ModelCatalog` 默认 sourceUrl 配置 —— 为内置 providers 添加 LiteLLM 同步 URL | `packages/agent-runtime/src/model-catalog/types.ts` |
| C5 | 远程同步集成到 daemon 启动流程 —— 异步初始化，缓存回退，可配置间隔 | `packages/agent-daemon/src/index.ts` + `packages/agent-runtime/src/model-catalog/` |

**前置依赖**: 无（C4-C5 完全独立；C1-C3 不依赖 SecretStore，可与轮次 2/3 并行）
**输出**: 5 个代码变更 + 5 个测试（路由 enrich、fallback 遍历、角色分配、catalog 配置、远程同步）

---

## 轮次 5: OAuth 与账号管理（5 个 Agent）

| Agent | 任务 | 涉及文件 |
|-------|------|----------|
| D1 | OAuth PKCE 前端流程 —— 调用 Tauri shell `open` API 打开浏览器 + 启动本地回调服务器 + 凭证写入 `SecretStore` | `packages/agent-runtime/src/provider/auth/oauth/pkce-flow.ts`（新建）+ Tauri shell 桥接 |
| D2 | `AccountSettingsTab` 连接 `ChatGPTAccountPool` 后端 —— 添加/删除/刷新/状态查询 | `packages/agent-runtime/src/provider/auth/oauth/chatgpt-pool.ts` + UI `AccountSettingsTab` |
| D3 | 账号状态实时反映到 UI —— Token 过期时间、用量状态、冷却状态 | UI 组件（`apps/crish-desktop/src/components/`） |
| D4 | OAuth 回退机制 —— 当浏览器回调端口被阻断时提供手动粘贴 token 的 fallback | `packages/agent-runtime/src/provider/auth/oauth/` |
| D5 | `AccountStore` 持久化配置与 daemon 配置管道集成 —— 通过 `update-config` WebSocket 同步 | `packages/agent-runtime/src/provider/auth/oauth/account-store.ts` + WebSocket handler |

**前置依赖**: 轮次 2（A3-A5 SecretStore 就绪后 OAuth 凭证读写才可工作）+ 轮次 3（B3/B4 AccountStore 加密就绪）
**输出**: 5 个代码变更 + 5 个测试（PKCE 流程、账号池交互、UI 状态、fallback、配置同步）

---

## 轮次 6: 断路器设计与输入安全加固（5 个 Agent）

| Agent | 任务 | 涉及文件 |
|-------|------|----------|
| E3 | 断路器设计 —— 超时放弃、结果缓存、重试策略集成（**设计先行**） | `packages/agent-runtime/src/stream/circuit-breaker.ts`（新建）+ streaming 类型定义 |
| F1 | `providerId` 字符白名单 —— `declarative-schema.ts` 中限制只允许 `[a-zA-Z0-9_-]` | `packages/agent-runtime/src/provider/declarative-schema.ts` |
| F2 | `model.id` 长度限制 —— 最大 128 字符 | `packages/agent-runtime/src/provider/declarative-schema.ts` |
| F3 | `normalizeDeclarativeDef` 拒绝未知字段 —— 添加 `additionalProperties: false` 校验 | `packages/agent-runtime/src/provider/declarative-schema.ts` |
| F8 | DNS rebinding 防护评估 —— 当前字符串比较不防御 DNS rebinding | `packages/agent-runtime/src/provider/factory.ts`（URL 校验点） |

**前置依赖**: 无（F1/F2/F3/F8 完全独立；E3 设计先行供轮次 7 使用）
**输出**: 5 个代码变更 + 4 个测试（断路器单元测试 + schema 校验测试 *3）

---

## 轮次 7: 流式执行与多模态管线（5 个 Agent）

| Agent | 任务 | 涉及文件 |
|-------|------|----------|
| E1 | `StreamingToolExecutor` 嵌入 `agent-session-loop` 主循环 —— 流式 `tool_call` delta 到达时立即分发执行 | `packages/agent-runtime/src/stream/streaming-tool-executor.ts` + `packages/agent-runtime/src/agent-session-loop.ts` |
| E2 | 执行结果在流结束前回注后续 LLM 轮次（延迟降低） | `packages/agent-runtime/src/stream/` + `packages/agent-runtime/src/agent-session-loop.ts` |
| E4 | 多模态管线在 `OpenAICompatibleEngine` 层统一处理 —— image/audio/video content part 预处理 | `packages/agent-runtime/src/provider/engines/openai-compatible-engine.ts` |
| E5 | 多模态用量统计 —— token 估算接入引擎层记账 | `packages/agent-runtime/src/provider/engines/`（引擎层记账） |
| E6 | provider 能力标志中的 `vision`/`multimodal` 控制路由选择 | `packages/agent-runtime/src/model-routing.ts` + router 决策点 |

**前置依赖**: 轮次 6（E3 断路器设计就绪后 E1/E2 才可正确嵌入）；E4/E5/E6 独立
**输出**: 5 个代码变更 + 5 个测试（流式执行、回注、多模态预处理、用量、路由标志）

---

## 轮次 8: 加密安全与文档修正（4 个 Agent）

| Agent | 任务 | 涉及文件 |
|-------|------|----------|
| F4 | 加密文件权限 `0o600` —— `EncryptedFileStore.writeVault()` 设置文件权限 | `packages/agent-runtime/src/provider/auth/`（vault 写入点） |
| F5 | 加密文件默认主密钥熵增强 —— 替代基于 `COMPUTERNAME + USERNAME + hostname()` 的可预测 fallback | `packages/agent-runtime/src/provider/auth/`（密钥派生点） |
| G1 | `CONTRIBUTING-PROVIDERS.md` 已验证与最新 schema 一致（M4-R2 检查通过） | `docs/CONTRIBUTING-PROVIDERS.md` |
| G3 | `ARCHITECTURE.md` AuthMethod 数量修正为 9（文档写 8） | `docs/ARCHITECTURE.md` |

**前置依赖**: 无（完全独立，可提前或与轮次 6/7 并行）
**输出**: 4 个变更（2 个加密代码 + 2 个文档修正）

---

## 轮次 9: CI 安全扫描与模板更新（4 个 Agent）

| Agent | 任务 | 涉及文件 |
|-------|------|----------|
| F6 | `cargo-audit` 集成到 CI | `.github/workflows/`（新增 security-audit job） |
| F7 | `npm audit fix` 修复 existing moderate 漏洞 | `package.json` + 依赖锁定文件 |
| G2 | `templates/provider.*.json` 更新到 `DeclarativeProviderDef` 新 schema —— 当前模板使用旧 `id`/`version`/`pathPrefix`/`auth.method` 格式 | `templates/provider.*.json` |
| G4 | 确认 `crish` CLI 是否注册 `provider` 子命令 —— 如未注册，在 package.json `bin` 中添加 | `apps/crish-desktop/package.json` + CLI 入口 |

**前置依赖**: 无（完全独立）
**输出**: 4 个变更（CI 配置、依赖修复、模板更新、CLI 注册）

---

## 轮次 10: CI 自动化全链路编排（5 个 Agent）

| Agent | 任务 | 涉及文件 |
|-------|------|----------|
| H1 | `LlmApiMockServer` E2E 测试集成到 CI pipeline —— 当前测试文件存在但未编排 | `.github/workflows/`（E2E job 编排） |
| H2 | 启用在 M2-R3-A1 创建的 `provider-validation.yml` workflow | `.github/workflows/provider-validation.yml` |
| H3 | E2E job 覆盖全部三家引擎（OpenAI/Anthropic/Ollama）的 mock 场景 | `packages/agent-runtime/src/__tests__/integrations/` + CI matrix |
| H4 | Rust 基准测试 `cargo bench -p conex-stream` CI 步骤 | `.github/workflows/`（bench job） |
| H5 | TypeScript 基准测试 `vitest bench` CI 步骤 | `.github/workflows/`（bench job） |

**前置依赖**: 轮次 1-7（所有核心代码变更完成后 CI 测试才有意义）；可与此前轮次部分并行
**输出**: 5 个 CI 配置变更 + 测试编排

---

## 轮次 11: 生态建设（5 个 Agent）

| Agent | 任务 | 涉及文件 |
|-------|------|----------|
| I1 | `community/providers/` 目录建立 —— 接受 PR 提交新 Provider JSON | `community/providers/`（新建目录 + README） |
| I2 | CI 自动运行 `provider-validate.ts` + `provider-test.ts` 验证 PR | `.github/workflows/provider-pr-check.yml`（新建） |
| I3 | `conex provider install <id>` 命令行支持远程市场安装 | `packages/agent-runtime/src/provider/`（CLI handler）+ daemon API |
| I4 | 兼容性矩阵 HTML/JSON 报告生成 | `community/compatibility-report/`（新建）+ 生成脚本 |
| I5 | 远程 Provider 索引 `providers.conex.dev/index.json` | 社区基础设施 + 索引生成脚本 |

**前置依赖**: 轮次 10（CI 编排就绪后 PR 验证才可集成）；I3 依赖轮次 2（SecretStore + CredentialResolver）
**输出**: 5 个变更（目录结构、CI 校验、CLI 命令、报告生成器、索引脚本）

---

## 附录：依赖关系与关键路径

```
轮次 1 (A2/A6/A7/A8) ───────────────────────────────────────────────────┐
                                                                          │
轮次 2 (A3/A4/A5) ◄──── SecretStore 基础设施                               │
       │                                                                  │
       ├──────────► 轮次 3 (B2→B1/B3/B4) ── 数据持久化                     │
       │                                                                  │
       └──────────► 轮次 5 (D1-D5) ── OAuth 与账号管理                     │
                                                                          │
轮次 4 (C1-C5) ─── 模型路由（独立，可与轮次 2/3 并行）                     │
                                                                          │
轮次 6 (E3/F1/F2/F3/F8) ── 断路器设计 + 输入安全                           │
       │                                                                  │
       └──────────► 轮次 7 (E1/E2/E4/E5/E6) ── 流式执行 + 多模态           │
                                                                          │
轮次 8 (F4/F5/G1/G3) ── 加密安全 + 文档修正（独立，可提前）                 │
轮次 9 (F6/F7/G2/G4) ── CI 安全 + 模板（独立，可提前）                      │
       │                                                                  │
       └──────────► 轮次 10 (H1-H5) ── CI 自动化全链路                      │
                          │                                                │
                          └──────────► 轮次 11 (I1-I5) ── 生态建设           │
```

### 关键依赖链

| 依赖 | 说明 |
|------|------|
| A3-A5 → B3/B4 | `SecretStore` 基础设施就绪后 `AccountStore` 才能加密存储 |
| A3-A5 → D1-D3 | `SecretStore` 就绪后 OAuth 凭据才能安全落盘 |
| B2 → B1 | 双写路径决策完成后才能实现迁移 |
| E3 → E1/E2 | 断路器设计完成后流式执行才能嵌入正确超时/重试/缓存 |
| 轮次 1-9 → 轮次 10 | 核心代码变更完成后 CI 全链路测试才有覆盖意义 |
| 轮次 10 → 轮次 11 | CI 编排就绪后社区 PR 才能获得自动验证 |

### 并行化建议

- **轮次 1 + 轮次 4** 可完全并行（无共享依赖）
- **轮次 2 + 轮次 4** 可完全并行
- **轮次 6 + 轮次 8 + 轮次 9** 可完全并行
- **轮次 7 + 轮次 8 + 轮次 9** 可完全并行
- 各 Agent 内部单元测试应跟随代码变更在同一轮次完成，不拆入后续轮次

### 已完成项

| 条目 | 状态 | 说明 |
|------|------|------|
| A1 | ✅ 已完成 | `initProviderEngine()` 调用点已在 daemon 入口 `packages/agent-daemon/src/index.ts` 添加 |
