# Provider System Post-M4 Roadmap

> 交付状态：M4 已完成（35+ 声明式 Provider、CLI 工具栈、安全审计）
> 本文档识别已知差距并规划后续改进阶段

---

## 已知差距

| # | 差距 | 状态 | 关键文件 |
|---|------|------|----------|
| G1 | **ChatGPT 账号池 UI 未接线**：AccountSettingsTab 存根已渲染但无后端调用 | 前端组件存根，后端已就绪 | `apps/crish-desktop/src/components/settings/AccountSettingsTab.tsx:6` |
| G2 | **OAuth PKCE 前端流程缺失**：需要打开浏览器 + 启动本地回调服务器，UI 交互未实现 | 后端 `OAuthFlowManager` 已实现，前端未连接 | `packages/agent-runtime/src/__tests__/integrations/oauth-flow.test.ts:13` |
| G3 | **Mock Server 未接入 CI E2E Job**：`LlmApiMockServer` 测试存在但未在 CI 中编排 | 测试文件就绪，CI 未包含 | `packages/agent-runtime/src/provider/__tests__/e2e/mock-server.ts` |
| G4 | **ModelCatalog 远程同步默认禁用**：`CatalogSyncManager` 代码完整但无默认 sourceUrl | 未配置 | `packages/agent-runtime/src/model-catalog/catalog-sync.ts:11` |
| G5 | **StreamingToolExecutor 未接入 agent-runtime 主流程**：独立的单元测试/集成测试已通过，但 agent-session-loop 未调用 | 独立测试通过 | `packages/agent-runtime/src/stream/streaming-tool-executor.ts:19` |
| G6 | **多模态管线未连接到 Provider 引擎**：vision content part 在 request-build 层处理，但 Provider 引擎级别无统一多模态管线 | 部分集成 | `packages/agent-runtime/src/openai-request-build.ts:438` |

---

## Phase 5: UI 集成（目标：1-2 周）

> 将后端能力对接到前端设置界面，完成账号配置的完整用户体验闭环

### 5.1 AccountSettingsTab → ChatGPT 账号池后端

```
状态: G1
文件: apps/crish-desktop/src/components/settings/AccountSettingsTab.tsx
     packages/agent-runtime/src/provider/auth/oauth/token-guardian.ts
```

- 调用 `ChatGptAccountPool` (位于 `token-guardian.ts`) 列出/添加/删除账号
- 连接 refresh/status 操作到 `TokenGuardian` 的 session 管理 API
- 显示 Token 过期时间、用量状态（活跃/已过期/错误）
- 通过 `update-config` WebSocket 消息持久化账号配置

### 5.2 OAuth PKCE 浏览器回调流程

```
状态: G2
文件: apps/crish-desktop/src/components/settings/AccountSettingsTab.tsx
     packages/agent-runtime/src/provider/auth/oauth/
```

- 点击"授权" → 调用 Tauri shell 的 `open` API 打开系统浏览器
- 启动本地回调 HTTP 服务器（随机端口）接收 OAuth 回调
- 回调后关闭本地服务器，将 credential 写入 `AutoSecretStore`
- 新增 OAuth 状态指示器：等待中 / 已授权 / 已过期

### 5.3 Provider 配置保存到新 Store

```
状态: G1, G2
```

- 将 AccountSettingsTab 的 state 从本地 `useState` 迁移到 provider store (`apps/crish-desktop/src/store/provider/types.ts`)
- 通过 `update-config` 协议将账号配置写入 daemon 配置管道
- 配置刷新后 UI 自动反映最新状态

### 验收标准 (Phase 5)

- [ ] 添加 ChatGPT 账号后，后端 `TokenGuardian` 可见新 session
- [ ] OAuth 授权流程完成 end-to-end（浏览器 → 回调 → 凭证存储）
- [ ] 账号状态变更 UI 实时响应（添加/移除/过期）

---

## Phase 6: 生产加固（目标：1-2 周）

> 将已实现的独立组件集成到核心业务管线中，确保生产路径完整性

### 6.1 StreamingToolExecutor 集成到 agent-session-loop

```
状态: G5
文件: packages/agent-runtime/src/stream/streaming-tool-executor.ts
     packages/agent-orchestrator/src/session/
```

- 在 `agent-session-loop` 主循环中嵌入 `StreamingToolExecutor`
- 流式响应到达 tool_call delta 时：立即分发执行，不等完整响应
- 执行结果在流结束前回注到后续 LLM 轮次（reduce latency）
- 增加断路器：超时放弃、结果缓存、重试策略集成

### 6.2 多模态管线集成到 Provider 引擎

```
状态: G6
文件: packages/agent-runtime/src/openai-request-build.ts
     packages/agent-runtime/src/provider/
```

- 在 `OpenAICompatibleEngine` 层统一处理 vision/image/audio content parts
- image 预处理管线：自动 resize、格式转换、base64/URL 自动选择
- 多模态用量统计：token 估算（现有 `context-compression.ts:64`）→ 引擎层记账
- provider 能力声明中的 `vision`/`multimodal` flag 控制路由选择

### 6.3 ModelCatalog 远程同步配置

```
状态: G4
文件: packages/agent-runtime/src/model-catalog/catalog-sync.ts
```

- 为内置 providers 添加默认的 LiteLLM 同步 URL（可配置覆盖）
- 同步失败时有缓存回退 + 显式告警
- daemon 启动时异步初始化同步，不阻塞启动流程
- 同步间隔可配置（默认 1h），支持手动触发一键同步

### 验收标准 (Phase 6)

- [ ] StreamingToolExecutor 在 agent-session-loop 中生效，流式 tool call 延迟降低 ≥30%
- [ ] 多模态图片输入在所有 3 个引擎（OpenAI/Anthropic/Ollama）上可通过 provider 引擎链路
- [ ] ModelCatalog 启动后自动从远程同步，缓存可用且可配置

---

## Phase 7: 生态建设（持续）

> 面向社区和可扩展性，降低第三方 Provider 的接入门槛

### 7.1 社区贡献的 Provider JSON

- 建立 `community/providers/` 目录，接受 PR 提交新 Provider JSON
- CI 自动运行 `provider-validate.ts` + `provider-test.ts` 验证 PR
- 提供贡献指南模板（`CONTRIBUTING-PROVIDER.md`）

### 7.2 Provider 市场/目录

- 内置 `provider-list` CLI 支持在线市场查询
- 从远程索引（`providers.conex.dev/index.json`）发现社区 Provider
- 一键安装：`conex provider install <provider-id>`
- Provider 评分/兼容性标签（已验证引擎版本、最后测试时间）

### 7.3 自动化 Provider 兼容性测试

- 将 `LlmApiMockServer` 扩展到多引擎 mock（补全所有 35+ provider 的模拟场景）
- CI 中新增 E2E job 步骤：启动 mock server → 运行 provider-test → 报告兼容性矩阵
- 兼容性矩阵输出 HTML/JSON 报告，发布到 `providers.conex.dev` 状态页

### 验收标准 (Phase 7)

- [ ] 社区可通过 PR 贡献 Provider JSON，CI 自动验证
- [ ] `conex provider install <id>` 可从远程市场安装
- [ ] 兼容性矩阵覆盖 ≥80% 的已注册 provider，且有公开状态页

---

## 时间线总览

| Phase | 范围 | 预估工期 | 前置依赖 |
|-------|------|----------|----------|
| Phase 5 | UI 集成 | 1-2 周 | M4 后端能力（已完成） |
| Phase 6 | 生产加固 | 1-2 周 | Phase 5 完成 |
| Phase 7 | 生态建设 | 持续（4-6 周 MVP） | Phase 6 完成，CI 基础设施 |

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| OAuth 浏览器回调端口被防火墙阻断 | Phase 5 延期 | 提供 fallback：手动粘贴 token |
| StreamingToolExecutor 与 session-loop 状态机冲突 | Phase 6 延期 | 先用 feature flag 控制，逐 provider 灰度 |
| 社区 Provider 质量参差 | Phase 7 用户信任 | CI 强制验证 + 兼容性标签 + 沙箱测试 |
