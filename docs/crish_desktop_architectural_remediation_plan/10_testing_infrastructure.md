# 子计划 10：Layer J — 测试基础设施标准化

> **层级编号**：Layer J（Round 0 启动 J-4~J-5 测试隔离，Round 2~6 逐步完善；J-20 随 C2 Phase 2 在 Round 3 或 Round 4 执行，取决于 C2 实际完成时间，不应在 Round 0 或 Round 4 单独执行）
> **建议 Agent 数量**：8–10 个（测试工具包、隔离设施、覆盖门禁）
> **涉及维度**：D10（测试基础设施）
> **包路径**：`packages/agent-runtime/src/testing/`、`vitest.config.ts`、`tests/fixtures/`

---

## 一、层级目标

Layer J 的核心使命是建立标准化的测试替身体系、增强测试环境隔离、补充缺失的模块测试、建立覆盖率门禁：

1. **测试替身标准化**：创建 `FauxAgentProvider`、`FauxProviderCallGateway`、`MockTool` 等标准测试替身类，消除散落各处的手动 mock。测试替身作为一等公民代码存放于 `packages/agent-runtime/src/testing/`。
2. **测试环境隔离**：`vitest.globalSetup` 清除所有 Provider API key 环境变量；`vitest.setup.ts` 增强内层隔离（默认 `vi.useFakeTimers()` + `onUnhandledRejection` handler）；`provider-gateway.ts` 暴露 `resetProviderEngine()` 导出用于测试内重置。
3. **Fixture 管理**：Provider 响应数据、工具输入输出、路由配置等测试数据抽取为独立的 JSON/YAML fixture 文件，存放在 `tests/fixtures/provider-responses/` 下。
4. **测试覆盖补充**：填补 ProviderGateway（10+ 路由场景）、ToolExecutor（策略组合）、AgentSessionLoop（完整 Turn 循环）、ProviderCallGateway（流恢复+降级链）的集成测试空缺。Rust 侧补充 conex-fs/conex-net/conex-db 模块测试。
5. **覆盖率门禁**：所有包 vitest 配置设置阈值（statements 70%, branches 60%, functions 65%, lines 70%），CI 中硬性阻断。
6. **测试工具包**：创建 `@crish/test-utils` 统一导出 FauxProvider/MockTool/FixtureLoader/RecordingGateway。

---

## 二、问题现状

### 2.1 当前测试状态评估

| 子项 | 评分 | 现状 |
|------|------|------|
| 测试框架配置 | 3/5 | vitest 配置存在但不完整，`include` 模式覆盖全部包但 CI 只传子路径 |
| 覆盖率 | 2/5 | 阈值已定义但不强制，CI 从不验证 |
| 测试类型分布 | 2/5 | 大量单元测试，集成测试极少，无 E2E |
| 测试工具基础设施 | 2/5 | 无 FauxProvider，手动 mock 散落各处 |
| 隔离性 | 1/5 | Provider API key 环境变量污染测试；全局单例 `_gatewayBridge` 跨测试污染 |
| 可重复性 | 2/5 | Strict 测试 `Math.random()` 路径不可重现 |
| 可观测性 | 2/5 | 有覆盖率报告配置但未利用 |

### 2.2 具体缺陷

**缺陷 1：无 FauxProvider（高严重性）**

当前 Provider 测试要么需要真实 API key（如 `provider-gateway.test.ts:21`），要么使用 `vi.mock` 模拟整个模块（如 `fallback-chain/engine.test.ts:6`）。手动 mock 容易过期——当 Provider 接口变更时，mock 实现不会收到类型错误。

**缺陷 2：全局状态跨测试污染（高严重性）**

`provider-gateway.ts:972` 的 `_gatewayBridge` 是模块级全局单例。测试 A 对此单例的修改会影响测试 B 的行为。`vitest.setup.ts` 当前不做任何全局状态清理。

**缺陷 3：环境变量泄漏（高严重性）**

本地开发环境中 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等环境变量存在时，测试可能触发真实的 API 调用。`test.sh` 虽尝试 `unset` 但这些环境变量，但未通过 `vitest.globalSetup` 做编程式清理。

**缺陷 4：覆盖率门禁失效（中严重性）**

`apps/crish-desktop/vitest.config.ts:13-18` 有阈值配置，但 CI 从未验证。新代码引入 100 行未覆盖代码不会被告知。

**缺陷 5：缺少 fixture 管理（中严重性）**

Provider 响应数据、工具输入输出等测试数据作为字符串字面量嵌入测试文件中。30+ 行长的 JSON 响应在测试文件中占据大量视觉空间。

---

## 三、设计原则

### 原则 1：FauxProvider 优先于 mock HTTP

所有 Provider 层面的测试应优先使用实现 `AgentProvider` 接口的假 Provider，而非启动真实 HTTP 服务器的 mock server。假 Provider 确定性高、速度快、无网络依赖。

### 原则 2：测试隔离是硬门槛

每个测试套件启动前必须清理环境变量、临时文件和全局单例状态。`globalSetup` + `setup` 构成外层和内层两层隔离边界。

### 原则 3：接口契约测试替代实现细节测试

测试应围绕公开接口编写，而非内部实现细节。契约测试确保接口行为稳定，使重构成为可能。

### 原则 4：测试数据由 fixture 驱动

Provider 响应数据、工具输入输出等测试数据抽取为独立的 JSON fixture 文件。测试代码只描述"从哪个 fixture 加载"和"断言什么"。

---

## 四、目标架构

### 4.1 FauxProvider 三级设计

```
真实 Provider 体系：              Faux 测试替身体系：
┌─────────────────────┐         ┌──────────────────────────────┐
│ ProviderCallGateway │         │ FauxProviderCallGateway       │
│  流编排+熔断器       │         │  - 实现相同接口               │
│  依赖 stream()      │         │  - 可注入事件序列             │
├─────────────────────┤         │  - 内置调用记录              │
│ ProviderGateway     │         ├──────────────────────────────┤
│  路由选择+凭证       │         │ RecordingProviderGateway      │
├─────────────────────┤         │  - 记录 planRoute/resolve  │
│ AgentProvider       │         ├──────────────────────────────┤
│  stream(request)    │         │ FauxAgentProvider             │
│  → AsyncIterable    │         │  - 可控事件序列               │
└─────────────────────┘         │  - 支持故障注入               │
                                │  - 支持延迟模拟               │
                                └──────────────────────────────┘
```

### 4.2 FauxAgentProvider 接口

```typescript
export class FauxAgentProvider implements AgentProvider {
  readonly id: string;

  constructor(id: string, private config?: FauxProviderConfig) {}

  /** 预设事件序列 */
  setEvents(events: ProviderStreamContractEvent[]): void;

  /** 预设错误 */
  setError(error: ProviderStreamError | Error): void;

  /** 预设延迟 */
  setLatency(ms: number): void;

  /** 故障注入：在第 N 个事件后中断 */
  setFailAfter(n: number): void;

  /** 重置状态 */
  reset(): void;

  async *stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamContractEvent> {
    if (this.config?.latencyMs) await sleep(this.config.latencyMs);
    for (const event of this.events) {
      if (this.config?.failAfter !== undefined) break;
      yield event;
    }
  }
}
```

### 4.3 双层隔离策略

```typescript
// vitest.globalSetup.ts（外层隔离——进程级）
export async function setup(): Promise<void> {
  // 备份并清除所有 Provider API key
  const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", ...];
  for (const key of keys) {
    if (process.env[key]) {
      process.env[`__TEST_BACKUP_${key}__`] = process.env[key];
      delete process.env[key];
    }
  }
}

// vitest.setup.ts（内层隔离——测试套件级）
beforeEach(() => {
  vi.useFakeTimers();
  // 重置所有全局单例
  const { resetProviderEngine } = await import("./packages/agent-runtime/src/provider-gateway");
  resetProviderEngine();
});
```

---

## 五、任务总表

| 编号 | 任务 | 目标文件 | 核心问题 | 修复策略 | 前置依赖 |
|------|------|---------|---------|---------|---------|
| J-1 | 创建 FauxAgentProvider | `src/testing/faux-provider.ts`（新建） | Provider 测试需真实 API key | 可控事件序列 + 故障注入 | Layer A AgentProvider 接口稳定 |
| J-2 | 创建 FauxProviderCallGateway | `src/testing/faux-call-gateway.ts`（新建） | Gateway 路由决策不可控 | 记录路由决策 + 预设响应 | J-1 |
| J-3 | 创建 createMockTool 工厂 | `src/testing/mock-tool.ts`（新建） | Tool 测试手动构造 ToolExecutor | 标准 MockTool + 预设 output/error | 无 |
| J-4 | vitest.globalSetup 外层隔离 | `vitest.globalSetup.ts`（新建） | 环境变量污染导致意外网络请求 | 备份并清除所有 Provider API key | 无 |
| J-5 | vitest.setup 内层隔离增强 | `vitest.setup.ts`（修改） | 单例污染、定时器泄漏 | `vi.useFakeTimers()` + `onUnhandledRejection` | J-4 |
| J-6 | 创建 FixtureLoader + JSON fixtures | `tests/fixtures/provider-responses/` | 测试数据硬编码 | `loadFixture()` + fixture 目录 | 无 |
| J-7 | ProviderGateway 测试完善 | `provider-gateway.test.ts`（修改） | 路由选择分支覆盖率不足 | 覆盖 fallback/cooldown/priority 等 10+ 场景 | J-1 |
| J-8 | ToolExecutor 测试增强 | `tool-executor.test.ts`（修改） | Options 模式分支无独立测试 | 策略组合/继承/条件选择的边界 | C1-9 |
| J-9 | AgentSessionLoop 集成测试 | `agent-session-loop.test.ts`（修改） | 完整 Turn 循环未验证 | FauxProvider 模拟响应，验证状态机 | C1-1, J-1 |
| J-10 | ProviderCallGateway 集成测试 | `provider-call-gateway.test.ts`（修改） | 流恢复/降级链未覆盖 | FauxProvider 注入网络错误，验证恢复路径 | J-2 |
| J-11 | Tool+Provider 管线 E2E 测试 | `tests/integration/tool-provider-pipeline.test.ts`（新建） | 模型输出→工具执行管线未覆盖 | FauxProvider yield tool-call→MockTool 验证 | J-1, J-3 |
| J-12 | 创建 @crish/test-utils 包 | `packages/test-utils/`（新建） | 测试工具散落各处 | 统一导出 FauxProvider/MockTool/FixtureLoader | J-1~J-6 |
| J-13 | 覆盖率门禁设置 | 各包 `vitest.config.ts` | 阈值已定义但不强制 | 70/60/65/70 硬性阻断 | 无 |
| J-14 | Rust 测试增强 | `crates/conex-fs/src/` 等 | conex-fs/conex-net/conex-db 无测试 | 函数级单元测试 + fixture | 无 |
| J-15 | 测试分组 | `vitest.workspace.ts`（新建） | unit/integration/e2e 混跑 | vitest workspace 分离三组 | 无 |
| J-16 | CI 测试脚本统一 | `scripts/ci-test.mjs`（新建） | 测试命令分散 | 聚合 + JUnit 报告 | 无 |
| J-17 | Stress 测试可重现 | `tests/stress/stress-runner.ts` | `Math.random()` 路径不可重现 | 种子随机数 + 确定性调度 | 无 |
| J-18 | Rust Mock LLM endpoint | `crates/conex-test-utils/`（新建） | Rust 侧集成测试需真实 HTTP | mock HTTP server | 无 |
| J-19 | Retry/flaky 配置 | `vitest.config.ts` | flaky 测试导致 CI 不稳定 | `retry: 2` + `test-timeout: 10000` | 无 |
| J-20 | provider-gateway 单例 reset | `src/provider-gateway.ts` | `_gatewayBridge` 跨测试污染 | 暴露 `resetProviderEngine()` | C2-9（GatewayV2Bridge 去单例化） |
| J-21 | 手动 mock 替换 | 跨 `*.test.ts` | 20+ 处手动 vi.mock | 逐步替换为 FauxProvider | J-1~J-2 |
| J-22 | Rust 覆盖率门禁 | `ci.yml` + `Cargo.toml` | Rust 侧无覆盖率检查 | tarpaulin/grcov 集成 | B-14~B-20 |
| J-23 | 缺失模块测试补充 | 多文件 | cache/retry/wal 等无测试 | 按重要性逐步添加 | 无 |

---

## 六、执行批次

| 轮次 | 任务 | Agent 数 | 与其他层的并行关系 |
|------|------|---------|-----------------|
| Round 0 | J-4, J-5（隔离基础设施） | 2 | 与 Layer A 完全并行 |
| Round 2 | J-1~J-3, J-6（核心工具） | 4 | 与 Layer B/C1 并行 |
| Round 4 | J-7~J-12, J-20（集成测试扩展 + 单例 reset） | 4 | 与 Layer E 并行 |
| Round 6 | J-13~J-23（覆盖门禁 + 缺失测试） | 6 | 与 Layer G/I 并发 |

---

## 七、验证标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| V-J1 | 隔离性 | `process.env.ANTHROPIC_API_KEY` 在 globalSetup 后为空 | 所有 API key 环境变量被清理 |
| V-J2 | FauxProvider 可用 | `new FauxProvider("test").stream(req)` 返回预设事件 | 序列100%匹配 |
| V-J3 | 覆盖率门禁 | `npm run test:coverage` 低于阈值报错 | 70/60/65/70 |
| V-J4 | Provider 测试 | ProviderGateway 覆盖 10+ 路由场景 | 全部通过 |
| V-J5 | SessionLoop 集成测试 | 用 FauxProvider 跑完整 Turn 循环 | 状态机全部状态可达 |
| V-J6 | Rust 测试 | `cargo test --workspace --all-features` | 无新增失败 |
| V-J7 | @crish/test-utils 包 | `import { FauxProvider } from "@crish/test-utils"` | 构建 + 导入 |
| V-J8 | Mock 替代进度 | `grep "vi.mock" --include="*.test.ts"` | 数量下降 50%+ |

---

## 八、风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| FauxProvider 接口随 Provider 变更需同步 | 中 | 中 | 先冻结 `AgentProvider` 接口再开发 FauxProvider |
| 覆盖率门禁过高导致 CI 频繁失败 | 中 | 中 | 初始门槛设为当前水平（~60%），逐轮提升 |
| 测试隔离影响开发者本地体验 | 低 | 低 | `globalSetup` 仅在 `CI=true` 时生效 |
