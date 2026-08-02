# Technical Debt Register

> 种子清单，基于 P1–P12 审计报告提取（2026-07-23）  
> 按照严重性分级：Critical / Major / Minor / Cosmetic  
> 每项含：ID · 描述 · 影响范围 · 关联位置 · 发现时间

---

## Priority: Critical

| ID | 描述 | 范围 | 关联位置 | 发现时间 |
|----|------|------|----------|----------|
| TD-001 | 兜底默认 `TRANSIENT_SERVER`(retryable:true) 与现有 3 套分类器矛盾，可能引发无限重试 | ErrorClassifier | `base-engine.ts:96-97`, `fallback-chain/engine.ts:20`, `provider-openai-compatible.ts:2335` | 2026-07-23 |
| TD-002 | `CircuitBreakerOpenError` 冒泡路径不存在，`ProviderCallGateway.call()` 直接 throw，不会被 `FallbackChain` 捕获 | RecoveryPipeline | `runtime-components/provider-call-gateway.ts:96`, `agent-session-loop.ts` | 2026-07-23 |
| TD-003 | `sliceContextAtValidBoundary` 不存在，Tier 3 上下文自愈依赖的函数未实现 | Context Compression | `context-slicer.ts`(需新建) | 2026-07-23 |
| TD-004 | `session-store/index.ts:169` 静默拒绝 — shard 满时 `appendMessage` 直接 return，新消息丢失 | Session Store | `session-store/index.ts:169` | 2026-07-23 |
| TD-005 | 不存在 `PricingEngine`，Token 消耗时序追踪完全缺失，无 USD 成本计算 | Observability | `pricing-engine.ts`(需新建), `token-tracker.ts` | 2026-07-23 |
| TD-006 | 不存在 `TECH_DEBT.md`，技术债务信息散落 12+ 份文档中无法统一追踪 | Engineering | 项目根目录(需新建) | 2026-07-23 |
| TD-007 | 7 处错误判定逻辑分散在 4 个包中，无统一入口，存在重复代码 | Error Classification | `base-engine.ts`, `provider-openai-compatible.ts`(4函数), `provider-openai-base.ts`, `fallback-chain/engine.ts`, `FailoverReason.ts` | 2026-07-23 |
| TD-008 | `canonicalizeJsonSchema` 位于前端 `crish-desktop` 且仅处理第一层属性，完全不递归 | Tool Schema | `apps/crish-desktop/src/api/directFetchBridge.ts:16-40` | 2026-07-23 |
| TD-009 | `@deprecated` 全部 27 处缺少替代路径和删除条件 | Code Quality | 全部 27 处 `@deprecated` 标记文件 | 2026-07-23 |
| TD-060 | CSP `unsafe-eval` / `unsafe-inline` 策略放行，增加 XSS 攻击面 | Security | `apps/crish-desktop/index.html`, nginx config | 2026-07-24 |
| TD-061 | frontend `localStorage` 明文存储 API keys 未加密 | Security | `apps/crish-desktop/src/api/clientApi.ts`, `apps/crish-desktop/src/api/mcpApi.ts` | 2026-07-24 |
| TD-063 | session 无 per-session 并发控制，多 Tab 同 session 可能产生冲突写 | Session Store | `packages/agent-runtime/src/session-store/` | 2026-07-24 |

## Priority: Major

| ID | 描述 | 范围 | 关联位置 | 发现时间 |
|----|------|------|----------|----------|
| TD-010 | 400/422 分支覆盖 `payload-too-large` 特例，图像 scrub 恢复被打断 | Error Classification | `error-classifier.ts`(需修复优先级表) | 2026-07-23 |
| TD-011 | 缺少 `QUOTA_EXHAUSTED` / `GATEWAY_CHALLENGE` / `ENDPOINT_UNAVAILABLE` 三个 ErrorDomain | Error Classification | `error-classifier.ts` | 2026-07-23 |
| TD-012 | `ClassifiedError` 缺少 `subType` 字段，Tier 3 无法区分 `context_overflow` 和 `payload_too_large` | Error Classification | `error-classifier.ts` | 2026-07-23 |
| TD-013 | `messages.shift()` 物理截断 4 处，破坏 tool-call/tool-result 配对完整性 | Session Context | `chat.ts:46`, `sessionActions.ts:437-438`, `agent.ts:44`, `sessionActions.ts:840` | 2026-07-23 |
| TD-014 | `isAiBusy` 判定窗口不可靠，存在双窗口竞态导致两个 Run 并发启动 | Steering Queue | `useChatStream.ts:1901-1956` | 2026-07-23 |
| TD-015 | `queued` 消息没有自动消费机制，`queued` 消息永远留在 store 中成为幽灵 | Steering Queue | `useChatStream.ts`, `agent-input-queue.ts` | 2026-07-23 |
| TD-016 | `store/actions/` 目录 5 个僵尸文件 — ✅ 已删除 (R5.1) | Frontend State | `store/actions/` | 2026-07-23 |
| TD-017 | 8 处 `Object.assign` 在 Immer 回调内的原位突变，破坏 Immer 不变性 | Frontend State | `sessionActions.ts`(8处:414/621/675/757/759/813/838) | 2026-07-23 |
| TD-018 | `streamTextOffset` 保存在每个 Message 上导致大量内存开销 + 序列化膨胀 | Frontend State | `types.ts`, `sessionPersistence.ts` | 2026-07-23 |
| TD-019 | 压缩优先级不当：工具输出 > 思考块 > 完整 Turn，可能导致模型"幻觉依赖" | Context Compression | `context-compression.ts` | 2026-07-23 |
| TD-020 | `compressionHistory` 不保留，跨压缩轮次追溯不可行 | Context Compression | `context-state.ts` | 2026-07-23 |
| TD-021 | `FileSnapshotHint` 缺少 `op` 字段，读写区分靠正则启发式 | Context Compression | `context-compression.ts:385-401` | 2026-07-23 |
| TD-022 | 自动文件操作追踪完全缺失 — Tool 执行后不调用 `markFileSnapshot` | Context Compression | `tool-middleware.ts`, `context-state.ts` | 2026-07-23 |
| TD-023 | 不存在 `SubagentExecutionStrategy` 枚举，子 Agent 执行路径硬编码 | Subagent | `subagents.ts`, `subagent-runtime.ts` | 2026-07-23 |
| TD-024 | 不存在 `agentLoop()` 纯函数，子 Agent 完整构建 `AgentRuntime` 不必要 | Subagent | `subagents.ts:257-268` | 2026-07-23 |
| TD-025 | `common.ts` 与 `base.ts` validator 高度重复，违反 DRY | IPC Protocol | `protocol/validators/common.ts:1812`, `base.ts:1808` | 2026-07-23 |
| TD-026 | IPC 协议无版本号，无法运行时检测 Daemon 与客户端协议版本差异 | IPC Protocol | `schema-groups.ts`, `protocol.ts` | 2026-07-23 |
| TD-027 | `protocol.ts` switch 缺少 exhaustiveness `never` 检查 | IPC Protocol | `protocol.ts` | 2026-07-23 |
| TD-028 | `rejectUnknownFields` 无警告模式，新版客户端多余字段直接被拒绝 | IPC Protocol | `common.ts:1812`, `base.ts:1808` | 2026-07-23 |
| TD-029 | `crish-desktop/tsconfig.node.json` 不继承 `tsconfig.base.json`，无 `strict` | Engineering | `apps/crish-desktop/tsconfig.node.json` | 2026-07-23 |
| TD-030 | `tsconfig.base.json` 缺少 `noUncheckedIndexedAccess` — ✅ 已修复 (noUncheckedIndexedAccess 已开启) | Engineering | `tsconfig.base.json` | 2026-07-23 |
| TD-031 | `tsconfig.base.json` 缺少 `exactOptionalPropertyTypes` — ✅ 已修复 (exactOptionalPropertyTypes 已开启) | Engineering | `tsconfig.base.json` | 2026-07-23 |
| TD-032 | `arr[N]` 下标访问模式约 1070 处，缺少非空保护 | Engineering | 全部 `packages/` + `apps/` | 2026-07-23 |
| TD-058 | 21 个 UU (Unused/Untested) 文件散布于 packages/agent-runtime，未纳入测试覆盖 | Code Cleanup | `packages/agent-runtime/src/` | 2026-07-24 |
| TD-059 | `useChatStream` / `useAgentStream` 渲染策略分裂 — 两套相似但独立的流式渲染 hook | Frontend Architecture | `apps/crish-desktop/src/hooks/useChatStream.ts`, `apps/crish-desktop/src/hooks/useAgentStream.ts` | 2026-07-24 |
| TD-062 | CI/CD 缺 5 项安全门禁：SAST、SCA、容器扫描、密钥扫描、许可合规 | Engineering | `.github/workflows/` | 2026-07-24 |

## Priority: Minor

| ID | 描述 | 范围 | 关联位置 | 发现时间 |
|----|------|------|----------|----------|
| TD-033 | `DynamicModelRouter` 与 `FallbackChain` 无集成契约，两套降级机制互不感知 | Recovery Pipeline | `model-routing-dynamic/index.ts`, `fallback-chain/engine.ts` | 2026-07-23 |
| TD-034 | `provider-call-gateway.ts:131` 向后兼容路径使用硬编码正则 | Error Classification | `provider-call-gateway.ts:131` | 2026-07-23 |
| TD-035 | `chat.ts` 的 `setSessionMessageStatus` 签名用 `status: any` — ✅ 文件已删除 (R5.1) | Frontend State | `store/actions/chat.ts` | 2026-07-23 |
| TD-036 | `blocks` 使用 `filter` 破坏性重置，非增量更新 | Frontend State | `sessionActions.ts:578` | 2026-07-23 |
| TD-037 | `ToolRegistry.list()` 不是排序输出 | Tool Schema | `tool-registry.ts` | 2026-07-23 |
| TD-038 | `ToolRegistry` 无 `ready` Promise | Tool Schema | `tool-registry.ts` | 2026-07-23 |
| TD-039 | no-circular 规则配置不存在 | Engineering | `.dependency-cruiser.cjs`(需新建) | 2026-07-23 |
| TD-040 | `lint:deps` npm script 不存在 | Engineering | `package.json` | 2026-07-23 |
| TD-041 | `chatApi.demo.ts` — 有外部引用（`chatApi.ts` 导入 `shouldUseMockStream`/`streamMockAssistantResponse`），需先重构 `chatApi.ts` 解除依赖 | Code Cleanup | `apps/crish-desktop/src/api/chatApi.demo.ts` | 2026-07-23 |
| TD-042 | `clientApi.ts` 4 个返回 `[]` 的桩函数 — 仍存在，待清理 | Code Cleanup | `apps/crish-desktop/src/api/clientApi.ts` | 2026-07-23 |
| TD-043 | `layoutAnimationStore.ts:99,191` 两个无引用的属性 — 已清理，文件仍存在 | Code Cleanup | `apps/crish-desktop/src/store/layoutAnimationStore.ts` | 2026-07-23 |
| TD-044 | `provider-factory.ts` 整文件废弃 — 仍存在且有 8 处外部引用，待清理 | Code Cleanup | `packages/agent-runtime/src/provider-factory.ts` | 2026-07-23 |
| TD-045 | `provider-anthropic.ts` @deprecated → `AnthropicMessagesEngine` | Code Cleanup | `packages/agent-runtime/src/provider-anthropic.ts` | 2026-07-23 |
| TD-046 | `provider-gemini.ts` @deprecated → `OpenAICompatibleEngine` | Code Cleanup | `packages/agent-runtime/src/provider-gemini.ts` | 2026-07-23 |
| TD-047 | `provider-openai-base.ts` @deprecated 已迁移到 `base-engine.ts` | Code Cleanup | `packages/agent-runtime/src/provider-openai-base.ts` | 2026-07-23 |
| TD-048 | `provider-openai-compatible.ts` @deprecated → `OpenAICompatibleEngine` | Code Cleanup | `packages/agent-runtime/src/provider-openai-compatible.ts` | 2026-07-23 |
| TD-049 | `VirtualScrollManager.ts:111` `syncOrder` 别名 | Code Cleanup | `apps/crish-desktop/src/api/VirtualScrollManager.ts:111` | 2026-07-23 |
| TD-050 | `toolPresentation.ts:575` `toolHumanLabel` 别名 | Code Cleanup | `apps/crish-desktop/src/api/toolPresentation.ts:575` | 2026-07-23 |
| TD-051 | `useAgentStream.ts:29` 自动推导 | Code Cleanup | `apps/crish-desktop/src/hooks/useAgentStream.ts:29` | 2026-07-23 |

## Priority: Cosmetic

| ID | 描述 | 范围 | 关联位置 | 发现时间 |
|----|------|------|----------|----------|
| TD-052 | `@deprecated` 注释格式不统一（部分缺失替代路径和删除条件） — ✅ 已修复 (统一添加 @see / @removeWhen) | Code Quality | 全部 27 处 `@deprecated` | 2026-07-23 |
| TD-053 | `builder-adapter-utils.ts` 内类型定义顺序未按确定性排序 | Tool Schema | `builder-adapter-utils.ts` | 2026-07-23 |
| TD-054 | 压缩摘要消息缺乏结构化标记，模型难以区分 VS 用户消息 | Context Compression | `context-compression.ts:223-247` | 2026-07-23 |
| TD-055 | `fileSnapshotHints` 输出为字符串数组而非结构化数据 | Context Compression | `context-state.ts:113-136` | 2026-07-23 |
| TD-056 | 无 `lint:deps` CI 步骤 | Engineering | `.github/workflows/` | 2026-07-23 |
| TD-057 | 无 Husky pre-commit dep-cruiser 检查 | Engineering | `.husky/` | 2026-07-23 |

---

## 统计

| 严重性 | 数量 |
|--------|------|
| Critical | 12 |
| Major | 26 |
| Minor | 19 |
| Cosmetic | 6 |
| **总计** | **63** |
