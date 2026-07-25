# Provider 系统后续改进方案（全量审计驱动，逻辑顺序）

> 基于 M4-R2 集成审计 + 安全审计 + 现有路线图综合生成。
> 所有条目优先级相同，仅按逻辑依赖排列。每条之前的工作必须先完成。

---

## A. 运行时健全性（其他一切的基础）

- [A1] `initProviderEngine()` 调用点 —— 已在 daemon 入口 `packages/agent-daemon/src/index.ts` 添加
- [A2] `factory.ts` 中 `buildEngineOptions()` 路径添加 `validateBaseUrl()` 防御深度校验
- [A3] `AutoSecretStore` 实例化 —— 在 daemon 初始化路径创建 `new AutoSecretStore(path)` 并注入 credential 解析链
- [A4] `CredentialResolver` 接入 provider-gateway —— 使凭据解析经过三层密钥存储而非直读 `apiKey` 字段
- [A5] `AuthMethod` 类型与 `ProviderCredentialSource` 类型的统一桥接 —— 添加 `authMethodToCredentialSource()` 转换函数
- [A6] `EngineOptions.apiKey` 类型已改为 `SecretValue` —— 验证全链路传递不丢失品牌类型
- [A7] `factory.ts` HTTP 错误体经 `sanitizeForLog()` 脱敏 —— 第 128 行 `body.slice(0, 200)` 输出前过滤敏感数据
- [A8] `classifyError` 中未知错误类型的原始 message 经 `sanitizeForLog()` 清洗

## B. 数据持久化与迁移（存储层健全）

- [B1] `providerStore` 初始化时自动检测旧 `crish_provider_profiles_v1` 并调用 `migrateFromV1()` 迁移
- [B2] 审查 `providerProfiles.ts` 的双写路径 —— 决定废弃 v1 代码或同步写 v2 store
- [B3] `AccountStore.save()` 对敏感字段的实际加密（当前存 `"***"` 导致 token 丢失）—— 使用 `SecretStore` 加密存储真实 token
- [B4] `AccountStore.load()` 从 `SecretStore` 解密恢复 token

## C. 模型路由完备（路由决策链）

- [C1] `provider-gateway.ts` 的 `planRoute()` 中调用 `enrichProfileFromCatalog()` —— 使 `ProviderRouteOffer.modelProfile` 携带 `capabilityFlags` 和 `pricing`
- [C2] `callWithFallbackChain` 支持遍历完整 fallback list —— 当前只取 `fallbackList[0]`
- [C3] `allocateModelRoles` 在无匹配时返回 `undefined` 而非 `profiles[0]` —— 调用方区分"匹配成功"和"无匹配取默认"
- [C4] `ModelCatalog` 默认 sourceUrl 配置 —— 为内置 providers 添加 LiteLLM 同步 URL
- [C5] 远程同步集成到 daemon 启动流程 —— 异步初始化，缓存回退，可配置间隔

## D. OAuth 与账号管理（用户侧交互）

- [D1] OAuth PKCE 前端流程 —— 调用 Tauri shell `open` API 打开浏览器 + 启动本地回调服务器 + 凭证写入 `SecretStore`
- [D2] `AccountSettingsTab` 连接 `ChatGPTAccountPool` 后端 —— 添加/删除/刷新/状态查询
- [D3] 账号状态实时反映到 UI —— Token 过期时间、用量状态、冷却状态
- [D4] OAuth 回退机制 —— 当浏览器回调端口被阻断时提供手动粘贴 token 的 fallback
- [D5] `AccountStore` 持久化配置与 daemon 配置管道集成 —— 通过 `update-config` WebSocket 同步

## E. 流式执行与多模态（核心业务管线）

- [E1] `StreamingToolExecutor` 嵌入 `agent-session-loop` 主循环 —— 流式 `tool_call` delta 到达时立即分发执行
- [E2] 执行结果在流结束前回注后续 LLM 轮次（延迟降低）
- [E3] 断路器 —— 超时放弃、结果缓存、重试策略集成
- [E4] 多模态管线在 `OpenAICompatibleEngine` 层统一处理 —— image/audio/video content part 预处理
- [E5] 多模态用量统计 —— token 估算接入引擎层记账
- [E6] provider 能力标志中的 `vision`/`multimodal` 控制路由选择

## F. 安全加固（纵深防御）

- [F1] `providerId` 字符白名单 —— `declarative-schema.ts` 中限制只允许 `[a-zA-Z0-9_-]`
- [F2] `model.id` 长度限制 —— 最大 128 字符
- [F3] `normalizeDeclarativeDef` 拒绝未知字段 —— 添加 `additionalProperties: false` 校验
- [F4] 加密文件权限 `0o600` —— `EncryptedFileStore.writeVault()` 设置文件权限
- [F5] 加密文件默认主密钥熵增强 —— 替代基于 `COMPUTERNAME + USERNAME + hostname()` 的可预测 fallback
- [F6] `cargo-audit` 集成到 CI
- [F7] `npm audit fix` 修复 existing moderate 漏洞
- [F8] DNS rebinding 防护评估 —— 当前字符串比较不防御 DNS rebinding

## G. 文档与模板（开发者体验）

- [G1] `CONTRIBUTING-PROVIDERS.md` 已验证与最新 schema 一致（M4-R2 检查通过）
- [G2] `templates/provider.*.json` 更新到 `DeclarativeProviderDef` 新 schema —— 当前模板使用旧 `id`/`version`/`pathPrefix`/`auth.method` 格式
- [G3] `ARCHITECTURE.md` AuthMethod 数量修正为 9（文档写 8）
- [G4] 确认 `crish` CLI 是否注册 `provider` 子命令 —— 如未注册，在 package.json `bin` 中添加

## H. CI 与自动化测试（质量保障）

- [H1] `LlmApiMockServer` E2E 测试集成到 CI pipeline —— 当前测试文件存在但未编排
- [H2] 启用在 M2-R3-A1 创建的 `provider-validation.yml` workflow
- [H3] E2E job 覆盖全部三家引擎（OpenAI/Anthropic/Ollama）的 mock 场景
- [H4] Rust 基准测试 `cargo bench -p conex-stream` CI 步骤
- [H5] TypeScript 基准测试 `vitest bench` CI 步骤

## I. 生态建设（面向社区）

- [I1] `community/providers/` 目录建立 —— 接受 PR 提交新 Provider JSON
- [I2] CI 自动运行 `provider-validate.ts` + `provider-test.ts` 验证 PR
- [I3] `conex provider install <id>` 命令行支持远程市场安装
- [I4] 兼容性矩阵 HTML/JSON 报告生成
- [I5] 远程 Provider 索引 `providers.conex.dev/index.json`
