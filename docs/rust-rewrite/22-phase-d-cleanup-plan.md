# 22. Phase D 清场盘点：TS 旧 agent 包删除计划

> 状态：盘点完成（Round 19 A2 产出；只读盘点 + 本计划，未删除任何代码）
> 关联：`docs/rust-rewrite/00-master-plan.md` §2 Phase D D4「删除 TS 旧包与 CLI runner；更新工作区配置」
> 背景：Rust 新核心（crates/agent-provider、session-loop、orchestrator、agent-tools + conex-*，运行于 apps/agent-workbench/src-tauri 壳进程内）已替代 TS 侧 agent 运行时链。

---

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| 删除候选包总数 | **11 个**（agent-runtime / agent-core / agent-model / agent-daemon / agent-orchestrator / agent-context / agent-tools / agent-mcp / agent-subagent / agent-permissions / decision-engine） |
| 分类统计 | **A（无活引用，可删）7 个**：agent-core、agent-model、agent-context、agent-mcp、agent-subagent、agent-permissions、decision-engine<br>**B（引用均属废弃路径/测试/脚本）4 个**：agent-runtime、agent-daemon、agent-orchestrator、agent-tools<br>**C（活引用，保留）0 个** |
| 保留包 | shared-types、shared-utils、logger、telemetry、plugin-sdk（需摘除对 agent-tools 的类型引用）、test-utils（需摘除 agent-runtime 重导出与 devDep） |
| CLI runner 方案 | **推荐直接删除**（apps/agent-workbench/src/ 整目录 + cli_bridge.rs + 相关脚本），Tauri 壳（src-tauri + package.json）保留 |
| 前端影响 | apps/crish-desktop/src 对 11 个旧包**零引用**，零改动 |

---

## 1. 盘点范围与方法

- 检索路径：`packages/*/src`、`apps/crish-desktop/src`、`apps/agent-workbench/src`、`tests/`、`scripts/`、根与各 workspace 的 package.json / tsconfig / 构建配置、`.github/workflows`、`.husky`、`.dependency-cruiser.cjs`、`eslint.config.js`、`vitest.workspace.ts`。
- 判定标准：
  - **A**：除旧包互相引用外无任何外部引用（含测试、脚本、配置文件）。
  - **B**：存在引用，但引用方全部属于删除范围（CLI/废弃路径）、测试资产或可清理的脚本/配置。
  - **C**：被保留的前端/共享包（crish-desktop、shared-types、shared-utils、logger、telemetry）在生产代码中引用。

---

## 2. 删除候选表

### 2.1 全表（包 | 判定 | 依赖方 | 依据）

| 包 | 判定 | 依赖方（src 级 import / package.json / 脚本） | 依据 |
|---|---|---|---|
| @crish/agent-runtime | **B** | agent-orchestrator（pkg L33 + src/orchestrator/agent-loop.ts `plugin-registry`）；agent-daemon（pkg L35 + scripts/benchmark-daemon-streaming-harness.ts）；apps/agent-workbench（pkg L17、vite.config.ts L7 alias、src/cli/** 共 12 文件、src/shared/background-command-bridge.ts + .test.ts）；packages/test-utils（devDep L24 + src/index.ts L19-29 重导出，死代码）；scripts/test-real-provider-api.mjs L1（import dist/index.js） | 官方 deprecated shim（src/index.ts L31 带删除警告）；全部消费方属于删除/废弃/测试路径 |
| @crish/agent-core | **A** | agent-orchestrator（src/state-machine.ts、runtime-engine.ts）；agent-subagent（src/subagents.ts、instance.ts、scheduler.ts、subagent-loop.ts、subagent-context-pack.ts 等）；agent-daemon（type: protocol-outbound-session.ts L2、protocol-inbound-session.ts L2、conversation-rewind-boundary.test.ts）；agent-runtime（pkg L42 再导出） | 生产消费方全为旧包 |
| @crish/agent-model | **A** | agent-daemon（type: snapshot-types.ts、protocol-inbound-diagnostic.ts、error-propagation.e2e.test.ts、agent-real-workflow-e2e.test.ts）；agent-subagent（subagent-loop.ts `normalizeAndCoalesceProviderStreamEvents`）；agent-runtime（pkg L45 再导出）；tests/integration/provider-rate-limit-fallback.test.ts L39 | 生产消费方全为旧包；外部仅 1 个集成测试 |
| @crish/agent-daemon | **B** | scripts/bundle-daemon.mjs（bundle dist → resources 孤儿文件）；scripts/run-full-e2e-suite.mjs L20/L25（跑 daemon e2e 测试）；scripts/check-coverage-threshold.mjs L31（覆盖路径）；根 package.json：daemon（L45）、daemon:dist（L46）、bench:daemon（L47）、test:core（L70）、check:daemon（L63）、build:daemon（L42）；依赖全家（orchestrator/runtime/tools/permissions/mcp/decision-engine/model/context） | 无产品消费方；所有引用均是可清理的脚本/CI 项 |
| @crish/agent-orchestrator | **B** | agent-daemon（type: types/entities.ts、protocol-*.ts、daemon-lifecycle.ts、conversation-rewind-boundary.ts）；apps/agent-workbench src/cli/（goal-runner.ts L8、snapshot-aware-goal-strategy.ts）；agent-runtime（pkg L44 再导出） | CLI 属删除范围；其余为旧包 |
| @crish/agent-context | **A** | agent-tools（tools.ts、skills.ts、rich-read.ts、local-tools/*、tool-middleware.ts、workspace-mutation-coordinator.ts）；agent-subagent（subagents.ts、instance.ts、subagent-loop.ts）；agent-daemon（conversation-rewind-boundary.ts、types/entities.ts、types/protocol-*.ts）；agent-orchestrator（type: conversation-rewind.ts 等）；agent-runtime（pkg L47 再导出） | 生产消费方全为旧包 |
| @crish/agent-tools（TS） | **B** | agent-daemon（src/index.ts L12/L14、background-task-manager.ts）；agent-orchestrator（type: types.ts L4）；agent-subagent（subagents.ts L22、测试）；agent-mcp（pkg L34）；plugin-sdk（src/tools/plugin-api.ts L24/L30 **仅类型引用**）；tests/integration/plugin-hook-intercept.test.ts L58、mcp-server-startup.test.ts L43；agent-runtime（pkg L44 再导出） | 生产消费方全为旧包；外部仅 plugin-sdk 类型引用 + 2 个集成测试 |
| @crish/agent-mcp | **A** | agent-daemon（server-runtime-factory/*、server/index.ts、mcp-config.ts、mcp-stdio-adapter.ts、server.test.ts 等 9 处）；agent-runtime（pkg L46 再导出）；agent-core（pkg L36 **仅声明无 src 引用**）；agent-subagent（pkg L34 **仅声明无 src 引用**）；tests/integration/mcp-server-startup.test.ts L42 | 生产消费方全为旧包；外部仅 1 个集成测试 |
| @crish/agent-subagent | **A** | agent-daemon（subagent-runtime.ts L4-5）；agent-runtime（pkg L43 再导出 + src/subagents.test.ts）；tests/integration/session-subagent.test.ts L26/L32 | 生产消费方全为旧包；外部仅 1 个集成测试 |
| @crish/agent-permissions | **A** | agent-tools（tools.ts L19/L581）；agent-daemon（src/index.ts L17）；agent-runtime（pkg L48 再导出） | 生产消费方全为旧包 |
| @crish/decision-engine | **A** | agent-tools（permission/command-classification.ts）；agent-daemon（daemon-approval-handler.ts）；agent-permissions（trust-zone-policy.ts）；agent-runtime（permission/trust-zone-policy.ts、command-classification.ts） | 保留的 Layer 0 包（shared-types / shared-utils）零引用；消费方全为旧包 |

### 2.2 保留包引用核对（结论：干净）

- packages/shared-types/src、shared-utils/src、logger/src、telemetry/src：对 11 个旧包 **0 匹配**。
- apps/crish-desktop/src：对 11 个旧包、@crish/plugin-sdk、@crish/test-utils **0 匹配**（Round 16-18 已删除 WS daemon 链路）。
- apps/crish-desktop/tests/integration/setup.ts：仅 `installBrowserStorageMocks`（test-utils 自身代码，非 agent-runtime 重导出）。
- @crish/test-utils 被 @crish/agent-runtime 的引用仅是 src/index.ts L19-29 的 **死重导出**（外部无人 import FauxProvider/FauxAgentProvider 等）——删除 agent-runtime 前需摘除。
- @crish/plugin-sdk 对 @crish/agent-tools 的引用是 **类型层**（plugin-api.ts import type）——删除 agent-tools 前需迁移到 shared-types 内类型。

---
## 3. CLI runner 分析（apps/agent-workbench/src/cli/）

### 3.1 入口与命令面

- 入口：`apps/agent-workbench/src/cli/main.ts`（`runCliMain`，共 567 行；底部 `shouldRunCliMain()` L546-567 判定直接执行）。
- 命令面：`status` / `continue` / `run` / `run-json` / `goal-run` / `goal-json`（main.ts L518-544）。
- 结构：cli/ 下 19 个文件，其中 runner/ 5 个（goal-runner、runner-types、session-runner、stream-reader、token-budget）；provider-*.ts 6 个；goal-runner、snapshot-aware-goal-strategy、runtime-factory、workbench-runner、run-registry。
- 调用方式：`apps/agent-workbench/package.json` L12 `"cli": "node ../../node_modules/vite-node/vite-node.mjs --config vite.config.ts src/cli/main.ts"`；vite.config.ts L7 有 `@crish/agent-runtime` 源码 alias。

### 3.2 是否有入口 / 被调用

- **有入口**（package.json `cli` 脚本），**有调用点但均属废弃/诊断路径**：
  1. 根 package.json：`dev:cli`（L35）、`cli`（L44）、`check:workbench`（L64 → `cli:check`）、`build:workbench`（L37 前置 `check:workbench`）、`check:core`（L60 链式包含）。
  2. Rust 壳 `apps/agent-workbench/src-tauri/src/cli_bridge.rs`：6 个 `workbench_dev_cli_*` 命令 shell 出 `npm --workspace @crish/agent-workbench run cli`；**仅 debug 构建注册**（main.rs L3-4 `#[cfg(debug_assertions)] mod cli_bridge`、L123-135 `register_handlers!(dev)`），文件头注明"Developer diagnostics only"。
  3. 前端 apps/crish-desktop/src 对 `workbench_dev_cli_*` **零调用**（grep 无匹配）。
- **工具链依赖**：无 CI workflow 调用 cli:check（ci.yml 仅 turbo typecheck / eslint / depcruise / vitest / cargo）；DEVELOPMENT_LOG.md、AGENT-COORDINATION.md 属开发日志类文档引用；tests/e2e 驱动的是原生二进制（非 TS CLI）。
- **测试锚定**：`apps/agent-workbench/src/core/tauri-command-registry.test.ts` 强断言：L119-131 dev_cli 命令清单与 surface；L170 `cli_bridge::workbench_dev_cli_continuation` 在 rust main.rs；L186-197 release 不注册 dev 命令；L213-214 根 package.json `dev:cli`/`cli` 脚本字符串；L206-209 workspaces 含 agent-daemon/orchestrator/runtime。`src/shared/chinese-text-regression.test.ts` 由 command-registry:check 一并执行。

### 3.3 处理方案对比与推荐

| 方案 | 评估 |
|---|---|
| 迁移到 Rust 核心 | 不推荐。CLI 语义（task/goal/run-registry/resume/snapshot）与 Rust 壳已有 `core_run_task`/`core_get_status`/`core_read_run_events`/`core_run_control` 等价且已接前端；迁移需重写 TS CLI 全栈（依赖 agent-runtime/orchestrator 语义），收益仅开发者诊断，成本高。 |
| 标记废弃保留 | 不推荐。与 00-master-plan D4「删除 TS 旧包与 CLI runner」直接冲突；保留 CLI 则 agent-runtime 无法删除（CLI 是其主要消费方）。 |
| **直接删除（推荐）** | **推荐**。删除 `apps/agent-workbench/src/` 整目录（cli/core/shared）与 `vite.config.ts`；删除 `src-tauri/src/cli_bridge.rs` 及 main.rs 的 debug 注册分支；删除/改写其测试锚定（tauri-command-registry.test.ts）；删除根 `dev:cli`/`cli`/`check:workbench` 与 `cli:check` 链路。Tauri 壳不受影响：tauri.conf.json `frontendDist` 指向 `../../crish-desktop/dist`（L7），`beforeDevCommand`/`beforeBuildCommand` 均委托 crish-desktop（agent-workbench package.json L9-10），`src/` 不参与 Tauri 构建。 |

**删除面清单（CLI 相关）**：
- `apps/agent-workbench/src/`（cli/、core/、shared/ 全部，含 5 个测试文件）
- `apps/agent-workbench/vite.config.ts`（仅被 cli 脚本的 vite-node 使用）
- `apps/agent-workbench/src-tauri/src/cli_bridge.rs` + main.rs L3-4、L123-135（`register_handlers!(dev)`）、L153-154
- `apps/agent-workbench/package.json`：cli / cli:check / command-registry:check 脚本、`@crish/agent-runtime` 依赖、`vite` devDep
- 根 package.json：`dev:cli`（L35）、`cli`（L44）、`check:workbench`（L64）、`check:core`（L60）与 `build:workbench`（L37）中前置的 check:workbench
- vitest.workspace.ts L23 `apps/agent-workbench/src/**/*.test.{ts,tsx}`（unit 项目 include）

---

## 4. 配置文件修改清单（具体行）

### 4.1 根 package.json

| 行（现文件） | 内容 | 动作 |
|---|---|---|
| L8-28 workspaces | 11 个旧包条目（agent-context/core/daemon/mcp/model/orchestrator/permissions/runtime/subagent/tools + decision-engine） | 全部移除；保留 logger、plugin-sdk、shared-types、shared-utils、telemetry、test-utils 与 2 个 apps |
| L34 dev:workbench | `npm --workspace @crish/agent-workbench run tauri -- dev` | **保留**（Tauri 壳启动入口） |
| L35 dev:cli | CLI 启动 | 删除 |
| L37 build:workbench | `npm run check:workbench && npm --workspace @crish/agent-workbench run build` | 改写为 `npm --workspace @crish/agent-workbench run build`（去掉 check:workbench 前置） |
| L39 build:runtime / L40 build:orchestrator | 旧包构建 | 删除 |
| L42 build:daemon | turbo --filter=@crish/agent-daemon... | 删除 |
| L43 build:product | `turbo run build && npm run build:daemon-binary` | 改写为 `turbo run build`；**`build:daemon-binary` 当前根本未定义**（悬空引用，顺带修复） |
| L44 cli | `npm run dev:cli` | 删除 |
| L45 daemon / L46 daemon:dist / L47 bench:daemon | 运行/构建 TS daemon | 删除 |
| L60 check:core | 链式 check:runtime/orchestrator/daemon/workbench/desktop | 删除（保留 check:desktop） |
| L61 check:runtime / L62 check:orchestrator / L63 check:daemon / L64 check:workbench | 旧包 tsc 检查 / CLI 检查 | 删除 |
| L66 typecheck | `tsc --noEmit --project apps/crish-desktop/tsconfig.json` | 保留（前端自足） |
| L70 test:core | vitest 跑旧包路径 | 删除 |

### 4.2 apps/agent-workbench/package.json

| 行 | 内容 | 动作 |
|---|---|---|
| L8 typecheck / L9 dev / L10 build / L11 tauri | tsc / 委托 crish-desktop / Tauri | L8 可删（src/ 删除后无 TS 编译面）；L9-11 **保留**（Tauri 构建路径） |
| L12 cli / L13 cli:check / L14 command-registry:check | CLI 脚本 | 删除 |
| L17 `@crish/agent-runtime` | workspace 依赖 | 删除 |
| L18-20 shared-types / shared-utils / crish-desktop | 保留 | 保留（dev/build 委托需要；shared-* 为保留包） |
| L26 vite devDep | 仅 cli 的 vite-node 使用 | 删除 |

### 4.3 apps/crish-desktop/package.json

- **无改动**：dependencies/devDependencies 对 11 个旧包零引用（L19-57 核对）。

### 4.4 turbo.json

- **无改动**：tasks 为泛化定义（build/build:types/build:js/test/lint/typecheck/clean），无包名引用；旧包移出 workspaces 后任务自动消失。

### 4.5 vitest.workspace.ts / vitest.config.ts

- vitest.workspace.ts L23 `apps/agent-workbench/src/**/*.test.{ts,tsx}`：删除（与 CLI 删除同步）。
- vitest.workspace.ts L20 `packages/*/src/**/*.test.{ts,tsx}`：保留（模式匹配，旧包删除后自动为空）。
- vitest.integration.config.ts：仅含 crish-desktop/tests/integration，无旧包引用，保留。
- vitest.config.ts：coverage include 为 `apps/crish-desktop/src` + `packages/*/src` 模式，无显式旧包引用；保留（旧包删除后自动缩小）。

### 4.6 tsconfig

- 各旧包 tsconfig.json（11 份）：随包删除（仅自引用 tsBuildInfoFile，无跨引用，见 4.6 核对）。
- tsconfig.base.json：无包路径映射，无改动。
- apps/agent-workbench/tsconfig.json（L9 include `["src", "vite.config.ts"]`）：src 与 vite.config.ts 删除后可一并删除该文件。
- apps/crish-desktop/tsconfig*.json：无旧包引用，无改动。

### 4.7 .dependency-cruiser.cjs

| 行 | 内容 | 动作 |
|---|---|---|
| L39 LAYERS[0] | `packages/(shared-types\|shared-utils\|decision-engine)` | 移除 decision-engine |
| L41-47 LAYERS[2..7] | agent-context/permissions/mcp、agent-tools/model、agent-core、agent-subagent、agent-orchestrator、agent-daemon | 整组删除 |
| L48 LAYERS[8] plugin-sdk | 保留（若 plugin-sdk 保留） | 保留 |
| L79-99 no-daemon-private-from-frontend / no-utils-reverse-dependency | 引用 agent-daemon / agent-runtime/orchestrator/daemon | 删除或改写为仅 shared-utils 反向规则 |
| L104-247 no-layer-N-reverse 系列 | 引用已删包层 | 删除 L2-L7 对应规则；保留 layer 0/1/8/9 或整体简化 |
| L255-264 no-agent-runtime-import | 对 agent-runtime 的 warn 禁令 | 删除（包已不存在） |
| L270-282 no-plugin-sdk-runtime-to-agent-tools | 对 agent-tools/agent-mcp 禁令 | 删除（包已不存在，或随 plugin-sdk 类型迁移后删除） |

### 4.8 eslint.config.js

- L124 `apps/agent-workbench/**/*.{ts,tsx}`（react 规则组）：src/ 删除后可移除该行（src-tauri 无 TS）。
- L47 `**/.agent-runtime/**` ignore：为工具目录忽略项，与包无关，保留。

### 4.9 scripts / tests / 测试资产

| 文件 | 行 | 动作 |
|---|---|---|
| scripts/bundle-daemon.mjs | 整文件（依赖 packages/agent-daemon/dist） | 删除 |
| scripts/run-full-e2e-suite.mjs | L20、L25（跑 agent-daemon e2e 测试） | 删除对应条目 |
| scripts/check-coverage-threshold.mjs | L29-31（agent-core/subagent/daemon 阈值） | 删除对应条目 |
| scripts/test-real-provider-api.mjs | L1（import agent-runtime/dist） | 删除或改写为直连 HTTP（与 test-real-fetch.mjs 同型） |
| scripts/check-legacy-shim.mjs | L47-52 agent-runtime 模式、L90-96 daemon-logger allowedIf 引用 agent-daemon 路径 | 删除 agent-runtime 模式；daemon 相关 allowedIf 一并清理 |
| tests/integration/plugin-hook-intercept.test.ts | L58（agent-tools ToolRegistry） | 删除或迁移（能力已由 crates/agent-tools 集成测试覆盖） |
| tests/integration/mcp-server-startup.test.ts | L42-43（agent-mcp + agent-tools） | 同上 |
| tests/integration/provider-rate-limit-fallback.test.ts | L39（agent-model） | 同上 |
| tests/integration/session-subagent.test.ts | L26/L32（agent-subagent） | 同上 |
| packages/test-utils/src/index.ts | L19-29（agent-runtime 重导出） | 删除重导出 |
| packages/test-utils/package.json | L24 devDependencies `@crish/agent-runtime` | 删除 |
| packages/plugin-sdk/src/tools/plugin-api.ts | L24/L30（agent-tools 类型） | 迁移到 shared-types 内类型后删除引用 |
| apps/agent-workbench/src-tauri/resources/crish-agent-daemon.bundle.js | git 跟踪的**孤儿文件**（Round 18 删 sidecar 后无任何引用：tauri.conf 无 resources 项、Rust 代码 0 匹配） | 删除 |

### 4.10 无改动项确认

- turbo.json、playwright.config.ts、.lintstagedrc.json、.husky/pre-commit、pre-push、.github/workflows/ci.yml：均无旧包引用（CI 不调 cli:check / check:core）。
- package-lock.json：删除包后执行 `npm install` 重新生成即可。

---
## 5. 删除顺序（先无引用，后有相互引用的核心包）

> 原则：**先清消费端，再删叶子，最后删汇聚核心**；每个阶段结束时 `npm install` + `tsc --noEmit` + `vitest run` 绿。

| 阶段 | 内容 | 理由 |
|---|---|---|
| 阶段 1：清消费端 | ① CLI：apps/agent-workbench/src/ 整目录 + vite.config.ts + src-tauri/src/cli_bridge.rs + main.rs debug 注册 + agent-workbench package.json cli 脚本/依赖；② 根 package.json 脚本（dev:cli/cli/check:workbench/check:core 及 daemon 相关）与 workspaces 中旧包条目；③ tests/integration 4 个旧包测试（确认 crates 覆盖后删）；④ scripts/（bundle-daemon、run-full-e2e-suite、check-coverage-threshold、test-real-provider-api、check-legacy-shim）；⑤ test-utils 重导出 + devDep；⑥ plugin-sdk 类型迁移；⑦ 孤儿 resources bundle；⑧ vitest.workspace.ts L23、eslint L124、depcruiser 规则同步 | 消除所有外部引用面，使旧包仅剩包间互引 |
| 阶段 2：删叶子包（A 类 7 个） | decision-engine、agent-context、agent-model、agent-mcp、agent-subagent、agent-permissions | 无外部引用（仅旧包互引 + 已清理的测试）；agent-mcp/agent-subagent 的 pkg 声明依赖同时移除 |
| 阶段 3：删中段包 | agent-tools（先完成 plugin-sdk 类型迁移）、agent-core | 被 agent-orchestrator/daemon 依赖，须在汇聚包之前 |
| 阶段 4：删汇聚核心（B 类） | agent-orchestrator → agent-runtime（shim 最后删）→ agent-daemon | runtime 是全链汇聚点；daemon 是脚本/测试引用最多的包，放最后以便验证 |
| 阶段 5：配置收尾 | 根 package.json workspaces/scripts 终审、.dependency-cruiser.cjs 简化、`npm install` 重生成 lock、全量验证（turbo typecheck + vitest run + cargo test/clippy + depcruise + eslint） | 与 00-master-plan D1-D3 验证闭环衔接 |

---

## 6. 风险项

| # | 风险 | 说明与缓解 |
|---|---|---|
| 1 | **测试配置引用旧包** | vitest.workspace.ts unit include `packages/*/src/**/*.test.ts` 与 `apps/agent-workbench/src/**/*.test.ts`；旧包测试随包消失，但 agent-workbench 的 CLI 测试必须在阶段 1 同步删除，否则 CI（`npx vitest run`）红 |
| 2 | **tauri-command-registry.test.ts 强断言** | L119-131/170/186-197/206-209/213-214 断言 dev_cli 命令清单、rust main.rs 内容、根 package.json workspaces 与 dev:cli/cli 脚本字符串——**配置修改必须与该测试同一次改动**，否则 cli:check/typecheck 红 |
| 3 | **tests/integration 4 个旧包测试** | 直接删除影响 vitest.workspace integration 项目与 coverage 阈值（statements 70 / branches 60）；删除前确认对应能力已由 crates（agent-provider/session-loop/orchestrator/agent-tools）集成测试覆盖（见 05-test-mapping.md） |
| 4 | **test-utils 依赖链** | test-utils devDep `@crish/agent-runtime` + src/index.ts L19-29 重导出；不先清理则 `npm ci` 与 typecheck 在删除 agent-runtime 后失败；清理后 test-utils 仅剩自身 mock 工具（installBrowserStorageMocks 等），由 crish-desktop/tests/integration/setup.ts 使用，保留 |
| 5 | **plugin-sdk 类型引用** | plugin-api.ts 对 agent-tools 的 import type 在运行时无包依赖声明（靠提升解析）；删除 agent-tools 前必须将 ToolDefinition 等类型迁移至 shared-types，否则编译失败 |
| 6 | **depcruise 规则失真** | .dependency-cruiser.cjs 的 LAYERS/L2-L7 与 no-agent-runtime-import/no-plugin-sdk-runtime-to-agent-tools 引用已删包；删除包后 depcruise 对不存在路径虽不报错，但规则失去意义且 `npm run lint:depcruise`（CI lint job）需保持绿 |
| 7 | **根 build:product 悬空引用** | L43 `npm run build:daemon-binary` 未在任何 package.json 定义（历史遗留）；删除 daemon 时须改写为 `turbo run build`，避免发布脚本失败 |
| 8 | **resources 孤儿 bundle** | `apps/agent-workbench/src-tauri/resources/crish-agent-daemon.bundle.js` 为 git 跟踪文件、Round 18 后零引用；删除避免产物误打包（tauri.conf 无 resources 声明，实际不会打包，属清理项） |
| 9 | **cli_bridge 的 Rust 测试** | cli_bridge.rs 内 `test_cli_bridge_blocks_red_line_commands`（L170-201）参与 `cargo test`；删除模块时同步删除，否则壳测试红 |
| 10 | **agent-workbench dev/build 委托链** | package.json L9-10 委托 crish-desktop，tauri.conf beforeDevCommand/beforeBuildCommand 依赖该链；删 CLI 时**不得**删除 dev/build 脚本与 @crish/crish-desktop 依赖，否则 Tauri 启动/构建断裂 |
| 11 | **check-legacy-shim 模式残留** | 删除 agent-runtime 后其 import 模式恒为 0 匹配，保留无害；但 L90-96 daemon-logger 的 allowedIf 引用 `agent-daemon` 路径段，包删除后该判断失效，需一并清理 |
| 12 | **文档引用滞后** | DEVELOPMENT_LOG.md、AGENT-COORDINATION.md、analysis/*.md 大量引用 cli:check/check:core/旧包；非构建依赖，建议后续统一修正，不作为删除阻塞项 |

---

## 7. 遗留与待办

- 00-master-plan.md §4 副文档清单登记本文档（由主 Agent 更新，本任务仅产出文档）。
- tests/integration 4 个旧包测试的 Rust 对应覆盖核对（依赖 05-test-mapping.md 与 crates 集成测试现状）。
- plugin-sdk 类型迁移具体落点（shared-types 中 ToolDefinition/RegisteredTool 的最终位置）需在阶段 1 确定。
- agent-workbench 壳更名建议（`@crish/agent-workbench` → 描述 Tauri 壳语义的名称）可另行评估，不影响本计划。

---

## 8. 报告摘要

- **删除候选总数：11**（agent-runtime、agent-core、agent-model、agent-daemon、agent-orchestrator、agent-context、agent-tools、agent-mcp、agent-subagent、agent-permissions、decision-engine）
- **分类统计：A = 7，B = 4，C = 0**（保留包与 crish-desktop 零引用）
- **CLI 方案推荐：直接删除**（含 src/ 整目录、cli_bridge.rs、相关脚本与测试锚定；Tauri 壳保留）