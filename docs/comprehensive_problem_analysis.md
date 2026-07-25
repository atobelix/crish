# Conex 代码库综合问题分析报告

> 基于 8+8=16 个 Agent 的多维度只读分析，结合 57 项 TECH_DEBT、12 份审计报告、11 份规划文档综合编译
> 分析日期：2026-07-24
> 本文件仅做问题分析与证据陈列，不包含解决方案

---

## 第一部分：系统性问题总览

### 1.1 执行纪律缺失

Conex 代码库最根本的问题不是缺少分析、缺少设计、缺少基础设施，而是"执行纪律缺失"。具体表现为三类：

**A. 基础设施已存在但未接入（虚假保障）**

以下组件写入了代码库，配置也存在，但未接入任何执行路径：
- `frameScheduler.ts` — 完整帧调度器实现，全库零调用方
- `useFpsMonitor.ts` — FPS 监控 hook，全库零调用方
- `backpressure.ts` 的 `Semaphore` — 仅测试引用，生产零消费方
- `sab_ring_buffer.rs` — 1 行空结构体，命名为"高性能 IPC"但无实现
- `OSKeychainStore` — 完整接口定义，所有方法 throw "not available"
- `deny.toml` — 严格依赖审计配置，CI 中从未执行 `cargo deny check`
- `.dependency-cruiser.js` — 架构约束规则，CI 中从未执行
- `.husky/pre-commit` — 调用 `npx lint-staged`，但 `lint-staged` 无任何配置
- `scripts/check-no-as-any-store.mjs` — 仅覆盖 `store/` 目录，不覆盖 packages/ 和全 apps/

**B. 文档与代码脱节（账实不符）**

TECH_DEBT.md 中 57 项债务的当前状态严重偏离实际：
- TD-030/031 声称"缺少 `noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`"，实际 `tsconfig.base.json` 中两者均已开启
- TD-044 声称"`provider-factory.ts` 已删除（确认无外部引用）"，实际文件仍在且有 8 处外部引用
- TD-042 声称"`clientApi.ts` 4 个返回 `[]` 的桩函数已删除"，实际 4 个 `@deprecated` 函数仍在
- TD-009 声称"21 处 @deprecated", 实际已增长到 27 处

**C. 同一能力多套实现**

同一个功能在代码库中有多套独立实现，治理复杂度和维护成本翻倍：
- 错误分类：ErrorClassifier（统一）+ provider-openai-compatible.ts 独立 3 函数 + fallback-chain 独立映射
- 流式渲染：useChatStream（StreamRenderBuffer + StreamTextBatcher 双层批合并）vs useAgentStream（每 chunk 直写 store）
- 降级机制：DynamicModelRouter + FallbackChain + RecoveryPipeline 三套互无集成契约

---

### 1.2 合并冲突污染（阻塞性问题）

`git status` 显示 **21 个 UU（unmerged）文件**处于未解决的合并冲突状态。这些文件包含 `<<<<<<<` / `=======` / `>>>>>>>` 标记，直接导致 TypeScript 编译失败 (TS1185)。

**涉及的核心文件（按影响面排序）：**

协议层（agent-daemon 10 个）：
- `packages/agent-daemon/src/protocol/protocol.ts` — IPC 消息验证的全部 switch 逻辑
- `packages/agent-daemon/src/protocol/registry.test.ts` — 协议注册表测试
- `packages/agent-daemon/src/protocol/validators/common.ts` — 公共验证器
- `packages/agent-daemon/src/protocol/validators/run.ts` — run 相关验证器
- `packages/agent-daemon/src/server.ts` — DaemonServer 主入口
- `packages/agent-daemon/src/server-handlers.ts` — Server handler
- `packages/agent-daemon/src/server-runtime-factory.ts` — Runtime 工厂
- `packages/agent-daemon/src/server-runtime-factory.test.ts` — 工厂测试
- `packages/agent-daemon/src/handlers/run-handlers.ts` — 运行 handler
- `packages/agent-daemon/src/types.ts` — 类型定义

运行时核心（agent-runtime 6 个）：
- `packages/agent-runtime/src/agent-session-loop.ts` — 会话循环（God 类拆分后的 barrel，但仍有冲突）
- `packages/agent-runtime/src/context-projection.ts` — 上下文投影
- `packages/agent-runtime/src/runtime-helpers.ts` — 运行时辅助
- `packages/agent-runtime/src/plugin-fs-registry.ts` — 插件注册表
- `packages/agent-runtime/src/provider-anthropic.ts` — Anthropic Provider
- `packages/agent-runtime/src/provider-gemini.ts` — Gemini Provider

前端核心（apps/crish-desktop 4 个）：
- `apps/crish-desktop/src/hooks/useChatStream.ts` — 流式会话核心 hook（L14-18 import、L747-760 onFrame 含冲突）
- `apps/crish-desktop/src/store/sessionActions.ts` — 会话 store action（L10-50 含冲突）
- `apps/crish-desktop/src/store/sessionStore.ts` — 会话 store（L9-23 含冲突）
- `apps/crish-desktop/src/store/layoutStore.ts` — 布局 store（L7-17 含冲突）

编排层（1 个）：
- `packages/agent-orchestrator/src/orchestrator.ts` — 编排器

**致命放大效应**：useChatStream.ts 的 Stashed 分支调用 `batchUpdateMessageText`，但该方法在 `session-actions/message-actions.ts` 中根本不存在（只实现了 `updateMessageText`）。若 Stashed 版本被合并，运行时会抛 `batchUpdateMessageText is not a function`。

---

## 第二部分：分层问题详情

### 2.1 架构解耦与模块边界

#### 2.1.1 God Class（大文件）现状

| 文件 | 行数 | 评估 |
|------|------|------|
| `apps/crish-desktop/src/App.tsx` | 138 | 正常（已通过 app/ 子模块拆分） |
| `packages/agent-daemon/src/server.ts` | 1 | 正常（barrel，已拆分到 server/ 目录） |
| `apps/crish-desktop/src/store/layoutStore.ts` | 191 | 正常（已通过 slices/ 拆分） |
| `apps/crish-desktop/src/store/sessionActions.ts` | 7 | 正常（barrel，已拆分到 session-actions/ 目录） |
| `apps/crish-desktop/src/api/clientApi.ts` | 887 | 偏高（Settings 类型 + Provider 转发桩 + DEAD/HONEST-HIDE 死代码） |
| `apps/crish-desktop/src/api/daemonChatBridge.ts` | 1214 | 极高（20+ 导出函数 + EventRouter + streamViaDaemon，前端最大单体文件） |
| `packages/agent-runtime/src/provider-openai-compatible.ts` | 623 | 中高（1 个 Provider 类 + 20 个模块级辅助函数） |
| `packages/agent-runtime/src/types.ts` | 283 | 正常 |

#### 2.1.2 组件行数超标

| 组件 | 行数 | 标准 | 超标 |
|------|------|------|------|
| `Workspace.tsx` | 994 | 300 | 694 |
| `ChatComposer.tsx` | 671 | 300 | 371 |

#### 2.1.3 包间依赖方向合规性

- `agent-daemon` 引用 `agent-runtime`：42 处全部走 `@crish/agent-runtime` 公共 API，合规（0 深路径）
- `apps/crish-desktop` 引用 packages：全部走 workspace 别名，合规
- `apps/agent-workbench` 测试文件 `tauri-command-registry.test.ts:17-22` 通过 `../../../../packages/agent-daemon/src/` 深路径引用，违规
- `shared-types` 被 100 个文件依赖，变更传播面极宽

#### 2.1.4 React.memo 覆盖率

- 提取子组件总数：119
- 已 memo：81
- 缺失 memo：38
- 覆盖率：68.1%
- 原生 `title="..."` 残留：约 50 处（`AgentCard.tsx`, `ApprovalAskCard.tsx`, `CardPanel.tsx`, `ChatStatusRibbons.tsx`, `McpSettingsTab.tsx` 等）

---

### 2.2 状态管理与数据流

#### 2.2.1 Immer 内 Object.assign 反模式

6 处 `Object.assign(draft, ...)` 全部在 Immer `set((state) => ...)` 回调内，破坏 Immer 代理追踪：

| 位置 | 行 | 目标来源 |
|------|-----|---------|
| `tool-actions.ts` | 27 | `msg.toolCalls.find(...)` 的 target |
| `tool-actions.ts` | 62 | `msg.toolCalls.find(...)` 的 tc |
| `tool-actions.ts` | 93 | agent toolCalls.find 的 tc（终态分支） |
| `tool-actions.ts` | 95 | agent toolCalls.find 的 tc（常规分支） |
| `agent-actions.ts` | 49 | `sess.agents.find(...)` 的 ag |
| `agent-actions.ts` | 61 | `ag.messages.find(...)` 的 existing |

L683 的注释"字段无实质变化：不 Object.assign"自相矛盾——紧接着 L685 就是 `Object.assign`。

#### 2.2.2 streamTextOffset 每消息保存

`SessionMessage` 上的 `streamTextOffset` 字段通过 6 条路径每消息写入，随 localStorage 持久化，长会话下序列化膨胀严重。该字段仅在流式渲染期间有意义。

写入路径：
1. `tool-actions.ts:38` — addMessageToolCall 固化
2. `message-actions.ts:47` — updateMessageText 归零
3. `sessionEventHydrate.ts:185` — message-done 投影
4. `sessionEventHydrate.ts:219` — tool-start 投影
5. `subagentTimeline.ts:170` — 子代理 tool-start
6. `sessionPersistence.ts:291-295` — localStorage 反序列化读入

#### 2.2.3 messages.shift() 物理截断

2 处残留（packages 层已清零）：
- `message-actions.ts:27` — `>= MAX_MESSAGES_PER_SESSION` 时 shift 最早消息
- `agent-actions.ts:63` — `>= MAX_MESSAGES_PER_AGENT` 时 shift 最早消息

截断无条件，不检查被移除消息是否包含 `toolCalls`（未完成的 tool-call 会丢失配对的 tool-result）。

#### 2.2.4 Zustand useShallow 遗漏

`useChatCardSelectors.ts:18-29` 中 `appSettings`、`diffFiles`、`composerDrafts` 等引用类型字段的 selector 无 `useShallow` 保护，每次 `useLayoutStore` 任一字段变更都触发 ChatCard 重渲染。

---

### 2.3 错误处理与可恢复性

#### 2.3.1 错误分类器统一状态

**已修复**：ErrorClassifier 核心实现完整（12 个 ErrorDomain、ClassifiedError 含 subType）、base-engine.ts 和 fallback-chain/engine.ts 已调用 ErrorClassifier.classify()。以下 TD 已解决：TD-001（默认 UNKNOWN + retryable: false 避免无限重试）、TD-010（413 在 400/422 之前）、TD-011（3 个缺失 domain 已添加）、TD-012（subType 已添加）。

**仍存在**：
- `provider-openai-compatible.ts:464-486` 仍有 `classifyTransportProviderError`/`classifyStreamProviderError`/`classifyHttpProviderError` 三个独立函数未走 ErrorClassifier
- TD-002：`ProviderCallGateway.call()` 抛出的 `CircuitBreakerOpenError` 不会被 `fallback-chain/engine.ts` 捕获（两者调用栈不通）
- TD-004：`session-store/index.ts:143,158` 两处 silent return 仍存在
- TD-033：DynamicModelRouter + FallbackChain + RecoveryPipeline 三套降级机制无集成契约

#### 2.3.2 空 catch 块

全代码库约 35 处空 catch：

按类型：
- `catch {}`：13 处（session-loop/index.ts 3 处 dispatch 失败吞、encrypted-file-store.ts:47 chmod 失败吞、dragOverlay/server-runtime-factory 等）
- `.catch(() => {})`：22 处（SessionSyncService 3 处、WAL 2 处、jsonl-append-batcher 3 处、layoutStore 2 处/bootstrap 3 处等）

最高风险位置：
- `session-loop/index.ts:121/126/284` — dispatch() 结果静默吞，状态机状态可能失控
- `shared-utils/src/wal.ts:96/101` — WAL 提交失败吞，数据不一致
- `shared-utils/src/jsonl-append-batcher.ts:175/180/190` — 批量 flush 失败吞，数据丢失
- `apps/crish-desktop/src/services/SessionSyncService.ts:350/409/445` — 会话同步失败吞，数据不一致

#### 2.3.3 CircuitBreaker 冒泡路径断裂

`provider-call-gateway.ts:96-98` 的 `throw new CircuitBreakerOpenError()` 被 `session-loop/index.ts:114` 的通用 `catch (cause)` 捕获后交给 `RecoveryCoordinator.handleErrorWithHook`，但其中没有针对 `CircuitBreakerOpenError` 的特殊降级。fallback-chain 的 `onCircuitOpen` 配置永远不会被触发，因为调用栈不经过 fallback-chain。

#### 2.3.4 Session Store 静默拒绝

`session-store/index.ts:143`（shard 满）和 `:158`（单 shard 消息满）仍 silent return，无日志、无异常、无 metric、无调用方反馈。

---

### 2.4 性能与资源利用

#### 2.4.1 流式渲染策略分裂

| 特性 | useChatStream | useAgentStream |
|------|--------------|----------------|
| Text batcher | StreamTextBatcher (48ms / 8000 chars) | 无 |
| Thinking batcher | StreamTextBatcher (48ms / 4000 chars) | 无 |
| Tool batcher | StreamValueBatcher (48ms) | 无 |
| Frame budget | StreamRenderBuffer (12ms / 8192 bytes) | 无 |
| 写入方式 | 批合并后写 store | 每 chunk 直写 `useLayoutStore.setState` |

useAgentStream 的 `onChunk` 回调（`:143-147`）每 token 直接 `useLayoutStore.setState`，性能策略完全落后于 useChatStream。

#### 2.4.2 Session 级并发控制缺失

- `session-loop/index.ts` 无 per-session AsyncMutex，同一 session 并发 `run()` 共享 state machine
- daemon `server.ts` 无 session 级锁（仅一个全局 `tickMutex` 用于 workflow 调度）
- `SessionStreamManager.ts:28` 使用 `new Map<string, SessionStreamHandle>()`（无界），非 `BoundedMap`

#### 2.4.3 sab_ring_buffer 空实现

`crates/conex-ipc/src/sab_ring_buffer.rs:1` 全文仅 `pub struct RingBufferHeader;`，无字段无方法。`conex-ipc/router.rs` 所有 dispatch 走 `serde_json::to_value`/`from_value` 全序列化。命名为"高性能 IPC"但名存实亡。

#### 2.4.4 死代码清单

以下组件已写入但无任何调用方（虚假保障）：
- `frameScheduler.ts` — 完整帧调度器，零引用
- `useFpsMonitor.ts` — FPS 监控，零调用方
- `backpressure.ts` 的 `Semaphore` 类 — 仅测试引用
- `bootstrap-services.ts` — 串行服务初始化，未在 main.tsx 中调用（可能死代码）

#### 2.4.5 SSE 解析零拷贝缺失

`crates/conex-stream/src/parser/sse.rs`：
- `:73` `to_vec()` 堆分配拷贝每帧
- `:80` `drain()` O(n) 移动剩余字节
- `:84` `to_vec()` 尾部 \r 剔除第二次堆分配
- `:97` `String::from_utf8(bytes.to_vec())` 第三次堆分配

每帧至少 3 次堆分配，无零拷贝路径。

---

### 2.5 测试覆盖与质量保障

#### 2.5.1 测试文件统计

| 包 | 测试文件数 |
|----|-----------|
| `packages/agent-runtime/src/` | 110 |
| `packages/agent-daemon/src/` | 25 |
| `apps/crish-desktop/src/` | 97 |
| `apps/agent-workbench/src/` | 12 |
| 总计 | 244+ |

#### 2.5.2 关键模块测试缺口

- `provider/engines/` 下 `anthropic-messages-engine.ts`、`ollama-engine.ts`、`openai-compatible-engine.ts` 无直接单元测试
- `session-loop/` 目录内 6 个模块文件无直接测试（仅通过 `agent-session-loop.test.ts` 间接覆盖）
- `ollama-engine.ts` 无任何层级的专用测试

#### 2.5.3 集成测试配置路径错位

- `package.json:62` 的 `test:integration` 从根目录运行 `vitest run --config vitest.integration.config.ts`
- `vitest.integration.config.ts` 存在于 `apps/crish-desktop/` 下，根目录不存在
- `apps/crish-desktop/tests/integration/` 下仅 2 个 `.test.ts` 文件和 `setup.ts`
- CI 集成测试 job 可能空跑或失败

#### 2.5.4 测试通过率（test:core）

- 137 个测试文件，92 通过，45 失败（通过率 67.2%）
- 1414 个测试用例，1157 通过，257 失败（通过率 81.8%）
- 主要失败原因：SSRF 拦截 localhost（`provider-factory.test.ts`、`circuit-breaker-e2e.test.ts`）、E2E 超时（`steering-injection.test.ts`、`stream-parser.test.ts`）、类型断言错误（`provider-call-gateway.test.ts`）

#### 2.5.5 覆盖率阈值

所有 vitest 配置统一为：statements 70 / branches 60 / functions 65 / lines 70。根配置未设 `enabled: true`，需 `--coverage` 触发。

---

### 2.6 安全与密钥管理

#### 2.6.1 Provider API Key 存储

**严重缺陷**：
1. **OSKeychainStore 是 stub**：`secret-store.ts:15-30` 所有方法 throw "not available"。不调用 macOS Keychain / Windows Credential Manager / Linux libsecret。
2. **Master key 与 vault 同目录**：`encrypted-file-store.ts:28-29` `.crish-master-key` 与 `.crish-secrets.enc` 同目录。文件读权限突破即同时获取密钥和密文。Windows 上 `chmod 0o600` 静默失败。
3. **前端 localStorage 明文**：`providerProfiles.ts:641-649` 经 `saveProfiles` 将 apiKey 明文序列化到 `localStorage` 键 `crish_provider_profiles_v1`。
4. **密码熵不足**：master key 文件缺失时的 fallback 密码 `${masterKey}${COMPUTERNAME}${USERNAME}${os.hostname()}`，域环境下可预测。

#### 2.6.2 Sandbox 隔离骨架

- `guard.rs`：`pub struct CommandGuard;` 一行，无方法
- `process.rs`：`pub struct ProcessManager;` 一行，无方法
- `sandbox_handler.rs`：`run_sandboxed` 返回 `{"status":"not_implemented"}`
- `gatekeeper.rs:73-78`：`check_command` 仅正则黑名单，`args.join(" ")` 无引号处理，`rm -rf "/"` 即可绕过

无 seccomp、namespace、job object、AppContainer 任何真正进程隔离。

#### 2.6.3 MCP 启动安全

- `mcp-stdio-adapter.ts:84-89`：command 无白名单/签名/权限校验，任何配置即可执行任意命令
- `:123-132` `mergeProcessEnv()`：完整 `process.env` 泄漏给 MCP 子进程（含 API key）
- `mcp-config.ts:105-120`：mcp.json 无完整性检查/签名

#### 2.6.4 CSP 完全开放

`index.html:7` CSP 含：
- `script-src 'unsafe-inline' 'unsafe-eval'` — XSS 防御完全失效
- `connect-src http: https: ws: wss:` — SSRF 防护连通已被 CSP 绕过

#### 2.6.5 DNS Rebinding 未修复

`base-url-validator.ts:35-72` 仅字符串匹配，无 DNS 解析后校验。`DNS-REBINDING-ASSESSMENT.md` 评估为"中"风险但无对应修复代码。

---

### 2.7 类型系统与代码质量

#### 2.7.1 any 类型滥用

| 范围 | as any | : any | 合计 |
|------|--------|-------|------|
| packages/ 生产代码 | 99 | 90 | 189 |
| apps/crish-desktop/ | 43 | — | 43 |

重灾文件：
- `provider-openai-compatible.ts`：25 处 `: any`（函数签名类型）
- `session-loop/index.ts`：12 处 `as any`
- `layoutStore.ts`：6 处 `as any`
- `SessionRuntimeRegistry.ts`：4 处 `as any`

`scripts/check-no-as-any-store.mjs` 仅覆盖 `store/` + `storeAccess.ts`，不覆盖 packages/ 和 apps/ 大部分代码。

#### 2.7.2 @deprecated 标记失控

全库共 27 处（比 TD-009 的 21 处多 6 处）。其中：
- 4 处完全无替代路径（`SidebarContextMenus.tsx:71/73/75/77`，仅有 `/** @deprecated */`）
- 6+ 处有替代路径但无删除条件
- 3 处替代路径模糊（`provider-factory.ts:2 "勿用于生产"` 无具体指向）

#### 2.7.3 TS strictness 配置

- `noUncheckedIndexedAccess`：已开启（tsconfig.base.json:18），TD-030 已修复但文档未更新
- `exactOptionalPropertyTypes`：已开启（tsconfig.base.json:19），TD-031 已修复但文档未更新
- `apps/crish-desktop/tsconfig.node.json`：仍不继承 base，无 strict

---

### 2.8 构建与 CI/CD 流水线

#### 2.8.1 CI 配置缺口

| 能力 | 状态 |
|------|------|
| 跨平台矩阵测试 | 存在 |
| Rust cargo test --workspace | 存在 |
| Rust clippy (deny) | 存在 |
| 集成测试 job | 存在（但路径错位） |
| 模糊测试 job | 存在 |
| Rust 覆盖率 (>=50%) | 存在 |
| npm audit | 缺失 |
| cargo audit / cargo deny check | 缺失（deny.toml 已配置但未执行） |
| depcruise 门禁 | 缺失（配置存在但 CI 未执行） |
| 合并冲突检测 | 缺失（CI 和 pre-commit 均无 `<<<<<<<` 检查） |

#### 2.8.2 depcruise 状态

- 配置文件：存在（`.dependency-cruiser.cjs` + `.dependency-cruiser.js`，内容一致）
- 规则：4 条（no-runtime-to-shared / no-daemon-from-runtime / no-daemon-from-desktop / no-circular）
- `no-runtime-to-shared` 规则与代码实际脱节：agent-runtime 大量使用 shared-utils（AsyncMutex、BoundedMap 等），执行后会报 46 条违规
- 未排除 `dist/` 目录，运行 `depcruise packages apps` 报告 255 条违规（全部为 `dist/` 构建产物的循环依赖误报）
- `package.json` 中无 `dependency-cruiser` 依赖或脚本

#### 2.8.3 package.json 脚本缺口

| 脚本 | 状态 |
|------|------|
| audit | 缺失 |
| lint:deps / check:deps | 缺失 |
| depcruise | 缺失 |

#### 2.8.4 Husky Git Hooks

- `.husky/pre-commit`：调用 `npx lint-staged`，但 `lint-staged` 零配置（空跑）
- `.husky/pre-push`：运行 `typecheck && test`，设计合理但不检测合并冲突

---

## 第三部分：跨层关联分析

### 3.1 问题传播链

以下问题在多个层间传播，单一层修复无法根治：

1. **错误分类→降级→Session Store 的链**：分类器未统一→provider-openai-compatible 自写分类返回错误的 retryable→降级链无限重试→Session Store 满→静默拒绝→消息丢失。

2. **流式渲染→store→持久化的链**：useAgentStream 无批合并→每 token 写 store→trigger React 重渲染→store 中 streamTextOffset 随每消息持久化→序列化膨胀→long session 内存泄漏。

3. **沙盒→MCP→CSP 的安全链**：sandbox 骨架→MCP 启动无校验→任意命令可执行→CSP `unsafe-eval` 不阻止 XSS→攻破无 sandbox 的系统。

4. **合并冲突→CI 缺拦截→TECH_DEBT 失真的治理链**：合并冲突未拦截→CI 状态不可靠→信任缺失→TECH_DEBT 无人更新→文档与代码进一步脱节。

### 3.2 累积影响评估

| 维度 | 评估 | 说明 |
|------|------|------|
| 编译可靠性 | 不可靠 | 21 个 UU 文件，TS1185 编译必败 |
| 测试可靠性 | 不可靠 | 45/137 文件失败，SSRF 误拦掩蔽真实问题 |
| 安全防护 | 形同虚设 | 沙盒未实现，CSP 无效，API key 明文 |
| 性能上限 | 低于可能 | useAgentStream 无批合并，sab_ring_buffer 未实现，SSE 零拷贝无 |
| 维护成本 | 极高 | 27 处 @deprecated 无清理计划，205 处 any，35 处空 catch |
| 治理可信度 | 极低 | TECH_DEBT 账实不符，CI 基础设施存在但未运行 |

---

## 第四部分：统计附录

### 4.1 问题汇总表

| 类别 | 问题数 | 证据级别 |
|------|--------|---------|
| 合并冲突（UU 文件） | 21 | git status 直接确认 |
| God Class / 大文件 | 4 | 文件行数直接确认 |
| 空 catch 块 | 35 | grep 直接确认 |
| any 类型滥用 | 232 | grep 直接确认 |
| @deprecated 标志 | 27 | grep 直接确认 |
| 缺失替代路径的 @deprecated | 4+6 | 人工审读 |
| Immer 内 Object.assign | 6 | grep + 上下文确认 |
| messages.shift() 残留 | 2 | grep 直接确认 |
| streamTextOffset 写入路径 | 6 | grep 直接确认 |
| useShallow 遗漏 | 1(组12个字段) | 代码审读 |
| 死代码（定义了未使用） | 4 | grep 交叉验证 |
| 测试失败（test:core） | 257 用例 | npm run 实测 |
| 无直接测试的 engine | 3 | 文件存在性检查 |
| CI 缺口 | 5 | 配置审读 |
| 安全缺陷（严重+高） | 6 | 代码审读 |

### 4.2 文件引用索引

所有证据文件路径均为 `c:\Software\conex\` 下相对路径。完整文件引用列表：

| 文件 | 行号 | 问题 |
|------|------|------|
| apps/crish-desktop/src/hooks/useChatStream.ts | 14-18, 747-760 | 合并冲突 |
| apps/crish-desktop/src/store/sessionActions.ts | 10-50 | 合并冲突 |
| apps/crish-desktop/src/store/sessionStore.ts | 9-23 | 合并冲突 |
| apps/crish-desktop/src/store/layoutStore.ts | 7-17 | 合并冲突 |
| packages/agent-daemon/src/protocol/protocol.ts | 34-45, 203-224, 258-263 | 合并冲突 |
| packages/agent-daemon/src/server.ts | 全部 | 合并冲突 |
| packages/agent-daemon/src/server-handlers.ts | 全部 | 合并冲突 |
| packages/agent-daemon/src/server-runtime-factory.ts | 全部 | 合并冲突 |
| packages/agent-daemon/src/handlers/run-handlers.ts | 全部 | 合并冲突 |
| packages/agent-daemon/src/types.ts | 全部 | 合并冲突 |
| packages/agent-runtime/src/agent-session-loop.ts | 全部 | 合并冲突 |
| packages/agent-runtime/src/context-projection.ts | 全部 | 合并冲突 |
| packages/agent-runtime/src/runtime-helpers.ts | 全部 | 合并冲突 |
| packages/agent-runtime/src/plugin-fs-registry.ts | 全部 | 合并冲突 |
| packages/agent-runtime/src/provider-anthropic.ts | 全部 | 合并冲突 |
| packages/agent-runtime/src/provider-gemini.ts | 全部 | 合并冲突 |
| packages/agent-orchestrator/src/orchestrator.ts | 全部 | 合并冲突 |
| packages/agent-runtime/src/error-classifier.ts | 4-17, 21-33, 61-212 | 已实现 |
| packages/agent-runtime/src/provider-openai-compatible.ts | 464-486 | 独立分类器残留 |
| packages/agent-runtime/src/provider-gateway/credential-resolver.ts | 48 | baseUrl 验证 |
| packages/agent-runtime/src/provider/auth/base-url-validator.ts | 35-72 | DNS rebinding 未修复 |
| packages/agent-runtime/src/provider/auth/secret-store.ts | 15-30 | OSKeychain stub |
| packages/agent-runtime/src/provider/auth/encrypted-file-store.ts | 28-29 | master key 同目录 |
| apps/crish-desktop/src/api/providerProfiles.ts | 641-649 | localStorage 明文 |
| apps/crish-desktop/index.html | 7 | CSP unsafe-eval |
| packages/agent-daemon/src/mcp-stdio-adapter.ts | 84-89, 123-132 | MCP 无校验 |
| crates/conex-sandbox/src/guard.rs | 1 | 空 guard |
| crates/conex-sandbox/src/process.rs | 1 | 空 process manager |
| crates/conex-sandbox/src/handlers/sandbox_handler.rs | 14 | not_implemented |
| crates/conex-ipc/src/sab_ring_buffer.rs | 1 | 空 ring buffer |
| packages/agent-runtime/src/session-loop/index.ts | 34-129 | 无 per-session 锁 |
| packages/agent-runtime/src/session-store/index.ts | 142-143, 158 | silent return |
| packages/shared-utils/src/backpressure.ts | 全部 | Semaphore 死代码 |
| apps/crish-desktop/src/utils/frameScheduler.ts | 62 | 死代码 |
| apps/crish-desktop/src/hooks/useFpsMonitor.ts | 4 | 死代码 |
| .dependency-cruiser.cjs | 3-31 | 规则定义 |
| .github/workflows/ci.yml | 全部 | CI 配置 |
| TECH_DEBT.md | 全部 | 57 项债务 |
| tsconfig.base.json | 18-19 | TD-030/031 已修复但未更新 |

---

*本文件为综合问题分析文档，供方案制定使用。不包含具体的解决方案、时间安排或人员分配。*
