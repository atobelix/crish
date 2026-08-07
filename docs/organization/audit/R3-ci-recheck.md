# R3 CI 复核报告（Round 1 F10-testing-gates-audit 实跑复验）

- 复核日期：2026-08-07
- 复核方式：独立只读复核——静态核读 + 关键门禁命令**实跑**（本机 win32 / node 20 / vitest 3.2.7 / cargo 编译验证），未改动任何代码
- 复核对象：`docs/organization/audit/F10-testing-gates-audit.md` 八项清单
- 与 F10 结论对照口径：✅ 真（F10 正确）/ ❌ 假（F10 错误）/ ⚠️ 部分（方向对、细节出入）

---

## 结论总览

| #   | 项                        | F10 结论    | R3 复核结论                                                                   |
| --- | ------------------------- | ----------- | ----------------------------------------------------------------------------- |
| 1   | ci-mid test job 必红      | P0 必红     | ✅ 真（实测 EXIT=1，21 文件全失败）                                           |
| 2   | test:integration 启动即崩 | P0 必红     | ✅ 真（实测 Startup Error，EXIT=1）                                           |
| 3   | tests/stress 零生产代码   | P0 空转     | ✅ 真（import 链仅 Node 内置 + 自引用）                                       |
| 4   | coverage 双口径必红       | P1 不可调和 | ✅ 真（实测 0.16% < 70%，EXIT=1）                                             |
| 5   | --locked 仅 1/8           | P1          | ✅ 真（实际 1/7，方向正确、计数微差）                                         |
| 6   | bench 空转                | P1 恒 echo  | ❌ **假**（5 个 criterion bench 已入库且可编译；TS bench 已入 perf-test.yml） |
| 7   | knip 未接线               | P1 零守护   | ✅ 真（无依赖/无脚本/无 job；实跑 EXIT=1）                                    |
| 8   | 双口径 37/37 全绿         | 已修复      | ✅ 真（实测 37/37 EXIT=0）                                                    |

**R3 最重要的纠偏：F10-07（bench 空转）为假。** `crates/*/benches` 存在 5 个已入库的 criterion 基准文件（2026-08-02 至 08-05 提交，早于 F10 审计日），4 个 crate 均声明 `criterion = { workspace = true }` 为 dev-dependency，`cargo bench --workspace --no-run` 实跑编译成功（EXIT=0）。F10 声称"0 目录 / criterion 无消费者 / 恒 echo"与实际仓库状态不符。此外 F10 的 workflow 扫描漏掉了 `perf-test.yml`（PR 即触发 TS benchmark + stress + PR comment），"TS bench 未入任何 CI"亦不成立。

---

## 一、ci-mid test job 必红（F10-01）— ✅ 真

**原结论**：vitest e2e 项目（vitest.config.ts:101-115）include `tests/e2e/**/*.spec.ts`，收集 Playwright spec 加载即抛 `Playwright Test did not expect test.describe()`，中层 `npm run test`（ci-mid.yml:82）确定性必红。

**静态验证**：

- `vitest.config.ts:101-115` 确认 e2e 项目 include：`'**/__tests__/e2e/**/*.test.ts'`、`'tests/e2e/**/*.spec.ts'`、`'tests/e2e/**/*.test.ts'`；
- `ci-mid.yml:82` 确认 `- run: npm run test -- --reporter=verbose`，且注释（:76-81）自认"e2e 项目 vitest include 命中 Playwright spec（test.describe 与 vitest 运行器冲突，预存问题），无法在 vitest 下运行"——**知病未医**；
- `tests/e2e/` 现有 21 个 spec/test 文件（ast-block-tables / format-checker / ime-composition / keyboard-navigation / wysiwyg-interaction 等均在列）。

**实跑**：`npx vitest run --project e2e`（超时 180s）

```
Test Files  21 failed (21)
     Tests  1 failed | 1 passed (2)     EXIT=1
错误：test.describe() ... tests/e2e/wysiwyg-interaction.spec.ts:3:6
另见 tauri-native-smoke.spec.ts:194 taskkill 本机失败（L3-2，win32 特有）
```

**确认**：真。21/21 文件全失败，EXIT=1——中层 test job 在 CI（ubuntu）上必然同样崩溃，且 `npm run test` 默认跑全部项目含 e2e，必红成立。注：F10 报"22 个文件失败"，当前 e2e 目录仅 21 个 spec/test 文件（口径差或文件数变动，不影响结论）。

**修复建议**（沿用 F10）：e2e 项目 exclude `tests/e2e/**`；中层新增真 Playwright job（`npm run test:e2e`）；或在 ci-mid 注释处把该"预存问题"兑现为修复。

---

## 二、test:integration 启动即崩（F10-02）— ✅ 真

**原结论**：`vitest.workspace.ts:11` 为 stub `export {}` 非 default array；`vitest.integration.config.ts` 无 `test.projects`；vitest 3.2.7 启动解析 workspace 文件即崩。

**静态验证**：

- `vitest.workspace.ts` 全文 11 行确认：第 11 行 `export {};`，注释自述"已废弃（2026-08-03 迁移至 test.projects）…待确认无工具链引用后经回收站删除"；
- `vitest.integration.config.ts` 全文 8 行确认：仅 `include: ['apps/crish-desktop/tests/integration/**/*.test.ts']`，**无 `test.projects`**——与 vitest.workspace.ts 配合即触发 workspace 解析路径。

**实跑**：`npx vitest run --config vitest.integration.config.ts`（超时 180s）

```
DEPRECATED The workspace file is deprecated and will be removed in the next major.
Startup Error
TypeError: Workspace config file "C:/Software/conex/vitest.workspace.ts"
must export a default array of project paths.
    at Vitest.resolveProjects ... EXIT=1（0 用例执行）
```

**确认**：真。启动即挂，与 F10 完全一致。附：ci-mid.yml:94 注释声称 F3 层含 "integration/fuzz/race/recovery"，但 config include 仅 integration 子目录，fuzz/race/recovery 在 `tests/` 根下为空目录（静态核对），注释与实现不符（F10 已指出，复核证实）。

**修复建议**（沿用 F10）：vitest.integration.config.ts 迁移到 `test.projects`（对齐 vitest.config.ts 模式）；或删除 vitest.workspace.ts stub（vitest.config.ts 已用 projects，需先确认无工具链引用，注释中已自认待删）；顺带对齐 ci-mid.yml:94 注释与实际 include。

---

## 三、tests/stress 零生产代码（F10-03）— ✅ 真

**原结论**：三个压力场景只做 TextEncoder/JSON.stringify/Set 差集等 Node 内置操作，不 import 任何生产代码，"压力轨"名义存在。

**静态验证**（全量 import 链核读，tests/stress/ 5 文件）：

- `stress-ai-stream.ts:1`：`import { runStressTest, SeededRandom, type StressScenario } from "./stress-runner"`——随机字符 → `TextEncoder/TextDecoder` 往返（:14-15）；
- `stress-diff-load.ts:1`：同只 import "./stress-runner"——字符串 Set 差集 + startsWith 统计（:33-46）；
- `stress-session-switch.ts:1`：同——JSON.stringify/join/parse 循环（:29-34）；
- `stress-runner.ts:1-2`：仅 `node:perf_hooks` + `node:fs`（写 perf-report/ 报告）；
- `run-all-stress.ts`：仅聚合上述自引用。

全链 **0 个生产包 import**（grep `import|from` 仅命中上述 10 处）。"FPS"确为 Node 循环迭代吞吐（stress-runner.ts:120-130 按 ops 计），内存/延迟阈值（maxHeap 200-300MB、p95 100-200ms）在现代机器上 trivially 通过。任何 chatBridge/stream/store/引擎回归都不会让该套件变红。

**确认**：真。零产品接触成立（F10 未实跑该套件、仅源码判定，R3 以静态全链核读支持其判断，风险判断不受实跑影响）。

**修复建议**（沿用 F10）：压力场景驱动真实生产路径（import chatBridge / StreamRenderBuffer / eventParser + 引擎事件流回放），或删除并声明"压力靠 Rust #[ignore] 层 + e2e"。注意：perf-test.yml 的 stress-test job 同样跑 run-all-stress.ts（PR 触发），修复一处两处生效。

---

## 四、coverage 双口径必红（F10-05）— ✅ 真

**原结论**：app-dir 模式 `coverage.enabled=true` + 阈值 70/60/65/70 使任何 scoped run 必红；root/CI 口径 `enabled=false` + 45/70/65/45 不可调和。

**静态验证**：

- `apps/crish-desktop/vitest.config.ts:10-18`：`coverage: { provider: 'v8', enabled: true, thresholds: { statements: 70, branches: 60, functions: 65, lines: 70 } }`，且无 `exclude` 覆盖 app 测试自身（:19-25 exclude 不含 `**/*.test.*`）；
- `vitest.config.ts:29-52`：`coverage: { enabled: false, ... thresholds: { 45, 70, 65, 45 } }`。

**实跑**（app 目录，不带 `--coverage.enabled=false`）：

```
npx vitest run src/components/ui/Menu/Menu.lowViewport.test.tsx
用例 5/5 全过，但：
ERROR: Coverage for lines (0.16%) does not meet global threshold (70%)
ERROR: Coverage for statements (0.16%) does not meet global threshold (70%)
EXIT=1
```

**确认**：真。app-dir 任何 scoped run 必红（0.16% < 70% 为必然），与 F10 实证完全一致。IDE/开发者在 app 目录的任何 vitest 操作均见红，报告失真。

**修复建议**（沿用 F10）：二选一——app-dir 配置改 `coverage.enabled=false` + 阈值对齐 root，或删 app-dir 配置并显式声明唯一口径（root+CI）；52 个无 `@vitest-environment jsdom` 头的 .tsx 统一补头（两模式结果分叉的模式性风险）。

---

## 五、--locked 仅 1/8（F10-06）— ✅ 真（计数微差：实际 1/7）

**原结论**：三层共 8 个 cargo 命令，仅 1 个带 --locked（ci.yml:132）；Cargo.lock 已入库，锁漂移只能被快层 rust-check 拦截。

**静态验证**（grep 全部 4 个 workflow 的 `cargo` 命令，perf-test.yml 无 cargo）：

| workflow       | 命令                                            | --locked |
| -------------- | ----------------------------------------------- | -------- |
| ci.yml:132     | `cargo check --workspace --locked`              | ✅ 唯一  |
| ci.yml:142     | `cargo test -p conex-types -p session-loop`     | ❌       |
| ci-mid.yml:44  | `cargo test --workspace`                        | ❌       |
| ci-mid.yml:57  | `cargo clippy --workspace --all-targets`        | ❌       |
| ci-mid.yml:103 | `cargo machete`                                 | ❌       |
| ci-slow.yml:38 | `cargo test --workspace --release -- --ignored` | ❌       |
| ci-slow.yml:79 | `cargo bench --workspace`                       | ❌       |

共 **7** 个实际 cargo 命令（F10 数 8，可能计入注释行 `cargo clippy --workspace -- -D warnings` 等）；`git ls-files` 确认 Cargo.lock 已入库。

**确认**：真（方向完全正确，1/7 vs 1/8 仅计数口径差）。中层/慢层测试在漂移 lock 下运行结果不可复现的风险成立。

**修复建议**（沿用 F10）：7 个命令统一加 `--locked`（一行级改动，无成本）。

---

## 六、bench 空转（F10-07）— ❌ **假**（R3 最重要的纠偏）

**原结论**：`crates/*/benches` 不存在（实测 0 目录），ci-slow bench job 恒走 else 分支 echo；criterion 0.5 无消费者；TS 侧 bench 未入任何 CI。

**静态验证（推翻 F10）**：

- `git ls-files` 确认 **5 个 criterion bench 文件已入库**：
  - `crates/agent-provider/benches/sse_parse.rs`（4100B）
  - `crates/conex-db/benches/db_write.rs`（3903B）
  - `crates/orchestrator/benches/event_chain.rs`（7824B）
  - `crates/session-loop/benches/request_build.rs`（5210B，criterion_group!/criterion_main! + BenchmarkId 标准形态）
  - `crates/session-loop/benches/tool_batch.rs`（6289B）
- 提交时间（`git log --follow`）：49dc7a8e（2026-08-02）/ d1b0dde2（08-04）/ e6ab9d4e（08-04）/ 3d09fd61（08-05）——**全部早于 F10 审计日 08-07**，且 F10 审计日 HEAD（ce2ceadc）上 `git ls-tree` 确认已存在；
- **criterion 有 4 个消费者**（非"无任何 crate 引用"）：session-loop/Cargo.toml:46、conex-db/Cargo.toml:26、orchestrator/Cargo.toml:33、agent-provider/Cargo.toml:32 均声明 `criterion = { workspace = true }`；
- ci-slow.yml:77-82 guard `if ls crates/*/benches` 会命中（4 个目录存在）→ 真跑 `cargo bench --workspace`，**非恒 echo**；
- 另：`perf-test.yml`（2026-07-19 入库，PR + main/refactor push 触发）的 benchmark job 跑 `packages/shared-utils/src/bench/run-benchmarks.ts` + mem + compare-benchmarks + acceptance-criteria + 上传报告 + PR 评论——**TS bench 已入 CI**，F10"TS bench 未入任何 CI"不成立（F10 只扫了 ci.yml/ci-mid.yml/ci-slow.yml，漏掉 perf-test.yml）。

**实跑**：`cargo bench --workspace --no-run`（超时 600s）→ 编译成功

```
Executable benches\event_chain.rs / request_build.rs / tool_batch.rs / sse_parse.rs / db_write.rs ...
EXIT=0
```

（`--no-run` 仅编译验证；实际 CI 中 `cargo bench --workspace` 会真跑全部 5 个基准。）

**确认**：**假**。bench 轨已落地（Rust 侧 5 基准 + TS 侧 perf-test.yml 全链），ci-slow bench job 会执行而非 echo。F10 的"0 目录"判断与仓库事实不符（可能审计时未跑通路径检查或与旧状态对照）。**criterion 0.5 声明有消费者**，F10 第七节表格中"Cargo.toml:84-86 无任何 crate 引用"亦为误判。

**修复建议**（修正 F10）：无需"落地首个 benchmark"——已有 5 个 criterion 基准在 nightly 真跑；建议（1）将 ci-slow bench 的 guard 从"存在性检查"升级为显式 `--bench` 列表（防未来误删静默失效）；（2）确认 perf-test.yml（PR 每次触发、预算 30min）与 ci-slow bench（nightly）的分工与重复问题，避免 PR 轨道被 TS 基准拖长。

---

## 七、knip 未接线（F10-08）— ✅ 真

**原结论**：knip.config.ts 存在（error 级 rules: files/dependencies/devDependencies/unresolved），但无 npm script、无 CI job、node_modules/knip 未安装——从未执行 = 零守护。

**静态验证**：

- `package.json` 全文件核对：devDependencies 无 knip，scripts 无 knip 相关（F10-08 成立）；
- 4 个 workflow grep `knip`：0 命中（未接线成立）；
- `Test-Path node_modules/knip` = False、`node_modules/.bin/knip*` 不存在、`npm ls knip` = (empty)——本地未安装成立；
- `knip.config.ts` 全文核读：rules 68-78 确认 `files/dependencies/devDependencies/unresolved: 'error'`，配置本身合理（ignoreFiles 登记字符串路径消费文件）。

**实跑**：`npx --no-install knip`（超时 300s，走 npx 全局缓存 6.32.0）

```
Unused files (1)
  apps/crish-desktop/src/components/chat-message-list/AgentToolRowRenderer.tsx
Unlisted binaries (2)  rimraf / tasklist
Unused exports (594)  …（warn 级）
Duplicate exports (5)  …（warn 级）
Configuration hints (5)  …（ignoreFiles 中 5 项建议移除）
EXIT=1
```

**确认**：真。未接线零守护成立；且若直接接线会**立即必红**（Unused files 1 项命中 error 级 rules.files + Unlisted binaries 等），收敛存量成本真实存在。注：本机 npx 全局缓存存在 knip 6.32.0，CI ubuntu 上 `npx knip` 会触发自动安装，F10"从未执行"在 CI 意义上成立。

**修复建议**（沿用 F10）：先本地 `npx knip` 收敛存量（删 AgentToolRowRenderer.tsx 或登记 ignore；确认 rimraf/tasklist 的 unlisted 处置），再接入 ci-mid 或快层 lint job；建议同时加入 `--max-warnings 0` 之外的 warn 级收敛节奏（exports 594 项为长尾，可先只拦 error 级）。

---

## 八、双口径现状 37/37（F10-15 修复确认）— ✅ 真

**原结论**：Menu.lowViewport（CWD 修复）/ sessionRustDbWriteModel（按 Stream D 重写）/ messageHandlers.cache（flaky 未复现）已修复，双模式 37/37 全绿；但文档（AGENTS.md 等）仍登记为"基线失败集"——文档过期。

**实跑**（root 模式，`--coverage.enabled=false`，对应 F10 实证命令）：

```
npx vitest run .../Menu.lowViewport.test.tsx .../messageHandlers.cache.test.ts .../sessionRustDbWriteModel.test.ts
Test Files  3 passed (3)
     Tests  37 passed (37)     EXIT=0
（Menu.lowViewport 5 + messageHandlers.cache 16 + sessionRustDbWriteModel 16 = 37）
```

补充实跑：`npx vitest run src/api/oklchColorGuard src/api/userFacingErrors src/api/session-persistence src/components/menu --coverage.enabled=false` → 6 文件 **77/77 全绿 EXIT=0**（含旧 4 文件基线全数覆盖）。

**确认**：真。37/37 全绿复现，旧基线集（oklchColorGuard/userFacingErrors/sessionRustDbWriteModel/DiffCard.perf + Menu.lowViewport/messageHandlers.cache 基建 3 文件）当前均通过；AGENTS.md 及方案文档中"基线失败集中在…"的表述为过期口径。

**修复建议**（沿用 F10-15）：更新 AGENTS.md 与相关方案文档：基线集清零，验收口径改为"快层全绿 + 中层两 job 修复（F10-01/F10-02）"；R3 补充建议：本轮 F10-07 误判也应同步更正基准轨状态（见第六节）。

---

## 附：R3 实跑命令清单（全部只读/无代码改动）

| 命令                                                                          | 结果                                                                                                                              |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run --project e2e`                                                | ❌ EXIT=1，21 文件全失败（test.describe 冲突）                                                                                    |
| `npx vitest run --config vitest.integration.config.ts`                        | ❌ EXIT=1，Startup Error（workspace stub）                                                                                        |
| `npx vitest run src/components/ui/Menu/Menu.lowViewport.test.tsx`（app 目录） | ❌ EXIT=1，用例全过但 coverage 0.16% < 70%                                                                                        |
| `npx vitest run` 3 问题文件（root，--coverage.enabled=false）                 | ✅ 37/37 EXIT=0                                                                                                                   |
| `npx vitest run` 6 目录（root，--coverage.enabled=false）                     | ✅ 77/77 EXIT=0                                                                                                                   |
| `cargo bench --workspace --no-run`                                            | ✅ EXIT=0（5 个 criterion bench 编译成功）                                                                                        |
| `npx --no-install knip`                                                       | ❌ EXIT=1（Unused files 1 / Unlisted binaries 2 / exports 594 warn）                                                              |
| 静态                                                                          | Cargo.lock 入库 ✅；tests/stress 零生产 import ✅；--locked 1/7 ✅；vitest.workspace.ts stub ✅；perf-test.yml 存在（F10 漏扫）⚠️ |

## 诚实边界

- 未实跑 `npm run test` 全量（372 文件级，耗时不可控）；但 `--project e2e` 21/21 必红 ⇒ 全量含 e2e 项目必红，结论不受影响。
- 未实跑 `cargo test --workspace` 全量（Rust 基线沿用 AGENTS.md/B4 记录）。
- `cargo bench` 以 `--no-run` 编译验证为准，未跑完整基准数据（验证目标为"是否空转"，编译成功 + 文件入库已足证非空转）。
- 本机 win32 与 CI ubuntu 的差异项（tauri-native-smoke taskkill）已标注，不影响必红结论。
