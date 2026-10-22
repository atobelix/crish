# PE-11 测试策略与验证体系 · 任务书

> 状态：草稿（只读研究产出，本任务书不含任何代码改动）
> 日期：2026-08-01 · 类型：方案设计文档（可执行任务书）
> 定位：**全仓测试策略 SoT**——分层规范、测试资产归属、CI 门禁、空白区承接（AU-02 §五.4/5/6/9、AA-01 Q41、AU-03 C4 阈值冲突）。
> 输入事实：
> - `docs/rust-rewrite/00-master-plan.md` §1.3（质量门槛：cargo test / clippy / 关键语义单测 faux provider / 切换轮端到端冒烟）
> - `docs/rust-rewrite/23-architecture-hardening-plan.md` §4（每轮验证门槛：`cargo test --workspace` + 前端 vitest 相关套件 + typecheck；删除必须 grep 零残留）
> - `docs/rust-rewrite/05-test-mapping.md`（TS 测试资产 → Rust 测试映射，§6 分层建议）
> - `docs/rust-rewrite/audits/AU-02-coverage-audit.md`（§五 空白区 4/5/6/9、§六.3 补全建议）
> - `docs/rust-rewrite/audits/AU-03-executability-audit.md`（P1 跨 PE 接口冻结表、C4 首 token 阈值冲突）
> - 各域任务书：PE-01（T03.3 密钥迁移 / T05.2 目录迁移）、PE-02（T02.1 契约 / T02.6 性能验收）、PE-03（T03.8 golden / T03.9 契约文档）、PE-05（visual 迁移期）、PE-07（T07.4 密钥迁移）、PE-08（T08.7 迁移版本化 / T08.8 sequence）、PE-09（T09.1 增量流 / T09.7 基准基建 / T09.8 复测）

---

## 0. 现状事实与空白区承接

### 0.1 现有测试资产盘点（证据，实现时以此核对）

**Rust 侧**（`cargo test --workspace` 全量可跑）：

| 资产 | 位置 | 现状 |
|---|---|---|
| 单元测试 | `crates/*/src` 内 `#[cfg(test)]` | 各 crate 自成体系（agent-provider 352+、session-loop 126+、orchestrator 121+、conex-types 69+ 等，见 00-master-plan.md 轮次表） |
| 集成测试 | `crates/{session-loop,orchestrator,agent-provider,conex-types,conex-markdown,conex-telemetry,agent-tools}/tests/` | run_loop/divergence/drive/cancel/approval/parse_*/roundtrip/parity/mcp_bridge 等 |
| 测试替身 | `crates/session-loop/src/testing/mod.rs`（TestProvider/TestTool）、`crates/orchestrator/tests/common/mod.rs` | 脚本化事件流，05 §4.9 对应表已落地 |
| 通用工具 | `crates/conex-test-utils`（TempWorkspace / assert_json_roundtrip / setup_test_env） | 仅 3 个助手，无断言序列/时钟能力 |
| 契约测试 | `apps/agent-workbench/src-tauri/tests/`（event_bridge 等） | golden 契约套件由 PE-03 T03.8 新建（`tests/ipc_contract/golden/`），当前不存在 |
| 基准 | `crates/**/benches/` | **不存在**，PE-09 T09.7 新建（Criterion 5 场景 + TTFB 集成测试） |

**前端侧**：

| 资产 | 位置 | 现状 |
|---|---|---|
| unit/component | `vitest.workspace.ts` unit 项目（node env，`apps/crish-desktop/src/**/*.test.{ts,tsx}`，component 用 `// @vitest-environment jsdom` 逐文件切换，grep 确认 34 处） | 3639/3679 基线（Round 19） |
| snapshots | `apps/crish-desktop/tests/snapshots/`（3 文件 + `__snapshots__/`） | `test:snapshots` / `test:snapshots:update` |
| integration/fuzz/race/recovery | `apps/crish-desktop/tests/{integration,fuzz,race,recovery}`（13 文件）+ `tests/integration`（vitest.workspace integration 项目，`vitest.integration.config.ts`） | 已有，无 owner 轮次维护 |
| e2e（Playwright） | 根 `playwright.config.ts`（testDir `./tests/e2e`，webServer `npm --workspace @crish/crish-desktop run dev`，端口 5174）+ `apps/crish-desktop/playwright.config.ts`（testDir `./tests`，含 visual） | `tests/e2e/ui-store-invariants.spec.ts`（L2 mock IPC 模式，已可跑）；`apps/crish-desktop/tests/e2e/ui-store-invariants.spec.ts` 为重复拷贝 |
| native 冒烟 | `tests/e2e/tauri-native-smoke.spec.ts` | **陈旧**：断言 WS daemon 握手（`tauri-native-smoke.spec.ts:135-145`），daemon/WS 链路已在 Round 16-18 删除——该测试当前必然失败或空转 |
| visual | `apps/crish-desktop/tests/visual/app.spec.ts`（3 张全页截图） | 无基线入库记录、无 diff 阈值、无 CI 接线 |
| stress | `tests/stress/`（stress-runner + 3 场景 + run-all-stress） | **纯 TS/node**，不触 Rust 侧（`npm run stress`） |

### 0.2 空白区承接声明（AU-02 §五 / §六.3）

| # | 空白区（AU-02 原文） | 承接 |
|---|---|---|
| 1 | §五.4 前端测试策略（e2e/visual 门禁全书无任务；PE-05 引用 `test:visual` 仅为迁移用；playwright 快照无任务维护） | **本任务书 T11.1 + T11.2** |
| 2 | §五.6 升级/迁移文档（用户数据侧无统一任务） | **T11.5**（升级指南文档 + 迁移测试场景） |
| 3 | §五.9 G3 首 token 总验收 owner 互等（PE-02「与 PE-09 联调时执行」× PE-09「与 PE-02 联调时执行」） | **T11.4 认领单一 owner**；AU-02 建议的 PE-09 T09.8 改为只做复测数据提供方 |
| 4 | AA-01 Q41 时间脆弱测试（真实时钟），移交「测试基础设施域」 | **T11.7**（TestClock 注入） |
| 5 | §五.5 事件载荷 schema 版本化（IPC 有 changelog、事件无） | **T11.3.2**（事件 schema changelog + 旧事件兼容测试） |
| 6 | AU-03 C4 首 token 阈值三套数字（PE-02 `<500ms` / PE-09 G1 `≤300ms` / T09.1 `<600ms`） | **T11.4 统一裁决**（见 T11.4.2） |
| 7 | AU-03 P1 跨 PE 接口冻结表（四组接口各有 ≥2 份定义） | 冻结表本体由 PE-01/03/04/06/08/09 会签产出；**本任务书 T11.3.1 定义其契约测试归属与运行方式** |

### 0.3 本任务边界（明确不做）

| 不做 | 理由 |
|---|---|
| 实现 PE-03 T03.8 golden 套件本身 | 属 PE-03（IPC 契约域），本任务只立**统一规范与运行门禁** |
| 实现 PE-09 T09.7 Criterion 基准 | 属 PE-09；本任务只定义基线存档单一化与复测流程 |
| 实现 PE-08 T08.7 迁移测试 | 属 PE-08；本任务补**升级端到端场景**（用户视角）与统一文档 |
| 引入新测试框架（Cypress/Storybook 等） | Playwright + vitest 已覆盖全部需求（见 T11.1 评估） |
| 覆盖率数字调整 | 现有 70/60/65/70 阈值保持，本任务只建议分层门禁与豁免清单 |

---

## 1. 测试分层规范（SoT）

> 本规范是全仓测试资产**唯一归属依据**：所有现有与新增测试按本节约定位。各轮验收命令以 §1.3 总表为准。
> 与 23 方案 §4 的每轮验证门槛（`cargo test --workspace` + 前端 vitest 相关套件 + typecheck）对齐，本规范将其细化为四层 × 门禁归属。

### 1.1 Rust 分层（unit → integration → 契约测试 → e2e faux）

| 层 | 定义 | 归属目录 | 运行命令 | 示例 |
|---|---|---|---|---|
| **L1 unit** | 单函数/单类型纯逻辑：状态机转移、解析、分类、映射表、序列化。无 I/O、无跨模块 | `crates/<crate>/src/` 内 `#[cfg(test)] mod tests` | `cargo test -p <crate>` | conex-types 事件 roundtrip、agent-provider 错误分类、session-loop steering 队列 |
| **L2 integration** | 多组件组合：TestProvider/TestTool/TestGateway 替身注入；真实 DB（临时目录）；真实网络（本地 TCP mock） | `crates/<crate>/tests/`（每 crate 独立 `common/` 共享基建） | `cargo test -p <crate> --tests` | orchestrator `tests/drive.rs`、agent-provider `tests/parse_*.rs`、agent-tools `tests/mcp_bridge.rs` |
| **L3 契约测试** | 对**冻结接口**的 golden 断言，与界面解耦：① IPC 命令面（命令名/请求/响应/错误）② 流式增量契约（增量性/收敛性/取消保留/传输错误）③ 事件 schema 兼容（旧载荷解析） | ① `apps/agent-workbench/src-tauri/tests/ipc_contract/`（golden JSON）② `crates/session-loop/tests/streaming_incremental_contract.rs`（PE-02 T02.1 锚点）③ `crates/conex-types/tests/events_roundtrip.rs`（fixtures 扩展，T11.3.2） | ① `cargo test -p agent-workbench`（含契约套件）② `cargo test -p session-loop --test streaming_incremental_contract` ③ `cargo test -p conex-types` | PE-03 T03.8 `<cmd>.ok.json`/`<cmd>.err.json`；T02.1 T1-T4 四用例 |
| **L4 e2e faux** | faux provider 脚本驱动全流程（消息→文字流→工具调用→收口；L2/L3 取消；恢复），**不连真实模型**；真壳级为「无 GUI 直连冒烟」（模拟 TUI 客户端：直接调 core_run_task + 订阅事件通道） | ① `crates/session-loop/tests/{run_loop,divergence}.rs`、`crates/orchestrator/tests/*` ② `apps/agent-workbench/src-tauri/tests/`（壳级冒烟） | ① `cargo test -p session-loop -p orchestrator` ② `cargo test -p agent-workbench` | e2e::full_run（05 §5.7）、PE-03 T03.8 冒烟 4 |

**层间规则（强制）**：
1. L3 契约测试**不得依赖 GUI/传输层实现**（golden 只断言命令函数直调结果）；L4 不连 live model（live 冒烟独立于测试门禁，00 §1.3「切换轮」用）。
2. 关键语义必须至少有 L1 单测 + L4 全流程各一（00-master-plan.md:73「关键语义必须有单测（faux provider）」）。
3. 时间敏感测试一律走 T11.7 TestClock（AA-01 Q41），禁止 `std::time` 裸用（见 T11.7.3）。

### 1.2 前端分层（unit → component → integration → e2e）

| 层 | 定义 | 归属 | 运行命令 | 示例 |
|---|---|---|---|---|
| **F1 unit**（node env） | 纯逻辑：状态机、buffer 分帧、事件累加、错误映射；不渲染 | `packages/*/src/**/*.test.ts`、`apps/crish-desktop/src/**/*.test.ts`（无 jsdom 指令的） | `npm test`（vitest.workspace unit 项目） | StreamRenderBuffer、error-translation、EventRouter |
| **F2 component**（jsdom） | 组件渲染交互：@testing-library/react + 文件头 `// @vitest-environment jsdom` + test-setup.ts 的 Tauri invoke mock（`mockTauriCommand/mockTauriMissing/mockTauriError` 三态，test-setup.ts:61-96） | `apps/crish-desktop/src/**/*.test.tsx` | `npm test` | AsyncMarkdownBlock、SettingsPanel、MessageContent |
| **F3 integration/fuzz/race/recovery** | 跨模块组合：store 并发、回灌、内存压力、崩溃恢复 | `apps/crish-desktop/tests/{integration,fuzz,race,recovery}` + `tests/{integration,fuzz,race,recovery}` | `npm run test:integration`（vitest.integration.config.ts）+ `npm run test:fuzz`；workspace integration 项目 `npx vitest run --project=integration` | store-persistence、virtual-scroll fuzz、memory-pressure |
| **F4 e2e**（Playwright） | 浏览器真渲染 + mock Tauri invoke（L2 模式，CI 全量）/ 真壳 tauri-driver（L3 模式，发布前） | `tests/e2e/`（全旅程）+ `apps/crish-desktop/tests/visual/`（截图） | `npx playwright test tests/e2e`（根 config）；`npm --workspace @crish/crish-desktop run test:visual` | ui-store-invariants、full-journey（T11.1 新增） |
| **F5 snapshot** | React 渲染树快照（jest 式 toMatchSnapshot） | `apps/crish-desktop/tests/snapshots/` | `npm --workspace @crish/crish-desktop run test:snapshots` | ToastStack、ChatToolCallBlock、AppErrorBoundary |

**归属规则**：
- 组件测试一律 F2 层 jsdom；**不得**把渲染断言写进 F1 node 层。
- 涉及真实浏览器行为（滚动、视口、字体、截图）一律 F4；jsdom 无法替代。
- 单测的 DOM 断言（`container.innerHTML`）允许 F2；截图断言只允许 F4。

### 1.3 运行命令总表（每轮验证门禁）

| 门禁 | 命令 | 时长量级 | 归属轮次 |
|---|---|---|---|
| Rust 全量 | `cargo test --workspace`（含 L1-L4 + 契约套件） | 中（分钟级） | 每实现轮必跑（23 §4） |
| Rust 静态 | `cargo clippy --workspace` | 快 | 每实现轮必跑 |
| 前端全量 | `npm test`（vitest.workspace：unit+integration+e2e 项目） | 中（~2-4 分钟，Round 19 基线 3679 用例） | 每前端轮必跑 |
| 前端 typecheck | `npm run typecheck` / `npm --workspace @crish/crish-desktop run typecheck` | 快 | 每前端轮必跑 |
| snapshot | `npm --workspace @crish/crish-desktop run test:snapshots` | 快 | 组件/样式改动轮 |
| 契约套件 | `cargo test -p agent-workbench`（T03.8）+ `cargo test -p session-loop --test streaming_incremental_contract` | 中 | PE-03/PE-09/PE-02 相关轮 |
| e2e L2 | `npx playwright test tests/e2e` | 慢（分钟级） | CI PR 层 + 每切换轮 |
| visual | `npm --workspace @crish/crish-desktop run test:visual` | 慢 | PE-05 每迁移单元 + CI 慢层 |
| stress TS | `npm run stress` | 慢（~60s+） | 前端压力轮 |
| stress Rust | `cargo test --workspace --release --locked --test 'stress_*' -- --ignored`（T11.6 新增，`#[ignore]` 场景，清单见 `PE-11-ignored-tests-inventory.md`） | 很慢 | nightly / 发布前 |
| 基准 | `cargo bench`（T09.7 落地后） | 很慢 | PE-09 轮 + 发布前 |
| live 冒烟 | 手工（00 §1.3 切换轮；tauri-mcp 或 UI 全旅程） | — | 切换轮必做 |

**规则**：CI 分三层（快层每次提交 / 中层 PR / 慢层 nightly+发布前），定义见 T11.7.4。任何轮次验收不得跳过所属门禁；「测试全绿」表述一律对照本表。

---

## 2. 任务分解（T11.x）

任务编号 T11.1–T11.7，每任务含目标/输入/产出/验收/依赖。执行顺序见 §4。

### T11.1 前端 e2e 策略（Playwright 评估 + 场景落地）

- **目标**：终结「前端 e2e 无策略」空白（AU-02 §五.4）——评估现有方案、归一配置、补齐必覆盖场景、重写陈旧资产。
- **方案评估结论（决策，先定死）**：
  1. **沿用 Playwright，不引入新框架**：`@playwright/test` 已在 devDependencies（apps/crish-desktop/package.json:47），L2 mock-IPC 模式已被 ui-store-invariants.spec.ts 验证可跑（playwright.config.ts:4-14 + `page.addInitScript` 注入 `__TAURI_INTERNALS__`，ui-store-invariants.spec.ts:75-101）。
  2. **双配置归一**：根 `playwright.config.ts`（testDir `tests/e2e`）与 `apps/crish-desktop/playwright.config.ts`（testDir `tests`，含 visual）职责分裂——裁决：**根 config 为 e2e 唯一入口**（projects：`e2e-l2` 默认 / `e2e-l3` tauri-driver 可选）；`apps/crish-desktop/playwright.config.ts` 收敛为 visual 专用 config（testDir 限 `tests/visual`），避免 `playwright test` 在 app 目录误扫 F3 层。
  3. **mock 引擎 vs 真引擎**：
     - **E2E-L2（mock 引擎）**：dev server + `addInitScript` mock `invoke` + 注入式事件推送（模拟 message-delta/run-terminal 事件流）。确定性、CI 稳定、全量跑。**CI 默认层**。
     - **E2E-L3（真壳）**：`tauri-driver` 驱动真二进制，provider 指到**本地 mock SSE 服务**（复用 `crates/agent-provider/src/transport/mod.rs:73-100` 的 `serve_sse` 模式，经环境变量指向 mock endpoint，不连 live model）。**发布前/nightly 层**。当前不接线 tauri-driver 的，先以「进程级冒烟」占位（见下 5）。
     - live model 全旅程维持 00 §1.3 切换轮手工冒烟，不进自动化门禁（模型不稳）。
  4. **陈旧资产处置**：`tests/e2e/tauri-native-smoke.spec.ts` 断言已删除的 WS daemon（:135-145 `Started daemon process (PID`、`ws://127.0.0.1:8765`）——**重写为进程级冒烟**：spawn 真二进制 → 断言进程存活 + 日志含引擎初始化标记（PE-04 接线后 `init_default` 输出）+ SIGTERM 干净退出 + 无残存进程（去掉全部 WS/daemon 断言）；或删除并由 T11.5 冒烟替代，二选一（默认重写，保留「二进制可拉起」这条发布门禁）。
  5. **data-testid 契约**：新建 `tests/e2e/README.md`（覆盖现 README）登记全旅程所需 testid 清单（已有 `sidebar`/`new-session-button`/`settings-button`/`settings-panel`/`model-selector-button` 等沿用），新场景缺 testid 的以本任务为 owner 补（补 testid 属测试基建改动，不动业务逻辑）。
- **必覆盖场景（至少 4 个 spec 文件）**：
  1. `tests/e2e/full-journey.spec.ts`：**启动 → 新建会话 → 发送 → 流式渲染 → 工具调用 → 收口**。mock 脚本：`core_run_task` 返回 runId → 事件推送序列（message-start → delta×N → tool-call-batch → tool-start/end → message-end → run-terminal）。断言：输入框文字清空、消息列表出现 assistant 消息、delta 逐条追加（`assistantText` 累积）、工具调用卡可见、run 终态标记、收口后无 pending 态。
  2. `tests/e2e/session-restore.spec.ts`：**会话恢复**。预置 mock `list_sessions`/`read_session_events` 返回 3 会话（含 1 个 in-flight 恢复为 interrupted，对齐 PE-08 T08.6 语义）→ 断言会话树渲染、消息回灌、终态标注。
  3. `tests/e2e/settings-persist.spec.ts`：**设置保存 → 重启 → 状态一致**。mock `config_get/config_set`（Rust 真源语义，PE-01 T03.2 后）+ localStorage 标记 → 改设置 → `page.reload()` → 断言设置面板值回显、无「待同步」提示（PE-01 T02.2 验收语义）、LS 无明文 key（PE-07 T07.4 语义）。
  4. `tests/e2e/streaming-render.spec.ts`：**流式渲染专项**。逐 delta 推送含未闭合 fence 的 markdown → 断言流式期 DOM 出现 `md-code-block`（软渲染）、无纯文本闪烁（对比 PE-02 E2 现状）；完成后 finalize 收敛为 rustHtml 结构（PE-02 T02.4 语义）。
- **产出**：4 个 spec 文件 + README testid 契约 + 双 config 归一 + native-smoke 重写。
- **验收**：
  - V1 `npx playwright test tests/e2e`（根 config）全绿；每个 spec 断言为行为级（非空跑）；
  - V2 双 config 归一后 `npm --workspace @crish/crish-desktop run test:visual` 只扫 `tests/visual`；
  - V3 `rg "ws://127.0.0.1|daemon|WebSocket" tests/e2e` 零命中（陈旧断言清零）；
  - V4 native-smoke 重写版绿：二进制拉起 + 退出干净（`tasklist`/`process.kill(pid,0)` 断言）；
  - V5 testid 清单文档化（README），场景所需 testid 全部存在（`grep` 可查）。
- **依赖**：PE-01（设置真源语义）、PE-03（命令面）、PE-08（恢复语义）落地后断言口径才成立；场景 1/4 依赖 PE-02/PE-09 流式契约（delta 事件形状，T02.1）。可先以「mock 事件按当前协议形状」开发，联调口径后置。

### T11.2 visual 回归门禁（PE-05 样式重构期间）

- **目标**：PE-05 迁移期（tokens.css 227+ 硬编码收敛、双轨 css 合并）的视觉回归门禁：可重复截图基线 + diff 阈值 + 人工复核流程，防止「改样式改坏布局」无感知（AU-02 §五.4 点名 PE-05 引用 test:visual 无任务维护）。
- **方案**：
  1. **基线与稳定化**：扩展现有 `apps/crish-desktop/tests/visual/app.spec.ts`（当前 3 张截图无基线管理）。稳定化三件套：mock Tauri invoke（复用 T11.1 L2 模式，ui-store-invariants.spec.ts:75-101）、固定 viewport（`resize_page` 或 config `viewport` 1280×800）、`beforeEach` 注入 `document.fonts.ready` 等待 + 全局禁动画 CSS（`*{animation:none!important;transition:none!important}`）。基线入库 `apps/crish-desktop/tests/visual/__screenshots__/`（提交到 git）。
  2. **阈值与更新流程**：`toHaveScreenshot({ maxDiffPixelRatio: 0.01 })`（1% 像素差阈值，容忍抗锯齿抖动）；更新命令 `npm --workspace @crish/crish-desktop run test:visual:update`（已有脚本）；**golden 变更必须显式审查**：PR 中 diff 图随截图附件，评审人确认后方合并（对齐 PE-03 T03.8「golden 变更必须显式更新」精神）。
  3. **首版 story 清单（8 个）**：初始布局（含侧栏+主区）、侧栏会话列表（3 会话 mock）、设置面板（模型 tab）、聊天消息（纯文本）、fence 代码块（含未闭合软渲染态）、表格、工具调用卡、暗色主题（`prefers-color-scheme` 注入）。
  4. **PE-05 联动条款**：每个 pane/组件迁移单元（PE-05 T05.1.2/5.2/5.3/5.5 逐套）提交前跑 visual——迁移前后各拍一次，diff 归零或人工确认（对应 PE-05 自身「视觉目检」要求，将其升级为自动化基线）。
- **产出**：story 扩展、稳定化 helper（`tests/visual/helpers.ts`：mock invoke 注入 + 字体/动画等待）、基线截图入库、README 更新。
- **验收**：
  - V1 `npm --workspace @crish/crish-desktop run test:visual` 全绿且基线已入库（`git ls-files | grep __screenshots__` 非空）；
  - V2 人为注入样式回归（如把主色改错）→ 套件失败（阈值生效的负例验证）；
  - V3 PE-05 迁移单元清单与 visual 跑测记录关联（迁移日志或 PR 截图附件）；
  - V4 与 F5 snapshot 层不重叠：渲染树快照继续归 `tests/snapshots`，visual 只做像素级。
- **依赖**：T11.1（config 归一、mock 模式复用）；PE-05 各迁移单元（配合执行，不阻塞 PE-05 开工——story 先立基线）。

### T11.3 契约测试统一规范（AU-03 冻结表 + PE-03 golden + 事件 schema 版本化）

- **目标**：把「接口冻结 → 契约测试 → golden 管理」立为统一规范，覆盖：① AU-03 P1 跨 PE 接口冻结表（产出后）② PE-03 T03.8 IPC golden ③ PE-02 T02.1 流式契约锚点 ④ AU-02 §五.5 事件 schema 版本化空白。
- **T11.3.1 冻结表契约测试归属与运行方式**：
  - 冻结表（五张：命令命名 / CoreStatus 字段 / 错误类型 / 写模型 / 流式契约与阈值，AU-03-executability-audit.md:290）由 PE-01/03/04/06/08/09 会签产出后，**本任务负责其测试化落地**：
    - 命令命名表 → `apps/agent-workbench/src-tauri/tests/ipc_contract/golden/<cmd>.{ok,err}.json`（PE-03 T03.8 已定目录，本任务不再另起）；
    - CoreStatus 字段表 → `core_get_status` golden 断言字段名与缺省语义（PE-01 T01.2 / PE-03 联动）；
    - 错误类型表 → 77 码映射全表测试（conex-types 单测，PE-03 T03.3 已有映射任务）；
    - 写模型表（upsert vs 全量）→ conex-db upsert 语义测试（PE-08 T08.1/T08.2 + PE-09 T09.4）；
    - 流式契约表 → `crates/session-loop/tests/streaming_incremental_contract.rs`（T02.1 锚点）**回归门禁**：每轮 `cargo test -p session-loop` 必含，禁止带 `#[ignore]` 或 skip 合并。
  - 运行方式统一：契约测试 = **命令函数直调（构造 State，不依赖 Tauri runtime）** + golden JSON 快照比对；golden 变更 = 显式更新快照文件 + 契约文档 changelog 同步（PE-03 T03.9）；拒绝「更新后隐式吞 diff」。
- **T11.3.2 事件 schema 版本化（AU-02 §五.5 空白承接）**：
  - 产出 `docs/rust-rewrite/contracts/event-schema-changelog.md`（版本 | 事件 | 字段变更 | 兼容性 | 依据），初始条目登记 AgentEvent 25 类型（PE-03 契约文档旁挂）；
  - 旧事件兼容测试：`crates/conex-types/tests/` 新增 `fixtures/events/`（v1 旧载荷 JSON 样本：字段重命名/新增可选字段/删字段三类）→ roundtrip 断言**新代码可解析旧载荷**（缺失字段走默认值）、未知字段忽略不报错；
  - 与 PE-04 R4「旧事件兼容解析」风险缓解合并验证：orchestrator 重放 fixture 库（v1 事件 JSON）→ 断言不 panic、终态收敛正确。
- **验收**：
  - V1 冻结表五张全部落地为测试锚点（每表 ≥1 个断言文件，行号可查）；
  - V2 golden 目录结构与 PE-03 T03.8 完全一致，无第二套；`cargo test -p agent-workbench` 契约套件全绿；
  - V3 流式契约锚点 4 用例（增量性/收敛性/取消保留/传输错误）全绿且无 skip；
  - V4 事件 changelog 文档存在且覆盖 25 类型；旧载荷 fixture ≥6 个，roundtrip 全绿。
- **依赖**：PE-03（T03.8/T03.9 落地）、PE-02 T02.1（锚点文件）、AU-03 P1 冻结表（会签产出后）、PE-08（写模型终稿）。

### T11.4 首 token 延迟验收（owner 认领 + 阈值裁决 + 测量方法）

- **目标**：消除 AU-02 §五.9「PE-02 与 PE-09 互等」；统一 AU-03 C4 三套阈值；给出可重复测量方法与单一基线存档。
- **T11.4.1 owner 单一化**：
  - **G3 首 token 总验收 owner = 本任务 T11.4**。PE-02 T02.6（「与 PE-09 联调时执行」）与 PE-09 T09.8（「与 PE-02 联调时执行」）的表述**由本任务统一收口**：两书分别只做「前端埋点基线（T02.6）」与「Rust 侧集成测试与基准数据（T09.1/T09.7）」的**数据提供方**；合判定由 T11.4 执行者完成（验收不通过则回退到对应数据方修复，职责表写进 §4）。
  - 交接时点：PE-09 T09.7 基线产出后 + PE-02 T02.6 埋点上线后，触发 T11.4 一次正式测量。
- **T11.4.2 阈值统一裁决（AU-03 C4）**：三层口径，各管各的验收，不再混用：

| 口径 | 阈值 | 测量方法 | 归属 |
|---|---|---|---|
| **C1 断言级**（CI 集成测试） | 首条 `message-delta` 到达事件桥 **< 600ms**（mock SSE 分块慢发：首 token 500ms、总时长 5s） | `apps/agent-workbench/src-tauri/tests/` TTFB 集成测试（PE-09 T09.7.2 已定义，`serve_sse` 模式） | PE-09 T09.1 验收保持不动 |
| **C2 目标级**（端到端测量） | `requestToFirstChunkMs` **p95 < 500ms** | `recordStreamDiag` scope `ttft` 埋点（PE-02 T02.6 已定义）+ mock 增量源 | PE-02 T02.6 口径保持；由 T11.4 合判定 |
| **C3 期望级**（优化方向） | 首条 delta 在流产出后 **≤ 300ms** 到达事件桥 | 同 C1 测量，作为回归看板项 | PE-09 G1 原表述**降级为期望值**，不作为验收硬门槛（避免 CI 抖动导致门禁不可达） |

  裁决记录：三套数字不再互斥——C1 是「能不能过门禁」，C2 是「用户端好不好」，C3 是「优化方向」；任一任务书引用首 token 阈值时按上表指明口径编号。
- **T11.4.3 测量方法与产出**：
  - 本地 mock SSE：复用 `serve_sse`（`crates/agent-provider/src/transport/mod.rs:73-100`），固定分块参数（块大小 32B、间隔 50ms、首 token 延迟 500ms、总时长 5s）——**参数写入 T11.4 产物，杜绝 AU-03 指出的「mock 源 emit 时序未定」**；
  - 前端埋点：`useStreamCallbacks.ts` onChunk 首次触发记 `firstChunkAt`（PE-02 T02.6 已列），输出 `ttft` scope；
  - **基线存档单一化**：`docs/rust-rewrite/plans/PE-02-perf-baseline.md` 为唯一存档（PE-02 T02.6 指定）；PE-09 T09.7.3 的「或单独 PE-09-benchmarks.md」二选一**裁决为前者**，PE-09 基准数据并入同一文件（避免双份存档漂移，AU-03 P8）。
  - 产出：测量运行说明（命令 + 环境变量）、首测基线报告、阈值裁决记录（本文件 §T11.4.2 即记录）。
- **验收**：
  - V1 owner 表生效：T11.4 执行者在两书数据齐备后 1 轮内产出合判定报告（含 C1/C2/C3 三行数据）；
  - V2 mock SSE 参数固定化（文档可复现）；C1 测试在 CI 绿（PE-09 完成后）；
  - V3 C2 端到端 p95 数据入档；基线文件唯一（`git ls-files | grep -i baseline` 只 1 个 PE-02-perf-baseline.md）；
  - V4 复测流程文档化：后续性能轮（含 PE-11 自身 T11.6）复用同一方法。
- **依赖**：PE-09（T09.1/T09.7）、PE-02（T02.1 mock 源/T02.6 埋点）。

### T11.5 迁移/升级测试（DB v3→v4、localStorage→DPAPI、升级指南）

- **目标**：承接 AU-02 §五.6 空白——用户数据侧升级/迁移有统一测试场景 + 统一文档；与 PE-01/PE-07/PE-08 已有实现任务互补（本任务补**升级端到端**与**用户视角验收**，不重复实现）。
- **T11.5.1 DB 迁移升级测试（v3→v4）**：
  - PE-08 T08.7 已定 `tests/migrations.rs`（v1/v2/v3 fixture → v4、`user_version` 驱动、备份、中断重试，PE-08-data-persistence-plan.md:391-396）——本任务补**升级端到端场景**：预置真实 v3 库 fixture（含会话/消息/事件脏数据）→ 走真实启动路径（`LocalDb::open` 全链）→ 断言：升级后 `user_version=4`、会话树/消息完整可见（前端 hydrate 断言或 DB 层行数断言）、备份文件存在、二次启动幂等；
  - 场景与验收表（对齐 PE-08 3.1 节，本任务仅作门禁归属登记，不新写实现）。
- **T11.5.2 localStorage→DPAPI 密钥迁移测试**：
  - PE-01 T03.3（migrateLegacyProfiles 三用例：成功/失败重试/幂等）+ PE-07 T07.4（workbench_profile_apply 迁移编排）已覆盖单测——本任务补**迁移失败回退的 e2e 场景**（settings-persist.spec.ts 扩展或独立 spec）：注入「DPAPI 写失败」mock → 断言迁移报错可见（非静默失败，AA-07 教训）、LS 明文保留不删（可重试）、重启后再次尝试；
  - 断言 LS 无明文 key 的 grep 门禁：`rg "apiKey" apps/crish-desktop/src/api/provider-profiles` 无赋值残留（PE-07 T07.4 语义）。
- **T11.5.3 统一升级指南文档（AU-02 §五.6 空白本体）**：
  - 产出 `docs/rust-rewrite/UPGRADING.md`（用户数据侧唯一迁移清单），内容：① 密钥迁移（localStorage→DPAPI，何时触发、失败可见性、回退）② DB schema 迁移（v3→v4，备份机制 `sessions.db.bak-v{n}`、中断恢复）③ config 目录迁移（旧 `%APPDATA%\Crish\AgentWorkbench` → 新根，PE-01 T05.2）④ workspace 重新授权（PE-07 风险 3）⑤ 各迁移的验证步骤（升级后如何自查：启动日志关键字 / 设置页状态诊断）；
  - 与各实现任务书双向引用（PE-01 T03.3/T05.2、PE-07 T07.4、PE-08 T08.7），升级指南为**用户侧唯一文档 SoT**。
- **验收**：
  - V1 升级 e2e 场景绿：真实 v3 fixture 升级后数据可见（断言行数 + 前端回灌）；
  - V2 密钥迁移失败回退场景绿（三态：成功/失败重试/幂等 + 明文保留）；
  - V3 UPGRADING.md 存在，5 项迁移条目齐全且每条含可执行验证命令；
  - V4 各任务书（PE-01/07/08）中「迁移说明」统一指向上级指南，无第二份用户侧迁移文档。
- **依赖**：PE-01（T03.2/T03.3/T05.2）、PE-07（T07.4）、PE-08（T08.7）。

### T11.6 压力测试（Rust 侧补齐）

- **目标**：现有 `tests/stress/` 为纯 TS/node 场景（stress-ai-stream/diff-load/session-switch，`stress-runner.ts` 全 JS），**不触 Rust 侧**——补 Rust 侧压力测试：长会话、并发 run、事件桥吞吐，形成 TS+Rust 双轨压力体系。
- **Rust 侧新增场景（`#[ignore]` + release 运行，避免拖慢常规 CI）**：
  1. **长会话**：`crates/orchestrator/tests/stress_long_session.rs`——faux provider 脚本驱动 500/5000 条消息的 run（多轮 goal 续轮），断言：事件序列连续（对齐 PE-08 T08.8）、终态唯一、`record_message` 路径无超线性劣化（配合 PE-09 T09.3 基准）；内存不上限断言可后置。
  2. **并发 run**：`crates/orchestrator/tests/stress_concurrent_runs.rs`——① 同会话 4 路并发 run（sequence 分配竞争，AA-01 Q23 场景前置，依赖 PE-08 T08.8 落地）② 跨会话 16 路并发；断言：无 sequence 冲突（无 UNIQUE 失败）、事件队列吞吐不退化、终态记录完整。
  3. **事件桥吞吐**：`apps/agent-workbench/src-tauri/tests/stress_event_bridge.rs`——高密度 delta（1000 条/秒级 mock 流）下断言 buffer 丢帧策略（Delta→Soft 优先丢、Critical 永不丢，buffer.rs:41-58 语义）不丢 terminal。
  4. **DB 写并发**：`crates/conex-db/tests/stress_write.rs`——多线程 append + upsert 混合（WAL 模式），断言无锁冲突崩溃、行数准确（配合 PE-09 T09.4 写放大基准）。
- **运行与注册**：
  - 命令：`cargo test --workspace --release --locked --test 'stress_*' -- --ignored` + `cargo test -p crish-agent-workbench --release --locked --lib -- --ignored stress_`（压力场景均 `#[ignore]` 标记，清单与选择规则见 `PE-11-ignored-tests-inventory.md`）；单场景 `cargo test -p session-loop --release --test stress_long_session -- --ignored --nocapture`；
  - `tests/stress/README.md` 更新为「TS 压力（前端 UI） + Rust 压力（引擎）」双轨注册表：场景名/文件/命令/时长/通过阈值；
  - `npm run stress` 保持 TS 轨；新增脚本 `npm run stress:rust` 串接 release ignored（时长预算 ≤10 分钟）。
- **阈值（首个版本，允许后续按数据修正）**：长会话 500 消息 run 驱动 ≤60s（release）；并发 16 run 无序列冲突；桥压力 terminal 零丢失；DB 混合写 10k 行无崩溃。
- **验收**：
  - V1 4 个压力场景文件存在且 `--ignored` 下可跑（release 绿）；
  - V2 阈值断言表（上表）逐项成立，失败时输出量化数据（对齐 stress-runner.ts 的 PASS/FAIL 输出风格）；
  - V3 README 注册表完整；`npm run stress:rust` 可一键运行；
  - V4 常规 CI（debug）不受影响（`#[ignore]` 生效，`cargo test --workspace` 不含压力场景）。
- **依赖**：PE-08 T08.8（sequence 分配，场景 2 前置）、PE-09（T09.3/T09.4 优化落地后阈值才可达，压力场景可与优化并行开发、阈值按优化后数据定）。

### T11.7 测试基础设施与 CI 门禁（conex-test-utils 扩展 + 注入时钟 + CI 分层）

- **目标**：把测试基建补齐为全仓公共能力（AU-02 §六.3 建议的「测试基础设施域」落地），并给出 CI 分层门禁建议。
- **T11.7.1 conex-test-utils 扩展**（`crates/conex-test-utils/src/lib.rs` 增补）：
  1. `TempWorkspace` 增强：`keep_on_failure()`（`CONEX_TEST_KEEP=1` 或失败路径保留目录打印路径）、`copy_fixture(from, to)`（fixture 目录复制）、`path_str()` 便捷返回；
  2. 断言助手（05 §6.2 建议一等公民化）：
     - `assert_event_sequence(events: &[AgentEvent], expected_type_names: &[&str])`——事件序列类型名断言（T09.2 的 roundtrip 与序列连续性复用）；
     - `assert_message_delta_concatenation(deltas, final_text)`——message-delta 拼接 == message-end 全文（PE-02 契约 T2 收敛性直接复用）；
     - `assert_provider_requests(requests: &[ProviderRequest], n, contains: &str)`——第 n 次请求含指定文本（nudge 文案断言，05 §6.2 `assert_request_text_contains` 对应）；
     - `assert_no_clone` 审查助手（静态 grep 脚本化：驱动 T09.2「无 .clone()」审查断言进 CI 脚本，非运行时）。
  3. 注意：`AgentEvent` 等类型在 conex-types——助手放 `conex-test-utils` 但以 generic/trait 形式（`T: serde + PartialEq`），或直接扩展 conex-types 测试域；实现时二选一，禁止引入循环依赖（conex-test-utils 不得依赖 session-loop/orchestrator）。
- **T11.7.2 TestClock 注入时钟（AA-01 Q41 承接）**：
  - 波及面（先 grep 登记）：orchestrator retry/backoff、agent-provider 退避、session-loop 超时判定（时间敏感测试现用真实时钟，偶发失败）；
  - 方案：`conex-test-utils` 提供 `TestClock`（可手动推进 / tokio `time::pause` 包装 / 递增计数），涉及超时与退避的测试统一注入；生产代码不新增时钟参数（仅测试替身与依赖注入点，判定为「测试域改动，不进生产 API」）——如某模块生产路径无注入点，则用 `tokio::time::pause()` 包测试体（最小侵入）；
  - 验收：时间敏感测试 flaky 归零（连续 5 次运行无失败）。
- **T11.7.3 断言/时钟的接入清单**：PE-09 T09.2/T09.3 断言、PE-02 契约 T2、orchestrator retry 套件——本任务产出助手 + 迁移既有用例（迁移只换断言函数，不改行为）。
- **T11.7.4 CI 门禁建议（分层，含时长预算）**：

| 层 | 触发 | 内容 | 时长预算 |
|---|---|---|---|
| 快层 | 每次提交 | `cargo test --workspace` + `cargo clippy --workspace` + `npm test`（workspace vitest）+ `npm run typecheck` | ≤15 min |
| 中层 | PR / 每轮汇总 | 契约套件（`-p agent-workbench` + 锚点）、snapshot、`test:integration`/`test:fuzz`、`npx playwright test tests/e2e`（L2） | ≤20 min |
| 慢层 | nightly + 发布前 | visual（`test:visual`）、`npm run stress` + `npm run stress:rust`（release ignored）、`cargo bench`、native-smoke、T11.4 首 token 验收（C1） | ≤40 min |

  建议落地形式：GitHub Actions 三 workflow（或现有 CI 配置扩展）；本任务只给**建议与命令**，CI 编排改动可并入 PE-10 或独立小任务（登记遗留）。
- **验收**：
  - V1 conex-test-utils 新助手全部有自测（扩展自身 `#[cfg(test)]`）；
  - V2 迁移 ≥3 个既有用例使用新助手（event_sequence / delta_concatenation / requests）且行为不变（测试结果等价）；
  - V3 时间敏感测试连续 5 次运行零 flaky；
  - V4 CI 分层表成文（本文件 §2 即 SoT），命令全部可复现执行；
  - V5 无循环依赖：`cargo check --workspace` 绿（conex-test-utils 不反向依赖业务 crate）。
- **依赖**：无硬依赖；助手被 T11.3/T11.4/T11.6 复用（排最前，§4 阶段 0）。

---

## 3. 验证清单（可勾选执行）

### T11.1 前端 e2e
- [ ] `npx playwright test tests/e2e` 全绿（4 个新 spec + ui-store-invariants）
- [ ] 双 config 归一：visual config 只扫 `tests/visual`
- [ ] `rg "ws://127.0.0.1|daemon|WebSocket" tests/e2e` 零命中（陈旧断言清零）
- [ ] native-smoke 重写：二进制拉起 + 干净退出断言绿
- [ ] README testid 契约文档化，场景所需 testid 全部存在

### T11.2 visual 回归
- [ ] `test:visual` 全绿；基线截图已入库（git ls-files 非空）
- [ ] 负例验证：注入样式回归 → 套件失败
- [ ] PE-05 迁移单元前后 diff 记录（迁移日志/PR 附件）
- [ ] 8 个 story 全量拍摄（含暗色/软渲染 fence/表格/工具卡）

### T11.3 契约规范
- [ ] 冻结表五张 → 测试锚点文件（每表 ≥1 断言）
- [ ] golden 目录与 PE-03 T03.8 一致；`-p agent-workbench` 契约套件绿
- [ ] 流式契约锚点 4 用例绿、无 skip
- [ ] 事件 changelog 覆盖 25 类型；旧载荷 fixture ≥6，roundtrip 绿

### T11.4 首 token 验收
- [ ] owner 表生效（本任务单一 owner；PE-02/PE-09 数据提供方角色写明）
- [ ] 阈值裁决表（C1<600ms / C2 p95<500ms / C3 ≤300ms 期望）落地本文件
- [ ] mock SSE 参数固定化（分块 32B/间隔 50ms/首 token 500ms/总 5s）
- [ ] 基线存档唯一（PE-02-perf-baseline.md）；首测报告三行数据齐全

### T11.5 迁移/升级
- [ ] 升级 e2e：真实 v3 fixture → 数据可见（行数 + 前端回灌）绿
- [ ] 密钥迁移失败回退三态绿 + LS 明文 grep 零残留
- [ ] UPGRADING.md 5 项条目齐全、每条含验证命令

### T11.6 压力测试
- [ ] 4 个 Rust 压力场景 release `--ignored` 绿（长会话/并发 run/桥吞吐/DB 写）
- [ ] 阈值断言表成立（500 消息 ≤60s、16 run 无序列冲突、terminal 零丢失、10k 行无崩溃）
- [ ] README 双轨注册表；`npm run stress:rust` 一键可跑
- [ ] debug CI 不受影响（`#[ignore]` 生效）

### T11.7 基础设施/CI
- [ ] conex-test-utils 新助手自测绿；≥3 用例迁移等价
- [ ] TestClock 接入；时间敏感测试 5 连跑零 flaky
- [ ] CI 分层表（快/中/慢 + 时长）成文
- [ ] `cargo check --workspace` 绿（无循环依赖）

---

## 4. 执行顺序与依赖

### 4.1 依赖图

```
阶段 0（基建，最先）：
  T11.7 conex-test-utils 扩展 + TestClock        ← 无依赖；T11.3/4/6 复用

阶段 1（前端门禁，PE-05 前置）：
  T11.1 e2e 策略（依赖 PE-01/03/08 语义口径，可先 mock 开发）
  T11.2 visual 门禁（依赖 T11.1 config 归一，story 先立基线）   ── 并行
      └─→ PE-05 各迁移单元配合跑 visual（不阻塞 PE-05 开工）

阶段 2（契约与验收口径）：
  T11.3 契约规范（依赖 PE-03 T03.8/T03.9、PE-02 T02.1、AU-03 P1 冻结表）
  T11.4 首 token 验收（依赖 PE-09 T09.1/T09.7 + PE-02 T02.6 埋点；触发点 = 两书数据齐备）

阶段 3（迁移与压力）：
  T11.5 升级测试（依赖 PE-01/07/08 实现落地）
  T11.6 Rust 压力（场景 2 依赖 PE-08 T08.8；阈值按 PE-09 优化后数据定）

阶段 4（收口）：
  全量验证清单（§3）逐项勾选；更新 00-master-plan.md §4 副文档状态表与 §5 轮次表
```

### 4.2 并行与冲突规则

| 规则 | 说明 |
|---|---|
| 串行强制 | T11.1 → T11.2（config 归一前置）；T11.3 → T11.4（契约口径稳定后验收才有意义） |
| 文件 owner | `tests/e2e/*` 全部 T11.1 唯一 owner（T11.2 只读视觉目录）；`playwright.config.ts` 两文件 T11.1 owner；`conex-test-utils/src/lib.rs` T11.7 owner |
| 与 PE 各书重叠面 | golden 目录归 PE-03 T03.8（本任务只登记门禁不建目录）；`streaming_incremental_contract.rs` 归 PE-02 T02.1（本任务只加回归门禁）；migrations.rs 归 PE-08（本任务只加升级 e2e，新文件 `tests/e2e/` 前端侧无冲突） |
| 时钟改动 | TestClock 只动测试代码；若发现需动生产注入点，先登记到 30-verification-checklist，不擅改生产 API（T11.7.2 边界） |

### 4.3 与既有任务书的交接（owner 表）

| 交接点 | 数据提供方 | 判定方（owner） | 说明 |
|---|---|---|---|
| 首 token C1 集成测试数据 | PE-09 T09.1/T09.7 | **T11.4** | 合判定报告由 T11.4 出 |
| 首 token C2 端到端数据 | PE-02 T02.6（ttft 埋点） | **T11.4** | 同上 |
| IPC 契约 golden 套件 | PE-03 T03.8 | T11.3（运行门禁） | 规范不重复实现 |
| DB 迁移单元测试 | PE-08 T08.7 | T11.5（升级 e2e + 文档） | 互补 |
| 密钥迁移单测 | PE-01 T03.3 / PE-07 T07.4 | T11.5（失败回退 e2e） | 互补 |
| 基准数据 | PE-09 T09.7 | T11.4（存档归口） | 基线文件唯一化 |

---

## 5. 遗留问题与登记（本任务不承接）

| # | 项 | 去向 |
|---|---|---|
| 1 | AA-05 范围外 10 项 + AA-06 P9/P10/F5/F6/M1 + AA-01 Q22/Q28/Q39 + AA-02 S-7/S-11/S-17/S-18 + AA-03 Q14（AU-02 §六.3 P2-8） | 登记到 `30-verification-checklist.md`（待办登记表），每项注明决议与负责轮次 |
| 2 | CI 三层 workflow 编排（GitHub Actions 具体配置） | 本任务只给命令与预算；编排改动并入 PE-10（依赖/构建域）或独立小任务 |
| 3 | `tests/e2e/ui-store-invariants.spec.ts` 的 app 内重复拷贝（apps/crish-desktop/tests/e2e/） | T11.1 归一 config 时删除拷贝（grep 双份断言零残留） |
| 4 | 覆盖率阈值差异化（压力/契约层豁免清单） | 待 T11.6 场景落地后评估，登记 30-verification-checklist |
| 5 | AU-03 P1 冻结表本体 | 由 PE-01/03/04/06/08/09 会签产出（P1 既定）；本任务 T11.3.1 已定义其测试化落地 |

---

*本任务书基于 2026-08-01 仓库快照只读研究产出；文件路径与行号可在仓库复核。完成后更新 00-master-plan.md §4 副文档状态表（本文件状态置 ✅ 已建立）并登记轮次。*
