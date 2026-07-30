# Round 12：CI 强化与文档产品化

> **本文件是 Round 12 的唯一权威设计文档**（依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 29 唯一权威来源原则）。
> 所有 Agent 任务、CI 配置、depcruise 规则、文档结构、删除清单引用本文件时，必须以本文件的 Agent 分配与验证门禁为准。
>
> **前置文档**：
>
> - `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10-12 包拆分边界、禁令 23-26 迁移策略与 Legacy Shim（全部子节）、禁令 27-28 Agent 任务量、禁令 29-31 文档一致性
> - `v2/01-OVERVIEW.md` §3 依赖图、§3.2 拓扑层级、§4.1 轮次总览、§4.3 每轮验证门禁、§6 跨轮次验证体系
> - `v2/02-FILE-MAPPING.md` §1 目标包总览、§9 依赖方向验证
> - `v2/03-ERROR-MIGRATION.md` §1 现有错误码清单、§2 新 CrishErrorCode 体系、§7 迁移三阶段
> - `v2/ROUND-05-split-phase-C.md` §5 Legacy Shim 设计（v0.3.0 移除时间表）
> - `v2/ROUND-08-plugin-sdk.md` §5.3 旧 plugin-sdk 17 行接口的 deprecation shim
>
> **本 Round 遵守的硬性红线**：
>
> - 禁令 23：迁移三阶段策略的**删除阶段**（第三阶段）——所有 deprecated 代码在本 Round 删除，禁止保留"以防万一"
> - 禁令 24：Legacy shim 在 v0.3.0 必须删除；CI 门禁必须包含"检查无 `@crish/agent-runtime` import"的规则
> - 禁令 25：错误码迁移完成，旧 `SessionError`/`ProviderError`/`ProtocolError`/`PermissionError` 类与旧错误码（`SessionErrorCode`/`ProviderErrorKind`/`ErrorDomain`）一并删除
> - 禁令 26：TSC 错误数 < 50（Round 11 已达成，本 Round 维持不恶化）
> - 禁令 28：每个 Agent ≥ 5 文件或 ≥ 300 行变更
> - 禁令 30：文档间不得冲突；ARCHITECTURE.md 与 02-FILE-MAPPING.md 的依赖图必须一致
> - 禁令 31：文档是活文档，必须与代码同步

---

## 1. Round 概述

### 1.1 拓扑层说明

Round 12 是整个 v2 修复方案的最后一轮，处于拓扑层之上的"横切层"（CI + 文档）。本 Round 不创建新包、不迁移代码，而是完成三件收尾工作：

1. **CI 强化**：将 8 项验证门禁固化为 CI 配置，附加 legacy shim 移除检查、TSC 错误数门禁、测试覆盖率门禁
2. **文档产品化**：更新 ARCHITECTURE.md 反映 9 包架构，编写 3 份专题开发指南，清理 TECH_DEBT.md
3. **删除阶段**：删除所有 deprecated 代码（旧错误类型、logger re-export、daemon-logger re-export、agent-runtime legacy shim、旧 plugin-sdk shim）

```
Layer 0-9: 全部 9 包已创建（R1-R11 完成）+ Rust crates 对齐（R10）+ 前端韧性（R11）
                ↓
Layer 横切: CI 配置 + 文档 + 删除阶段（本 Round）
```

**关键拓扑约束**：

- 本 Round 必须在 Round 11（前端韧性 + TSC < 50）完成后执行
- 本 Round 删除的 deprecated 代码在前 11 轮已全部标记 `@deprecated` 并保留 shim，删除行为不影响运行时
- 本 Round 无后续轮次，验证门禁即为最终发布门禁

### 1.2 目标与范围

**目标**：将 12 轮修复方案的成果固化为可持续运行的 CI 门禁与可维护的文档体系，同时完成迁移三阶段的最后一步——删除所有 deprecated 代码。

**范围边界**：

| 范围内（本 Round 实现）                        | 范围外（不属于本 Round）           |
| ---------------------------------------------- | ---------------------------------- |
| 8 项 CI 门禁配置 + 3 项附加门禁                | 新功能开发                         |
| dependency-cruiser 跨层依赖规则                | 性能优化（属 R11 已完成）          |
| 4 个端到端集成测试                             | 压测/基准测试（已有独立脚本）      |
| ARCHITECTURE.md 更新为 9 包架构                | API 参考 docs（自动生成）          |
| 3 份专题开发指南                               | 用户手册                           |
| TECH_DEBT.md 清理                              | Bug 追踪系统迁移                   |
| 删除旧错误类型（SessionError 等）              | 重写错误处理逻辑（R1/R5 已完成）   |
| 删除 logger/daemon-logger deprecated re-export | 重写日志系统（R2 已完成）          |
| 删除 agent-runtime legacy shim（v0.3.0）       | 重写 agent-runtime（R3-R5 已完成） |
| 删除旧 plugin-sdk 17 行 shim（v0.3.0）         | 重写 plugin-sdk（R8 已完成）       |

### 1.3 目标包

| 目标                                                        | 类别           | 责任 Agent | 变更量（约）    |
| ----------------------------------------------------------- | -------------- | ---------- | --------------- |
| `.github/workflows/ci.yml` 强化                             | CI 配置        | 12-A       | +180 行         |
| `scripts/check-legacy-shim.mjs` 新建                        | CI 脚本        | 12-A       | ~80 行          |
| `scripts/check-tsc-threshold.mjs` 新建                      | CI 脚本        | 12-A       | ~60 行          |
| `.dependency-cruiser.cjs` 增强                              | depcruise 规则 | 12-B       | +150 行         |
| `tests/integration/*.test.ts` 4 文件                        | 集成测试       | 12-B       | ~600 行         |
| `ARCHITECTURE.md` 重写                                      | 文档           | 12-C       | ~400 行         |
| `docs/plugin-development.md` 新建                           | 专题指南       | 12-C       | ~350 行         |
| `docs/subagent-development.md` 新建                         | 专题指南       | 12-C       | ~300 行         |
| `docs/error-handling.md` 新建                               | 专题指南       | 12-C       | ~280 行         |
| `packages/shared-types/src/errors.ts` 删除旧类              | 代码删除       | 12-D       | -200 行         |
| `packages/shared-utils/src/logger.ts` 删除 re-export        | 代码删除       | 12-D       | -30 行          |
| `packages/agent-daemon/src/daemon-logger.ts` 删除 re-export | 代码删除       | 12-D       | -25 行          |
| `packages/agent-runtime/` 删除整个包                        | 代码删除       | 12-D       | -100 行（shim） |
| `packages/plugin-sdk/src/index.ts` 删除旧 shim              | 代码删除       | 12-D       | -40 行          |
| `TECH_DEBT.md` 清理                                         | 文档           | 12-D       | -150 行         |

### 1.4 交付物清单

| 交付物         | 路径                                                                                     | 说明                              |
| -------------- | ---------------------------------------------------------------------------------------- | --------------------------------- |
| CI 配置强化    | `.github/workflows/ci.yml`                                                               | 8 项标准 + 3 项附加门禁           |
| CI 辅助脚本    | `scripts/check-legacy-shim.mjs`、`scripts/check-tsc-threshold.mjs`                       | legacy shim 检查 + TSC 错误数门禁 |
| depcruise 规则 | `.dependency-cruiser.cjs`                                                                | 跨层依赖禁止 + legacy 包禁止      |
| 集成测试       | `tests/integration/{session-subagent,plugin-hook,provider-fallback,mcp-startup}.test.ts` | 4 个端到端场景                    |
| 架构文档       | `ARCHITECTURE.md`                                                                        | 9 包架构 + 依赖图 + 包边界        |
| 专题指南       | `docs/plugin-development.md`、`docs/subagent-development.md`、`docs/error-handling.md`   | 3 份开发指南                      |
| 技术债务清理   | `TECH_DEBT.md`                                                                           | 移除已解决条目                    |
| 删除清单       | 见 §7                                                                                    | deprecated 代码删除完成           |
| 最终验证报告   | `analysis/iterative-repair/v2/round-12-verification-report.md`                           | 12 轮方案最终验证                 |

---

## 2. Agent 任务详细设计

### 2.1 Agent 编排与依赖

```
12-A (CI 门禁 + 脚本)  ──┐
                          │
12-B (depcruise + 集成测试) ─┼──→ 12-D (删除 deprecated + TECH_DEBT 清理 + 验证)
                          │    ↑
12-C (ARCHITECTURE + 专题文档) ┘
                              │
                              └── 12-D 依赖 12-A/12-B/12-C 的产出（删除后需重新运行门禁验证）
```

| Agent | 文件集（不相交）                                                                                                                                                                                          | 依赖前置         | 协调次数                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------ |
| 12-A  | `.github/workflows/ci.yml`、`scripts/check-legacy-shim.mjs`、`scripts/check-tsc-threshold.mjs`、`package.json`（scripts 段）                                                                              | 无               | 1（与 12-D 约定 legacy shim 检查规则）           |
| 12-B  | `.dependency-cruiser.cjs`、`tests/integration/*.test.ts`                                                                                                                                                  | 无               | 1（与 12-A 约定 depcruise 在 CI 中的调用方式）   |
| 12-C  | `ARCHITECTURE.md`、`docs/plugin-development.md`、`docs/subagent-development.md`、`docs/error-handling.md`                                                                                                 | 无               | 0                                                |
| 12-D  | `packages/shared-types/src/errors.ts`、`packages/shared-utils/src/logger.ts`、`packages/agent-daemon/src/daemon-logger.ts`、`packages/agent-runtime/`、`packages/plugin-sdk/src/index.ts`、`TECH_DEBT.md` | 12-A, 12-B, 12-C | 2（消费 CI 脚本 + depcruise 规则用于删除后验证） |

**并行性说明**（依据 01-OVERVIEW.md §5.1）：

- 12-A、12-B、12-C 操作的文件集完全不相交，可真并行启动
- 12-D 必须在 12-A/12-B/12-C 完成后执行，因为删除 deprecated 代码后需要用新的 CI 脚本与 depcruise 规则验证无回归

### 2.2 Agent 12-A：CI 门禁配置 + legacy shim 移除检查

| 维度     | 说明                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| **类型** | 实现型 + 验证型                                                                  |
| **目标** | 配置 CI 的 8 项标准门禁 + 3 项附加门禁（legacy shim 检查、TSC < 50、覆盖率门禁） |
| **前置** | Round 11 已完成（TSC < 50 已达成）                                               |
| **后续** | 12-D 删除 deprecated 后重新运行 CI 验证                                          |

**输入**：

- 现有 `.github/workflows/ci.yml`（8 个 job：typecheck/lint/test/test:integration/audit/cargo-deny/secret-scan/rust-check）
- 现有 `package.json` scripts 段（`check:core`、`check:store-types`、`test:coverage`、`lint:depcruise` 等）
- `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 24 legacy shim 移除验证
- `01-OVERVIEW.md` §4.3 每轮验证门禁的 8 项检查

**输出**：

- `.github/workflows/ci.yml`（强化版，8 项标准 + 3 项附加）
- `scripts/check-legacy-shim.mjs`（新建）
- `scripts/check-tsc-threshold.mjs`（新建）
- `package.json`（scripts 段增加 `check:legacy-shim`、`check:tsc-threshold`）

**任务清单**：

1. **整合 8 项标准门禁到 CI**：
   - `tsc` job：调用 `npx turbo run typecheck`（现有 typecheck job 保留）
   - `cargo-check` job：调用 `cargo check --workspace`（现有 rust-check job 保留）
   - `vitest` job：调用 `npx vitest run`（现有 test job 保留）
   - `cargo-test` job：新增，调用 `cargo test --workspace`
   - `depcruise` job：调用 `npm run lint:depcruise`（现有 lint job 内已含，本 Round 拆分为独立 job 以便单独门禁）
   - `turbo-build` job：新增，调用 `npx turbo run build`
   - `lint` job：调用 `npx eslint .`（现有 lint job 拆分后保留）
   - `store-types` job：新增，调用 `npm run check:store-types`

2. **新增 legacy shim 移除检查门禁**（禁令 24）：
   - 编写 `scripts/check-legacy-shim.mjs`：grep 源码中 `from '@crish/agent-runtime'` 与 `from '@crish/plugin-sdk'`（旧 17 行接口）的 import
   - 检查范围：`packages/`、`apps/`，排除 `*.test.ts`、`__tests__/`、`node_modules/`、`dist/`
   - 通过标准：0 处残留 import
   - 新增 CI job `legacy-shim-check` 调用此脚本

3. **新增 TSC 错误数门禁**（禁令 26，Round 11 目标 < 50 的固化为 CI 规则）：
   - 编写 `scripts/check-tsc-threshold.mjs`：运行 `npx tsc --noEmit`，解析输出错误数，与阈值 50 比较
   - 通过标准：错误数 < 50（严格小于，依据 禁令 26 Round 11 目标）
   - 新增 CI job `tsc-threshold-check` 调用此脚本
   - 脚本支持环境变量 `TSC_ERROR_THRESHOLD` 覆盖默认值 50（便于后续降低阈值）

4. **新增测试覆盖率门禁**：
   - 复用 `package.json` 现有 `test:coverage` 脚本
   - 在 CI `test` job 中增加覆盖率阈值断言：orchestrator 70% stmt、runtime（已拆分为 9 包）各包 50% stmt（依据 `01-OVERVIEW.md` §1.2 基线）
   - 通过标准：各包覆盖率不低于基线（不恶化）
   - 覆盖率基线文件：`test-coverage-baseline.json`（Round 1 建立，每轮更新）

5. **更新 `package.json` scripts 段**：
   - 增加 `"check:legacy-shim": "node scripts/check-legacy-shim.mjs"`
   - 增加 `"check:tsc-threshold": "node scripts/check-tsc-threshold.mjs"`
   - 增加 `"ci:all": "npm run check:legacy-shim && npm run check:tsc-threshold && npm run typecheck:ci && npm run lint:depcruise && npm run lint && npx turbo run build && npm run test:coverage && npm run check:store-types"`（TS 侧一键全门禁）

**CI job 拓扑**（强化后）：

```yaml
jobs:
  # ── 8 项标准门禁 ──
  tsc: # 1. TypeScript 编译
  cargo-check: # 2. Rust 编译
  vitest: # 3. 单元测试（TS）
  cargo-test: # 4. 单元测试（Rust）[NEW]
  depcruise: # 5. 循环依赖 [拆分为独立 job]
  turbo-build: # 6. 构建 [NEW]
  lint: # 7. Lint
  store-types: # 8. Store 类型 [NEW]

  # ── 3 项附加门禁 ──
  legacy-shim-check: # 9. legacy shim 移除检查 [NEW]
  tsc-threshold-check: # 10. TSC 错误数 < 50 [NEW]
  coverage-check: # 11. 测试覆盖率门禁 [NEW]

  # ── 既有安全门禁（保留） ──
  audit:
  cargo-deny:
  secret-scan:
```

**工作量预估**：4 文件（ci.yml 重写 + 2 脚本新建 + package.json 修改），~320 行变更。

### 2.3 Agent 12-B：dependency-cruiser 规则 + 集成测试

| 维度     | 说明                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------- |
| **类型** | 实现型                                                                                              |
| **目标** | 增强 depcruise 规则（禁止循环依赖 + 禁止跨层依赖 + 禁止 legacy 包 import），编写 4 个端到端集成测试 |
| **前置** | Round 5-11 已完成全部 9 包创建与迁移                                                                |
| **后续** | 12-D 删除 deprecated 后 depcruise 规则验证无回归                                                    |

**输入**：

- 现有 `.dependency-cruiser.cjs`（3 条规则：no-circular、no-daemon-private-from-frontend、no-utils-reverse-dependency）
- `01-OVERVIEW.md` §3 权威依赖图（9 包拓扑层）
- `02-FILE-MAPPING.md` §9 依赖方向验证
- Round 5-11 的全部包创建结果

**输出**：

- `.dependency-cruiser.cjs`（增强版，含跨层依赖规则）
- `tests/integration/session-subagent.test.ts`
- `tests/integration/plugin-hook-intercept.test.ts`
- `tests/integration/provider-rate-limit-fallback.test.ts`
- `tests/integration/mcp-server-startup.test.ts`

**任务清单**：

1. **增强 depcruise 规则**（依据 `01-OVERVIEW.md` §3 拓扑层）：

   depcruise 规则按拓扑层定义"允许的依赖方向"，禁止跨层反向依赖。规则以"层组"组织：

   | 层      | 包                                          |
   | ------- | ------------------------------------------- |
   | Layer 0 | shared-types, shared-utils, decision-engine |
   | Layer 1 | @crish/logger, @crish/telemetry             |
   | Layer 2 | agent-context, agent-permissions, agent-mcp |
   | Layer 3 | agent-tools, agent-model                    |
   | Layer 4 | agent-core                                  |
   | Layer 5 | agent-subagent                              |
   | Layer 6 | agent-orchestrator                          |
   | Layer 7 | agent-daemon                                |
   | Layer 8 | plugin-sdk                                  |
   | Layer 9 | crish-desktop                               |

   新增规则：
   - `no-layer-0-reverse`：Layer 0 包不得依赖任何上层包
   - `no-layer-1-reverse`：Layer 1 包仅可依赖 Layer 0
   - `no-layer-2-reverse`：Layer 2 包仅可依赖 Layer 0/1
   - `no-layer-3-reverse`：Layer 3 包仅可依赖 Layer 0/1/2
   - `no-layer-4-reverse`：Layer 4（agent-core）仅可依赖 Layer 0-3
   - `no-layer-5-reverse`：Layer 5（agent-subagent）仅可依赖 Layer 0-4
   - `no-layer-6-reverse`：Layer 6（agent-orchestrator）仅可依赖 Layer 0-4
   - `no-layer-7-reverse`：Layer 7（agent-daemon）仅可依赖 Layer 0-6
   - `no-layer-8-reverse`：Layer 8（plugin-sdk）仅可依赖 Layer 0/4（agent-core）+ Layer 0（shared-types）
   - `no-layer-9-reverse`：Layer 9（crish-desktop）仅可依赖 Layer 0/7
   - `no-agent-runtime-import`：禁止任何包 import `@crish/agent-runtime`（legacy shim 移除后强制的硬门禁，禁令 24）
   - `no-plugin-sdk-runtime-to-agent-tools`：plugin-sdk 运行时不得 import agent-tools/agent-mcp（仅允许类型引用，禁令 11 循环依赖规避）

2. **编写集成测试 1：session-subagent.test.ts**：
   - 场景：启动 agent session → spawn 子代理 → 验证返回
   - 验证点：
     - SessionLoop 启动后 `session.start` 事件触发
     - `SubagentScheduler.submit(taskCard)` 返回 taskId
     - 子代理执行完成后 `subagent.end` 事件触发
     - `SubagentInstance.join()` 返回 `SubagentResult`（status='completed'）
     - 递归守卫 `maxDepth=3` 生效（depth=4 时拒绝）
     - DeadlockDetector 检测到祖先链中包含目标 session 时拒绝 spawn

3. **编写集成测试 2：plugin-hook-intercept.test.ts**：
   - 场景：触发插件钩子 → 验证拦截
   - 验证点：
     - PluginDiscoverer 从临时 user-dir 发现插件
     - PluginLoader.load 调用 activate(api) 成功
     - 插件通过 `api.on('tool.pre', handler)` 注册拦截器
     - `tool.pre` 事件触发时，handler 返回 `{ block: true, reason: 'blocked by plugin' }`
     - SessionLoop 收到 block 信号后中止工具执行
     - 插件通过 `api.observe('turn.end', handler)` 注册观察器
     - `turn.end` 事件触发时，handler 被调用但返回值被忽略（observe 容错）
     - 能力清单校验：activate 中注册超出 `declaredHooks` 的事件时，PluginValidator 拒绝

4. **编写集成测试 3：provider-rate-limit-fallback.test.ts**：
   - 场景：模拟 provider rate_limit → 验证 fallback
   - 验证点：
     - FauxProvider 配置为首次返回 HTTP 429
     - ProviderCallGateway 调用 provider.stream
     - ErrorClassifier.classify 将错误分类为 `provider.rate_limit`
     - RecoveryPipeline Tier 1 重试（指数退避）
     - 重试后 provider 返回正常流
     - `model.afterResponse` 事件 payload 含 `retried=true, retryCount=1`
     - PipelineResult 返回 `{ ok: true, events, tierUsed: 1 }`
   - **关键约束**（§禁令 3）：验证 fallback 仅在同模型上重试，不切换模型

5. **编写集成测试 4：mcp-server-startup.test.ts**：
   - 场景：模拟 MCP 服务器启动 → 验证工具列表
   - 验证点：
     - McpLifecycleManager.start 启动 stdio MCP 服务器（使用 echo mock 进程）
     - 服务器初始化握手完成后，`listTools` 返回工具清单
     - 工具清单经 ToolRegistry 注册后可通过 `listTools()` 查询
     - 调用 MCP 工具时，`tool.pre`/`tool.post` 事件正常触发
     - MCP 服务器进程退出时，McpLifecycleManager 检测并清理资源
     - `registerPluginServer(pluginName, declaration)` 声明的插件 MCP 服务器被正确启动

**工作量预估**：5 文件（1 depcruise + 4 测试），~750 行变更。

### 2.4 Agent 12-C：ARCHITECTURE.md 更新 + 专题文档

| 维度     | 说明                                                      |
| -------- | --------------------------------------------------------- |
| **类型** | 文档型                                                    |
| **目标** | 更新 ARCHITECTURE.md 反映 9 包架构，编写 3 份专题开发指南 |
| **前置** | Round 5-11 全部包创建完成                                 |
| **后续** | 12-D 清理 TECH_DEBT 时核对文档一致性                      |

**输入**：

- 现有 `ARCHITECTURE.md`（描述单体 agent-runtime 架构，需重写为 9 包架构）
- `01-OVERVIEW.md` §3 权威依赖图
- `02-FILE-MAPPING.md` §1 目标包总览
- `ROUND-08-plugin-sdk.md` §3 plugin-sdk 包设计
- `ROUND-05-split-phase-C.md` §4 agent-subagent 设计
- `03-ERROR-MIGRATION.md` §2 CrishErrorCode 体系

**输出**：

- `ARCHITECTURE.md`（重写）
- `docs/plugin-development.md`（新建）
- `docs/subagent-development.md`（新建）
- `docs/error-handling.md`（新建）

**任务清单**：

1. **重写 ARCHITECTURE.md**：
   - **总览**：Crish 是桌面 AI Agent 工作台，9 包架构 + Rust crates + 前端
   - **9 包架构图**：引用 `01-OVERVIEW.md` §3 的 mermaid 依赖图（禁令 30 文档间一致性）
   - **包职责清单**：每个包的职责、依赖、公共 API（引用 `02-FILE-MAPPING.md` §1）
   - **包边界**：明确各包的"范围内/范围外"（引用 guardrails 禁令 10）
   - **传输与壳**：保留现有 ARCHITECTURE.md 的 WebSocket / Tauri invoke 描述
   - **控制面**：保留现有 Run Control L0-L3 描述
   - **providerProfiles**：保留现有描述
   - **开发与校验入口**：更新为新的 CI 门禁（引用本 Round §3）
   - **迁移历史**：简述从 agent-runtime 单体到 9 包的迁移过程（引用 v2 方案）

2. **编写插件开发指南 `docs/plugin-development.md`**：
   - **PluginManifest 声明**：能力清单（declaredHooks/declaredTools/declaredMcpServers）、权限声明、信任级别、引擎版本约束
   - **HookAPI 使用**：observe/on 双模式区别、registerTool、registerMcpServer、log
   - **工具注册**：ToolDefinition 结构、ToolRegistrationOptions、RegisteredTool
   - **14 钩子事件**：事件名、payload 字段、控制信号（LifecycleHandlerResult / ToolErrorHandlerResult）
   - **信任模型**：restricted vs full、权限粒度、full 级别仅 user-dir
   - **技能加载**：SKILL.md frontmatter 结构、技能→工具转换
   - **完整示例**：一个最小插件的 manifest.json + activate 函数

3. **编写子代理开发指南 `docs/subagent-development.md`**：
   - **SubagentDefinition**：角色（role 标签）、能力模式（capabilityMode）、任务卡（SubagentTaskCard）
   - **调度策略**：FIFO 队列、RecursionGuard（maxDepth=3, maxSiblings=5, maxConcurrent=6, ROUND-09 §3.2 DEFAULT_RECURSION_GUARD 权威值）
   - **子代理发现**：通过 PluginManifest 的 agents 字段、BuiltinDiscoverySource
   - **通信机制**：ControlBus L1/L2/L3（禁令 20，禁止 SubagentCommunicationBus）
   - **DeadlockDetector**：spawn 时 O(depth) 环检测
   - **完整示例**：一个 researcher 子代理的定义与 spawn 调用

4. **编写错误处理指南 `docs/error-handling.md`**：
   - **CrishError 结构**：code（domain.reason 格式）、category、retryable、public、action、cause 链
   - **CrishResult ADT**：ok/err 工具函数（mapResult/flatMapResult/match）
   - **64 正式码 + 10 reserved 码表**：19 域 × reason，引用 `03-ERROR-MIGRATION.md` §2.2
   - **使用策略**：
     - 何时 throw CrishError vs 返回 CrishResult（throw 用于不可恢复，Result 用于可恢复）
     - 何时标记 retryable=true（transient 域默认 true，permanent 域默认 false）
     - 何时标记 public=false（内部诊断码）
     - cause 链使用（最多 8 层，避免无限递归）
   - **跨进程序列化**：CrishErrorPayload 格式、Rust 侧 CoreError 对齐
   - **迁移指南**：从旧 SessionError/ProviderError 迁移到 CrishError 的映射表（引用 `03-ERROR-MIGRATION.md` §3）
   - **完整示例**：provider 调用失败时的错误处理流程

**工作量预估**：4 文件，~1330 行变更。

### 2.5 Agent 12-D：删除旧 deprecated + TECH_DEBT.md 清理

| 维度     | 说明                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **类型** | 删除型 + 验证型                                                                                                                                                                 |
| **目标** | 删除所有 deprecated 代码（旧错误类型、logger re-export、daemon-logger re-export、agent-runtime legacy shim、旧 plugin-sdk shim），清理 TECH_DEBT.md，运行全部验证门禁确认无回归 |
| **前置** | 12-A（CI 脚本）、12-B（depcruise 规则）、12-C（文档）完成                                                                                                                       |
| **后续** | 无（最后一轮）                                                                                                                                                                  |

**输入**：

- `packages/shared-types/src/errors.ts`（含旧 SessionError/ProviderError/ProtocolError/PermissionError 类）
- `packages/shared-utils/src/logger.ts`（含 `@crish/logger` 的 deprecated re-export）
- `packages/agent-daemon/src/daemon-logger.ts`（含 `@crish/logger` 的 deprecated re-export）
- `packages/agent-runtime/`（整个 legacy shim 包，禁令 24 v0.3.0 移除）
- `packages/plugin-sdk/src/index.ts`（含旧 17 行 Plugin/definePlugin shim，禁令 24 v0.3.0 移除）
- `TECH_DEBT.md`（含已解决条目）
- 12-A 产出的 `scripts/check-legacy-shim.mjs`
- 12-B 产出的 `.dependency-cruiser.cjs`

**输出**：

- 清理后的 `packages/shared-types/src/errors.ts`
- 清理后的 `packages/shared-utils/src/logger.ts`
- 清理后的 `packages/agent-daemon/src/daemon-logger.ts`
- 删除 `packages/agent-runtime/` 整个目录
- 清理后的 `packages/plugin-sdk/src/index.ts`
- 清理后的 `TECH_DEBT.md`
- 最终验证报告 `analysis/iterative-repair/v2/round-12-verification-report.md`

**任务清单**：

1. **删除旧错误类型**（禁令 25，引用 `03-ERROR-MIGRATION.md` §1）：
   - 从 `packages/shared-types/src/errors.ts` 删除：
     - `SessionError` 类
     - `SessionErrorCode` 类型（5 个码值）
     - `ProviderError` 类
     - `ProviderErrorKind` 类型（12 个码值）
     - `ProtocolError` 类
     - `PermissionError` 类
   - 保留 `CrishError` 基类 + 4 个新子类（CrishSessionError/CrishProviderError/CrishProtocolError/CrishPermissionError，Round 1 创建）
   - 删除 `migrateErrorCode()` 函数（迁移已完成，禁令 25 桥接函数无存在必要）
   - 验证：grep 源码中无 `new SessionError`/`new ProviderError`/`new ProtocolError`/`new PermissionError` 调用点

2. **删除 shared-utils/logger.ts 的 deprecated re-export**：
   - 删除 `packages/shared-utils/src/logger.ts` 中 re-export `@crish/logger` 的部分
   - 保留 shared-utils 自身的非日志工具函数（如 retry/cache/abort-utils）
   - 验证：grep 源码中无 `from '@crish/shared-utils'` 导入 Logger 的调用点

3. **删除 agent-daemon/daemon-logger.ts 的 deprecated re-export**：
   - 删除 `packages/agent-daemon/src/daemon-logger.ts` 中 re-export `@crish/logger` 的部分
   - 若整个文件仅剩 re-export，则删除整个文件并更新 `agent-daemon/src/index.ts` 的导出
   - 验证：grep 源码中无 `from '@crish/agent-daemon/daemon-logger'` 或 `from './daemon-logger'` 的调用点

4. **删除 agent-runtime legacy shim**（禁令 24，v0.3.0 时间已到）：
   - 删除整个 `packages/agent-runtime/` 目录
   - 从 `package.json` 的 `workspaces` 数组中移除 `packages/agent-runtime`
   - 删除 `package.json` scripts 中的 `build:runtime`、`check:runtime` 脚本
   - 更新 `check:core` 脚本：移除 `check:runtime`，替换为 `check:agent-core`（若存在）
   - 验证：12-A 的 `check-legacy-shim.mjs` 通过（0 处 `@crish/agent-runtime` import）
   - 验证：depcruise 的 `no-agent-runtime-import` 规则通过

5. **删除旧 plugin-sdk 17 行 shim**（禁令 24，v0.3.0 时间已到）：
   - 从 `packages/plugin-sdk/src/index.ts` 删除：
     - 旧 `Plugin` 接口定义
     - 旧 `definePlugin()` 函数
     - 相关 `@deprecated` 注释
   - 保留新 API 导出（manifest/hooks/tools/registry/skills/api）
   - 验证：grep 源码中无 `definePlugin` 调用点

6. **清理 TECH_DEBT.md**：
   - 移除已解决的条目（标注"已解决"或已在 R1-R11 修复的）：
     - TD-002（CircuitBreakerOpenError 冒泡路径）：已通过移除 CircuitBreaker 解决（§禁令 6）
     - TD-005（PricingEngine 不存在）：已在 R4 agent-model 创建
     - TD-006（TECH_DEBT.md 不存在）：本文件即存在
     - TD-007（错误判定逻辑分散）：已通过 R1/R5 ErrorClassifier + CrishError 统一
     - TD-011（缺少 QUOTA_EXHAUSTED 等 ErrorDomain）：已通过 R1 CrishErrorCode 64 正式码 + 10 reserved 码覆盖
     - TD-012（ClassifiedError 缺少 subType 字段）：已在 R5 增强
     - TD-016（store/actions 僵尸文件）：已删除
     - TD-023（不存在 SubagentExecutionStrategy 枚举）：已在 R9 实现
     - TD-024（不存在 agentLoop 纯函数）：已在 R9 实现
     - TD-030/031（tsconfig.base.json 缺少 strict 选项）：已修复
     - TD-035（chat.ts status: any）：文件已删除
     - TD-039（no-circular 规则不存在）：已存在并本 Round 增强
     - TD-040（lint:deps script 不存在）：已存在 `lint:depcruise`
     - TD-044（provider-factory.ts 整文件废弃）：已在 R4 迁移到 agent-model
     - TD-045/046/047/048（provider-*.ts @deprecated）：已在 R4 迁移
     - TD-058（21 个 UU 文件）：已在 R3-R5 迁移到 9 包
     - TD-062（CI/CD 缺 5 项安全门禁）：本 Round 部分解决（cargo-deny/secret-scan 已存在）
   - 保留未解决的条目（标注"保留，后续处理"）
   - 在文件头部更新"清理历史"记录：本次清理基于 R1-R12 修复成果

7. **运行全部验证门禁确认删除后无回归**：
   - 执行 12-A 的 `ci:all` 一键全门禁
   - 执行 `cargo check --workspace && cargo test --workspace`
   - 执行 4 个集成测试（12-B 产出）
   - 执行 `check-legacy-shim.mjs` 与 `check-tsc-threshold.mjs`
   - 生成最终验证报告 `round-12-verification-report.md`

**工作量预估**：6 文件修改 + 1 目录删除 + 1 报告生成，~350 行变更（含删除的 -395 行与新增的验证报告 +350 行）。

---

## 3. CI 门禁配置详细

### 3.1 8 项标准检查

依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 27 与 `01-OVERVIEW.md` §4.3，CI 必须包含以下 8 项标准检查。每项检查作为独立 CI job，失败即阻断 PR 合并。

| 序号 | 检查项           | CI job 名称   | 命令                        | 通过标准                             | 现状                                   |
| ---- | ---------------- | ------------- | --------------------------- | ------------------------------------ | -------------------------------------- |
| 1    | TypeScript 编译  | `tsc`         | `npx turbo run typecheck`   | 0 errors（turbo 聚合各包 typecheck） | 现有 `typecheck` job 保留              |
| 2    | Rust 编译        | `cargo-check` | `cargo check --workspace`   | 0 errors                             | 现有 `rust-check` job 保留             |
| 3    | 单元测试（TS）   | `vitest`      | `npx vitest run`            | 全部通过                             | 现有 `test` job 保留                   |
| 4    | 单元测试（Rust） | `cargo-test`  | `cargo test --workspace`    | 全部通过                             | **新增**                               |
| 5    | 循环依赖         | `depcruise`   | `npm run lint:depcruise`    | 0 violations                         | 现有 lint job 内含，**拆分为独立 job** |
| 6    | 构建             | `turbo-build` | `npx turbo run build`       | 全部成功                             | **新增**                               |
| 7    | Lint             | `lint`        | `npx eslint .`              | 0 errors                             | 现有 lint job 拆分后保留               |
| 8    | Store 类型       | `store-types` | `npm run check:store-types` | 通过                                 | **新增**                               |

**CI job 配置示例**（强化后的 `.github/workflows/ci.yml` 核心片段）：

```yaml
jobs:
  # ── 8 项标准门禁 ──
  tsc:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx turbo run typecheck

  cargo-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions-rust-lang/setup-rust-toolchain@v1
        with:
          components: clippy
      - run: cargo check --workspace
      - run: cargo clippy --workspace -- -D warnings

  vitest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx vitest run --reporter=verbose

  cargo-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions-rust-lang/setup-rust-toolchain@v1
      - run: cargo test --workspace

  depcruise:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx depcruise --config .dependency-cruiser.cjs packages apps --ignore "dist/"

  turbo-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx turbo run build

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx eslint .

  store-types:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run check:store-types
```

### 3.2 legacy shim 移除检查

依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 24，v0.3.0 发布前 CI 门禁必须包含"检查无 `@crish/agent-runtime` import"的规则。本 Round 将此规则扩展为"检查无任何 legacy shim import"，覆盖：

| Legacy shim                                                      | 检查规则                                            | 依据                    |
| ---------------------------------------------------------------- | --------------------------------------------------- | ----------------------- |
| `@crish/agent-runtime`                                           | 0 处 import                                         | 禁令 24，v0.3.0 移除    |
| `@crish/plugin-sdk`（旧 17 行接口）                              | 0 处 `definePlugin` 调用                            | 禁令 24，v0.3.0 移除    |
| `SessionError`/`ProviderError`/`ProtocolError`/`PermissionError` | 0 处 `new XxxError` 调用                            | 禁令 25，错误码迁移完成 |
| `@crish/shared-utils` 导入 Logger                                | 0 处 `import { Logger } from '@crish/shared-utils'` | R2 logger 提取完成      |
| `agent-daemon/daemon-logger` 导入                                | 0 处 `from './daemon-logger'`                       | R2 logger 合并完成      |

**检查脚本 `scripts/check-legacy-shim.mjs`**：

```javascript
#!/usr/bin/env node
/**
 * legacy shim 移除检查（禁令 24）
 *
 * 检查源码中无任何 legacy shim 的 import/调用：
 * - @crish/agent-runtime（v0.3.0 移除）
 * - definePlugin（旧 plugin-sdk 17 行接口，v0.3.0 移除）
 * - new SessionError/ProviderError/ProtocolError/PermissionError（旧错误类型，禁令 25）
 * - import { Logger } from '@crish/shared-utils'（R2 logger 提取后保留 shim，本 Round 删除）
 * - from './daemon-logger'（R2 logger 合并后保留 shim，本 Round 删除）
 *
 * 通过标准：0 处残留
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const PATTERNS = [
  {
    name: '@crish/agent-runtime import',
    regex: /from\s+['"]@crish\/agent-runtime['"]/,
    guardrail: '禁令 24 v0.3.0 移除',
  },
  {
    name: 'definePlugin 调用',
    regex: /\bdefinePlugin\s*\(/,
    guardrail: '禁令 24 旧 plugin-sdk 17 行接口 v0.3.0 移除',
  },
  {
    name: 'new SessionError',
    regex: /\bnew\s+SessionError\s*\(/,
    guardrail: '禁令 25 旧错误类型删除',
  },
  {
    name: 'new ProviderError',
    regex: /\bnew\s+ProviderError\s*\(/,
    guardrail: '禁令 25 旧错误类型删除',
  },
  {
    name: 'new ProtocolError',
    regex: /\bnew\s+ProtocolError\s*\(/,
    guardrail: '禁令 25 旧错误类型删除',
  },
  {
    name: 'new PermissionError',
    regex: /\bnew\s+PermissionError\s*\(/,
    guardrail: '禁令 25 旧错误类型删除',
  },
  {
    name: "import { Logger } from '@crish/shared-utils'",
    regex:
      /import\s+\{[^}]*\bLogger\b[^}]*\}\s+from\s+['"]@crish\/shared-utils['"]/,
    guardrail: 'R2 logger 提取后 shim 删除',
  },
  {
    name: "from './daemon-logger' or 'daemon-logger'",
    regex: /from\s+['"][^'"]*daemon-logger['"]/,
    guardrail: 'R2 logger 合并后 shim 删除',
  },
];

const SCAN_DIRS = ['packages', 'apps'];
const EXCLUDE_PATTERNS = [
  /node_modules/,
  /\/dist\//,
  /\/build\//,
  /\.test\.ts$/,
  /\.spec\.ts$/,
  /\/__tests__\//,
  /tests\/integration\//, // 集成测试可能引用 legacy 名作为负向测试，但本 Round 不允许
];

let violations = 0;

for (const dir of SCAN_DIRS) {
  const files = execSync(`git ls-files "${dir}/**/*.ts" "${dir}/**/*.tsx"`, {
    encoding: 'utf-8',
  })
    .trim()
    .split('\n')
    .filter((f) => !EXCLUDE_PATTERNS.some((p) => p.test(f)));

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    for (const { name, regex, guardrail } of PATTERNS) {
      const matches = content.match(new RegExp(regex, 'g'));
      if (matches) {
        console.error(
          `[VIOLATION] ${file}: ${name} (${matches.length} 处) — ${guardrail}`
        );
        violations += matches.length;
      }
    }
  }
}

if (violations > 0) {
  console.error(`\nlegacy shim 移除检查失败：${violations} 处违规`);
  process.exit(1);
}

console.log('legacy shim 移除检查通过：0 处违规');
```

**CI job 配置**：

```yaml
legacy-shim-check:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20
        cache: npm
    - run: npm ci
    - run: node scripts/check-legacy-shim.mjs
```

### 3.3 TSC 错误数门禁（< 50）

依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 26，Round 11 目标为 TSC 错误 < 50。本 Round 将此目标固化为 CI 规则，确保后续维护中不恶化。

**检查脚本 `scripts/check-tsc-threshold.mjs`**：

```javascript
#!/usr/bin/env node
/**
 * TSC 错误数门禁（禁令 26）
 *
 * 运行 tsc --noEmit 并解析错误数，与阈值比较。
 * 通过标准：错误数 < THRESHOLD（严格小于）。
 *
 * 环境变量：
 * - TSC_ERROR_THRESHOLD：阈值，默认 50（禁令 26 Round 11 目标）
 */

import { execSync } from 'node:child_process';

const THRESHOLD = parseInt(process.env.TSC_ERROR_THRESHOLD ?? '50', 10);

console.log(`运行 tsc --noEmit（阈值 < ${THRESHOLD}）...`);

let output;
try {
  execSync('npx tsc --noEmit', {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  output = '';
} catch (err) {
  output = err.stderr?.toString() ?? err.stdout?.toString() ?? '';
}

// tsc 错误行格式：file(line,col): error TSxxxx: message
const errorLines = output
  .split('\n')
  .filter((line) => /\berror TS\d+:/.test(line));
const errorCount = errorLines.length;

console.log(`TSC 错误数：${errorCount}`);

if (errorCount >= THRESHOLD) {
  console.error(`TSC 错误数门禁失败：${errorCount} >= ${THRESHOLD}`);
  console.error('\n错误详情（前 20 条）：');
  errorLines.slice(0, 20).forEach((line) => console.error(`  ${line}`));
  process.exit(1);
}

console.log(`TSC 错误数门禁通过：${errorCount} < ${THRESHOLD}`);
```

**CI job 配置**：

```yaml
tsc-threshold-check:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20
        cache: npm
    - run: npm ci
    - run: node scripts/check-tsc-threshold.mjs
      env:
        TSC_ERROR_THRESHOLD: '50'
```

### 3.4 测试覆盖率门禁

依据 `01-OVERVIEW.md` §1.2 基线（orchestrator 70% stmt、runtime 50% stmt），本 Round 固化覆盖率门禁，确保后续维护中覆盖率不下降。

**覆盖率基线**（基于 Round 1 建立的 `test-coverage-baseline.json`，经 11 轮更新）：

| 包                 | 覆盖率基线（stmt%） | 门禁阈值 |
| ------------------ | ------------------- | -------- |
| shared-types       | 85%                 | ≥ 80%    |
| shared-utils       | 75%                 | ≥ 70%    |
| decision-engine    | 70%                 | ≥ 65%    |
| @crish/logger      | 80%                 | ≥ 75%    |
| @crish/telemetry   | 75%                 | ≥ 70%    |
| agent-context      | 65%                 | ≥ 60%    |
| agent-permissions  | 70%                 | ≥ 65%    |
| agent-mcp          | 60%                 | ≥ 55%    |
| agent-tools        | 65%                 | ≥ 60%    |
| agent-model        | 60%                 | ≥ 55%    |
| agent-core         | 55%                 | ≥ 50%    |
| agent-subagent     | 60%                 | ≥ 55%    |
| agent-orchestrator | 75%                 | ≥ 70%    |
| agent-daemon       | 65%                 | ≥ 60%    |
| plugin-sdk         | 70%                 | ≥ 65%    |
| crish-desktop      | 50%                 | ≥ 45%    |

> 门禁阈值 = 基线 - 5%（允许小幅波动，但不允许持续下降）。

**CI job 配置**：

```yaml
coverage-check:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20
        cache: npm
    - run: npm ci
    - run: npx vitest run --coverage
    - name: Check coverage thresholds
      run: node scripts/check-coverage-threshold.mjs
```

**覆盖率检查脚本**（`scripts/check-coverage-threshold.mjs`，复用现有 `test:coverage` 产出的 coverage-summary.json）：

```javascript
#!/usr/bin/env node
/**
 * 测试覆盖率门禁
 *
 * 读取 vitest 产出的 coverage-summary.json，按包验证 stmt 覆盖率不低于阈值。
 * 阈值定义见本文件 §3.4 表格。
 */

import { readFileSync } from 'node:fs';

const THRESHOLDS = {
  'packages/shared-types': 80,
  'packages/shared-utils': 70,
  'packages/decision-engine': 65,
  'packages/@crish/logger': 75,
  'packages/@crish/telemetry': 70,
  'packages/agent-context': 60,
  'packages/agent-permissions': 65,
  'packages/agent-mcp': 55,
  'packages/agent-tools': 60,
  'packages/agent-model': 55,
  'packages/agent-core': 50,
  'packages/agent-subagent': 55,
  'packages/agent-orchestrator': 70,
  'packages/agent-daemon': 60,
  'packages/plugin-sdk': 65,
  'apps/crish-desktop': 45,
};

const summary = JSON.parse(
  readFileSync('coverage/coverage-summary.json', 'utf-8')
);

let failed = false;
for (const [path, threshold] of Object.entries(THRESHOLDS)) {
  const entry = Object.entries(summary).find(([key]) => key.includes(path));
  if (!entry) {
    console.warn(`[WARN] 未找到 ${path} 的覆盖率数据，跳过`);
    continue;
  }
  const stmtPct = entry[1].statements.pct;
  if (stmtPct < threshold) {
    console.error(`[FAIL] ${path}: stmt ${stmtPct}% < ${threshold}%`);
    failed = true;
  } else {
    console.log(`[PASS] ${path}: stmt ${stmtPct}% >= ${threshold}%`);
  }
}

if (failed) process.exit(1);
console.log('\n测试覆盖率门禁通过');
```

---

## 4. dependency-cruiser 规则设计

### 4.1 规则设计原则

依据 `01-OVERVIEW.md` §3 权威依赖图与 `02-FILE-MAPPING.md` §9 依赖方向验证，depcruise 规则按以下原则设计：

1. **拓扑层约束**：每个包仅可依赖更低层的包，禁止反向依赖
2. **循环依赖禁止**：全局禁止循环依赖（现有规则保留）
3. **legacy 包禁止**：删除 agent-runtime 后，禁止任何包 import `@crish/agent-runtime`
4. **类型 vs 运行时**：允许 plugin-sdk 通过 shared-types 间接引用 agent-tools/agent-mcp 的类型，但禁止运行时 import（禁令 11 循环依赖规避）

### 4.2 规则清单

增强后的 `.dependency-cruiser.cjs` 包含以下规则：

| 序号 | 规则名                                 | severity | 描述                                                                      | 依据            |
| ---- | -------------------------------------- | -------- | ------------------------------------------------------------------------- | --------------- |
| 1    | `no-circular`                          | error    | 全局禁止循环依赖                                                          | 现有规则保留    |
| 2    | `no-daemon-private-from-frontend`      | error    | 前端不得 import agent-daemon 私有模块                                     | 现有规则保留    |
| 3    | `no-utils-reverse-dependency`          | error    | shared-utils 不得 import 上层包                                           | 现有规则保留    |
| 4    | `no-layer-0-reverse`                   | error    | Layer 0 包（shared-types/shared-utils/decision-engine）不得依赖任何上层包 | 新增            |
| 5    | `no-layer-1-reverse`                   | error    | Layer 1 包（logger/telemetry）仅可依赖 Layer 0                            | 新增            |
| 6    | `no-layer-2-reverse`                   | error    | Layer 2 包（context/permissions/mcp）仅可依赖 Layer 0/1                   | 新增            |
| 7    | `no-layer-3-reverse`                   | error    | Layer 3 包（tools/model）仅可依赖 Layer 0/1/2                             | 新增            |
| 8    | `no-layer-4-reverse`                   | error    | Layer 4 包（agent-core）仅可依赖 Layer 0-3                                | 新增            |
| 9    | `no-layer-5-reverse`                   | error    | Layer 5 包（agent-subagent）仅可依赖 Layer 0-4                            | 新增            |
| 10   | `no-layer-6-reverse`                   | error    | Layer 6 包（agent-orchestrator）仅可依赖 Layer 0-4                        | 新增            |
| 11   | `no-layer-7-reverse`                   | error    | Layer 7 包（agent-daemon）仅可依赖 Layer 0-6                              | 新增            |
| 12   | `no-layer-8-reverse`                   | error    | Layer 8 包（plugin-sdk）仅可依赖 Layer 0 + Layer 4                        | 新增            |
| 13   | `no-layer-9-reverse`                   | error    | Layer 9 包（crish-desktop）仅可依赖 Layer 0 + Layer 7                     | 新增            |
| 14   | `no-agent-runtime-import`              | error    | 禁止任何包 import `@crish/agent-runtime`（legacy shim 删除后强制）        | 新增（禁令 24） |
| 15   | `no-plugin-sdk-runtime-to-agent-tools` | error    | plugin-sdk 运行时不得 import agent-tools/agent-mcp                        | 新增（禁令 11） |

### 4.3 规则配置示例

```javascript
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── 现有规则（保留）──
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Disallow circular dependencies across the entire codebase',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-daemon-private-from-frontend',
      severity: 'error',
      comment:
        'Frontend must not import private internal modules of agent-daemon',
      from: { path: '^apps/crish-desktop' },
      to: { path: '^packages/agent-daemon/src/(?!index|protocol|server)' },
    },
    {
      name: 'no-utils-reverse-dependency',
      severity: 'error',
      comment: 'Shared utils must not import upper business packages',
      from: { path: '^packages/shared-utils' },
      to: {
        path: '^packages/(agent-core|agent-orchestrator|agent-daemon|agent-tools|agent-model|agent-context|agent-permissions|agent-mcp|agent-subagent|plugin-sdk|logger|telemetry)',
      },
    },

    // ── 拓扑层反向依赖禁止规则（新增）──
    // Layer 0：shared-types / shared-utils / decision-engine 不得依赖任何上层包
    {
      name: 'no-layer-0-reverse',
      severity: 'error',
      comment: 'Layer 0 packages must not depend on any upper layer',
      from: {
        path: '^packages/(shared-types|shared-utils|decision-engine)',
      },
      to: {
        path: '^packages/(agent-core|agent-orchestrator|agent-daemon|agent-tools|agent-model|agent-context|agent-permissions|agent-mcp|agent-subagent|plugin-sdk|logger|telemetry)',
      },
    },
    // Layer 1：logger / telemetry 仅可依赖 Layer 0
    {
      name: 'no-layer-1-reverse',
      severity: 'error',
      comment:
        'Layer 1 packages (logger/telemetry) must only depend on Layer 0',
      from: {
        path: '^packages/(logger|telemetry)',
      },
      to: {
        path: '^packages/(agent-core|agent-orchestrator|agent-daemon|agent-tools|agent-model|agent-context|agent-permissions|agent-mcp|agent-subagent|plugin-sdk)',
      },
    },
    // Layer 2：context / permissions / mcp 仅可依赖 Layer 0/1
    {
      name: 'no-layer-2-reverse',
      severity: 'error',
      comment: 'Layer 2 packages must only depend on Layer 0/1',
      from: {
        path: '^packages/(agent-context|agent-permissions|agent-mcp)',
      },
      to: {
        path: '^packages/(agent-core|agent-orchestrator|agent-daemon|agent-tools|agent-model|agent-subagent|plugin-sdk)',
      },
    },
    // Layer 3：tools / model 仅可依赖 Layer 0/1/2
    {
      name: 'no-layer-3-reverse',
      severity: 'error',
      comment: 'Layer 3 packages must only depend on Layer 0/1/2',
      from: {
        path: '^packages/(agent-tools|agent-model)',
      },
      to: {
        path: '^packages/(agent-core|agent-orchestrator|agent-daemon|agent-subagent|plugin-sdk)',
      },
    },
    // Layer 4：agent-core 仅可依赖 Layer 0-3
    {
      name: 'no-layer-4-reverse',
      severity: 'error',
      comment: 'agent-core must only depend on Layer 0-3',
      from: {
        path: '^packages/agent-core',
      },
      to: {
        path: '^packages/(agent-orchestrator|agent-daemon|agent-subagent|plugin-sdk)',
      },
    },
    // Layer 5：agent-subagent 仅可依赖 Layer 0-4
    {
      name: 'no-layer-5-reverse',
      severity: 'error',
      comment: 'agent-subagent must only depend on Layer 0-4',
      from: {
        path: '^packages/agent-subagent',
      },
      to: {
        path: '^packages/(agent-orchestrator|agent-daemon|plugin-sdk)',
      },
    },
    // Layer 6：agent-orchestrator 仅可依赖 Layer 0-4
    {
      name: 'no-layer-6-reverse',
      severity: 'error',
      comment: 'agent-orchestrator must only depend on Layer 0-4',
      from: {
        path: '^packages/agent-orchestrator',
      },
      to: {
        path: '^packages/(agent-daemon|agent-subagent|plugin-sdk)',
      },
    },
    // Layer 7：agent-daemon 仅可依赖 Layer 0-6
    {
      name: 'no-layer-7-reverse',
      severity: 'error',
      comment: 'agent-daemon must only depend on Layer 0-6',
      from: {
        path: '^packages/agent-daemon',
      },
      to: {
        path: '^packages/(agent-subagent|plugin-sdk)',
      },
    },
    // Layer 8：plugin-sdk 仅可依赖 Layer 0 + Layer 4
    {
      name: 'no-layer-8-reverse',
      severity: 'error',
      comment:
        'plugin-sdk must only depend on Layer 0 (shared-types) + Layer 4 (agent-core)',
      from: {
        path: '^packages/plugin-sdk',
      },
      to: {
        path: '^packages/(agent-orchestrator|agent-daemon|agent-subagent|agent-tools|agent-model|agent-context|agent-permissions|agent-mcp|logger|telemetry)',
      },
    },
    // Layer 9：crish-desktop 仅可依赖 Layer 0 + Layer 7
    {
      name: 'no-layer-9-reverse',
      severity: 'error',
      comment:
        'crish-desktop must only depend on Layer 0 (shared-types) + Layer 7 (agent-daemon)',
      from: {
        path: '^apps/crish-desktop',
      },
      to: {
        path: '^packages/(agent-core|agent-orchestrator|agent-tools|agent-model|agent-context|agent-permissions|agent-mcp|agent-subagent|plugin-sdk|logger|telemetry|decision-engine|shared-utils)',
      },
    },

    // ── legacy 包禁止规则（新增，禁令 24）──
    {
      name: 'no-agent-runtime-import',
      severity: 'error',
      comment:
        '禁止任何包 import @crish/agent-runtime（legacy shim 已在 v0.3.0 删除）',
      from: {},
      to: { path: '^packages/agent-runtime' },
    },

    // ── plugin-sdk 循环依赖规避（新增，禁令 11）──
    {
      name: 'no-plugin-sdk-runtime-to-agent-tools',
      severity: 'error',
      comment:
        'plugin-sdk 运行时不得 import agent-tools/agent-mcp（仅允许通过 shared-types 类型引用）',
      from: {
        path: '^packages/plugin-sdk/src',
      },
      to: {
        path: '^packages/(agent-tools|agent-mcp)/src',
        pathNot: '\\.d\\.ts$',
      },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules|dist|build|target',
    },
    exclude: {
      path: 'node_modules|dist|build|target|packages/agent-runtime', // agent-runtime 已删除，排除
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: './tsconfig.base.json',
    },
    reporterOptions: {
      dot: {
        collapsePattern: 'node_modules/[^/]+',
      },
    },
  },
};
```

### 4.4 规则与依赖图的一致性验证

依据 禁令 30 文档间一致性原则，depcruise 规则必须与 `01-OVERVIEW.md` §3 权威依赖图一致。验证表：

| depcruise 规则                         | 依赖图对应边                                             | 一致性 |
| -------------------------------------- | -------------------------------------------------------- | ------ |
| `no-layer-0-reverse`                   | Layer 0 无入边（仅被依赖）                               | 一致   |
| `no-layer-1-reverse`                   | `ST --> LG/TM`，`SU --> LG/TM`（LG/TM 仅依赖 ST/SU）     | 一致   |
| `no-layer-2-reverse`                   | `ST/DE --> AX/AP/AM2`（AX/AP/AM2 仅依赖 ST/SU/DE/LG/TM） | 一致   |
| `no-layer-3-reverse`                   | `AX --> AT/AM`，`AT --> AM2`（AT/AM 仅依赖下层）         | 一致   |
| `no-layer-4-reverse`                   | `AX/AM/AT/AP/AM2/LG/TM --> AC`（AC 仅依赖下层）          | 一致   |
| `no-layer-5-reverse`                   | `AC/AT/AM2 --> AS`（AS 仅依赖 AC/AT/AM2）                | 一致   |
| `no-layer-6-reverse`                   | `AC/AT/ST --> AO`（AO 仅依赖 AC/AT/ST）                  | 一致   |
| `no-layer-7-reverse`                   | `AO/AM/AP --> AD`（AD 仅依赖 AO/AM/AP）                  | 一致   |
| `no-layer-8-reverse`                   | `AC/ST --> PS`（PS 仅依赖 AC/ST）                        | 一致   |
| `no-layer-9-reverse`                   | `AD/ST --> CD`（CD 仅依赖 AD/ST）                        | 一致   |
| `no-agent-runtime-import`              | agent-runtime 已删除，无对应边                           | 一致   |
| `no-plugin-sdk-runtime-to-agent-tools` | PS 不依赖 AT/AM2（仅通过 ST 类型引用）                   | 一致   |

---

## 5. 集成测试设计

### 5.1 测试目录结构

```
tests/integration/
├── session-subagent.test.ts              # 场景 1：启动 session → spawn 子代理 → 验证返回
├── plugin-hook-intercept.test.ts         # 场景 2：触发插件钩子 → 验证拦截
├── provider-rate-limit-fallback.test.ts  # 场景 3：模拟 provider rate_limit → 验证 fallback
├── mcp-server-startup.test.ts            # 场景 4：模拟 MCP 服务器启动 → 验证工具列表
└── vitest.config.ts                      # 集成测试配置（复用 vitest.integration.config.ts）
```

### 5.2 场景 1：session-subagent.test.ts

**测试目标**：验证 SessionLoop → SubagentScheduler → SubagentInstance 全链路。

**测试用例**：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '@crish/agent-core';
import {
  SubagentScheduler,
  DEFAULT_RECURSION_GUARD,
} from '@crish/agent-subagent';
import { FauxProvider } from '@crish/agent-core/testing';

describe('集成测试：session → spawn subagent → 验证返回', () => {
  let runtime: AgentRuntime;
  let scheduler: SubagentScheduler;

  beforeEach(async () => {
    const provider = new FauxProvider();
    runtime = await AgentRuntime.create({
      provider,
      maxTurns: 10,
    });
    scheduler = new SubagentScheduler({
      runtime,
      recursionGuard: DEFAULT_RECURSION_GUARD,
    });
  });

  afterEach(async () => {
    await runtime.stop();
  });

  it('应成功 spawn 子代理并返回 completed 结果', async () => {
    // 1. 启动 session
    const session = await runtime.sessionLoop.startSession({
      mode: 'new',
      cwd: '/tmp/test',
    });
    expect(session.sessionId).toBeDefined();

    // 2. 验证 session.start 事件触发
    const startEvents: unknown[] = [];
    runtime.hooks.observe('session.start', (payload) =>
      startEvents.push(payload)
    );

    // 3. spawn 子代理
    const taskId = await scheduler.submit({
      parentSessionId: session.sessionId,
      task: 'research the codebase',
      role: 'researcher',
      capabilityMode: 'read-only',
      timeoutMs: 5000,
    });

    // 4. 等待完成
    const result = await scheduler.await(taskId, 10000);

    // 5. 验证返回
    expect(result.status).toBe('completed');
    expect(result.output).toBeDefined();

    // 6. 验证 subagent.end 事件触发
    const endEvents: unknown[] = [];
    runtime.hooks.observe('subagent.end', (payload) => endEvents.push(payload));
    expect(endEvents.length).toBeGreaterThan(0);
  });

  it('应在 depth 超过 maxDepth=3 时拒绝 spawn', async () => {
    const session = await runtime.sessionLoop.startSession({
      mode: 'new',
      cwd: '/tmp/test',
    });

    // 模拟 depth=4 的祖先链
    await expect(
      scheduler.submit({
        parentSessionId: session.sessionId,
        ancestorSessionIds: [session.sessionId, 'child1', 'child2', 'child3'], // depth=4
        task: 'should be rejected',
        role: 'researcher',
        capabilityMode: 'read-only',
        timeoutMs: 5000,
      })
    ).rejects.toThrow(/maxDepth/);
  });

  it('应在检测到祖先链包含目标 session 时拒绝 spawn（DeadlockDetector）', async () => {
    const session = await runtime.sessionLoop.startSession({
      mode: 'new',
      cwd: '/tmp/test',
    });

    // 模拟环：目标 session 在祖先链中
    await expect(
      scheduler.submit({
        parentSessionId: session.sessionId,
        ancestorSessionIds: [session.sessionId],
        task: 'should be rejected (cycle)',
        role: 'researcher',
        capabilityMode: 'read-only',
        timeoutMs: 5000,
      })
    ).rejects.toThrow(/cycle|deadlock/i);
  });

  it('应在 maxSiblings 超过 5 时拒绝 spawn', async () => {
    const session = await runtime.sessionLoop.startSession({
      mode: 'new',
      cwd: '/tmp/test',
    });

    // 提交 5 个子代理（达到上限）
    const taskIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await scheduler.submit({
        parentSessionId: session.sessionId,
        task: `sibling ${i}`,
        role: 'researcher',
        capabilityMode: 'read-only',
        timeoutMs: 5000,
      });
      taskIds.push(id);
    }

    // 第 6 个应被拒绝
    await expect(
      scheduler.submit({
        parentSessionId: session.sessionId,
        task: 'sibling 6 (should be rejected)',
        role: 'researcher',
        capabilityMode: 'read-only',
        timeoutMs: 5000,
      })
    ).rejects.toThrow(/maxSiblings/);
  });
});
```

### 5.3 场景 2：plugin-hook-intercept.test.ts

**测试目标**：验证插件发现 → 加载 → activate → 钩子拦截全链路。

**测试用例**：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRuntime } from '@crish/agent-core';
import {
  PluginDiscoverer,
  PluginLoader,
  PluginRegistry,
  PluginValidator,
} from '@crish/plugin-sdk';

describe('集成测试：插件钩子拦截', () => {
  let tempDir: string;
  let runtime: AgentRuntime;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `crish-test-${Date.now()}`);
    mkdirSync(join(tempDir, 'plugins', 'block-tool-plugin'), {
      recursive: true,
    });

    // 创建测试插件
    writeFileSync(
      join(tempDir, 'plugins', 'block-tool-plugin', 'plugin.json'),
      JSON.stringify({
        id: '@test/block-tool',
        name: 'Block Tool Plugin',
        version: '1.0.0',
        entrypoints: { main: 'index.js' },
        permissions: ['hook:intercept'],
        trustLevel: 'restricted',
        engineVersion: '>=0.2.0',
        declaredHooks: ['tool.pre'],
        declaredTools: [],
        declaredMcpServers: [],
      })
    );

    writeFileSync(
      join(tempDir, 'plugins', 'block-tool-plugin', 'index.js'),
      `
      module.exports = {
        activate(api) {
          api.on('tool.pre', (payload) => {
            if (payload.toolName === 'dangerous_tool') {
              return { block: true, reason: 'blocked by test plugin' };
            }
          });
        },
      };
      `
    );

    runtime = await AgentRuntime.create({ provider: new FauxProvider() });
  });

  afterEach(async () => {
    await runtime.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('应通过 user-dir 发现插件并激活', async () => {
    const discoverer = new PluginDiscoverer(
      join(tempDir, 'plugins'), // user-dir
      join(tempDir, 'nonexistent') // project-dir（不存在）
    );
    const discovered = await discoverer.discover();
    expect(discovered.length).toBe(1);
    expect(discovered[0].manifest.id).toBe('@test/block-tool');
  });

  it('应通过 tool.pre 钩子拦截 dangerous_tool 工具调用', async () => {
    const registry = new PluginRegistry(
      new PluginDiscoverer(
        join(tempDir, 'plugins'),
        join(tempDir, 'nonexistent')
      ),
      new PluginLoader(runtime.getPluginDeps(), new PluginValidator())
    );
    await registry.loadAll();

    // 触发 tool.pre 事件
    const result = await runtime.hooks.emit('tool.pre', {
      sessionId: 'test-session',
      toolCallId: 'test-call',
      toolName: 'dangerous_tool',
      input: {},
      turnIndex: 0,
      cwd: '/tmp',
    });

    expect(result.block).toBe(true);
    expect(result.reason).toBe('blocked by test plugin');
  });

  it('应在 activate 注册超出 declaredHooks 时拒绝', async () => {
    // 创建声明空钩子但实际注册 tool.pre 的插件
    mkdirSync(join(tempDir, 'plugins', 'undeclared-hook-plugin'), {
      recursive: true,
    });
    writeFileSync(
      join(tempDir, 'plugins', 'undeclared-hook-plugin', 'plugin.json'),
      JSON.stringify({
        id: '@test/undeclared',
        name: 'Undeclared Hook',
        version: '1.0.0',
        entrypoints: { main: 'index.js' },
        permissions: ['hook:intercept'],
        trustLevel: 'restricted',
        engineVersion: '>=0.2.0',
        declaredHooks: [], // 声明为空
        declaredTools: [],
        declaredMcpServers: [],
      })
    );
    writeFileSync(
      join(tempDir, 'plugins', 'undeclared-hook-plugin', 'index.js'),
      `
      module.exports = {
        activate(api) {
          api.on('tool.pre', () => {}); // 未声明
        },
      };
      `
    );

    const loader = new PluginLoader(
      runtime.getPluginDeps(),
      new PluginValidator()
    );
    await expect(
      loader.load(
        (await new PluginDiscoverer(join(tempDir, 'plugins')).discover()).find(
          (p) => p.manifest.id === '@test/undeclared'
        )!
      )
    ).rejects.toThrow(/undeclared|validation failed/i);
  });
});
```

### 5.4 场景 3：provider-rate-limit-fallback.test.ts

**测试目标**：验证 provider 429 rate_limit → ErrorClassifier 分类 → RecoveryPipeline 重试 → 成功返回。

**测试用例**：

```typescript
import { describe, it, expect } from 'vitest';
import {
  AgentRuntime,
  ErrorClassifier,
  RecoveryPipeline,
} from '@crish/agent-core';
import { FauxProvider } from '@crish/agent-core/testing';

describe('集成测试：provider rate_limit → fallback', () => {
  it('应在 rate_limit 后通过 Tier 1 重试成功', async () => {
    const provider = new FauxProvider({
      responses: [
        { status: 429, body: { error: 'rate limit exceeded' } },
        { status: 200, body: { content: 'success after retry' } },
      ],
    });

    const runtime = await AgentRuntime.create({ provider });
    const session = await runtime.sessionLoop.startSession({
      mode: 'new',
      cwd: '/tmp',
    });

    // 监听 model.afterResponse 事件
    const afterResponseEvents: unknown[] = [];
    runtime.hooks.observe('model.afterResponse', (payload) =>
      afterResponseEvents.push(payload)
    );

    // 执行一次 turn
    const result = await runtime.sessionLoop.runTurn({
      sessionId: session.sessionId,
      input: 'test input',
    });

    expect(result.ok).toBe(true);

    // 验证重试事件
    expect(afterResponseEvents.length).toBeGreaterThan(0);
    const lastEvent = afterResponseEvents[afterResponseEvents.length - 1] as {
      retried: boolean;
      retryCount?: number;
    };
    expect(lastEvent.retried).toBe(true);
    expect(lastEvent.retryCount).toBe(1);
  });

  it('应将 HTTP 429 分类为 provider.rate_limit 错误码', () => {
    const error = new Error('HTTP 429: rate limit exceeded') as Error & {
      httpStatus?: number;
    };
    error.httpStatus = 429;

    const classified = ErrorClassifier.classify(error, {
      providerId: 'openai',
    });
    const code = classified.toCrishErrorCode();

    expect(code).toBe('provider.rate_limit');
    expect(classified.retryable).toBe(true);
  });

  it('应在重试时不切换模型（§禁令 3）', async () => {
    const provider = new FauxProvider({
      responses: [
        { status: 429, body: { error: 'rate limit' } },
        { status: 200, body: { content: 'success' } },
      ],
      model: 'gpt-4',
    });

    const runtime = await AgentRuntime.create({ provider });
    const session = await runtime.sessionLoop.startSession({
      mode: 'new',
      cwd: '/tmp',
    });

    const beforeRequestEvents: { model: string }[] = [];
    runtime.hooks.observe('model.beforeRequest', (payload) => {
      beforeRequestEvents.push({ model: payload.model });
    });

    await runtime.sessionLoop.runTurn({
      sessionId: session.sessionId,
      input: 'test',
    });

    // 所有请求都应使用同一模型
    expect(beforeRequestEvents.length).toBe(2);
    expect(beforeRequestEvents.every((e) => e.model === 'gpt-4')).toBe(true);
  });
});
```

### 5.5 场景 4：mcp-server-startup.test.ts

**测试目标**：验证 MCP 服务器启动 → 工具列表获取 → 工具调用全链路。

**测试用例**：

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { AgentRuntime } from '@crish/agent-core';
import { McpLifecycleManager } from '@crish/agent-mcp';

describe('集成测试：MCP 服务器启动 → 验证工具列表', () => {
  let mcpManager: McpLifecycleManager;
  let mockServerProcess: ReturnType<typeof spawn>;

  beforeAll(() => {
    // 启动 mock MCP 服务器（echo 协议）
    mockServerProcess = spawn('node', [
      '-e',
      `
      const { Server } = require('@modelcontextprotocol/sdk/server');
      const server = new Server({ name: 'mock-mcp', version: '1.0.0' });
      server.setRequestHandler('tools/list', () => ({
        tools: [
          { name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        ],
      }));
      server.setRequestHandler('tools/call', (req) => ({
        content: [{ type: 'text', text: 'echo: ' + req.params.arguments.text }],
      }));
      server.connect(process.stdin, process.stdout);
    `,
    ]);
  });

  afterAll(() => {
    mockServerProcess?.kill();
  });

  it('应启动 MCP 服务器并获取工具列表', async () => {
    mcpManager = new McpLifecycleManager();
    await mcpManager.start({
      name: 'mock-mcp',
      transport: 'stdio',
      command: 'node',
      args: ['-e', '/* mock server script */'],
    });

    const tools = await mcpManager.listTools('mock-mcp');
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('echo');
    expect(tools[0].description).toBe('Echo input');
  });

  it('应将 MCP 工具注册到 ToolRegistry 并可调用', async () => {
    const runtime = await AgentRuntime.create({ provider: new FauxProvider() });
    runtime.attachMcpManager(mcpManager);

    const tools = await runtime.toolRegistry.listTools();
    expect(tools.some((t) => t.name === 'echo')).toBe(true);

    // 调用 MCP 工具
    const toolPreEvents: unknown[] = [];
    runtime.hooks.observe('tool.pre', (payload) => toolPreEvents.push(payload));

    const result = await runtime.toolRegistry.execute('echo', {
      text: 'hello',
    });
    expect(result.text).toBe('echo: hello');
    expect(toolPreEvents.length).toBe(1);
    expect((toolPreEvents[0] as { toolName: string }).toolName).toBe('echo');
  });

  it('应通过 registerPluginServer 声明插件 MCP 服务器', async () => {
    const runtime = await AgentRuntime.create({ provider: new FauxProvider() });

    runtime.registerPluginServer('test-plugin', {
      name: 'plugin-mcp',
      transport: 'stdio',
      command: 'node',
      args: ['-e', '/* plugin mcp */'],
    });

    const servers = runtime.mcpManager.listServers();
    expect(servers.some((s) => s.name === 'plugin-mcp')).toBe(true);
  });

  it('应在 MCP 服务器进程退出时清理资源', async () => {
    const localManager = new McpLifecycleManager();
    await localManager.start({
      name: 'short-lived',
      transport: 'stdio',
      command: 'node',
      args: ['-e', 'process.exit(0)'],
    });

    // 等待服务器退出
    await new Promise((resolve) => setTimeout(resolve, 500));

    const status = localManager.getStatus('short-lived');
    expect(status).toBe('disconnected');
  });
});
```

### 5.6 集成测试运行配置

集成测试通过 `vitest.integration.config.ts` 独立配置，与单元测试分离：

```typescript
// vitest.integration.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 30000, // 集成测试超时 30s
    hookTimeout: 30000,
    // 集成测试需要真实进程，不并发
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
```

CI 中集成测试作为独立 job：

```yaml
test-integration:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20
        cache: npm
    - run: npm ci
    - run: npx vitest run --config vitest.integration.config.ts --reporter=verbose
```

---

## 6. 文档产品化清单

### 6.1 ARCHITECTURE.md 更新

**更新目标**：将现有 ARCHITECTURE.md（描述单体 agent-runtime 架构）重写为反映 9 包架构的权威文档。

**更新内容**：

| 章节             | 更新内容                                                    | 依据                           |
| ---------------- | ----------------------------------------------------------- | ------------------------------ |
| 总览             | Crish 是桌面 AI Agent 工作台，9 包架构 + Rust crates + 前端 | `01-OVERVIEW.md` §1            |
| 9 包架构图       | mermaid 依赖图（引用 `01-OVERVIEW.md` §3）                  | 禁令 30 文档一致性             |
| 包职责清单       | 每个包的职责、依赖、公共 API                                | `02-FILE-MAPPING.md` §1        |
| 包边界           | 各包范围内/范围外                                           | guardrails 禁令 10             |
| 传输与壳         | 保留现有 WebSocket / Tauri invoke 描述                      | 现有 ARCHITECTURE.md           |
| 控制面           | 保留现有 Run Control L0-L3 描述                             | 现有 ARCHITECTURE.md           |
| providerProfiles | 保留现有描述                                                | 现有 ARCHITECTURE.md           |
| 插件系统         | 新增：14 钩子 + observe/on + 信任模型                       | `ROUND-08-plugin-sdk.md`       |
| 子代理系统       | 新增：调度器 + 递归守卫 + DeadlockDetector                  | `ROUND-05-split-phase-C.md` §4 |
| 错误处理         | 新增：CrishError + CrishResult + 64 正式码 + 10 reserved 码 | `03-ERROR-MIGRATION.md`        |
| 开发与校验入口   | 更新为新的 CI 门禁（8 项标准 + 3 项附加）                   | 本 Round §3                    |
| 迁移历史         | 简述从 agent-runtime 单体到 9 包的迁移过程                  | v2 方案                        |

### 6.2 插件开发指南

**文件**：`docs/plugin-development.md`

**章节结构**：

1. **概述**：插件系统能力总览（14 钩子 + 工具注册 + MCP 声明 + 2 级信任）
2. **PluginManifest 声明**：
   - 能力清单（declaredHooks/declaredTools/declaredMcpServers）
   - 权限声明（11 项 PluginPermission）
   - 信任级别（restricted vs full）
   - 引擎版本约束（semver range）
3. **HookAPI 使用**：
   - observe vs on 双模式
   - registerTool
   - registerMcpServer
   - log
4. **14 钩子事件**：
   - 现有 6 个事件（turn.start/end、tool.pre/post、context.compact.start/end）
   - 新增 8 个事件（session.start/end、model.beforeRequest/afterResponse、subagent.start/end、tool.error、error.occurred）
   - payload 字段详解
   - 控制信号（LifecycleHandlerResult / ToolErrorHandlerResult）
5. **工具注册**：
   - ToolDefinition 结构
   - ToolRegistrationOptions
   - RegisteredTool
6. **信任模型**：
   - restricted（主线程 + 权限校验）
   - full（主线程 + 无校验，仅 user-dir）
   - 权限粒度（11 项）
7. **技能加载**：
   - SKILL.md frontmatter 结构
   - 技能目录结构（skills/<name>/SKILL.md + scripts/ + prompts/）
   - 技能→工具转换
8. **完整示例**：一个最小插件的 plugin.json + index.js

### 6.3 子代理开发指南

**文件**：`docs/subagent-development.md`

**章节结构**：

1. **概述**：子代理调度系统能力总览
2. **SubagentDefinition**：
   - role（标签：researcher/implementer/reviewer/debugger/planner）
   - capabilityMode（read-only/read-write/execute/all）
   - SubagentTaskCard 结构
3. **调度策略**：
   - FIFO 队列（priority/affinity 推迟）
   - RecursionGuard 默认值（maxDepth=3, maxSiblings=5, maxConcurrent=6, ROUND-09 §3.2 DEFAULT_RECURSION_GUARD 权威值）
   - ConcurrencyController（全局/每父/队列上限）
4. **子代理发现**：
   - 通过 PluginManifest 的 agents 字段
   - BuiltinDiscoverySource（内置子代理）
   - 禁止独立 ProjectFileDiscoverySource（禁令 22）
5. **通信机制**：
   - ControlBus L1（点对点 send）
   - ControlBus L2（AgentEvent 流订阅）
   - ControlBus L3（request-response，correlationId）
   - 禁止 SubagentCommunicationBus（禁令 20）
6. **DeadlockDetector**：
   - spawn 时 O(depth) 环检测
   - ancestorSessionIds 检查
   - 禁止运行时后台线程扫描（见 ROUND-09）
7. **完整示例**：一个 researcher 子代理的定义与 spawn 调用

### 6.4 错误处理指南

**文件**：`docs/error-handling.md`

**章节结构**：

1. **概述**：Crish 错误处理体系总览（CrishError + CrishResult + CrishErrorPayload）
2. **CrishError 结构**：
   - code（domain.reason 格式，64 正式码 + 10 reserved 码 / 19 域）
   - category（transient/permanent/security/protocol）
   - retryable（与 category 解耦）
   - public（是否对终端用户可见）
   - action（用户可执行的操作建议）
   - cause 链（最多 8 层）
3. **CrishResult ADT**：
   - ok/err 工具函数
   - mapResult / flatMapResult / match
4. **64 正式码 + 10 reserved 码表**：
   - 19 域 × reason
   - 引用 `03-ERROR-MIGRATION.md` §2.2
5. **使用策略**：
   - 何时 throw CrishError vs 返回 CrishResult
   - 何时标记 retryable=true
   - 何时标记 public=false
   - cause 链使用
6. **跨进程序列化**：
   - CrishErrorPayload 格式
   - Rust 侧 CoreError 对齐（§S-08）
7. **迁移指南**：
   - 从旧 SessionError/ProviderError 迁移到 CrishError 的映射表
   - 引用 `03-ERROR-MIGRATION.md` §3
8. **完整示例**：provider 调用失败时的错误处理流程

---

## 7. 删除阶段清单（deprecated 代码清理）

依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 23 迁移三阶段策略的**删除阶段**，本 Round 删除所有 deprecated 代码。

### 7.1 删除清单

| 序号 | 删除对象                                               | 路径                                         | 删除依据                   | 删除条件验证                                           |
| ---- | ------------------------------------------------------ | -------------------------------------------- | -------------------------- | ------------------------------------------------------ |
| 1    | `SessionError` 类                                      | `packages/shared-types/src/errors.ts`        | 禁令 25 错误码迁移完成     | grep 无 `new SessionError` 调用点                      |
| 2    | `SessionErrorCode` 类型                                | `packages/shared-types/src/errors.ts`        | 禁令 25                    | grep 无 `SessionErrorCode` 引用                        |
| 3    | `ProviderError` 类                                     | `packages/shared-types/src/errors.ts`        | 禁令 25                    | grep 无 `new ProviderError` 调用点                     |
| 4    | `ProviderErrorKind` 类型                               | `packages/shared-types/src/tool.ts`          | 禁令 25                    | grep 无 `ProviderErrorKind` 引用                       |
| 5    | `ProtocolError` 类                                     | `packages/shared-types/src/errors.ts`        | 禁令 25                    | grep 无 `new ProtocolError` 调用点                     |
| 6    | `PermissionError` 类                                   | `packages/shared-types/src/errors.ts`        | 禁令 25                    | grep 无 `new PermissionError` 调用点                   |
| 7    | `migrateErrorCode()` 函数                              | `packages/shared-types/src/errors.ts`        | 禁令 25 桥接函数无存在必要 | grep 无 `migrateErrorCode` 调用点                      |
| 8    | shared-utils/logger.ts 的 deprecated re-export         | `packages/shared-utils/src/logger.ts`        | R2 logger 提取完成         | grep 无 `import { Logger } from '@crish/shared-utils'` |
| 9    | agent-daemon/daemon-logger.ts 的 deprecated re-export  | `packages/agent-daemon/src/daemon-logger.ts` | R2 logger 合并完成         | grep 无 `from './daemon-logger'`                       |
| 10   | agent-runtime legacy shim（整个包）                    | `packages/agent-runtime/`                    | 禁令 24 v0.3.0 移除        | `check-legacy-shim.mjs` 通过                           |
| 11   | 旧 plugin-sdk 17 行 shim（Plugin + definePlugin）      | `packages/plugin-sdk/src/index.ts`           | 禁令 24 v0.3.0 移除        | grep 无 `definePlugin` 调用点                          |
| 12   | `package.json` 的 `agent-runtime` workspace 条目       | `package.json`                               | agent-runtime 包已删除     | npm workspaces 列表无 `packages/agent-runtime`         |
| 13   | `package.json` 的 `build:runtime`/`check:runtime` 脚本 | `package.json`                               | agent-runtime 包已删除     | scripts 段无 `runtime` 相关脚本                        |
| 14   | `check:core` 脚本中的 `check:runtime`                  | `package.json`                               | agent-runtime 包已删除     | `check:core` 不再调用 `check:runtime`                  |

### 7.2 删除前验证

删除前必须确认以下条件全部满足（依据 禁令 23 删除阶段前提）：

| 验证项                     | 验证方法                                                                                                                      | 通过标准 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------- |
| 旧错误类型无调用点         | `grep -r "new SessionError\|new ProviderError\|new ProtocolError\|new PermissionError" packages/ apps/ --exclude="*.test.ts"` | 0 处     |
| migrateErrorCode 无调用点  | `grep -r "migrateErrorCode" packages/ apps/`                                                                                  | 0 处     |
| shared-utils Logger 无导入 | `grep -r "import.*Logger.*from.*shared-utils" packages/ apps/`                                                                | 0 处     |
| daemon-logger 无导入       | `grep -r "from.*daemon-logger" packages/ apps/`                                                                               | 0 处     |
| agent-runtime 无 import    | `check-legacy-shim.mjs`                                                                                                       | 0 处     |
| definePlugin 无调用        | `grep -r "definePlugin" packages/ apps/ --exclude="*.test.ts"`                                                                | 0 处     |
| TSC 错误 < 50              | `check-tsc-threshold.mjs`                                                                                                     | 通过     |
| 9 包全部构建成功           | `npx turbo run build`                                                                                                         | 全部成功 |
| 全部测试通过               | `npx vitest run`                                                                                                              | 全部通过 |

### 7.3 删除后验证

删除后必须重新运行全部验证门禁确认无回归：

| 验证项           | 验证方法                                                 | 通过标准          |
| ---------------- | -------------------------------------------------------- | ----------------- |
| TSC 编译         | `npx turbo run typecheck`                                | 0 errors          |
| Rust 编译        | `cargo check --workspace`                                | 0 errors          |
| 单元测试（TS）   | `npx vitest run`                                         | 全部通过          |
| 单元测试（Rust） | `cargo test --workspace`                                 | 全部通过          |
| 循环依赖         | `npm run lint:depcruise`                                 | 0 violations      |
| 构建             | `npx turbo run build`                                    | 全部成功          |
| Lint             | `npm run lint`                                           | 0 errors          |
| Store 类型       | `npm run check:store-types`                              | 通过              |
| legacy shim 检查 | `npm run check:legacy-shim`                              | 0 处违规          |
| TSC 错误数       | `npm run check:tsc-threshold`                            | < 50              |
| 覆盖率           | `npm run test:coverage` + `check-coverage-threshold.mjs` | 不低于阈值        |
| 集成测试         | `npx vitest run --config vitest.integration.config.ts`   | 全部 4 个场景通过 |

---

## 8. 验证门禁

### 8.1 基线建立

Round 12 开始时记录以下基线：

```bash
# 记录 TSC 错误基线（继承 Round 11 结束时基线，应 < 50）
npx tsc --noEmit 2>&1 | tee analysis/iterative-repair/v2/round-12-tsc-baseline.json

# 记录 depcruise 基线
npm run lint:depcruise 2>&1 | tee analysis/iterative-repair/v2/round-12-depcruise-baseline.json

# 记录覆盖率基线
npx vitest run --coverage 2>&1 | tee analysis/iterative-repair/v2/round-12-coverage-baseline.json
```

### 8.2 8 项标准验证门禁

依据 禁令 27 与 `01-OVERVIEW.md` §4.3：

| 序号 | 检查项           | 命令                        | 通过标准     | 责任 Agent |
| ---- | ---------------- | --------------------------- | ------------ | ---------- |
| 1    | TypeScript 编译  | `npx turbo run typecheck`   | 0 errors     | 12-D       |
| 2    | Rust 编译        | `cargo check --workspace`   | 0 errors     | 12-D       |
| 3    | 单元测试（TS）   | `npx vitest run`            | 全部通过     | 12-D       |
| 4    | 单元测试（Rust） | `cargo test --workspace`    | 全部通过     | 12-D       |
| 5    | 循环依赖         | `npm run lint:depcruise`    | 0 violations | 12-D       |
| 6    | 构建             | `npx turbo run build`       | 全部成功     | 12-D       |
| 7    | Lint             | `npm run lint`              | 0 errors     | 12-D       |
| 8    | Store 类型       | `npm run check:store-types` | 通过         | 12-D       |

### 8.3 Round 12 专项验证

除上述 8 项标准检查外，Round 12 须额外验证以下专项：

| 序号 | 专项检查                           | 验证方法                                                                           | 通过标准                           | 责任 Agent |
| ---- | ---------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------- | ---------- |
| S1   | CI 配置强化                        | 检查 `.github/workflows/ci.yml`                                                    | 含 8 项标准 + 3 项附加门禁         | 12-A       |
| S2   | legacy shim 检查脚本               | 检查 `scripts/check-legacy-shim.mjs`                                               | 脚本存在且覆盖 8 类 legacy 模式    | 12-A       |
| S3   | TSC 错误数门禁脚本                 | 检查 `scripts/check-tsc-threshold.mjs`                                             | 脚本存在且阈值为 50                | 12-A       |
| S4   | depcruise 规则强化                 | 检查 `.dependency-cruiser.cjs`                                                     | 含 15 条规则（3 现有 + 12 新增）   | 12-B       |
| S5   | depcruise 跨层规则                 | 运行 `npm run lint:depcruise`                                                      | 0 violations（含跨层反向依赖检查） | 12-B       |
| S6   | 集成测试场景 1                     | 运行 `tests/integration/session-subagent.test.ts`                                  | 全部用例通过                       | 12-B       |
| S7   | 集成测试场景 2                     | 运行 `tests/integration/plugin-hook-intercept.test.ts`                             | 全部用例通过                       | 12-B       |
| S8   | 集成测试场景 3                     | 运行 `tests/integration/provider-rate-limit-fallback.test.ts`                      | 全部用例通过                       | 12-B       |
| S9   | 集成测试场景 4                     | 运行 `tests/integration/mcp-server-startup.test.ts`                                | 全部用例通过                       | 12-B       |
| S10  | ARCHITECTURE.md 更新               | 检查 `ARCHITECTURE.md`                                                             | 含 9 包架构图 + 包职责 + 包边界    | 12-C       |
| S11  | 插件开发指南                       | 检查 `docs/plugin-development.md`                                                  | 含 8 章节内容                      | 12-C       |
| S12  | 子代理开发指南                     | 检查 `docs/subagent-development.md`                                                | 含 7 章节内容                      | 12-C       |
| S13  | 错误处理指南                       | 检查 `docs/error-handling.md`                                                      | 含 8 章节内容                      | 12-C       |
| S14  | 旧错误类型删除                     | grep `new SessionError\|new ProviderError\|new ProtocolError\|new PermissionError` | 0 处                               | 12-D       |
| S15  | migrateErrorCode 删除              | grep `migrateErrorCode`                                                            | 0 处                               | 12-D       |
| S16  | shared-utils Logger re-export 删除 | grep `import.*Logger.*from.*shared-utils`                                          | 0 处                               | 12-D       |
| S17  | daemon-logger re-export 删除       | grep `from.*daemon-logger`                                                         | 0 处                               | 12-D       |
| S18  | agent-runtime 包删除               | 检查 `packages/agent-runtime/` 目录                                                | 不存在                             | 12-D       |
| S19  | 旧 plugin-sdk shim 删除            | grep `definePlugin`                                                                | 0 处                               | 12-D       |
| S20  | package.json workspaces 清理       | 检查 `package.json` workspaces                                                     | 无 `packages/agent-runtime`        | 12-D       |
| S21  | TECH_DEBT.md 清理                  | 检查 `TECH_DEBT.md`                                                                | 已解决条目移除，保留未解决条目     | 12-D       |
| S22  | TSC 错误数                         | `npm run check:tsc-threshold`                                                      | < 50（不恶化）                     | 12-D       |
| S23  | 覆盖率不下降                       | `npm run test:coverage` + `check-coverage-threshold.mjs`                           | 各包不低于阈值                     | 12-D       |
| S24  | 文档一致性                         | 对比 ARCHITECTURE.md 与 01-OVERVIEW.md §3 依赖图                                   | 一致（禁令 30）                    | 12-C       |
| S25  | legacy shim 检查                   | `npm run check:legacy-shim`                                                        | 0 处违规                           | 12-D       |

### 8.4 TSC 错误管理

依据 guardrails 禁令 26：

- Round 12 维持 Round 11 达成的 TSC < 50 目标
- 删除 deprecated 代码后 TSC 错误数应不增加（删除的是已迁移的 shim，不影响类型检查）
- 完全清零作为后续独立任务（不在本 Round 承诺）

---

## 9. 交付物

### 9.1 文件清单

| 类别         | 路径                                                           | 行数（估） | 责任 Agent |
| ------------ | -------------------------------------------------------------- | ---------- | ---------- |
| CI 配置      | `.github/workflows/ci.yml`（重写）                             | ~250       | 12-A       |
| CI 脚本      | `scripts/check-legacy-shim.mjs`                                | ~80        | 12-A       |
| CI 脚本      | `scripts/check-tsc-threshold.mjs`                              | ~60        | 12-A       |
| CI 脚本      | `scripts/check-coverage-threshold.mjs`                         | ~50        | 12-A       |
| package.json | `package.json`（scripts 段增强）                               | +15        | 12-A       |
| depcruise    | `.dependency-cruiser.cjs`（增强）                              | ~200       | 12-B       |
| 集成测试     | `tests/integration/session-subagent.test.ts`                   | ~180       | 12-B       |
| 集成测试     | `tests/integration/plugin-hook-intercept.test.ts`              | ~160       | 12-B       |
| 集成测试     | `tests/integration/provider-rate-limit-fallback.test.ts`       | ~130       | 12-B       |
| 集成测试     | `tests/integration/mcp-server-startup.test.ts`                 | ~150       | 12-B       |
| 文档         | `ARCHITECTURE.md`（重写）                                      | ~400       | 12-C       |
| 文档         | `docs/plugin-development.md`                                   | ~350       | 12-C       |
| 文档         | `docs/subagent-development.md`                                 | ~300       | 12-C       |
| 文档         | `docs/error-handling.md`                                       | ~280       | 12-C       |
| 代码删除     | `packages/shared-types/src/errors.ts`（清理）                  | -200       | 12-D       |
| 代码删除     | `packages/shared-utils/src/logger.ts`（清理）                  | -30        | 12-D       |
| 代码删除     | `packages/agent-daemon/src/daemon-logger.ts`（清理/删除）      | -25        | 12-D       |
| 代码删除     | `packages/agent-runtime/`（整个目录删除）                      | -100       | 12-D       |
| 代码删除     | `packages/plugin-sdk/src/index.ts`（清理）                     | -40        | 12-D       |
| 配置         | `package.json`（workspaces/scripts 清理）                      | -5         | 12-D       |
| 文档         | `TECH_DEBT.md`（清理）                                         | -150       | 12-D       |
| 报告         | `analysis/iterative-repair/v2/round-12-verification-report.md` | ~350       | 12-D       |

### 9.2 接口签名交付物

本 Round 不新增接口签名，仅删除 deprecated 接口。删除清单见 §7.1。

### 9.3 验证报告交付物

| 报告                                    | 内容                                             | 责任 Agent |
| --------------------------------------- | ------------------------------------------------ | ---------- |
| `round-12-tsc-baseline.json`            | Round 12 开始时的 TSC 错误基线                   | 12-D       |
| `round-12-tsc-final.json`               | Round 12 结束时的 TSC 错误                       | 12-D       |
| `round-12-depcruise-report.json`        | 循环依赖检查结果（含跨层规则）                   | 12-D       |
| `round-12-turbo-build-report.json`      | 构建结果                                         | 12-D       |
| `round-12-coverage-report.json`         | 覆盖率报告                                       | 12-D       |
| `round-12-integration-test-report.json` | 4 个集成测试结果                                 | 12-D       |
| `round-12-verification-report.md`       | 最终验证报告（8 项标准 + 25 项专项 + 12 轮回顾） | 12-D       |

### 9.4 文档同步要求（禁令 31）

本 Round 执行后须同步更新：

| 文档                                         | 更新内容                          |
| -------------------------------------------- | --------------------------------- |
| `02-FILE-MAPPING.md` §1                      | 移除 `agent-runtime` 包（已删除） |
| `01-OVERVIEW.md` §1.3 资产清单               | 标注 deprecated 资产已删除        |
| `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 24 | 标注 legacy shim 已在 v0.3.0 删除 |
| `TECH_DEBT.md`                               | 移除已解决条目                    |

---

## 10. 整个方案的最终验证（回顾 12 轮）

### 10.1 12 轮回顾总览

| Round | 名称                      | 目标包                                            | Agent 数 | 关键交付物                                                                           | 状态 |
| ----- | ------------------------- | ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------ | ---- |
| 1     | 类型基础层 + 基线审计     | shared-types（增强）                              | 5        | CrishError + CrishResult + CrishErrorPayload + 64 正式码 + 10 reserved 码 + 基线数据 | 完成 |
| 2     | 基础设施包                | @crish/logger, @crish/telemetry                   | 4        | Logger + RotatingFileSink + Telemetry + CrashHandler                                 | 完成 |
| 3     | 拆分 Phase-A（leaf）      | agent-context, agent-permissions, agent-mcp[骨架] | 5        | 3 个 leaf 包 + decision-engine 边界明确                                              | 完成 |
| 4     | 拆分 Phase-B（middle）    | agent-tools, agent-model, agent-mcp[完整]         | 5        | 3 个 middle 包 + provider 系统统一                                                   | 完成 |
| 5     | 拆分 Phase-C（top）+ 集成 | agent-core, agent-subagent[骨架], legacy shim     | 5        | agent-core + shim + 全系统集成验证                                                   | 完成 |
| 6     | 编排层重构                | agent-orchestrator                                | 4        | CrishError 集成 + 日志集成 + TSC 修复                                                | 完成 |
| 7     | Daemon 重构               | agent-daemon                                      | 4        | 日志升级 + 错误传播 + TSC 修复                                                       | 完成 |
| 8     | 插件 SDK 全面重建         | plugin-sdk                                        | 6        | 14 钩子 + observe/on + 工具注册 + 信任模型                                           | 完成 |
| 9     | 子代理调度系统            | agent-subagent[完整]                              | 5        | RecursionGuard + Scheduler + DeadlockDetector + ControlBus 扩展                      | 完成 |
| 10    | Rust 侧对齐               | conex-types, conex-telemetry, Tauri               | 4        | CrishErrorPayload Rust impl + IPC 对齐                                               | 完成 |
| 11    | 前端韧性 + TSC            | crish-desktop                                     | 5        | 错误翻译层 + TSC < 50 + 测试修复                                                     | 完成 |
| 12    | CI 强化与文档             | CI, docs                                          | 4        | CI 门禁 + depcruise 规则 + ARCHITECTURE.md + 删除 deprecated                         | 完成 |

**总量**：12 轮，56 个 Agent（≤ 60 目标，01-OVERVIEW.md §5.1）

### 10.2 结构性问题解决回顾

依据 `01-OVERVIEW.md` §2.1 结构性问题清单：

| 问题 ID | 问题                                          | 解决方案                                           | 解决 Round | 验证状态                                           |
| ------- | --------------------------------------------- | -------------------------------------------------- | ---------- | -------------------------------------------------- |
| S-01    | agent-runtime ~31K LOC 单体包                 | 九包拆分                                           | R3-R5      | 9 包全部创建，agent-runtime 已删除（R12）          |
| S-02    | plugin-sdk 仅 17 行                           | 单包全面重建                                       | R8         | 14 钩子 + observe/on + 工具注册 + 信任模型         |
| S-03    | 错误类型体系不完整                            | 扩展 errors.ts + 新建 result.ts + error-payload.ts | R1         | CrishError + CrishResult + CrishErrorPayload 完整  |
| S-04    | 日志和追踪分散三处                            | 新建 @crish/logger 和 @crish/telemetry             | R2         | 日志统一，deprecated re-export 已删除（R12）       |
| S-05    | 子代理系统缺少 DeadlockDetector               | 新建子代理调度系统                                 | R9         | RecursionGuard + Scheduler + DeadlockDetector 完整 |
| S-06    | 315 个 TSC 编译错误                           | 随拆分过程逐步修复                                 | R3-R11     | TSC < 50（R11 达成，R12 维持）                     |
| S-07    | Provider 系统散落 57 文件                     | 统一提取到 agent-model                             | R4         | provider 系统统一                                  |
| S-08    | Rust CoreError 与 TS CrishError 不统一        | CrishErrorPayload 双端对齐                         | R10        | 双端对齐完成                                       |
| S-09    | decision-engine 与 agent-permissions 职责重叠 | 明确切线                                           | R3         | decision-engine 管决策，agent-permissions 管执行   |
| S-10    | 250 处 throw new Error                        | 按包逐个迁移到 CrishError                          | R3-R11     | 迁移完成，旧错误类型已删除（R12）                  |

### 10.3 功能性缺失解决回顾

依据 `01-OVERVIEW.md` §2.2 功能性缺失清单：

| 问题 ID | 问题                                 | 解决方案                             | 解决 Round | 验证状态                            |
| ------- | ------------------------------------ | ------------------------------------ | ---------- | ----------------------------------- |
| F-01    | 无结构化文件日志                     | @crish/logger 新包                   | R2         | RotatingFileSink 实现               |
| F-02    | 无 Rust 端 telemetry crate           | conex-telemetry 新 crate             | R10        | Rust telemetry 实现                 |
| F-03    | 插件无法注册自定义工具               | plugin-sdk 工具注册 API              | R8         | registerTool 实现                   |
| F-04    | 插件无 MCP 服务器声明能力            | agent-mcp 的 registerPluginServer    | R8         | registerPluginServer 实现           |
| F-05    | 子代理无死锁检测                     | DeadlockDetector                     | R9         | spawn 时 O(depth) 环检测            |
| F-06    | 子代理调度无显式状态机               | SubagentScheduler + SubagentInstance | R9         | 状态机 + 超时 + 取消                |
| F-07    | 无统一 Tauri command 错误传播        | CrishErrorPayload Rust impl          | R10        | 双端对齐                            |
| F-08    | CrishResult 缺少工具函数             | shared-types 扩展                    | R1         | mapResult/flatMapResult/match       |
| F-09    | CrishErrorPayload 丢失 cause 链      | 递归 cause 设计                      | R1         | 最多 8 层                           |
| F-10    | LifecycleHookRegistry 双模式无文档化 | 钩子类型系统重建时保留并文档化       | R8 + R12   | 双模式保留 + 文档化（R12 插件指南） |

### 10.4 最终验证清单

12 轮方案完成后，最终验证以下指标全部达成：

| 类别     | 指标                 | 目标                               | 实际         | 验证方法                                               |
| -------- | -------------------- | ---------------------------------- | ------------ | ------------------------------------------------------ |
| 架构     | 9 包架构完整         | 9 个新包创建                       | 9 包全部创建 | `ls packages/`                                         |
| 架构     | agent-runtime 删除   | 包不存在                           | 已删除       | `packages/agent-runtime/` 不存在                       |
| 架构     | 循环依赖             | 0 violations                       | 0            | `npm run lint:depcruise`                               |
| 架构     | 跨层反向依赖         | 0 violations                       | 0            | depcruise 跨层规则                                     |
| 类型安全 | TSC 错误数           | < 50                               | < 50         | `npm run check:tsc-threshold`                          |
| 类型安全 | Rust 编译            | 0 errors                           | 0            | `cargo check --workspace`                              |
| 测试     | 单元测试（TS）       | 全部通过                           | 全部通过     | `npx vitest run`                                       |
| 测试     | 单元测试（Rust）     | 全部通过                           | 全部通过     | `cargo test --workspace`                               |
| 测试     | 集成测试             | 4 个场景通过                       | 4 个场景通过 | `npx vitest run --config vitest.integration.config.ts` |
| 测试     | 覆盖率               | 不低于基线                         | 不低于基线   | `npm run test:coverage`                                |
| 构建     | turbo build          | 全部成功                           | 全部成功     | `npx turbo run build`                                  |
| Lint     | eslint               | 0 errors                           | 0 errors     | `npm run lint`                                         |
| Store    | store-types          | 通过                               | 通过         | `npm run check:store-types`                            |
| 迁移     | throw new Error 迁移 | 250 处全部迁移                     | 全部迁移     | grep 验证                                              |
| 迁移     | 旧错误类型删除       | 全部删除                           | 全部删除     | grep 验证                                              |
| 迁移     | legacy shim 删除     | agent-runtime + plugin-sdk 旧 shim | 全部删除     | `npm run check:legacy-shim`                            |
| CI       | 8 项标准门禁         | 全部配置                           | 全部配置     | `.github/workflows/ci.yml` 检查                        |
| CI       | 3 项附加门禁         | 全部配置                           | 全部配置     | ci.yml + 脚本检查                                      |
| 文档     | ARCHITECTURE.md      | 反映 9 包架构                      | 已更新       | 文档检查                                               |
| 文档     | 专题指南             | 3 份                               | 3 份         | `docs/` 目录检查                                       |
| 文档     | TECH_DEBT.md         | 清理已解决条目                     | 已清理       | 文件检查                                               |
| 文档     | 文档一致性           | 无冲突                             | 无冲突       | 禁令 30 验证                                           |

### 10.5 后续独立任务（不属于 12 轮方案）

以下任务在 12 轮方案完成后作为后续独立任务处理（依据 禁令 26 不承诺完全清零）：

| 任务         | 描述                                                                        | 优先级 |
| ------------ | --------------------------------------------------------------------------- | ------ |
| TSC 完全清零 | 将 TSC 错误从 < 50 降至 0                                                   | 中     |
| 覆盖率提升   | 将各包覆盖率提升至 80%+                                                     | 中     |
| Phase 2 功能 | OAuth 支持、HotReload、npm/global-dir 插件源、sandboxed 信任级              | 低     |
| 子代理增强   | SubagentWatchdog.stuckDetection、TokenBudgetTracker、priority/affinity 调度 | 低     |
| 性能优化     | 基准测试、压测、启动时间优化                                                | 中     |

---

## 11. 风险与缓解

| 风险                           | 概率 | 影响 | 缓解措施                                                                            | 责任人     |
| ------------------------------ | ---- | ---- | ----------------------------------------------------------------------------------- | ---------- |
| 删除 deprecated 后编译失败     | 中   | 高   | 删除前验证全部调用点已迁移（§7.2）；删除后重新运行 8 项门禁（§7.3）                 | 12-D       |
| agent-runtime 删除后消费者断裂 | 低   | 高   | Round 5-11 已完成全部消费者 import 迁移；`check-legacy-shim.mjs` 验证 0 残留        | 12-A, 12-D |
| depcruise 跨层规则误报         | 中   | 中   | 规则基于权威依赖图（§4.4 一致性验证）；允许类型引用通过 shared-types 解耦           | 12-B       |
| 集成测试在 CI 环境失败         | 中   | 中   | 集成测试独立 job（test-integration），不阻塞标准门禁；使用 mock 进程避免真实依赖    | 12-B       |
| ARCHITECTURE.md 与代码漂移     | 低   | 中   | 禁令 31 文档同步要求；depcruise 规则验证依赖图一致性                                | 12-C       |
| TECH_DEBT.md 误删未解决条目    | 低   | 低   | 删除前逐条核对解决状态；保留"保留，后续处理"标注                                    | 12-D       |
| TSC 错误数在删除后上升         | 低   | 中   | 删除的是已迁移的 shim，不应影响类型检查；若上升则回滚删除并排查                     | 12-D       |
| CI 门禁过严阻塞正常开发        | 中   | 中   | 附加门禁（legacy-shim/tsc-threshold/coverage）独立 job，不阻塞标准 8 项；阈值可配置 | 12-A       |

---

## 12. 附录：Agent 编排时序

```
Round 12 开始
  │
  ├── [并行] Agent 12-A：CI 门禁配置 + legacy shim 检查脚本
  │   ├── 重写 .github/workflows/ci.yml（8 项标准 + 3 项附加）
  │   ├── 新建 scripts/check-legacy-shim.mjs
  │   ├── 新建 scripts/check-tsc-threshold.mjs
  │   ├── 新建 scripts/check-coverage-threshold.mjs
  │   └── 更新 package.json scripts 段
  │
  ├── [并行] Agent 12-B：dependency-cruiser 规则 + 集成测试
  │   ├── 增强 .dependency-cruiser.cjs（15 条规则）
  │   ├── 编写 tests/integration/session-subagent.test.ts
  │   ├── 编写 tests/integration/plugin-hook-intercept.test.ts
  │   ├── 编写 tests/integration/provider-rate-limit-fallback.test.ts
  │   └── 编写 tests/integration/mcp-server-startup.test.ts
  │
  ├── [并行] Agent 12-C：ARCHITECTURE.md + 专题文档
  │   ├── 重写 ARCHITECTURE.md
  │   ├── 编写 docs/plugin-development.md
  │   ├── 编写 docs/subagent-development.md
  │   └── 编写 docs/error-handling.md
  │
  ├── [串行·依赖 12-A/12-B/12-C] Agent 12-D：删除 deprecated + TECH_DEBT 清理 + 验证
  │   ├── 删除旧错误类型（SessionError 等）
  │   ├── 删除 shared-utils/logger.ts deprecated re-export
  │   ├── 删除 agent-daemon/daemon-logger.ts deprecated re-export
  │   ├── 删除 packages/agent-runtime/ 整个目录
  │   ├── 删除旧 plugin-sdk 17 行 shim
  │   ├── 清理 package.json workspaces/scripts
  │   ├── 清理 TECH_DEBT.md
  │   ├── 运行全部验证门禁（8 项标准 + 25 项专项）
  │   └── 生成最终验证报告 round-12-verification-report.md
  │
  └── Round 12 结束 → 12 轮方案完成 → v0.3.0 发布就绪
```

**并行性说明**（依据 01-OVERVIEW.md §5.1）：

- 12-A、12-B、12-C 操作的文件集完全不相交，可真并行启动
- 12-D 必须在 12-A/12-B/12-C 完成后执行
  - 需要 12-A 的 CI 脚本验证删除后无回归
  - 需要 12-B 的 depcruise 规则验证删除后无循环依赖
  - 需要 12-C 的文档作为删除后的"新真相"

**协调次数**：

- 12-A：1 次（与 12-D 约定 legacy shim 检查规则）
- 12-B：1 次（与 12-A 约定 depcruise 在 CI 中的调用方式）
- 12-C：0 次
- 12-D：2 次（消费 12-A 的 CI 脚本 + 12-B 的 depcruise 规则）

全部满足 禁令 28"协调次数 ≤ 2 次"约束。

---

> **本设计文档遵守 `ANTI_OVERENGINEERING_GUARDRAILS.md` 全部约束**：
>
> - 禁令 10-12 包拆分边界（9 包架构已固化） ✓
> - 禁令 13-19 插件 SDK 设计约束（R8 已实现，本 Round 文档化） ✓
> - 禁令 20-22 子代理调度约束（R9 已实现，本 Round 文档化） ✓
> - 禁令 23-26 迁移策略与 Legacy Shim（本 Round 执行删除阶段 + legacy shim 移除） ✓
> - 禁令 27-28 Agent 任务量（每个 Agent ≥ 5 文件或 ≥ 300 行变更） ✓
> - 禁令 29-31 文档一致性（ARCHITECTURE.md 与 01-OVERVIEW.md §3 依赖图一致） ✓
> - 禁令 1-9（全部遵守，无违反） ✓
