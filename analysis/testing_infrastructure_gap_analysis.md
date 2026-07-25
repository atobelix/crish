# 测试基础设施现状分析与差距识别

## 一、执行摘要

本文档对 conex 项目（monorepo）当前的测试基础设施进行全面的深度评估。项目涵盖 TypeScript 包（`packages/agent-runtime/`、`packages/agent-daemon/`、`packages/agent-orchestrator/`、`packages/shared-utils/`、`packages/decision-engine/`、`packages/shared-types/`）和 Rust crate（`crates/conex-stream/`、`crates/conex-db/`、`crates/conex-sandbox/`、`crates/conex-diff/`、`crates/conex-search/`、`crates/conex-compaction/`、`crates/conex-fs/`、`crates/conex-net/`、`crates/conex-ipc/`、`crates/conex-types/`），测试框架为 vitest（TypeScript）和 Rust 内建 `#[cfg(test)]`。

评估覆盖七个维度：测试框架配置质量、测试覆盖率分布、测试类型配比、测试工具基础设施、测试隔离性、测试可重复性、测试可观测性。每个维度给出评分（1–5）和代码级依据。

**核心发现**：项目拥有数量可观的测试文件（packages 下约 120+ 个 `.test.ts` 文件，crates 下约 50+ 个 `#[cfg(test)]` 模块），但存在严重的结构性问题——假 Provider / mock LLM 设施缺失、环境隔离不彻底、集成测试覆盖率极低、测试数据管理原始、覆盖率门禁不存在。这些问题共同导致：当前测试套件无法有效防止退化，修改 Provider 网关或工具管线等高复杂度模块时缺乏安全网。

**总体评分**：2.2 / 5（各项评分见下文各维度）。

---

## 二、当前测试体系深度评估

### 2.1 测试框架使用情况（vitest 配置质量）——评分：3/5

`vitest.config.ts`（`C:\Software\conex\vitest.config.ts:1-18`）配置内容：

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    environment: 'node',
    include: [
      'packages/**/src/**/__tests__/e2e/**/*.test.ts',
      'packages/**/src/**/*.test.ts',
      'apps/crish-desktop/src/**/*.test.ts',
      'apps/agent-workbench/src/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
```

这是一份干净但过于简化的配置。以下是逐一分析：

**2.1.1 setupFiles 单一且不完整**

`vitest.setup.ts`（`C:\Software\conex\vitest.setup.ts:1-44`）只提供了一组 browser 全局 mock（`localStorage`、`window`、`CustomEvent`、`dispatchEvent`）。这些 mock 是用于测试前端 store 和桌面端逻辑的。以下是当前 setup 缺失的关键点：

- 没有全局的 `vi.useFakeTimers()` 或时间控制策略——大部分测试依赖 `Date.now()` 和 `setTimeout`，但没有任何机制确保时间可控
- 没有默认的 `AbortController` 超时保护——测试可以无限等待不会完成的 Promise
- 没有环境变量清理——如果开发者的 shell 配置了 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`，测试可能无意触发真实 API 调用
- 没有 mock LLM API 的全局 hook
- 没有全局的 `onUnhandledRejection` 处理器——未捕获的 Promise rejection 不会被测试框架捕获
- 没有 `console.warn`/`console.error` 的 spy——测试过程中产生的意外日志不会被标记为失败

**2.1.2 缺少 globalSetup/globalTeardown**

vitest 支持 `globalSetup` 和 `globalTeardown` 配置，用于在所有测试开始前和结束后执行一次性操作。当前完全没有使用。这意味着：

- 无法在测试套件级别启动 mock HTTP server（每个 e2e 测试文件需要自己 `beforeAll` 启动、`afterAll` 关闭）
- 无法创建统一的临时目录结构用于文件操作测试
- 无法备份和清理环境变量

对比 `e2e/mock-server.ts`（`C:\Software\conex\packages\agent-runtime\src\provider\__tests__\e2e\mock-server.ts:125-136`）中每个 e2e 测试文件手动管理 `server.start()` / `server.stop()` 的生命周期，就可以看出缺失 globalSetup 的代价。

**2.1.3 集成测试配置分离但不对等**

`vitest.integration.config.ts`（`C:\Software\conex\apps\crish-desktop\vitest.integration.config.ts:1-8`）定义了独立的集成测试配置：

```typescript
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 10000,
    setupFiles: ['./tests/integration/setup.ts'],
  },
});
```

但问题是：
- 这个配置位于 `apps/crish-desktop/` 目录下，不属于 monorepo 根配置
- 它只覆盖 `tests/integration/**/*.test.ts`，但 `packages/agent-runtime/src/provider/__tests__/e2e/` 下的 5 个 E2E 测试文件走的是主配置
- 没有 workspace 级别的集成测试配置
- 没有 `test:integration` 脚本以外的 runner 入口

**2.1.4 测试分组策略原始**

`package.json:57-60` 定义了以下测试运行脚本：

```
"test:core": "vitest run packages/agent-runtime/src packages/agent-orchestrator/src packages/agent-daemon/src",
"test:desktop-helpers": "vitest run apps/crish-desktop/src/api apps/crish-desktop/src/store",
"test": "vitest run",
"test:coverage": "vitest run --coverage",
"test:integration": "vitest run --config vitest.integration.config.ts",
```

这种通过显式传递目录路径来分组的方式存在以下问题：
- 新增的测试文件如果放在子目录（如 `__tests__/integrations/`）会被意外包含或遗漏
- 没有标签系统（`@unit` / `@integration` / `@e2e`），无法在 CI 中选择运行特定类别
- `test:core` 没有覆盖 `packages/decision-engine/src`、`packages/shared-utils/src`、`packages/shared-types/src`
- `test:integration` 脚本对应的配置在 app 目录下，而不是 workspace 根目录

**2.1.5 缺少全局超时配置**

没有在 `vitest.config.ts` 中设置 `testTimeout` 的全局默认值。vitest 3.x 的默认超时是 3000ms（3 秒）。这对单元测试够用，但：
- `agent-session-loop.test.ts` 涉及 async generator 和多个 turn 循环，需要更长的超时
- 各个 e2e 测试需要 mock server 启动时间
- 每个测试文件要么继承默认值，要么通过 `.extend()` 手动设置，没有集中约定

### 2.2 测试覆盖率——评分：2/5

**2.2.1 packages/shared-utils 覆盖率**

文件 `/packages/shared-utils/src/` 目录下有 43 个文件（非 test），其中有测试的仅 14 个：

| 有测试的文件 | 无测试的关键文件 |
|-------------|------------------|
| `async-mutex.ts` | `cache.ts` |
| `deep-equal.ts` | `error.ts` |
| `backpressure.ts` | `logger.ts` |
| `bounded-map.ts` | `memory-manager.ts` |
| `ring-buffer.ts` | `retry.ts` |
| `seek-sequence.ts` | `wal.ts` |
| `jsonl-append-batcher.ts` | `metrics-exporter.ts` |
| `object.ts` | `prometheus-exporter.ts` |
| `skill-id.ts` | `fsync.ts` |
| `file/` 下 5 个文件 | `hardware-profile.ts` |
| | `dynamic-adaptation.ts` |
| | `platform-adaptation.ts` |
| | `use-platform-adaptation.ts` |
| | `bounded-array.ts` |
| | `bounds.ts` |
| | `guards.ts` |
| | `abort-utils.ts` |
| | `browser-index.ts` / `node-index.ts` |
| | `performance-tier.ts` |

分析这些无测试文件的复杂度：
- `cache.ts`：包含基于 TTL 的内存缓存，支持 `get()`/`set()`/`has()`/`delete()`/`clear()`/`evict()`，涉及时间敏感性
- `retry.ts`：被多模块广泛使用（tool-executor、provider-call-gateway、connection-manager），包含指数退避、最大重试次数、可重试错误判断
- `wal.ts`：预写日志模块，涉及文件 I/O、append-only 语义、恢复逻辑
- `error.ts`：错误分类工具，被整个项目引用
- `logger.ts`：日志基础设施，可能在测试中产生副作用
- `metrics-exporter.ts` 和 `prometheus-exporter.ts`：指标导出，会影响进程行为

这些文件的缺失测试意味着：
- 任何人都可以修改这些模块而不知道是否破坏了它们
- 重构这些模块时没有安全网
- `cache.ts` 的时间敏感的 `evict()` 逻辑和 `retry.ts` 的退避计算从未经过验证

**2.2.2 packages/agent-runtime 覆盖率**

`packages/agent-runtime/src/` 是项目最大的包，约有 80+ 个 `.test.ts` 文件。但在大量测试文件之下存在严重的覆盖率偏差：

**高覆盖率的模块**：
- `provider-gateway.ts`（1001 行）：`provider-gateway.test.ts`（625 行） + `provider-gateway-edge.test.ts`
- `tool-executor.ts`（568 行）：`tool-executor.test.ts`（284 行）
- `trust-zone.ts`（类似决策-引擎）：`trust-zone.test.ts`（491 行）——质量较高
- `tools.ts`：`tools.test.ts`（127 行）
- checkpoints、context-compression、preview-queue 等较小模块

**低覆盖率的关键模块**：
- `agent-session-loop.ts`（2293 行）：`agent-session-loop.test.ts`（990 行）——行数比 1:2.3，绝大多数分支未覆盖
- `provider-anthropic.ts`（432 行）：`provider-anthropic.test.ts`（644 行）——虽然行数多，但测试格式以 HTTP mock 为主，对于旧版 Provider 的标记为 `@deprecated` 状态缺乏明确的迁移测试
- `provider-openai-compatible.ts`（约 2000+ 行）：测试文件虽然大但集中在 request build 和 parse
- `runtime.ts`（225 行）：`runtime.test.ts` 只覆盖了基本创建
- `runtime-components/context-manager.ts`：`context-manager.test.ts` 只覆盖了少量路径

**零覆盖率的模块**：
- `pricing-engine.ts`：0 测试
- `hooks/` 目录：0 测试
- `steering/` 目录：部分测试不足
- `doctor-report.ts`：0 测试
- `provider-transport/connection-manager.ts`：`connection-manager.test.ts` 只覆盖了连接创建和销毁，未覆盖重连和降级
- `provider-transport/stream-recovery.ts`：`stream-recovery.test.ts` 存在但测试场景有限

**2.2.3 packages/agent-daemon 覆盖率**

`packages/agent-daemon/src/` 有约 27 个 `.test.ts` 文件，覆盖了：
- `workflow-store.test.ts`、`workflow-scheduler.test.ts`
- `task-snapshot-projection.test.ts`
- `subagent-runtime.test.ts`
- `stream-backpressure.test.ts`
- `session-query-handlers.test.ts`
- `session-metadata-store.test.ts`
- `server.test.ts`、`server-runtime-factory.test.ts`、`server-handlers.test.ts`
- `server-event-store.test.ts`
- `scoped-context-store.test.ts`
- `protocol/registry.test.ts`
- `plan-document-store.test.ts`
- `mcp-config.test.ts`
- `handlers/run-handlers.stream-pause.test.ts`
- `handlers/approval-handlers.test.ts`
- `daemon-provider-gateway.test.ts`
- `daemon-permission-policy.test.ts`
- `daemon-approval-handler.test.ts`
- `conversation-rewind-boundary.test.ts`
- `capabilities.test.ts`
- `binary-frame.test.ts`
- `approval-queue.test.ts`
- `approval-projection.test.ts`

覆盖率看似全面，但分析发现：
- 大部分测试是纯单元测试，测试的是 store/state 操作，而非 daemon 的运行行为
- `server.test.ts` 测试了 HTTP handler 的注册但未测试真实请求处理
- `daemon-provider-gateway.test.ts` 测试了 daemon 层的 Provider 网关但未与 agent-runtime 的 Provider 层联合测试
- 缺少集成测试来验证 daemon 的 `start()` → `handleRequest()` → `forwardToRuntime()` → `respond()` 完整链路

**2.2.4 Rust crate 覆盖率**

Rust crate 使用 `#[cfg(test)]` 进行内联测试，各 crate 覆盖情况：

| Crate | 测试模块数 | 测试用例数 | 评估 |
|-------|-----------|-----------|------|
| `conex-stream/src/parser/sse.rs` | 1 | 10 | 好——覆盖了帧解析、跨块、多帧、CRLF、大帧跳过、重置 |
| `conex-stream/src/parser/gemini.rs` | 1 | 11 | 好——覆盖了多种 Gemini 响应格式 |
| `conex-stream/src/parser/openai_chat.rs` | 1 | 10 | 好——覆盖了 text、tool call、streaming 和 finish_reason |
| `conex-stream/src/parser/anthropic.rs` | 1 | 8 | 一般——覆盖了 message_start、content_block、ping 和 error |
| `conex-stream/src/state/tool_accumulator.rs` | 1 | 10 | 好——覆盖了多种工具调用累积场景 |
| `conex-stream/src/state/thinking_config.rs` | 1 | 4 | 不足——只覆盖了 basic 和 token budget 计算 |
| `conex-stream/src/security.rs` | 1 | 6 | 一般——覆盖了基本的请求验证 |
| `conex-db/src/pool.rs` | 1 | 2 | 严重不足——只覆盖了 PRAGMA 设置和连接复用 |
| `conex-diff/src/diff_engine.rs` | 1 | 6 | 一般——覆盖了基本 diff 操作 |
| `conex-diff/src/seek_sequence.rs` | 1 | 15 | 好——覆盖了多种 seek 序列模式 |
| `conex-diff/src/stream_parser.rs` | 1 | 5 | 不足——只覆盖了基本的流解析 |
| `conex-search/src/fuzzy.rs` | 1 | 12 | 好——覆盖了多种模糊匹配场景 |
| `conex-search/src/search.rs` | 1 | 1 | 不足——只覆盖了基本搜索 |
| `conex-sandbox/src/gatekeeper.rs` | 1 | 6 | 好——覆盖了危险命令检测和多线程安全 |
| `conex-ipc/src/router.rs` | 1 | ? | 存在但未评估 |
| `conex-compaction/src/tokenizer.rs` | 1 | 6 | 一般——覆盖了 token 计数 |
| `conex-compaction/src/compaction.rs` | 1 | 5 | 一般——覆盖了基本压缩 |

零测试的模块：
- `conex-fs/src/reader.rs` — 文件读取逻辑（核心模块）
- `conex-fs/src/watcher.rs` — 文件监控
- `conex-fs/src/path_utils.rs` — 路径工具
- `conex-fs/src/ignore_rules.rs` — gitignore 规则
- `conex-net/src/http_client.rs` — HTTP 客户端（核心模块）
- `conex-net/src/ws_client.rs` — WebSocket 客户端（核心模块）
- `conex-net/src/llm_provider.rs` — LLM Provider 调用（核心模块）
- `conex-net/src/connection_pool.rs` — 连接池
- `conex-compaction/src/prefix_guard.rs` — 前缀保护
- `conex-compaction/src/ast_compactor.rs` — AST 压缩
- `conex-db/src/query.rs` — 查询构造
- `conex-db/src/schema.rs` — Schema 定义
- `conex-db/src/migration.rs` — 数据库迁移
- `conex-db/src/transaction.rs` — 事务管理
- `conex-sandbox/src/process.rs` — 进程管理（核心安全模块）
- `conex-sandbox/src/process_tree.rs` — 进程树（核心安全模块）
- `conex-sandbox/src/pty.rs` — PTY 创建
- `conex-sandbox/src/guard.rs` — 安全守卫

这些零测试的模块涵盖了文件 I/O、网络通信、进程管理、数据库操作等核心基础设施，风险极高。

**2.2.5 总体覆盖率估算**

基于文件计数的粗略估算：
- TypeScript 总源文件：约 200+
- TypeScript 有测试文件：约 120+
- TypeScript 模块级覆盖率（按文件）：约 60%
- Rust 总模块数：约 30+
- Rust 有测试的模块：约 13+
- Rust 模块级覆盖率（按模块）：约 43%
- 综合有测试的源文件占比：约 55%

但按代码行覆盖率估计会更低，因为大文件（`agent-session-loop.ts`、`provider-openai-compatible.ts`）的测试覆盖率远低于小文件。

### 2.3 测试类型分布——评分：2/5

**2.3.1 详细分布统计**

| 类型 | 文件数 | 占比 | 说明 |
|------|--------|------|------|
| 纯单元测试 | ~110 | ~85% | 主要分布在 `packages/*/src/` 和 `crates/*/src/` 的 `#[cfg(test)]` |
| 集成测试（vitest 组织） | ~6 | ~5% | `provider/__tests__/e2e/` 下的 5 个文件 + `oauth-flow.test.ts` |
| 压力测试 | 4 | ~3% | `tests/stress/stress-ai-stream.ts`、`stress-diff-load.ts`、`stress-session-switch.ts`、`run-all-stress.ts` |
| 恢复测试 | 2 | ~1.5% | `tests/recovery/crash-recovery.test.ts`、`jsonl-corruption.test.ts` |
| 竞态测试 | 2 | ~1.5% | `tests/race/parallel-ws-messages.test.ts`、`concurrent-store-modify.test.ts` |
| 模糊测试 | 2 | ~1.5% | `tests/fuzz/websocket-messages.test.ts`、`daemon-config.test.ts` |
| 启动测试 | 2 | ~1.5% | `tests/startup/measure-cold-start.ts`、`measure-warm-start.ts` |

**2.3.2 纯单元测试分析**

纯单元测试占据了 85% 的测试文件，这是合理的——任何项目的测试金字塔底部都应该是单元测试。但问题在于：

- 大部分单元测试只测试"快乐路径"（happy path），很少覆盖错误路径和边界条件
- 单元测试的"单元"没有明确定义——有些测试测的是单个函数（如 `deep-equal.test.ts`），有些测的是整个类的全部公共方法（如 `provider-gateway.test.ts`）
- 没有按"被测模块"组织的测试套件结构——`__tests__/` 目录下的文件与 `src/` 下的文件混合存放

**2.3.3 集成测试分析**

仅有的集成测试集中在 `packages/agent-runtime/src/provider/__tests__/e2e/`：

```
stream-parser.test.ts         — SSE 流解析与模拟场景
steering-injection.test.ts    — Steering 注入 E2E
provider-factory.test.ts      — ProviderFactory 创建和流式调用
context-length-recovery.test.ts — 上下文超长恢复
circuit-breaker-e2e.test.ts   — 熔断器 E2E
```

这些集成测试都依赖 `LlmApiMockServer`（`C:\Software\conex\packages\agent-runtime\src\provider\__tests__\e2e\mock-server.ts`），是一个启动真实 HTTP 端口的 mock server。这种集成级别是最基本的"组件内集成"。

缺失的集成测试类型：
- **跨包集成**：`agent-runtime` + `agent-daemon` 联合测试（如 daemon 收到请求 → 转发到 runtime → runtime 调用 Provider → 返回结果）
- **多 Provider 场景**：`ProviderGateway` 从一个 Provider 切换到另一个 Provider
- **工具管线完整链路**：Provider 返回 tool_call → ToolExecutor 执行 → Provider 接收 tool_result
- **持久化集成**：Session 保存到 store → crash → 恢复 Session
- **文件系统集成**：工具读写文件 → 文件变化监测 → 事件通知

**2.3.4 压力测试分析**

压力测试位于 `tests/stress/`，使用独立的 runner（`stress-runner.ts`），不与 vitest 集成。这意味着：

- 压力测试结果格式独立（JSON），不与 vitest 的 JUnit reporter 统一
- 不支持在 CI 中根据压力测试结果自动 fail pipeline
- `stress-ai-stream.ts:10` 使用 `Math.random()` 生成随机数据，导致不可重现
- 只涉及 3 个场景（AI stream、diff load、session switch），覆盖面不够
- `stress-runner.ts:111-118` 的通过判定逻辑（FPS、内存、延迟阈值）由每个场景自行定义，缺乏统一的基线管理

**2.3.5 恢复测试分析**

`tests/recovery/crash-recovery.test.ts` 和 `jsonl-corruption.test.ts` 都是基于 Mock 的单元测试级别恢复测试：

- `crash-recovery.test.ts:5-61` 定义了一个 `MockDaemonRecovery` 类，模拟 daemon 的崩溃恢复行为
- 这个 Mock 类与真实的 daemon recovery 实现无关，测试的是 Mock 的行为而非真实 recovery
- 由于没有 FauxProvider 和模拟真实 daemon 状态的能力，无法测试真实的 crash-recovery 场景

**2.3.6 竞态测试和模糊测试分析**

`tests/race/parallel-ws-messages.test.ts` 和 `concurrent-store-modify.test.ts`：
- 使用 vitest 运行
- 测试了基本的并发场景（WebSocket 并行消息、store 并发修改）
- 但没有使用 `vi.useFakeTimers()` 来控制时间，依赖真实时间调度
- 没有对 SharedArrayBuffer、锁机制等并发原语进行专项测试

`tests/fuzz/websocket-messages.test.ts`：
- 107 行的 fuzz 测试，测试了消息验证函数的各种输入
- 这不是真正的 fuzz 测试（没有随机种子、没有覆盖率反馈、没有突变算子）
- 本质上是带有多组输入的参数化测试

### 2.4 测试工具基础设施——评分：2/5

**2.4.1 现有 mock 工具汇总**

工具 1：**`LlmApiMockServer`**
- 位置：`packages/agent-runtime/src/provider/__tests__/e2e/mock-server.ts`
- 实现：基于 `node:http` 的 mock HTTP 服务器
- 功能：
  - 启动本地 HTTP 端口，返回预配置的 SSE 响应
  - 支持分阶段响应（请求次数递增时切换行为）
  - 可配置延迟、错误注入、连接断开
- 局限：
  - 只能在 Layer 7（HTTP 层面）mock，无法 mock `AgentProvider` 接口
  - 每个测试文件需要自己管理 server 的创建和销毁
  - 端口分配在测试间可能冲突（如果 `stop()` 调用后端口未立即释放）
  - 没有与 vitest 的 parallelism 集成（如果并行运行多个 test，端口可能冲突）

工具 2：**`mockFactories.ts`**
- 位置：`packages/shared-utils/src/test/mockFactories.ts`
- 提供的工厂函数：
  - `createMockProvider(overrides?)` — 创建 mock provider 配置对象
  - `createMockDaemonConfig(overrides?)` — 创建 mock daemon 配置
  - `createMockWebSocket(overrides?)` — 使用 `vi.fn()` 创建 mock WebSocket
- 优点：使用了 `Partial<T>` overrides 模式，简洁且可扩展
- 局限：
  - 只有 3 个工厂函数，远远不够
  - 没有 mock daemon runtime、mock session store、mock event store 等
  - `createMockWebSocket` 返回的类型是 `WebSocket` 但实现是 `as unknown as WebSocket`，类型安全不够

工具 3：**内联 mock Provider（PlannedProvider）**
- 位置：`provider-gateway.test.ts:14-24`
- 实现：
  ```typescript
  class PlannedProvider implements AgentProvider {
    readonly id: string;
    constructor(readonly plan: ProviderFactoryPlan) {
      this.id = `${plan.route.providerId}:${plan.route.upstreamModel}`;
    }
    async *stream(_request): AsyncIterable<ProviderStreamEvent> {
      yield { type: "stop", reason: "stop" };
    }
  }
  ```
- 局限：只在该文件可用，其他文件需要重复定义相同的类

工具 4：**内联 mock ProviderCallGateway（匿名继承）**
- 位置：`agent-session-loop.test.ts:36-86`
- 实现：匿名类继承 `ProviderCallGateway`，覆盖 `call()` 方法
- 代码量：约 80 行（包含内部事件收集和 response 组装逻辑）
- 局限：完全不可复用，每个测试场景都需要重新构造

工具 5：**内联 mock 工具定义**
- 位置：`tool-executor.test.ts:6-37`
- 函数：`shellTool()`、`exclusiveTool()`、`toolCall()`
- 局限：未提取到共享模块

工具 6：**`sseResponse()` helper**
- 位置：`provider-anthropic.test.ts:20-33`
- 实现：使用 `ReadableStream` 构造 SSE Response
- 局限：只在该文件可用

工具 7：**`noopProviderStream()` 函数**
- 位置：`agent-session-loop.test.ts:26-34`
- 实现：返回一个固定的事件序列（start → delta → end）
- 局限：过于简化，无法模拟复杂的工具调用场景

**2.4.2 Mock 模式不一致性分析**

当前测试文件中使用的 mock 方式至少有 6 种不同模式：

1. **接口实现模式**：创建新类实现接口（`PlannedProvider implements AgentProvider`）
2. **匿名继承模式**：匿名继承并覆盖方法（`class extends ProviderCallGateway { ... }`）
3. **vi.spyOn 模式**：`vi.spyOn(globalThis, "fetch")` 在 base-engine.test.ts 中使用
4. **vi.stubGlobal 模式**：`vi.stubGlobal("fetch", vi.fn())` 在 oauth-flow.test.ts 中使用
5. **vi.mock 模式**：`vi.mock("node:fs", ...)` 在 declarative-loader.test.ts 中使用
6. **HTTP Mock Server 模式**：`LlmApiMockServer` 在 e2e/ 目录下使用

这些不一致性导致：
- 新开发者需要学习 6 种不同的 mock 技术
- 不同测试文件之间无法复用 mock 代码
- 重构 Provider 接口时需要修改多个测试文件中的不同 mock 实现
- 无法统一 mock 的行为（如全局的 mock cleanup）

**2.4.3 缺失的关键测试工具**

基于上述分析，当前完全缺失以下测试工具：

1. **FauxAgentProvider 基类**：实现 `AgentProvider` 接口的假 Provider，可配置事件序列
2. **FauxProviderCallGateway**：可注入的 `ProviderCallGateway` mock，替代匿名继承模式
3. **MockAgentTool 工厂**：标准化的工具 mock，支持所有 `concurrency` 类型
4. **MockSessionStore**：内存中的 Session 存储，用于测试持久化逻辑
5. **MockPermissionPolicy**：可配置的权限策略 mock
6. **FixtureLoader**：从 JSON 文件加载测试数据
7. **TestContext builder**：创建标准化的 `ToolExecutionContext`、`AgentProviderRequest` 等上下文对象
8. **MockStreamParser**：Rust 侧的 SSE 流 mock

### 2.5 测试隔离性——评分：1/5

**2.5.1 环境变量隔离**

当前没有任何测试隔离机制清理环境变量。`package.json` 中也没有 `test.sh` 或类似的隔离入口。`.husky/pre-push`（`C:\Software\conex\.husky\pre-push:1`）内容为：

```
npm run typecheck && npm test
```

这意味着：
- 如果开发者在 shell 中 export 了 `ANTHROPIC_API_KEY=sk-real-key`，那么 `test` 命令运行时，任何涉及 Provider 创建的测试都可能触发真实 API 调用
- `provider-gateway.ts:517-519` 的 `CredentialResolver` 会从 `CONEX_API_KEY_` 前缀的环境变量中读取密钥——如果环境变量存在，测试可能使用真实凭据
- 部分测试（如 `base-engine.test.ts:147-151` 的 `vi.spyOn(globalThis, "fetch")`）通过 spy 覆盖了 fetch 行为，但并非所有测试都这样做
- `provider-openai-compatible.ts` 的 `loadOpenAICompatibleProviderConfig` 函数会读取文件系统和环境变量，如果测试执行时存在真实配置，可能加载真实配置而非测试配置

**缺少的隔离手段**：
- ❌ 没有 `test.sh` 来清理环境变量
- ❌ 没有 `vitest.globalSetup.ts` 来处理一次性隔离
- ❌ `vitest.setup.ts` 中没有 `beforeAll` 级别的环境变量清理
- ❌ 没有 `NODE_ENV=test` 强制设置

**2.5.2 文件系统副作用**

多个测试在文件系统上创建临时文件和目录：

`provider-openai-compatible.test.ts:14-18`：
```typescript
let tempRoot = "";
beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "agent-runtime-provider-"));
});
afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});
```

这虽然是必要的，但存在以下问题：
- 临时目录前缀使用硬编码字符串 `"agent-runtime-provider-"`，如果多个测试同时运行，可能产生可读性差的目录名
- `tmpdir()` 返回的全局临时目录在不同 OS 上行为不同（Windows：`%TEMP%`，Unix：`/tmp`）
- 如果 `afterEach` 中的 `rm` 抛出异常，后续的 cleanup 不会执行（应该用 `try/finally`）
- 没有 `vitest.globalSetup.ts` 创建的统一测试临时根目录

`crates/conex-db/src/pool.rs:59-65` 的 Rust 测试：
```rust
fn temp_db_path(label: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
    std::env::temp_dir().join(format!("conex-db-pool-{label}-{nanos}.sqlite"))
}
```
虽然使用 nanosecond 降低了碰撞概率，但仍然依赖全局 `temp_dir()`，且没有在 drop 后立即清理 WAL 和 SHM 文件。测试结束后的 cleanup 代码（`let _ = fs::remove_file(...)`）使用 `let _ =` 静默忽略删除失败，如果 `pool` 的 drop 延迟执行，可能因为文件仍在使用中而无法删除。

**2.5.3 全局单例污染**

`provider-gateway.ts:972-974` 定义了模块级别的全局单例：

```typescript
let _gatewayBridge: GatewayV2Bridge | null = null;

export function initProviderEngine(directory?: string, secretStore?: SecretStore): GatewayV2Bridge {
  if (!_gatewayBridge) {
    _gatewayBridge = new GatewayV2Bridge(undefined, secretStore);
    // ...
  }
  return _gatewayBridge;
}
```

这个单例的问题：
- 没有 `resetProviderEngine()` 导出函数
- 如果测试 A 调用了 `initProviderEngine()`，测试 B 看到的仍然是测试 A 的 bridge
- `GatewayV2Bridge` 可能注册了 Provider 实例，这些实例在测试间持续存在
- 如果测试 A 配置了 mock secretStore，测试 B 可能意外使用这个 secretStore

`session.ts` 中的 `InMemorySessionStore` 也可能存在类似问题——如果模块导出了一个默认的 store 实例，测试间可能共享状态。

**2.5.4 网络依赖**

虽然大部分测试通过 `vi.spyOn(globalThis, "fetch")` 或 `LlmApiMockServer` 隔离了网络调用，但：
- 没有全局机制防止意外网络请求
- 如果某个测试路径忘记 mock fetch，测试会在真实网络上执行
- `oauth-flow.test.ts` 使用 `vi.stubGlobal("fetch", vi.fn())` 来 mock，但其他测试可能没有
- `LlmApiMockServer` 启动的是真实 HTTP 端口，在并行运行时（vitest 默认使用 worker pool）可能发生端口冲突

### 2.6 测试可重复性——评分：2/5

**2.6.1 随机性控制**

问题文件：`tests/stress/stress-ai-stream.ts:4-18`
```typescript
async function* aiStreamScenario(): AsyncGenerator<() => Promise<unknown>> {
  const chars = "abcdefghijklmnopqrstuvwxyz...";
  let chunkIndex = 0;
  while (true) {
    yield async () => {
      const chunkSize = Math.floor(Math.random() * 50) + 10;
      let chunk = "";
      for (let i = 0; i < chunkSize; i++) {
        chunk += chars[Math.floor(Math.random() * chars.length)];
      }
      // ...
    };
  }
}
```

`Math.random()` 无法被 `vi.spyOn(Math, 'random')` 控制种子，导致：
- 每次压力测试运行生成不同的数据
- 失败场景无法复现
- 性能对比无法在相同数据下进行

其他使用 `Math.random()` 的测试：
- `backpressure.test.ts` 可能使用随机数据来模拟负载
- Rust 测试中 `fuzzy.rs` 使用确定性数据，是好的

**2.6.2 时序依赖**

`tool-executor.test.ts:96-98`：
```typescript
async execute() {
  order.push("slow-start");
  await new Promise((r) => setTimeout(r, 20));
  order.push("slow-end");
  return { text: "slow" };
}
```

这个测试依赖 `setTimeout(20)` 来确保 `slow` 工具的执行时间比 `fast` 长。但在不同环境下：
- CI 中 CPU 负载高时，20ms 可能不够（fast 也可能被延迟）
- 某些 VM 或容器环境中 setTimeout 的分辨率可能不是 1ms
- Node.js 版本间的 setTimeout 行为差异

`async-mutex.test.ts:15` 也有类似问题：
```typescript
await Promise.all([task("a", 10), task("b", 5), task("c", 1)]);
expect(order).toEqual(["enter-a", "exit-a", "enter-b", "exit-b", "enter-c", "exit-c"]);
```
这个测试假设 `setTimeout` 的延迟时间能决定执行顺序，但如果系统调度出现异常（如 task "a" 的 10ms 定时器比其他任务先到期），可能导致时序反转。

**2.6.3 全局状态依赖**

由于 `_gatewayBridge` 单例没有 reset 函数，测试运行顺序可能影响结果：
- 如果测试 A 先运行并调用了 `initProviderEngine()`，所有后续测试看到的是同一个 bridge
- 如果 bridge 内部有状态（如注册的 Provider 列表），测试 B 可能意外看到测试 A 的配置
- vitest 默认按文件名排序后随机分配 worker，因此测试顺序在不同运行间不可控

**2.6.4 异步资源清理**

部分测试创建了可能泄漏的异步资源：
- `e2e/mock-server.ts` 启动了 HTTP server，如果 `afterAll` 中 `server.stop()` 被跳过，server 继续监听端口
- 使用 `AbortController` 的测试如果忘记调用 `abort()`，信号监听器永远不会被移除
- `ProgressEventQueue` 的测试（`tool-executor.test.ts:249-255`）如果 `close()` 调用失败，pending 的 Promise 不会被 resolve

### 2.7 测试可观测性——评分：2/5

**2.7.1 覆盖率报告**

`vitest.config.ts:13-16` 当前的 coverage 配置：
```typescript
coverage: {
  provider: 'v8',
  reporter: ['text', 'json', 'html'],
},
```

- 没有 `thresholds` 配置，覆盖率不会作为门禁
- 没有 `exclude` 列表，node_modules、dist 等目录可能被计入
- 没有 `include` 配置，默认包含所有文件
- JSON 报告没有配置输出目录，默认输出到 `coverage/`

没有覆盖率的 CI 集成：
- `.husky/pre-push` 没有运行 `test:coverage`
- `scripts/ci-test.mjs`（尚不存在）没有包含 coverage 报告
- 没有覆盖率 badge，无法在 PR 中可视化覆盖率变化

**2.7.2 失败诊断**

缺少的 vitest 配置：
- `onConsoleWarn`：没有配置，意外 console.warn 不会让测试失败
- `onUnhandledRejection`：没有配置，未捕获的 Promise rejection 不会让测试失败
- `retry`：没有配置，flaky 测试不会自动重试
- `diff`：使用默认 diff 配置，没有针对大对象 diff 的优化
- `printConsoleError`：没有配置

`agent-session-loop.test.ts` 中常见的失败模式：
- 如果 async generator 没有完全消费，挂起的 Promise 可能导致测试卡住
- 错误消息可能指向 vitest 的 worker 代码而非被测代码

**2.7.3 基准测试管理**

基准测试和性能测试分散在多个入口：
- `package.json:34`：`bench:daemon` —— daemon 启动基准
- `package.json:35`：`bench` —— `packages/shared-utils/src/bench/run-benchmarks.ts`
- `package.json:36`：`bench:mem` —— 内存基准
- `package.json:37`：`bench:ci` —— CI 基准比较
- `package.json:38`：`bench:acceptance` —— 性能接受标准
- `package.json:39-40`：`bench:native-sla` / `bench:native` —— Rust 原生基准
- `package.json:41`：`bench:report` —— 报告生成
- `crates/conex-stream/benches/stream_bench.rs` —— Rust criterion 基准
- `tests/startup/measure-cold-start.ts` 和 `measure-warm-start.ts` —— 启动性能

存在的问题：
- 没有统一的基准测试 runner 来协调这些不同的基准
- `scripts/compare-benchmarks.ts` 用于比较两次运行的结果，但没有 CI 集成
- 基准测试结果没有持久化到历史数据库
- 没有性能回归门禁——基准下降不会阻止合入

**2.7.4 vitest 其他可观测性配置**

`testNamePattern`、`reporter`、`outputFile` 等配置都未使用，意味着：
- 无法通过 `--reporter=junit` 生成 CI 友好的测试报告
- 没有 `outputFile` 配置来持久化测试结果
- `testNamePattern` 没有用于实现测试分组标签系统

---

## 三、差距深度分析

### 3.1 缺少假 Provider / mock LLM 设施（间隙等级：严重）

**现状**：`packages/agent-runtime/` 有多个 Provider 实现（`AnthropicProvider`、`OpenAICompatibleProvider`、`ProviderGateway`），但缺乏一个标准的 `FauxProvider` 基类或 `MockProviderGateway`。当前的测试模式有两种：

模式 A（内联 mock）：如 `provider-gateway.test.ts:14-24` 的 `PlannedProvider` 通过构造函数注入 `ProviderFactoryPlan`。模式正确但不可复用——每个测试文件如果需要一个 mock Provider，都需要定义自己的 `PlannedProvider` 变体。

模式 B（E2E mock server）：如 `e2e/mock-server.ts` 启动真实 HTTP 服务器。这增加了测试复杂性：需要管理 server 生命周期、处理端口冲突、处理异步关闭。

**影响**：
1. 任何新的 Provider 集成测试都需要从头构建 mock 设施
2. `ProviderCallGateway`、`AgentSessionLoop` 等依赖 Provider 的高层模块测试覆盖不足
3. CI 中无法安全运行涉及 Provider 调用的测试——如果开发者配置了真实 API key，测试会打到真实端点
4. Provider 返回格式（SSE vs non-streaming JSON）的切换测试无法统一进行

**代码证据范围**：
- `provider-gateway.test.ts:14-24`：PlannedProvider 内联定义
- `agent-session-loop.test.ts:36-86`：匿名继承 ProviderCallGateway
- `provider-anthropic.test.ts:20-33`：sseResponse helper 仅用于该文件
- `provider-openai-compatible.test.ts:41-60`：fetch mock 响应手写
- `e2e/mock-server.ts`：唯一可复用的 mock，绑定到 HTTP 层
- `base-engine.test.ts:147-151`：vi.spyOn(globalThis, "fetch") 分散各处
- `fallback-chain/engine.test.ts:9,18,122+`：vi.fn() 的 stream mock 重复定义

### 3.2 测试环境隔离不足（间隙等级：严重）

**现状**：没有 `test.sh` 或等价的隔离入口脚本。`.husky/pre-push` 直接运行 `npm test`，不清理环境。

**影响**：
1. 本地开发中，测试可能因开发者环境变量差异而通过或失败
2. CI 和本地环境行为不一致
3. 跨 session 的全局单例污染导致测试无法可靠重复
4. 文件操作测试可能留下残余文件

**代码证据范围**：
- `.husky/pre-push:1`：无环境隔离
- `vitest.setup.ts:1-44`：无环境变量清理
- `provider-gateway.ts:972-974`：_gatewayBridge 全局单例无 reset
- `provider-openai-compatible.test.ts:14-22`：手动临时目录管理
- `crates/conex-db/src/pool.rs:59-65`：依赖全局 temp_dir
- `package.json:59`：test 脚本无隔离步骤

### 3.3 集成测试和 E2E 测试缺失（间隙等级：严重）

**现状**：仅有的 E2E 测试集中在 `packages/agent-runtime/src/provider/__tests__/e2e/`（5 个测试文件）。没有跨包集成测试，没有从 `AgentRuntime` 到 `Provider` 的端到端管线测试。

**影响**：
1. `agent-session-loop.ts`（2293 行）只有一个测试文件且覆盖的是注入 mock 后的单元行为
2. Provider 切换（如从 Anthropic Messages API 切换到 engine-based AnthropicMessagesEngine）无集成级验证
3. `ProviderGateway → ProviderCallGateway → ProviderResponseConsumer` 的完整管线无联合测试
4. `agent-runtime` + `agent-daemon` 的接口不匹配只能在运行时发现

**代码证据范围**：
- `agent-session-loop.ts:1`：2293 行，测试覆盖率不足
- `runtime-components/provider-call-gateway.ts:1`：321 行，集成测试缺失
- `runtime-components/provider-response-consumer.ts`：无 E2E 测试
- `tests/` 目录：无跨包集成测试

### 3.4 测试数据管理和 fixture 不足（间隙等级：中等）

**现状**：没有 fixture 文件（JSON/YAML 测试数据）。测试数据全部硬编码在测试文件中。

**影响**：
1. Provider response 构造需要大量手写 JSON
2. 测试数据无法被不同测试文件复用
3. 修改 fixture 需要改代码，不能通过数据变更
4. 数据格式变化时，需要逐个文件查找和修改

**代码证据范围**：
- `provider-anthropic.test.ts:51-80`：手写 message body 构造（约 30 行 JSON）
- `provider-openai-compatible.test.ts:41-60`：手写 Response 构造
- `provider-gateway.test.ts:131-166`：手写 route 对象数组（35 行）
- `agent-session-loop.test.ts:27-34`：固定的事件序列
- `tool-executor.test.ts:6-41`：工具定义硬编码

### 3.5 覆盖率门禁缺失（间隙等级：中等）

**现状**：vitest 配置了 coverage reporter 但没有设置 `thresholds`。CI 中没有要求覆盖率必须达到某个值。

**影响**：
1. 代码覆盖率可能持续下降
2. 新代码可以不加测试就合入
3. 没有 visibility 了解哪些模块缺少测试

**代码证据范围**：
- `vitest.config.ts:13-16`：只有 reporter 配置，无 thresholds
- `.husky/pre-push:1`：只运行 typecheck && test，不检查覆盖率

### 3.6 性能测试和基准测试管理不足（间隙等级：中等）

**现状**：项目有独立的基准测试框架（`scripts/run-native-benches.mjs`、`scripts/compare-benchmarks.ts`）、Rust criterion 基准（`crates/conex-stream/benches/stream_bench.rs`）、压力测试套件（`tests/stress/`）。但缺乏统一的管理。

**影响**：
1. 基准测试结果无法自动比较
2. 性能回归无法自动检测
3. 新代码引入的性能退化不能被及时发现

**代码证据范围**：
- `package.json:34-41`：bench* 脚本分散在多个入口
- `tests/stress/stress-runner.ts:157-159`：结果写入 `perf-report/` 但无自动比较
- `crates/conex-stream/benches/stream_bench.rs`：仅一个 criterion group

---

## 四、根因分析

### 4.1 架构原因

**4.1.1 测试基础设施演进滞后于业务代码**

`packages/agent-runtime/` 经历了多次重构：
- 原始 `runtime.ts`（225 行）被拆分为 `agent-session-loop.ts`（2293 行）和多个 runtime-components
- `provider-gateway.ts` 增加 `GatewayV2Bridge` 集成
- Provider 实现从单体 AnthropicProvider 迁移到 engine-based 体系

但这些重构中，测试工具没有同步更新。旧的测试结构保留在测试文件中：
- `PlannedProvider` 保留了旧架构的影子
- 匿名类 mock ProviderCallGateway 没有跟随新的 ProviderCallGatewayOptions 接口更新
- `LlmApiMockServer` 只支持旧有 Provider 格式，不支持新 engine 格式

**4.1.2 缺少共享的 test-utils 包**

虽然 `packages/shared-utils/` 已经有一个 `test/` 目录，但只有 `mockFactories.ts` 供了 3 个工厂函数。整个 monorepo 中没有 `test-utils` 包或共享的测试工具模块。每个测试文件要么自建 mock，要么重复实现相同的 helper 函数。

**4.1.3 Rust 和 TypeScript 测试分治**

Rust 使用 `#[cfg(test)]` 内联测试，TypeScript 使用 vitest 文件级测试。两者使用不同的运行器、不同的 CI gate、不同的覆盖率工具。没有统一的测试调用接口（`scripts/ci-test.mjs` 尚不存在），也没有合并覆盖率报告的策略。

### 4.2 工程实践原因

**4.2.1 没有测试隔离入口脚本**

项目缺少类似 `test.sh` 的脚本来在执行测试前统一清理环境。这导致：
- 环境变量泄漏
- 全局单例污染
- 文件系统残余

**4.2.2 没有覆盖率门禁文化**

项目没有设定覆盖率目标，也没有在 CI 中强制执行最低覆盖率。新模块在没有测试的情况下可以被接受。

**4.2.3 测试工具复用意识不足**

`shellTool()`、`toolCall()`、`collectBatch()`、`sseResponse()` 等 helper 函数虽然模式好，但没有被提取到共享模块。开发者在不同测试文件中重复实现相同的 mock 逻辑。代码 review 时也没有强制要求将重复的 mock 逻辑提取到共享位置。

### 4.3 技术债务原因

**4.3.1 全局单例耦合**

`provider-gateway.ts` 的 `_gatewayBridge` 单例使测试难以隔离。分析根本原因：
- 这个单例是为了跨模块共享 `GatewayV2Bridge` 实例而设计的
- 但没有为测试场景设计对应的 reset 机制
- `initProviderEngine()` 的调用不需要对应的 dispose

**4.3.2 接口边界不清晰导致 mock 困难**

`ProviderGateway` 和 `ProviderCallGateway` 职责分离后，它们的 mock 接口没有标准化：
- `ProviderGateway` 的接口（`planRoute`、`resolveProvider`、`recordRouteResult`）与 `ProviderCallGateway` 的接口（`call`）不同
- `agent-session-loop.test.ts` 需要 mock 的是 `ProviderCallGateway`，但测试中的匿名类与 `ProviderCallGateway` 的构造函数参数耦合
- 当 `ProviderCallGatewayOptions` 接口扩展时，所有使用匿名类的测试都需要更新

---

## 五、影响评估

### 5.1 对开发效率的影响

**5.1.1 修改 Provider 层需要大量手动测试**

因为缺少 FauxProvider，开发者修改 `provider-gateway.ts` 后只能依赖现有的 `provider-gateway.test.ts` 测试。这个测试覆盖了接口行为但：
- 没有测试 Provider 的流式输出（`yield` 行为）
- 没有测试 Provider 创建时的错误场景
- 没有测试凭证解析回退链（CredentialResolver ⇒ SecretStore ⇒ env var）
- 没有测试多 Provider 切换的完整场景

每次修改后，开发者需要手动运行 `npm test` 并等待其他模块的测试，或者通过 `vitest run packages/agent-runtime/src/provider-gateway.test.ts` 只运行相关测试。但即使所有测试通过，也无法保证新功能在集成环境中正常工作。

**5.1.2 集成问题发现延迟**

由于缺少跨包集成测试，`agent-runtime` 和 `agent-daemon` 之间的接口不匹配只能在运行时发现。典型场景：
0. 开发者修改了 `agent-runtime` 中的 `AgentSessionLoop` 接口
0. `agent-daemon` 中对应的 `daemon-provider-gateway.ts` 没有同步更新
0. 直到运行 daemon（`npm run daemon`）解析到真实请求时才暴露问题
0. 调试过程涉及复杂的日志分析和数据流追踪

**5.1.3 新开发者 onboarding 成本**

- 需要理解 6 种不同的 mock 模式
- 需要了解哪些模块有测试、哪些没有
- 编写新测试时找不到可参考的模式（因为已有测试的模式各不相同）

### 5.2 对代码质量的影响

**5.2.1 Provider 切换风险高**

当前 `provider-anthropic.ts` 头部标记为 `@deprecated`：
```
* @deprecated 旧版 Anthropic 原生 Provider 已迁移至引擎体系
* 替代方案: import { AnthropicMessagesEngine } from './provider/engines/anthropic-messages-engine.ts'
```

迁移到 `AnthropicMessagesEngine` 时，没有足够的集成测试作为安全网：
- 现有 `provider-anthropic.test.ts` 测试的是旧版 Provider，不是新版 engine
- `provider-factory.test.ts` 的 e2e 测试只验证了 Provider 创建，没有验证引擎查询行为
- 如果新旧 Provider 的行为有差异，只能在真实 API 调用中才能发现

**5.2.2 工具管线修改无防护**

`tool-executor.ts` 的修改依赖 `tool-executor.test.ts` 的 284 行测试，但：
- 没有测试 `ToolMiddlewareHook` 的自定义钩子
- 没有测试 `executeSequentialWithEvents` 的串行执行顺序验证
- 没有测试超时场景（`timeoutMs` 参数）
- 没有测试并行执行中的 `cancel-siblings` 策略的完整路径

### 5.3 对 CI/CD 的影响

**5.3.1 Flaky 测试风险**

由于测试隔离不足和时间依赖，CI 中可能出现间歇性失败：
- 时序敏感的测试在低负载机器上通过，在高负载机器上失败
- 文件系统操作测试在并行运行时互相干扰
- 端口分配在并行测试中冲突

**5.3.2 无覆盖率门禁导致质量退化不可见**

CI pipeline（`.husky/pre-push`）只运行 `typecheck && test`，不检查覆盖率。
- 新模块可以完全没有测试
- 已有测试的模块覆盖率可以逐渐下降
- 没有人注意到覆盖率的变化

### 5.4 对 on-boarding 的影响

**5.4.1 测试模式混乱**

新开发者面临的 6 种 mock 模式：
1. **PlannedProvider 类**（provider-gateway.test.ts）—— 适用于 ProviderGateway 测试
2. **匿名继承 ProviderCallGateway**（agent-session-loop.test.ts）—— 适用于 SessionLoop 测试
3. **vi.spyOn global fetch**（base-engine.test.ts）—— 适用于 base engine 测试
4. **vi.stubGlobal fetch**（oauth-flow.test.ts）—— 适用于 OAuth 测试
5. **vi.mock node:fs**（declarative-loader.test.ts）—— 适用于文件系统依赖测试
6. **LlmApiMockServer**（e2e/mock-server.ts）—— 适用于 HTTP 级集成测试

每种模式都有不同的学习曲线和不同的错误处理方式。

---

## 六、具体代码证据

以下列举 20 个具体文件路径和行号，作为上述分析的代码级依据：

1. `C:\Software\conex\vitest.config.ts:5` — setupFiles 只配置了一个文件，无 globalSetup
2. `C:\Software\conex\vitest.config.ts:13-16` — coverage 只有 reporter 配置，无 thresholds
3. `C:\Software\conex\vitest.setup.ts:4-44` — 只有 localStorage mock，无环境变量清理、时间控制、全局单例重置
4. `C:\Software\conex\package.json:57` — `test:core` 脚本手动指定 test 目录，无分组策略
5. `C:\Software\conex\package.json:59-61` — test 脚本没有 isolation 步骤
6. `C:\Software\conex\.husky\pre-push:1` — pre-push 只运行 `typecheck && test`，无环境隔离、无覆盖率检查
7. `C:\Software\conex\packages\agent-runtime\src\provider-gateway.ts:972-974` — `_gatewayBridge` 全局单例无 reset 函数
8. `C:\Software\conex\packages\agent-runtime\src\provider-gateway.test.ts:14-24` — `PlannedProvider` 内联定义，只在单文件可用
9. `C:\Software\conex\packages\agent-runtime\src\agent-session-loop.test.ts:36-86` — 80 行匿名类 mock `ProviderCallGateway`，不可复用
10. `C:\Software\conex\packages\agent-runtime\src\runtime-components\tool-executor.test.ts:6-41` — `shellTool()`、`exclusiveTool()` 等 helper 未提取为共享
11. `C:\Software\conex\packages\agent-runtime\src\provider\__tests__\e2e\mock-server.ts:58-156` — 唯一可复用的 mock 工具，绑定 HTTP 传输层
12. `C:\Software\conex\packages\agent-runtime\src\provider-anthropic.test.ts:20-33` — `sseResponse()` 函数模式好但未共享
13. `C:\Software\conex\packages\agent-runtime\src\provider\__tests__\base-engine.test.ts:147-151` — `vi.spyOn(globalThis, "fetch")` mock 模式分散多处
14. `C:\Software\conex\packages\agent-runtime\src\provider\__tests__\e2e\provider-factory.test.ts:10-25` — e2e 测试手动管理 http server 生命周期（start/stop）
15. `C:\Software\conex\packages\agent-runtime\src\provider-openai-compatible.test.ts:14-22` — 文件系统副作用（mkdtemp/rm -rf）需要手动管理
16. `C:\Software\conex\packages\agent-runtime\src\agent-session-loop.ts:1` — 2293 行大文件，仅 990 行测试文件，行数比 1:2.3
17. `C:\Software\conex\packages\shared-utils\src\test\mockFactories.ts:1-85` — 仅有的共享 mock 工厂，只覆盖 3 个函数
18. `C:\Software\conex\tests\stress\stress-ai-stream.ts:10` — `Math.random()` 无种子控制，结果不可重现
19. `C:\Software\conex\tests\stress\stress-runner.ts:157-159` — 压力测试结果写入 `perf-report/` 但无自动比较基线
20. `C:\Software\conex\crates\conex-stream\src\parser\sse.rs:144-272` — Rust 内联测试模式好但 `conex-net/`、`conex-fs/` 等核心 crate 零测试
21. `C:\Software\conex\crates\conex-db\src\pool.rs:54-163` — 仅 2 个测试用例，SQLite 临时文件管理有泄漏风险
22. `C:\Software\conex\apps\crish-desktop\vitest.integration.config.ts:5` — 集成测试配置在 app 目录下而非 workspace 根
23. `C:\Software\conex\packages\agent-runtime\src\provider-anthropic.ts:1-3` — `@deprecated` 标记的 Provider 需要迁移测试安全网
24. `C:\Software\conex\packages\agent-runtime\src\fallback-chain\engine.test.ts:9` — vi.fn().mockImplementation 的 stream mock 重复定义
25. `C:\Software\conex\packages\agent-runtime\src\steering\` — 目录下的 `steering-input-queue.test.ts` 覆盖不完整
