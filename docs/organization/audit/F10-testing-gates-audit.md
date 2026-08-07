# F10 测试体系与门禁严格审计报告

- 审计日期：2026-08-07
- 审计范围：`crates/*/tests/` 与 src 内测试、`apps/crish-desktop` 的 vitest（src/**tests**、各模块测试）、`tests/e2e/`（Playwright）、`tests/stress/`、`.github/workflows/`（ci.yml / ci-mid.yml / ci-slow.yml）、`scripts/` 门禁、vitest 配置（vitest.config.ts / vitest.workspace.ts / vitest.integration.config.ts / apps/crish-desktop/vitest.config.ts）、Cargo.toml 测试配置
- 方式：只读，逐配置核读 + 关键门禁命令**实跑验证**（见第六节实证记录，均为只读/无副作用或仅生成忽略目录内报告文件）+ 既有评审文档（B4-overall-health-review.md、B2-ts-quality-review.md、R0-baseline-frontend.md）交叉核对
- 严重度定义（门禁层面）：**P0=门禁必红或彻底无声（形式上存在、内容上失效）**；**P1=明确缺陷/门禁明显弱化，正常路径可触发**；**P2=边界缺陷、配置死面、文档漂移**

## 一、总体结论

**快层是真门禁，中层是"必红门禁"（等于没有），慢层部分空转。**

- **最强拦截点**：ci.yml 快层组合实测全绿且阈值真实生效——`npm run test:coverage -- --project=unit`（5259 用例通过，45/70/65/45 覆盖率门禁 EXIT=0）、`cargo test -p conex-types -p session-loop` 全绿、engine-bindings-drift / cargo-deny / gitleaks / clippy ratchet（check-clippy-baseline.mjs）均已接线。Rust 侧覆盖密度扎实：`run_loop.rs` 27 个主循环集成用例、`conex-db/tests/migrations.rs` 12 个迁移用例（v1→v6 + backup golden + WAL + 幂等）、前端 EventRouter/EventBus 测试 434+ 行。
- **最弱缺口（三处真空）**：
  1. **ci-mid 中层两个 job 全部确定性失败**——`test` job 因 vitest e2e 项目收集 Playwright spec 必红（实测 22 个文件失败）；`test:integration` job 因 `vitest.workspace.ts` stub 在 vitest 3.2.7 下解析崩溃（实测启动即挂）。即"合并前全量验证"实际从未生效。
  2. **TS 压力轨（tests/stress）不接触任何生产代码**——三个场景只做 TextEncoder/JSON.stringify/Set 差集等 Node 内置操作，任何产品回归都无法被其拦截。
  3. **Playwright e2e 只跑 nightly**，PR/合并前零 e2e 断言；visual 回归（tests/visual）声明"慢层归属"但 ci-slow 从未执行；bench job 因无 `crates/*/benches` 恒为 echo。
- **双口径（已知问题）现状验证**：B4 记载的 app-dir 5 失败 × 3 文件（Menu.lowViewport CWD、sessionRustDbWriteModel 环境敏感、messageHandlers.cache flaky）**本次双模式实测 37/37 全绿、已修复**；但配置口径分裂仍在且更严重——app-dir 模式 `coverage.enabled=true` + 70/60/65/70 使**任何** scoped run 必红（实测 0.16% < 70%），与 root/CI 口径（enabled=false + 45/70/65/45）不可调和。

---

## 二、审查维度 1：门禁双口径（root vs app-dir）

### 配置差异根因（逐项对照）

| 维度        | root 模式（CI 口径，vitest.config.ts）                                                      | app-dir 模式（apps/crish-desktop/vitest.config.ts）                                                         |
| ----------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| environment | unit 项目 `node`（vitest.config.ts:57），DOM 测试靠文件头 `@vitest-environment jsdom` 指令  | 全局 `jsdom`（apps/crish-desktop/vitest.config.ts:7）                                                       |
| retry       | 2（vitest.config.ts:68,89,106）                                                             | 无（默认 0）                                                                                                |
| coverage    | `enabled: false`，阈值 45/70/65/45（vitest.config.ts:29,47-52），仅显式 `--coverage` 时生效 | `enabled: true`，阈值 **70/60/65/70**（apps/crish-desktop/vitest.config.ts:10-18），任何 run 都强制算覆盖率 |
| projects    | 三项目（unit/integration/e2e，vitest.config.ts:54-115）                                     | 无 projects                                                                                                 |
| CWD 根      | 仓库根                                                                                      | app 目录                                                                                                    |
| 失败集合    | B4 记载 app-dir 5 失败 × 3 文件；本次实测 37/37 全绿（见第六节）                            | 同左                                                                                                        |

### 关键实证

1. **app-dir 任何 run 必红**：`npx vitest run src/components/ui/Menu/Menu.lowViewport.test.tsx`（app 目录、不加 `--coverage.enabled=false`）→ 5/5 用例全过但 `ERROR: Coverage for lines (0.16%) does not meet global threshold (70%)`。scoped 运行覆盖率为 0.16% 属必然，阈值 70 使 app-dir 门禁**永不可达**。IDE / 开发者在该目录的任何 vitest 操作都看到红。
2. **旧 4 文件基线（oklchColorGuard/userFacingErrors/sessionRustDbWriteModel/DiffCard.perf）现状**：已全部修复（R0-baseline-frontend.md:92-99 记载 + 本次 root/app-dir 双模式复跑 sessionRustDbWriteModel 16/16 全绿实证）。AGENTS.md 及各方案文档仍登记其为"基线失败集"——**文档过期**（F10-15）。
3. **B4 记载的 3 个基建问题文件修复状态**：
   - `Menu.lowViewport.test.tsx:41-43` 已从 `process.cwd()` 拼接改为 `new URL(relPathFromMenu, import.meta.url)`（修复 CWD 双前缀 ENOENT）；
   - `sessionRustDbWriteModel.test.ts` 已按 Stream D 真实契约重写（文件头注释 + 内存假库 mock transport），16/16 全绿；
   - `messageHandlers.cache.test.ts` 全量下 flaky 记录未复现（隔离跑 16/16 绿）。
4. **口径分裂的残余风险**：root 模式 52 个 .tsx 测试文件无 `@vitest-environment jsdom` 头（实测统计），依赖 node 环境下不触 DOM 才通过——新测试文件漏写环境头会得到**两模式不同结果**；CWD 敏感用例（文件系统读取）在 app-dir 与 root 下行为仍可能不同（Menu 类用例已消除，但这是模式性风险而非个例）。

---

## 三、审查维度 2：CI 一致性（三层 workflow 是否执行声明命令）

| workflow                    | 声明（头注释）                                                    | 实际命令                                                                            | 实测/核查结论                                                                                          |
| --------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| ci.yml vitest-fast          | "快集（unit 项目）+ coverage 门禁"                                | `npm run test:coverage -- --project=unit`（ci.yml:78）                              | ✅ 实测 EXIT=0，45/70/65/45 生效                                                                       |
| ci.yml rust-check           | `cargo check --workspace --locked`（ci.yml:132）                  | 同左                                                                                | ✅ 唯一使用 --locked 的 job                                                                            |
| ci.yml rust-unit-fast       | "关键单测：conex-types + session-loop"（ci.yml:142）              | `cargo test -p conex-types -p session-loop`                                         | ✅ 实测 19 组全部 ok；⚠️ **无 --locked**                                                               |
| ci-mid rust-test            | "cargo test --workspace 全量"（ci-mid.yml:44）                    | 同左                                                                                | ⚠️ 无 --locked；按 B4 记录 75 套件 0 失败（本次未复跑全量，见诚实边界）                                |
| ci-mid clippy               | "-D warnings + 基线 ratchet"（ci-mid.yml:57-62）                  | `cargo clippy --workspace --all-targets` + `node scripts/check-clippy-baseline.mjs` | ✅ 接线正确（ratchet 脚本设计良好，见维度 7）                                                          |
| ci-mid **test**             | "前端 vitest 全量（unit+integration+e2e）"（ci-mid.yml:82）       | `npm run test`                                                                      | ❌ **实测 EXIT=1：22 个文件失败**（e2e 项目收集 Playwright spec）→ 必红门禁                            |
| ci-mid **test:integration** | "F3 层：integration/fuzz/race/recovery"（ci-mid.yml:95）          | `npx vitest run --config vitest.integration.config.ts`                              | ❌ **实测启动即崩**（Startup Error，workspace stub）→ 必红门禁                                         |
| ci-mid machete              | cargo machete                                                     | 同左                                                                                | ⚠️ 无 --locked                                                                                         |
| ci-mid governance-baselines | unwrap/吞错/行数三基线（ci-mid.yml:116-118）                      | 同左                                                                                | ✅ 已接线                                                                                              |
| ci-slow rust-stress         | "cargo test --workspace --release -- --ignored"（ci-slow.yml:38） | 同左                                                                                | ✅ 命令真实（10 个 #[ignore] 测试跨 3 crate）；⚠️ release 含 tauri 壳编译，60min 预算存疑；无 --locked |
| ci-slow stress-ts           | "TS 压力轨 stress-runner"（ci-slow.yml:51）                       | `npm run stress`                                                                    | ❌ 空转（见维度 5）                                                                                    |
| ci-slow e2e                 | "Playwright L2 mock 引擎"（ci-slow.yml:66）                       | `npm run test:e2e`                                                                  | ✅ 链路实测可跑（5/5）；⚠️ 仅 nightly/tag                                                              |
| ci-slow bench               | "cargo bench 存在时运行"（ci-slow.yml:77-82）                     | guard `ls crates/*/benches`                                                         | ❌ 恒 echo（无任何 benches 目录），criterion 0.5 声明无消费者（Cargo.toml:84-86）                      |

**未接线清单（声明过但 CI 从未执行）**：`check:ui-layer`（package.json:42）、`knip`（knip.config.ts 全 error 规则）、`check:conex-db`（package.json:45-46，`cargo test -p conex-db` 仅本机手跑）、visual 回归（apps/crish-desktop/playwright.config.ts 头注释声明"慢层"但 ci-slow 无）、markdown-editor `npm test` 门禁（AGENTS.md 强制，但 .github 无任何引用，仅本机手跑）。

**--locked 一致性**：Cargo.lock 已入库（git ls-files 确认）。三层共 8 个 cargo 命令，仅 1 个带 --locked（ci.yml:132）。锁漂移（PR 增依赖未更新 lock）只能被快层 rust-check 拦截，中层/慢层测试在漂移 lock 下运行结果不可复现。

---

## 四、审查维度 3：测试覆盖盲区（抽样关键路径）

### Rust 侧（抽样）

| 模块                                                                                                                                                      | 测试面                                                                                                                                                                     | 结论                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| session-loop 主循环                                                                                                                                       | `tests/run_loop.rs` 1199 行 / 29 个 async fn：force_cancel、cooperative_stop、steering、retry ladder、idempotency、max_turns、event_sequence_contract、零拷贝、跨 run 延续 | ✅ 密集                                                                                |
| session-loop 8 个 handler（awaiting_input/executing_tools/no_tool_calls/prepare_turn/steering_evaluation/streaming/turn_complete + end.rs/invariants.rs） | src 内无 cfg(test)；由 run_loop.rs 集成测试间接覆盖                                                                                                                        | ⚠️ 分支级盲区存在（handler 内错误分支主要靠集成断言覆盖，无单元级穷举）                |
| session-loop provider.rs / tool_events.rs / testing                                                                                                       | provider.rs 144 行、tool_events.rs 262 行均无 cfg(test)                                                                                                                    | ⚠️ tool_events 的 ToolEvent 分类/失败语义无直接测试（run_loop 间接覆盖部分）           |
| conex-db 迁移                                                                                                                                             | `tests/migrations.rs` 904 行 / 12 用例（v1→v6 fixture、backup golden bytes、WAL 备份、幂等重开、备份失败降级继续）                                                         | ✅ 集成级扎实                                                                          |
| conex-db src 其余                                                                                                                                         | migrate.rs(461)/messages.rs(196)/runs.rs(401)/sessions.rs(259)/schema.rs(268)/import.rs(227)/events.rs(132)/error.rs(76) **全部无 cfg(test)**（实测 grep）                 | ❌ 约 2000 行核心持久化逻辑仅靠集成测试 + 壳层间接覆盖；runs/sessions 读写路径单测空白 |
| orchestrator 事件                                                                                                                                         | events.rs 1196 行有 cfg(test)；tests/ 有 multi_agent/cancel/kill_all/recovery_ladder/steering_queue 等 14 个集成文件                                                       | ✅ 良好                                                                                |
| 压力（#[ignore]）                                                                                                                                         | session-loop stress_long_session ×4 + streaming_incremental_contract ×1、conex-db stress_write ×3、orchestrator stress_concurrent_runs ×2（共 10 个）                      | ✅ 真实压力测试（orchestrator 147 行并发序列唯一性断言）                               |

### 前端侧（抽样）

- **EventRouter dispatch**：`EventRouter.ts` 128 行 vs `EventRouter.test.ts` 434 行 + `EventRouter.terminal.test.ts` + `dataPlaneRouter.test.ts` + `EventBus.adversarial.test.ts`——run-terminal 语义、approval-resolved、未知事件、surface 失败路径均有断言。✅ **是覆盖最好的模块之一**。
- **盲区**：snapshot 测试（apps/crish-desktop/tests/snapshots/*.test.tsx 3 文件）**不匹配任何 root 项目 include**——unit 项目只含 `apps/crish-desktop/src/**`（vitest.config.ts:70-75），integration 项目只含 `*.test.ts`（:91-97）——CI 永不运行（F10-11）；fuzz/race/recovery 目录在 `tests/` 根下为空（实测 0 文件），实际用例在 apps/crish-desktop/tests/ 下且仅被 integration 项目收集（race/recovery/fuzz 的 .test.ts 会跑，vitest.integration.config.ts 只收 integration/ 子目录，与 ci-mid.yml:94 注释"integration/fuzz/race/recovery"不符）。

---

## 五、审查维度 4：测试质量

1. **性能断言 flaky**：`MessageVirtualizer.perf.test.tsx:179-180`（100 次 act+fireEvent 滚动，max 40ms / avg 15ms 帧预算）与 `DiffCard.perf.test.tsx:83,135-136,163,183`（250/50/250/500ms 量级阈值）在 jsdom 并行负载下均属时间敏感；root retry=2（vitest.config.ts:68）掩盖抖动，app-dir 无 retry 即红。34-cleanup-closure.md:170 记载 MessageVirtualizer 曾"并行负载下超标（36/6ms 预算实际 59ms）"后放宽——**这类断言价值递减：真回归与抖动的区分依赖量级阈值，已被放宽到"超一个量级才炸"**。
2. **共享状态**：`messageHandlers.cache.test.ts:264,270,283-284` 直接 `useLayoutStore.setState` 全局变异（seedSession + afterEach 清理），B4 记载全量下 flaky；zustand store 为模块级单例，同 worker 内跨文件串行执行时清理不彻底即污染（当前测试显式清理，风险已降级但模式仍在）。
3. **跳过统计**：Rust 无 `#[ignore]` 之外的 skip（10 个 ignore 全部是慢层压力语义，理由充分）；前端 vitest 未发现 `it.skip`（grep 抽样）；`tauri-native-smoke.spec.ts` 用 `describe.skipIf` 按构建产物存在与否自动跳过——本地（有产物）会真跑，CI ubuntu（无产物）跳过——**同一文件在本地与 CI 行为不同**（本地实测还因 taskkill 失败 2 次）。
4. **测试替身质量**：正面——`src/test-setup.ts:36-50` 三态 invoke mock（ok/missing/error）语义清晰、beforeEach 自动清理（:121-123）、`vitest.globalSetup.ts:27-41` 清空 15+ Provider API key 防真实外呼，均是高质量替身；负面——app-dir `coverage.enabled=true` 使 setup 文件（test-setup.ts 位于 src/ 内）计入覆盖率且被 include 捕获，但这是配置问题非替身问题。messageHandlers.cache.test 的 HandlerEnv 全 vi.fn 桩（约 20 个）属"过宽 mock"风险面：`onRunError` 等回调从不被断言"未调用"，桩宽掩盖 handler 副作用遗漏（当前断言集中在 state.lastMessageCacheMetrics，属于可接受平衡）。

---

## 六、审查维度 5：压力 / 基准

1. **Rust 压力（#[ignore]）**：10 个真实压力/契约测试，slow 层 `cargo test --workspace --release -- --ignored`（ci-slow.yml:38）会真跑。风险：workspace 含 tauri 壳成员，release 编译 + 压力用例在 60min 预算内完成存疑；无 --locked。
2. **TS 压力轨（tests/stress）＝空转（P0）**：三个场景**零生产代码引用**：
   - `stress-ai-stream.ts:3-31`：随机字符 → TextEncoder → TextDecoder 往返（Node 内置）；
   - `stress-diff-load.ts:3-48`：字符串 Set 差集 + startsWith 统计；
   - `stress-session-switch.ts:3-53`：JSON.stringify/join/parse 循环。
   - `stress-runner.ts:99-130` 的 "FPS" 实为 **Node 循环迭代吞吐**（ops/sec），非浏览器帧；内存/延迟阈值（maxHeap 200-300MB、p95 100-200ms）在任何现代机器上 trivially 通过。**任何 chatBridge/stream/store/引擎回归都不可能让该套件变红**——"压力轨"是名义存在。
3. **基准**：`crates/*/benches` 不存在（实测 0 目录），ci-slow bench job 恒走 else 分支 echo（ci-slow.yml:80-81）；Cargo.toml:84-86 声明 criterion 0.5 为 workspace dev-dep 但无任何 crate 引用——**声明的基准轨从未落地**。TS 侧 `npm run bench`（packages/shared-utils/src/bench）未入任何 CI（grep workflows 无 bench 引用，仅 bench:ci 本地脚本）。

---

## 七、审查维度 6：e2e（Playwright）

1. **链路实测可跑**：`npx playwright test tests/e2e/cache-telemetry.spec.ts`（本地，dev server 自动拉起）5/5 通过——webServer 配置（playwright.config.ts:54-63，端口 5174 与 vite strictPort 对齐）、workers=4、testIgnore tauri-native-smoke 均正常。
2. **分层归属错误是核心问题**：
   - 合并前（ci.yml/ci-mid.yml）：**零 Playwright 断言**——ci-mid test job 反而把 spec 收集进 vitest e2e 项目而必红（vitest.config.ts:101-115 include `tests/e2e/**/*.spec.ts`，实测报 `Playwright Test did not expect test.describe() to be called here`）；
   - 仅 nightly/tag（ci-slow.yml:53-66）才跑真正的 Playwright 套件——**回归发现延迟以天计**。
3. **mock-engine 与生产漂移面**：正面——`mock-engine.ts` import 生产 `BUILTIN_COMMAND_MANIFEST`（mock-engine.ts:27），命令名单与生产共享，防命令名漂移；负面——`MOCK_EVENT_CHANNEL = 'workbench-run-event'`（mock-engine.ts:33）与 `tauriTransport.ts:30` 的 `RUN_EVENT_CHANNEL` 是**手工字符串复制**（仅有注释联动），事件载荷 shape 无 golden 校验（spec 内 fixture 与生产 eventParser 的兼容靠人工对齐）；注入面替换 `window.__TAURI_INTERNALS__` 依赖 Tauri v2 内部实现细节，@tauri-apps/api 大版本升级时 mock 与真壳易双漂移。
4. 5 个 markdown-editor 专项 spec（ast-block-tables/format-checker/ime-composition/keyboard-navigation/wysiwyg-interaction）均在列（tests/e2e/ 实测 24 文件），符合 AGENTS.md 保护要求。

---

## 八、审查维度 7：门禁脚本自身

| 脚本                                                              | 接线                                      | 漏检/误报风险                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| check-clippy-baseline.mjs                                         | ci-mid ✅                                 | **设计良好**（基线真源标记区、按消息+文件归一、--update 显式提升）。漏检：不扫 `#![allow]` 增补（代码内 allow 不产生告警即不被 ratchet 捕获，属已知边界）；误报：告警文本措辞变化计"新增"，方向保守（fail-closed），可接受 |
| check-ui-layer.mjs                                                | **未接线** ❌                             | 正则覆盖 import/require/import()（scripts/check-ui-layer.mjs:25-26）；漏检面：`import type` 后跟任意字符串均被 `[^'"]*?` 吞掉（会误判放行？实测语法 OK）、CSS `@import` 不扫、`<script>` 无。当前为摆设                    |
| check-unwrap-baseline / check-swallowed-errors / check-crate-size | ci-mid ✅                                 | 与 clippy ratchet 同类设计                                                                                                                                                                                                 |
| check-conex-db-size / test:conex-db                               | **未接线** ❌                             | `cargo test -p conex-db` 仅在 package.json:46，CI 无                                                                                                                                                                       |
| knip（knip.config.ts:68-78 error 规则）                           | **未接线** ❌ 且 node_modules/knip 未安装 | 配置本身合理（ignoreFiles 登记了字符串路径消费的文件）；从未执行=零守护                                                                                                                                                    |
| check-zindex                                                      | **已消亡** ❌                             | scripts/ 目录无此脚本（实测），仅 docs 提及（34-cleanup-closure.md、脚本审计-替换脚本清单.md）——z-index 层叠回归无任何守护                                                                                                 |
| 快层 CI lint                                                      | ci.yml:58 `npx eslint .`                  | **口径弱于 lint:all**：无 `--max-warnings 0`（package.json:53 才有），eslint.config.js:102,158 存在 warn 级规则 → warn 不拦 CI                                                                                             |

---

## 九、发现清单

### P0（门禁必红或彻底无声）

| #      | 位置                                                                                                                                              | 问题                                                                                                                                                                                                                               | 触发场景                                | 修复建议                                                                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F10-01 | `vitest.config.ts:101-115`（e2e 项目 include `tests/e2e/**/*.spec.ts`）；`ci-mid.yml:82`（`npm run test`）                                        | **中层 test job 确定性必红**：vitest e2e 项目收集 Playwright spec，加载即抛 `Playwright Test did not expect test.describe() to be called here`。实测 `npm run test` = 22 文件失败 / 2 用例失败 / EXIT=1                            | 任何 ci-mid 触发（每个 PR + main push） | e2e 项目 exclude `tests/e2e/**`（vitest 与 Playwright 不共存）；中层补真 Playwright job（`npm run test:e2e`），实现"合并前跑 e2e"（见 F10-04）                                                                                          |
| F10-02 | `vitest.workspace.ts:11`（stub `export {}`）；`vitest.integration.config.ts:2-7`（无 test.projects）                                              | **中层 test:integration job 启动即崩**：vitest 3.2.7 在配置无 projects 时解析 workspace 文件，stub 非 default array → `Startup Error: Workspace config file must export a default array of project paths`。实测 EXIT=1，0 用例执行 | 任何 ci-mid 触发                        | vitest.integration.config.ts 迁移到 `test.projects`（同 vitest.config.ts 模式），或删除 workspace stub（vitest.config.ts 已用 projects，该文件无消费方）；顺带核对 ci-mid.yml:94 注释声称的 fuzz/race/recovery 与 config include 不一致 |
| F10-03 | `tests/stress/stress-ai-stream.ts:3-31`、`stress-diff-load.ts:3-48`、`stress-session-switch.ts:3-53`、`stress-runner.ts:99-130`；`ci-slow.yml:51` | **TS 压力轨零产品接触**：三场景仅 Node 内置操作（TextEncoder/JSON.stringify/Set 差集），"FPS"为循环吞吐；任何产品回归都不会变红                                                                                                    | 依赖该套件拦截性能/内存回归的所有场景   | 压力场景改为驱动真实生产路径（import chatBridge/StreamRenderBuffer/eventParser + 真实引擎事件流回放），或删除并声明"压力靠 Rust #[ignore] 层 + e2e"                                                                                     |

### P1（明确缺陷 / 门禁明显弱化）

| #      | 位置                                                                                                                                                    | 问题                                                                                                                                                                                                                                                             | 触发场景                                                                                 | 修复建议                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F10-04 | `ci-slow.yml:53-66`；ci.yml/ci-mid.yml 无 e2e                                                                                                           | **Playwright e2e 仅 nightly/tag 执行，合并前零 e2e 断言**；中层反而因收集 spec 必红（F10-01）                                                                                                                                                                    | 任何不影响 unit 的 UI 回归（组件重构、事件桥字段改型）                                   | 中层加 `npm run test:e2e` job（预算允许则快层加最小冒烟 spec 集）；F10-01 修复后此条自动闭环一半                                                                                        |
| F10-05 | `apps/crish-desktop/vitest.config.ts:10-18` vs `vitest.config.ts:29,47-52`                                                                              | **双口径不可调和**：app-dir `coverage.enabled=true`+70/60/65/70 使任何 scoped run 必红（实测 0.16%<70%）；root/CI 口径 enabled=false+45/70/65/45。B4 记载的 5 失败×3 文件已修复（本次 37/37 全绿），但配置分裂（env 默认 node/jsdom、retry 2/0、CWD 根）持续存在 | IDE 内 app 目录跑 vitest、开发者按 app-dir 自检                                          | 二选一：app-dir 配置改为 `coverage.enabled=false` + 阈值对齐 root，或删 app-dir 配置并显式声明唯一口径（root+CI）；新测试文件环境头缺失的 52 个 .tsx 统一补 `@vitest-environment jsdom` |
| F10-06 | `ci.yml:142`、`ci-mid.yml:44,57,103`、`ci-slow.yml:38,79`                                                                                               | **--locked 仅 1/8 个 cargo 命令使用**（唯一在 ci.yml:132）；Cargo.lock 已入库                                                                                                                                                                                    | 依赖增删未同步 lock（快层 rust-check 能拦，但中层/慢层在漂移 lock 下运行，结果不可复现） | 全部 cargo 命令统一加 `--locked`                                                                                                                                                        |
| F10-07 | `ci-slow.yml:77-82`；Cargo.toml:84-86                                                                                                                   | **bench job 恒空转**：无任何 `crates/*/benches`，guard 恒 echo；criterion 0.5 无消费者                                                                                                                                                                           | 依赖基准门禁发现性能回归                                                                 | 落地首个 criterion bench（或 TS bench:ci 入 CI），移除死声明                                                                                                                            |
| F10-08 | `knip.config.ts:68-78`；无 npm script/CI job；node_modules/knip 未安装                                                                                  | **knip 门禁从未接线**：error 级规则（files/dependencies/devDependencies/unresolved）零执行                                                                                                                                                                       | 死代码/未用依赖引入                                                                      | 加 `npx knip` 到 ci-mid（或快层 lint job），先全量跑一次收敛存量                                                                                                                        |
| F10-09 | `package.json:42`（check:ui-layer）；`ci.yml:34-46`（typecheck job 仅 `npm run typecheck`）                                                             | **check:ui-layer 未接线**：ui 原子层依赖规则无 CI 守护                                                                                                                                                                                                           | 业务组件被 ui/ 反向引用（依赖倒置回归）                                                  | typecheck job 追加 `npm run check:ui-layer`（或并入 check:desktop）                                                                                                                     |
| F10-10 | `apps/crish-desktop/playwright.config.ts` 头注释（"CI 归属：慢层"）；ci-slow.yml 无 visual                                                              | **visual 回归声明慢层但从未执行**：tests/visual/app.spec.ts（截图基线）不进任何 CI                                                                                                                                                                               | UI 视觉回归（样式/间距/主题）                                                            | ci-slow e2e job 追加 `npm --workspace @crish/crish-desktop run test:visual`                                                                                                             |
| F10-11 | `vitest.config.ts:70-75`（unit 仅 src/**）、`:91-97`（integration 仅 `*.test.ts`）                                                                      | **snapshot 测试（tests/snapshots/\*.test.tsx 3 文件）不匹配任何 root 项目**：unit 不含 app 的 tests/ 目录，integration 不收 .tsx → CI 永不运行，仅 app-dir 手跑                                                                                                  | ToastStack/ChatToolCallBlock/AppErrorBoundary 渲染回归                                   | unit 项目 include 补 `apps/crish-desktop/tests/snapshots/**/*.test.tsx`（或建独立项目）                                                                                                 |
| F10-12 | `ci.yml:58`（`npx eslint .`）；`package.json:53`（lint:all 有 `--max-warnings 0`）；eslint.config.js:102,158（warn 级规则）                             | **CI lint 口径弱于声明**：warn 不拦 CI，与 lint:all 不一致；stylelint 也不在 CI                                                                                                                                                                                  | warn 级违规（no-explicit-any 等）堆积                                                    | ci lint job 改跑 `npm run lint:all` 或加 `--max-warnings 0`                                                                                                                             |
| F10-13 | `MessageVirtualizer.perf.test.tsx:179-180`、`DiffCard.perf.test.tsx:83,135-136,163,183`；vitest.config.ts:68（root retry=2）；34-cleanup-closure.md:170 | **性能断言 flaky 被 retry 掩盖**：root 模式 retry=2 兜底（CI 绿），app-dir 无 retry 即红（口径分叉的一个来源）；阈值已放宽到"量级级"，检测力弱                                                                                                                   | CI 负载波动、并行执行                                                                    | 收敛断言口径：jsdom 下不做真实帧预算（删除或迁移到 browser-mode 基准），保留结构/数量断言                                                                                               |

### P2（边界 / 死配置 / 文档漂移）

| #      | 位置                                                                                                                                   | 问题                                                                                                                                           | 触发场景                                                    | 修复建议                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| F10-14 | `package.json:86-96`                                                                                                                   | **vitest 死配置**：`vitest` 块阈值 50/40/50/50 + `coverage.enabled:true` 与 vitest.config.ts 45/70/65/45 冲突（vitest.config.ts 存在时被忽略） | 维护者删除 vitest.config.ts 后突然启用 50/40 阈值           | 删除 package.json vitest 块                                                                          |
| F10-15 | AGENTS.md（"基线失败集中在 oklchColorGuard/…/DiffCard.perf"）、docs/feature-gap-analysis/plans/00:814、REQ-EG-现状分析.md:889 等       | **基线失败清单文档过期**：4 文件均已修复（R0 报告 + 本次实测），文档仍把"不新增失败"当验收口径——掩蔽了真实问题（中层必红）                     | 新轮次按过期口径验收                                        | 更新 AGENTS.md 与方案文档：基线集清零，验收口径改为"快层全绿 + 中层两 job 修复"                      |
| F10-16 | `messageHandlers.cache.test.ts:264,270,283-284`                                                                                        | **全局 zustand store 变异测试**（B4 记载全量 flaky 史）                                                                                        | 同 worker 内其他文件对 layoutStore 的假设被污染             | 提取 store 工厂或至少固定串行（sequence）执行 + 完整快照清理                                         |
| F10-17 | `scripts/`（无 check-zindex）；docs 仅提及                                                                                             | **z-index 层叠门禁消亡**：脚本已不存在，无替代                                                                                                 | z-index 层叠回归                                            | 删除文档引用或重写等价检查（CSS 审计）                                                               |
| F10-18 | conex-db src：migrate.rs(461)/messages.rs(196)/runs.rs(401)/sessions.rs(259)/schema.rs(268)/import.rs(227)/events.rs(132)/error.rs(76) | **conex-db 核心模块单测空白**（约 2000 行无 cfg(test)），仅集成测试覆盖；`test:conex-db` 门禁也未入 CI                                         | runs/sessions 读写、schema 契约回归（集成测试未覆盖的分支） | 补 runs/sessions/schema 单测（内存 SQLite）；CI 中层加 `npm run check:conex-db`                      |
| F10-19 | `mock-engine.ts:33` vs `tauriTransport.ts:30`；mock-engine.ts 注入面                                                                   | **e2e mock 事件通道为手工字符串复制**（无编译期绑定），载荷 shape 无 golden 校验；`__TAURI_INTERNALS__` 注入依赖实现细节                       | @tauri-apps/api 升级、事件通道改名、载荷字段改型            | 通道名从生产模块导出复用；事件载荷加 JSON-schema/golden 对照（mock 与 eventParser 双测同一 fixture） |
| F10-20 | `ci-slow.yml:38`                                                                                                                       | **慢层 rust-stress 预算风险**：`cargo test --workspace --release` 含 tauri 壳成员编译，60min 预算存疑；无 --locked                             | nightly 超时静默失败（GitHub 无重试告警）                   | 拆分 job（先编译缓存 warm-up）或排除壳成员（--exclude tauri app）                                    |
| F10-21 | `.husky/pre-commit:1-2`                                                                                                                | **pre-commit 仅 lint-staged + diff check**，无 typecheck/测试                                                                                  | 提交引入类型错误或已破坏的单测                              | 至少加 typecheck（可 lint-staged 并行）；全量测试留给 CI                                             |

---

## 十、实证运行记录（本机复验，2026-08-07）

| 命令                                                                                | 结果                                                                                                                                                             |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run --project=unit --coverage.enabled=false`（3 个问题文件，root 模式） | ✅ 3 文件 / 37 用例全绿（Menu.lowViewport 5 + sessionRustDbWriteModel 16 + messageHandlers.cache 16）                                                            |
| `npx vitest run --coverage.enabled=false`（同 3 文件，app-dir 模式）                | ✅ 37/37 全绿                                                                                                                                                    |
| `npx vitest run`（app 目录，**不带** `--coverage.enabled=false`）                   | ❌ 用例全过但 `Coverage for lines (0.16%) does not meet global threshold (70%)`——app-dir 必红实证                                                                |
| `npx vitest run --project=e2e tests/e2e/cache-telemetry.spec.ts`                    | ❌ `Playwright Test did not expect test.describe() to be called here`——e2e 项目收集 Playwright spec 必失败实证                                                   |
| `npm run test`（= ci-mid test job 原命令，全项目）                                  | ❌ EXIT=1：372 文件 22 failed / 5261 用例 5259 过 2 失败（22 失败文件全部为 tests/e2e spec；2 失败用例为 tauri-native-smoke L3-2 taskkill，本地有产物故未 skip） |
| `npm run test:integration`（= ci-mid test:integration job 原命令）                  | ❌ Startup Error：`Workspace config file "vitest.workspace.ts" must export a default array of project paths`                                                     |
| `npm run test:coverage -- --project=unit`（= ci.yml vitest-fast 原命令）            | ✅ EXIT=0（阈值 45/70/65/45 达标，5259 用例过）                                                                                                                  |
| `npx playwright test tests/e2e/cache-telemetry.spec.ts`（dev server 自动拉起）      | ✅ 5/5 通过（39.4s）——Playwright 链路本身健康                                                                                                                    |
| `cargo test -p conex-types -p session-loop`（= ci.yml rust-unit-fast）              | ✅ 19 组 test result ok，0 失败                                                                                                                                  |
| 静态核查                                                                            | Cargo.lock 已入库；`crates/*/benches` 0 个目录；`node_modules/knip` 不存在；tests/stress 三文件无生产代码 import；vitest.workspace.ts 为 stub                    |

## 十一、诚实边界

- 未复跑 `cargo test --workspace` 全量（约 73-75 套件，时长不可控），Rust 全量基线沿用 AGENTS.md/B4 记录（75 套件 0 失败）并标注未复验。
- 未跑全部 21 个 Playwright spec（单 spec 5 用例验证链路），"e2e 套件整体通过"未承诺。
- `cargo test --workspace --release -- --ignored` 未实跑（编译时长），仅核读 10 个 ignore 测试内容。
- tests/stress 未实跑（基于源码核读判定零产品接触，风险判断不受实跑影响）。

## 十二、结论

1. **测试体系能否拦住回归——分层看**：
   - **能（快层）**：unit 5259 用例 + 45/70/65/45 coverage + Rust 快套件 + drift/security 门禁，实测全绿真实生效；Rust 主循环/迁移/前端 EventRouter 覆盖密度高，是当前真正的回归防线。
   - **不能（中层）**：ci-mid `test` 与 `test:integration` 两个 job 确定性必红（F10-01/F10-02），"合并前全量验证"形同虚设——红门禁与无门禁等价，且必红状态会训练团队忽视 CI 结果。
   - **部分不能（慢层）**：TS 压力轨空转（F10-03）、bench 空转（F10-07）、visual 未接线（F10-10）；仅 Rust #[ignore] 压力与 Playwright e2e 真实，且 e2e 只在 nightly。
2. **最弱缺口排序**：① 中层两 job 必红（最大，等于合并前无 e2e/无 F3/无集成层）；② TS 压力轨空转（虚假安全感）；③ e2e 仅 nightly + visual 从不跑（回归延迟以天/月计）；④ 双口径使 app-dir 体验与 CI 脱节（IDE 全红，报告失真）。
3. **优先修复序列**：F10-01/F10-02（中层复活，1-2 小时工作量）→ F10-05（口径收敛）→ F10-04/F10-10（合并前 e2e + visual 接线）→ F10-03/F10-07（压力/基准做实）→ 其余 P2 随治理轮清理。
