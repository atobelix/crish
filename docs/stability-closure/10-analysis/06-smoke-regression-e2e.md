# 端到端冒烟与回归体系：现状盘点与建设方案（06）

> 深度分析子 Agent 产出（只读 + 本文档；未修改任何代码）。日期：2026-08-09。
> 触发背景：DB 迁移崩溃（2 天）、MCP 端口假成功、前端快照 CSS 哈希漂移三起"CI 全绿、真机爆雷"事故。
> 全部结论基于实读（scripts/ 源码、三层 CI workflow、vitest/playwright 配置、src-tauri 主链路、dev_mcp.rs、conex-db）；不确定处已标注「未证实」。
> 姊妹文档：`01-data-migration-stability.md`（迁移链）、`02-runtime-health-observability.md`（MCP 假成功根因）、`03-boot-noise-logging-governance.md`（日志噪音）。

---

## 0. 结论先行

1. **scripts/ 下已有一批"真机冒烟半成品"，但全部未入库**：13 个 MCP 驱动/观察脚本（`tauri-mcp-driver/client`、`send-test-message`、`mcp-*` 系列、`bundle-daemon`、`cdp-*` 等）受 `.gitignore:167/362` 的 `*.mjs` 规则误伤，处于"本地有、仓库无"状态，违反 AGENTS.md 测试资产保护铁律。其中 6 个可直接复用为冒烟原语，1 个（`run-full-e2e-suite.mjs`）已入库但只覆盖 mock/headless 链路。
2. **三层 CI 全部跑在 `ubuntu-latest`，没有 Windows runner、没有 `tauri dev`、没有 MCP 通道、没有真实库生命周期**——这是三类事故的共同结构性根因。慢层离"真机冒烟"缺四样东西：Windows runner、tauri dev 进程管理、MCP TCP 4000 探测、sessions.db/快照的持久化断言。
3. **冒烟链路可全部基于现有资产拼装**：MCP TCP 4000（`CRISH_MCP_SOCKET=1`，token 边车 `%TEMP%\tauri-mcp-4000.token`）提供 `query_logs`/`execute_js`/`click`/`type_text` 等运行态通道；`execute_js` 内可 `invoke` 调 `list_sessions`/`core_get_status`/`core_compact_messages`（mcp-* 脚本已实证 invokeBootstrap 可用）；dev 模式 `sessions.db` 固定位于 `apps/agent-workbench/sessions.db`（host_paths.rs）。
4. **快照漂移的三重真相**：① Vite CSS Modules 默认 `_局部名_内容哈希` 类名进入 DOM，`toMatchSnapshot` 全量比对必然随 CSS 内容/模块顺序漂移；② 三个快照测试（`apps/crish-desktop/tests/snapshots/*.test.tsx`）**不在任何 vitest project 的 include 中**——unit 只含 `src/**`，integration 只匹配 `*.test.ts`，它们当前是 CI 脱管资产；③ 因此漂移只炸本地不炸 CI，治理必须同时做"接入 CI + 哈希隔离"。
5. **接入建议**：真机冒烟进慢层（`ci-slow.yml` 新 job `real-app-smoke`，windows-latest，daily+tag+dispatch 语义已匹配"发布前必跑"）；本地一键 `npm run smoke` 编排器先行，CI 以"无 UI 子集"分期推进（windows-latest 上 WebView2 渲染可行性未证实，标注风险）。

---

## ① scripts/ 盘点表

scripts/ 目录共 56 个文件，git 跟踪 28 个、未跟踪 28 个。未跟踪主因：`.gitignore:162-167` 与 359-365 两个重复块（"Antigravity/CDP/local dev temp logs and reports"）含 `*.mjs` 通配忽略；已入库的 .mjs（如 `audit-ui-runtime-errors.mjs`、`check-*.mjs`）为规则生效前或强加入库的历史存量（已跟踪文件不受 ignore 影响）。

### 1.1 冒烟/运行态相关脚本（本文关注面）

| 脚本 | 职责 | 调用方式/参数 | 断言强度 | 完成度 | 入库状态 |
|---|---|---|---|---|---|
| `run-full-e2e-suite.mjs` | 8 套件串行执行器（L1 agent-protocol、L1-Ext real-workflow、L2 UI-store、L2-Ext audit-ui、L2-Chaos、L2-Perf、L3 tauri-native-smoke、L3-Native） | 无参；报告写 `scratch/reports/e2e-full-report.json` | 每套件 exit 0/1 聚合，任一失败整体 exit 1（:128-130） | 完成（但全为 mock/headless 链路，无真机） | **已入库** |
| `audit-ui-runtime-errors.mjs` | Playwright chromium 连 5174 dev server，收集 pageerror / console error / StoreFreq 循环 / 反抖动 | 前置要求 dev server 已起（自检 10 次重试，失败 exit 1）；对照 `ui-selectors-manifest.json` / `ipc-daemon-audit-rules.json` | 运行时错误计数 >0 即失败（:81 起），日志面强 | 完成（浏览器层，非真 tauri 壳） | **已入库** |
| `tauri-mcp-driver.mjs` | MCP stdio 桥（spawn `npx tauri-plugin-mcp-server`）+ TCP 4000，命令：`list-tools` / `call <tool> [args.json]` / `batch <file>` | 结果写 `mcp-output.json`；单请求超时 60s；错误 exit 1 | 调用级原语，无业务断言 | 半成品（驱动层） | 未入库 |
| `tauri-mcp-client.mjs` | 同上精简版：`list` / `call <tool> <jsonArgs>`，stdout JSON | 无超时守卫（:52-58 无 timer） | 调用级原语 | 半成品 | 未入库 |
| `send-test-message.mjs` | **UI 冒烟雏形**：execute_js 找 textarea → focus → type_text → Enter → 等 15s → DOM 查消息 → 查错误文案（asyncIterator/run-terminal-failed 等） | 无参；依赖应用已启动 + TCP 4000 | **弱**：只 console.log，不 exit 非零；但链路骨架完整 | 半成品（骨架可复用） | 未入库 |
| `mcp-new-session.mjs` | 点"新对话" → 注入 textarea + 发消息 → 90s 观察循环（isRunning/hasError/toolCount/chatLen） | 可选消息参数；间隔 3s×30 步 | 观察型，无断言无退出码 | 半成品 | 未入库 |
| `mcp-long-test.mjs` | 多功能：`status`（daemon 连接/端点/get_status 三探针）`errors`（query_logs 过滤 error+warn）`sessions`（invoke list_sessions）`send-message` `observe` `snapshot` `pagemap` | 子命令 + 可选参数 | status/errors/sessions 三子命令含成败判定（execute_js 失败即 throw exit 1） | 半成品（7 个原语可直接复用 3 个） | 未入库 |
| `mcp-restart-daemon.mjs` | invoke `workbench_restart_daemon` → 轮询 `workbench_connection_status` 30×500ms 直到 ready | 无参 | 超时失败 exit 1（:83）；就绪轮询模式可复用 | 半成品（重启的是 daemon 非应用进程） | 未入库 |
| `mcp-run-detail.mjs` | query_logs 过滤 runtime-error/agent-end-error/run-complete 等关键字 + daemon 状态回查 | 无参 | 无断言（诊断工具） | 半成品 | 未入库 |
| `mcp-probe-provider.mjs` | 从 localStorage 取 provider 配置 → 直连 SSE 流打印帧结构 | 无参；无 API key 时 exit 1 | 无业务断言（协议观察） | 半成品（手动诊断） | 未入库 |
| `mcp-diagnose-config.mjs` | 检查本地 profiles / active 配置 / 调 syncActiveProfileToEngine / daemon 状态 | 无参 | 无断言 | 半成品 | 未入库 |
| `test-real-provider-api.mjs` | 真实 LLM API 出站（OpenAICompatibleProvider.chatStream），需 `API_KEY` env | env 驱动；无 key 时 exit 0 打提示 | **弱**：catch 后不 exit 非零（:51-53） | 手动工具 | **已入库** |
| `test-real-fetch.mjs` | 原生 fetch 直连 opencode 网关 | `OPENCODE_TEST_API_KEY` env | 无断言（打印状态码） | 手动工具 | **已入库** |
| `bundle-daemon.mjs` | esbuild 打包 daemon sidecar + SHA256SUMS | 无参；依赖 `packages/agent-daemon/dist` | 构建工具（非测试） | 完成（与冒烟无关，被 *.mjs 误伤） | 未入库 |
| `cdp-click-eval.mjs` / `cdp-screenshot.mjs` | Chrome DevTools 协议辅助 | 手动 | 无断言 | 手动工具 | 未入库 |
| `check-chat-state.mjs` / `check-coverage-threshold.mjs` / `check-tsc-threshold.mjs` / `check-line-counts.mjs` / `test-provider-tools.mjs` | 各类静态/阈值检查 | 各异 | 见各自实现 | 治理脚本，未入库 | 未入库 |

### 1.2 已入库的非冒烟脚本（与本文无直接关系，清单为完整度）

`acceptance-criteria.ts`、`check-clippy-baseline.mjs`、`check-conex-db-size.mjs`、`check-crate-size.mjs`、`check-layoutstore-actions.mjs`、`check-no-as-any-store.mjs`、`check-swallowed-errors.mjs`、`check-ui-layer.mjs`、`check-unwrap-baseline.mjs`、`compare-benchmarks.ts`、`generate-engine-bindings.mjs`、`generate-manifest.mjs`、`generate-perf-report.ts`、`inapp-goal-smoke.mjs`、`inspect-components.mjs`、`parse-all-components.mjs`、`scan-components.mjs`、`categorize-components.mjs`（及 5 个 json/md 数据文件）——均为静态检查/生成/治理 ratchet，不进运行态冒烟。

### 1.3 盘点结论

- **可直接复用为冒烟原语（6 个）**：`tauri-mcp-client.mjs`（调用原语）、`mcp-long-test.mjs`（status/errors/sessions）、`mcp-restart-daemon.mjs`（重启+就绪轮询模式）、`mcp-new-session.mjs`（UI 操作序列）、`send-test-message.mjs`（UI 链路骨架）、`tauri-native-smoke.spec.ts`（进程 spawn/存活/无残存断言模式，在 tests/e2e 下，已入库）。
- **可扩展复用（1 个）**：`audit-ui-runtime-errors.mjs`（错误收集器，需从 5174 浏览器面改为真机执行面）。
- **半成品判定依据**：全部 MCP 脚本无统一退出码协议、无超时汇总、无 JSON 报告、依赖"应用已手动启动"；`send-test-message`/`mcp-new-session` 的断言只打印不判定。
- **入库状态是硬伤**：13 个冒烟相关 .mjs 未入库；`bundle-daemon.mjs` 这种构建工具也因 `*.mjs` 被误伤。修复方案见 §5.4。

---

## ② CI 与真机测试的鸿沟

### 2.1 三层 CI 现状（实读）

| 层 | 文件 | 触发 | runner | 内容 |
|---|---|---|---|---|
| 快层 | `.github/workflows/ci.yml` | push/PR（docs 除外） | **全 ubuntu-latest** | cargo check --locked、typecheck、vitest unit+coverage（阈值 45/70/65/45）、eslint+depcruise、npm audit、engine-bindings drift、cargo-deny、gitleaks、cargo test -p conex-types -p session-loop |
| 中层 | `.github/workflows/ci-mid.yml` | PR+main | **全 ubuntu-latest** | cargo test 全量、clippy+基线 ratchet、vitest 全量、F3（integration/fuzz/race/recovery）、machete、knip、playwright 冒烟子集 5 spec、unwrap/吞错/crate-size 三基线 |
| 慢层 | `.github/workflows/ci-slow.yml` | daily 02:00 UTC + dispatch + v* tag | **全 ubuntu-latest** | rust-stress（release --ignored）、stress-ts（npm run stress，Node 层）、e2e（playwright tests/e2e 全量 + L2 mock 引擎）、bench（crates/*/benches 未落地则跳过） |

关键事实：
- 慢层 e2e job 的 webServer = `npm --workspace @crish/crish-desktop run dev`（5174，浏览器直连 dev server + `__TAURI_INTERNALS__` mock 注入，见根 playwright.config.ts:55-76），**不是 tauri 壳**。
- `tauri-native-smoke.spec.ts`（vitest native-smoke 项目，`npm run test:e2e:native`）：spawn 编译好的真二进制 → 断言进程存活 + 日志含「setup 完成（IPC 模式）」→ taskkill 干净退出 → 无残存进程。二进制不存在时 `describe.skipIf` 跳过。**这是最接近"真机"的既有资产，但无前端窗口、无 MCP socket、无 IPC 交互、无 DB 断言**（tauri-native-smoke.spec.ts:111-225）。
- 慢层 `bench` job 在 `crates/*/benches` 不存在时打印提示跳过（ci-slow.yml:76-82）——慢层本身有"占位-落地"演化先例，真机冒烟可循同样路径。

### 2.2 三类事故为什么 CI 抓不住

| 事故 | 现有测试为何不覆盖 | 需要的运行形态 |
|---|---|---|
| **DB 迁移崩溃 2 天**（真实库形态缺失） | `crates/conex-db/tests/migrations.rs` 用合成 fixture 库，覆盖 v1/v2/v3/v5 等形态与崩溃中间态自愈（01 文档 §1.4），但**壳层 `open_session_db` + 降级 + 真实用户库生命周期**（旧库升级→写入→重启→再读）没有任何进程级验证；CI 的 cargo test 直接构造 LocalDb，跳过 main.rs 的打开路径 | 真机：真实 `apps/agent-workbench/sessions.db`（dev 模式路径，host_paths.rs:5-15）+ 跨进程重启后的数据恢复断言 |
| **MCP 端口假成功**（无运行态探测） | 02 文档已定位根因：tauri-plugin-mcp `socket_server.rs` 的 listener `JoinHandle` 从不 poll，accept 循环崩溃后端口关闭但应用无感；插件是外部 crate，应用侧单测无法覆盖；CI 无任何"TCP 连接 4000 + 命令往返"探测 | 真机：TCP connect 握手 + `query_logs` 往返 + token 边车文件校验 |
| **快照 CSS 哈希漂移**（前端） | 三个快照测试不在任何 vitest project include 内（unit 只含 `apps/crish-desktop/src/**` 与 `__tests__`，integration 只匹配 `*.test.ts` 不含 `.test.tsx`；vitest.config.ts:60-106）——**CI 根本不跑它们**；`toMatchSnapshot` 全量比对 CSS Modules 哈希类名，任何 CSS 内容变化即全量漂移 | 治理 + CI 接入（详见 §4） |

### 2.3 慢层离"真机冒烟"还差什么

1. **Windows runner 缺失**：三层全部 `ubuntu-latest`。真机冒烟是桌面应用语义（WebView2、taskkill /T 进程树、%TEMP% token 边车、Windows 路径的 sessions.db），GitHub Actions `windows-latest` 可满足，但从未启用。**未证实风险**：windows-latest 为服务会话，WebView2 渲染/`tauri dev` 拉起窗口的可行性需实测（备选：无 UI 子集）。
2. **tauri dev 进程管理缺失**：现有 e2e 是 playwright webServer 拉 dev server；native-smoke 是 spawn 静态二进制。都没有"`CRISH_MCP_SOCKET=1 npm run dev:workbench`（tauri dev + Vite 5174）+ 就绪探测 + 进程树回收 + 重启"的编排。
3. **MCP 通道缺失**：`query_logs`/`execute_js`/`click`/`type_text` 只在真 tauri + debug + env 开启时注册（dev_mcp.rs:57-71），现有测试面无法触达。
4. **持久化断言缺失**：没有任何测试读 `sessions.db` / `orchestrator-snapshot.json` / `%TEMP%\tauri-mcp-4000.token`。
5. **运行态日志断言缺失**：`check-swallowed-errors.mjs` 是静态扫描；`audit-ui-runtime-errors.mjs` 是浏览器 console 面；没有"真机日志流（query_logs）无 ERROR / 无重复 warn"的判定。

---

## ③ 冒烟套件规格（自动化链路）

### 3.1 总体设计

- **编排器**（新脚本，建议 `scripts/smoke-real-app.mjs`）：单进程编排，逐步执行 S1-S8，每步输出 `{step, ok, detail, tookMs}`，终局汇总 JSON 写 `scratch/reports/smoke-real-app.json`；`--ci` 模式（无交互、无 --full）；`--full` 模式（本地，含 LLM 真实链路，见 S6）。
- **复用原则**：只写编排器与断言壳，不重造原语——复用 `tauri-mcp-client.mjs`（或抽公共 mcp 调用模块）、`mcp-long-test.mjs` 的 status/errors/sessions 逻辑、`mcp-new-session.mjs` 的 UI 操作序列、`tauri-native-smoke.spec.ts` 的进程管理。
- **退出码协议**：0 = 全绿；10 = 环境前置失败；20 = 启动失败/超时；21 = MCP 通道失败；22 = DB 断言失败；23 = 会话链路失败；24 = 压缩链路失败；25 = 重启恢复失败；26 = 日志健康失败。每步失败即中断（幂等清理后退出）。
- **通道事实（已实证）**：TCP 4000 请求格式 `{command, payload, id, authToken}` + `\n`（mcp-new-session.mjs:14-28）；token 边车 `%TEMP%\tauri-mcp-4000.token`（mcp-long-test.mjs:11-16 亦支持 `TAURI_MCP_AUTH_TOKEN` env）；`query_logs` 返回 `{data.entries: [{level, message, source, ts}]}`（mcp-long-test.mjs:83-89）；`execute_js` 内 `window.__TAURI_INTERNALS__.invoke` 可用（invokeBootstrap，mcp-new-session.mjs:38-43）。

### 3.2 链路与断言强度（硬 = 失败即中断；软 = 记 warn，exit 0 但汇总标注）

| 步骤 | 动作 | 判定 | 强度 | 超时 | 退出码 |
|---|---|---|---|---|---|
| S0 前置 | 环境检查：node 可用、端口 4000/5174 空闲、debug 二进制可构建（`cargo build -p crish-agent-workbench` 已存在或可 5min 内完成）、Windows 平台 | 全部满足 | 硬 | 30s | 10 |
| S1 启动 | `CRISH_MCP_SOCKET=1 CRISH_LOG_LEVEL=info npm run dev:workbench`（spawn，输出全量收 `scratch/logs/smoke-app.log`） | 就绪 = **TCP 4000 可 connect**（非日志关键字，直击"假成功"）；软辅：日志含「会话数据库已打开」 | 硬 | 180s | 20 |
| S2 DB 打开 | `query_logs` 过滤 `target=db`：有「会话数据库已打开」；软辅：无「打开 sessions.db 失败」ERROR；`apps/agent-workbench/sessions.db` 文件存在 | 硬（日志有 + 文件存在）；软（无 ERROR） | 硬+软 | 30s | 22 |
| S3 MCP 通道 | TCP connect + token 握手（读边车文件，缺失即硬失败）→ `query_logs` 往返成功 | 往返成功 + token 有效 | 硬 | 30s | 21 |
| S4 建会话 | `execute_js` 点「新对话」→ `invoke('list_sessions')` 记前/后计数，硬断言 +1；软辅：UI 找到按钮（找不到则仅走 invoke 路径，标注 UI 未覆盖） | 计数 +1 | 硬（计数）/ 软（UI 点击） | 60s | 23 |
| S5 发消息 | `execute_js` 注入 textarea（nativeInputValueSetter + input 事件）+ 发送按钮点击（复用 mcp-new-session 序列）→ 轮询日志出现 run 事件 / DOM 出现新消息 | 消息进入会话（日志事件或 DOM 二选一） | 硬 | 120s | 23 |
| S6 压缩链路 | B 路径（默认）：`invoke('core_compact_messages')` 往返成功 + 直查 `sessions.db`：`compression_blocks` 表存在（v7 形态断言，INSERT OR IGNORE 一行测试块再删除或只做 SELECT schema）；A 路径（--full）：真实会话摘要回调落块（core_run_commands.rs:1380 阶段二），等块行出现 | B：命令往返 + 表存在（硬）、真实块落库（软）；A：块行出现（硬，仅 --full） | 硬+软 | B 60s / A 300s | 24 |
| S7 重启恢复 | taskkill /T 杀进程树（复用 tauri-native-smoke killProcessTree）→ 等退出 → 重启（同 S1）→ `invoke('list_sessions')` 含 S4 会话（硬）+ `load_session_body` 非空（硬）→ 软辅：`orchestrator-snapshot.json` 存在（main.rs:351-353，restore 异步执行，core_run_commands.rs:479-520 restore_ready 门禁） | 会话与消息恢复 | 硬 | 180s+180s | 25 |
| S8 日志健康 | `query_logs` 全量（limit 500+）：无 `ERROR` 级（硬）；warn 按签名去重计数，超过白名单阈值（如单签名 warn > 3 次，配置项）即失败（软→默认仅标注）；崩溃文件数不增（软） | 按上述分级 | 硬（ERROR=0）+ 软 | 30s | 26 |

### 3.3 关键设计决策与诚实标注

- **S1 就绪判定必须用 TCP 探测而非日志**：正是"Socket server started successfully"日志假成功的教训（02 文档 §0.2）；TCP connect 成功 + S3 命令往返才是真就绪。
- **execute_js 可用性风险（未证实）**：dev_mcp.rs:12-13 注释称 execute_js 等高危命令"由前端 `workbench_dev_mcp_enabled()` 查询 `{enabled, execEnabled}` 后按需注册"，且 G11a 登记"接线在途"（dev_mcp.rs:24-26）。冒烟启动时**同时设置 `CRISH_DEV_MCP_EXEC=1`** 并前置探测；若 execute_js 不可用，S4-S7 降级为纯 `query_logs` + 直接 IPC（走 S3 通道之外的备用路径），降级路径在报告中明确标注。
- **S6 压缩落库的事实边界**：`core_compact_messages` 是纯内存压缩（core_commands.rs:244-262），不落库；**落 `compression_blocks` 表的是会话摘要完成回调**（summary_coordinator 默认回调，core_run_commands.rs:1380-1408）。因此 B 路径（默认）只断言"命令面存活 + 表结构存在"，A 路径（--full）才走真实回调链。规格不掩盖"受控压缩不落库"的架构事实。
- **S7"重启"是应用进程级**：`mcp-restart-daemon.mjs` 重启的是 daemon（其 WS 链路已删，脚本本身是历史遗留），冒烟的重启必须 kill 整个 tauri 进程树后重新 spawn——这是 DB 持久化/会话恢复断言的前提。
- **环境矩阵**：
  - 本机 Windows（推荐主环境）：完整链路 S1-S8；`npm run smoke` 一键。
  - CI `windows-latest`（二期）：先跑无 UI 子集（S1-S3 + S7-S8 的 DB 恢复部分，S4-S6 标注 skip）；WebView2 渲染可行性**未证实**，需试点。
  - CI `ubuntu-latest`：不适用（WebView2/sessions.db 路径语义差异），不接入。
- **总预算**：默认路径 ≤ 10min（S1 180s + S5 120s + S7 360s + 其余 ~90s），可进慢层 40min 预算；--full 模式 ≤ 15min。

---

## ④ 快照/基线稳定性

### 4.1 根因（实读实证）

1. **CSS Modules 哈希进 DOM**：Vite 默认类名格式 `_局部名_内容哈希`，`.snap` 实证 `class="_toolStack_3f3761"`（ChatToolCallBlock.test.tsx.snap:5、8）；哈希基于「相对路径 + CSS 内容」（Vite 默认 generateScopedName），任一 CSS 文件内容变化 → 该文件全部模块类名变 → `toMatchSnapshot` 全量 diff。
2. **配置面无定制**：`apps/crish-desktop/vitest.config.ts` 与 `vite.config.ts` 均未配置 `css.modules.generateScopedName`（实读确认），测试运行时 Vite 默认转换，哈希直接进入渲染 DOM。
3. **脱管状态（比漂移更严重）**：三个快照测试（AppErrorBoundary / ChatToolCallBlock / ToastStack）位于 `apps/crish-desktop/tests/snapshots/`，而：
   - unit 项目 include = `packages/*/src/**`、`apps/crish-desktop/src/**`、`src/__tests__/**`（vitest.config.ts:60-72）——不匹配 `tests/` 目录；
   - integration 项目 include = `apps/crish-desktop/tests/**/*.test.ts`（:85-97）——`*.test.ts` 不匹配 `.test.tsx`；
   - 结论：**三个快照测试在任何 CI job 中都不运行**，是"本地手跑才生效"的脱管资产；漂移之所以"漏到用户"，准确说是"漏到开发者"，且无门禁价值。

### 4.2 治理方案（三层递进，推荐组合 1+3）

| 方案 | 做法 | 收益 | 成本/风险 |
|---|---|---|---|
| 1. 快照隔离（推荐主） | `expect.addSnapshotSerializer`（在 `apps/crish-desktop/src/test-setup.ts` 或快照测试共享 setup）把 `class="_\w+_哈希"` 归一化为 `class="__hashed__"`（正则 `/_([A-Za-z0-9_]+)_[0-9a-f]{6}/g` 保守替换 `_$1__`）；或为三个测试单独配 `resolveSnapshotPath` 指向隔离目录 | 哈希噪音归零，结构/文案/属性断言保留；改动小（一个 serializer） | 快照不再能断言"样式类是否变化"——但哈希类名本就无断言价值；`[0-9a-f]{6}` 长度需实测核对（.snap 为 6 位） |
| 2. 哈希稳定化（可选辅助） | `vite.config.ts` 配 `css.modules.generateScopedName` 为无哈希格式（如 `[name]__[local]`） | 类名稳定到"文件+局部名" | 生产 CSS 跨文件重名冲突面（文件名唯一性一般足够，但需评估 monorepo 内 CSS 命名）；改动影响生产产物 |
| 3. CI 接入 + 纪律（必须） | ① unit 项目 include 补 `apps/crish-desktop/tests/snapshots/**/*.test.{ts,tsx}`（或 integration 项目 include 补 `*.test.{ts,tsx}`，建议 unit：快层即可跑）；② vitest 以 `--ci` 运行（CI 下禁止自动写快照，漂移即失败）；③ 本地更新必须显式 `vitest run -u` 且随提交审查 .snap diff；④ 快照更新纪律写入 AGENTS.md（与 markdown-editor 门禁并列） | 漂移从"本地噪音"升级为"CI 门禁" | 首次接入需 -u 更新一次基线（配合方案 1 后无哈希噪音，更新一次性） |
| 4. 降级备选 | 三个测试改为结构化断言（data-* 属性 + 文案 + 计数，ChatToolCallBlock 已有 `data-tool-*`/`aria-label` 语义），删除 .snap 资产 | 完全消除快照脆弱面 | 丢失 DOM 结构快照回归能力；与测试资产保护铁律需用户裁决（删 .snap 属于删除测试资产） |

推荐：**方案 1（序列化器剥离）+ 方案 3（CI 接入 + --ci + 更新纪律）**；方案 2 仅在需要生产类名稳定时启用；方案 4 作为快照持续脆弱的最终退路（需用户裁决）。

### 4.3 快照资产现状（实读）

- 3 个测试文件 + 3 个 .snap 已入库（`git ls-files` 确认），总计：AppErrorBoundary / ChatToolCallBlock（536 行 .snap，含 lucide svg 全量结构）/ ToastStack。
- 快照内容含：CSS 哈希类名、lucide SVG 内联结构、中文文案（「构建项目」「失败」「已折叠」等）——文案与结构断言有价值，哈希无价值，佐证方案 1 的精准剥离面。

---

## ⑤ 回归分级与接入建议

### 5.1 分层归属

| 层 | 放什么 | 理由 |
|---|---|---|
| 快层 ci.yml | 不动 | 5min 预算；真机冒烟 ≥10min 不匹配 |
| 中层 ci-mid.yml | 不动（快照测试接入后，随 unit 项目进快层即可覆盖） | 冒烟失败不应阻塞 PR（时长+平台成本） |
| **慢层 ci-slow.yml** | **新增 job `real-app-smoke`**（windows-latest，daily 02:00 + dispatch + v* tag 触发均已具备） | "发布前必跑"语义与慢层 tag 触发天然吻合；与 rust-stress/stress-ts/e2e/bench 并列 |
| 本地 | `npm run smoke`（完整链路）/ `npm run smoke:ci`（无 UI 子集） | 开发者日常回归 + CI 前自检 |

### 5.2 分期落地（风险平滑）

- **一期（本地先行）**：写 `scripts/smoke-real-app.mjs` 编排器（复用 §1.3 的 6 个原语）→ 本机跑通 S1-S8 → 报告 JSON 落盘 → 提交入库。
- **二期（CI 试点）**：ci-slow.yml 加 `real-app-smoke` job，先跑无 UI 子集（S1-S3 + S7-S8 DB 恢复 + S8 日志健康），S4-S6 标注 skip 并在报告注明；**未证实项**：windows-latest 上 WebView2 渲染 / tauri dev 拉窗可行性——若不可行，CI 侧退化为"进程级 + MCP 通道 + DB 恢复"子集（与 tauri-native-smoke 同哲学），UI 链路保留本地 nightly。
- **三期（全量）**：UI 链路（S4-S6）进 CI；`--full`（LLM 真实链路）保持本地/手动。

### 5.3 与既有资产的衔接

- `tauri-native-smoke.spec.ts` 保留（进程级冒烟是 S7 进程管理的现成参考）；真机冒烟与其不重复：native-smoke 验"二进制可拉起/干净退出"，smoke 验"运行态全链路"。
- `run-full-e2e-suite.mjs` 的 8 套件执行器模式（聚合报告 + 汇总退出码）直接复用于冒烟编排器；建议新增冒烟套件条目而非另起炉灶（L4-Real: 真机冒烟）。
- 快照测试接入 CI 后，与 ci.yml vitest-fast 的 `--coverage` 阈值口径对齐（快照测试计入 unit 覆盖率，45/70/65/45 阈值需复核影响，标注）。

### 5.4 入库纪律（AGENTS.md 测试资产铁律落实）

1. **修 .gitignore 白名单**：在 `.gitignore:167/362` 的 `*.mjs` 后追加 `!scripts/*.mjs`（或精确到冒烟脚本清单），并补 `!tests/e2e/**` 类目（tauri-native-smoke.spec.ts 已入库，不受影响）；同时移除 `.gitignore:55-56/250-251` 之外对 scripts/ 的其它误伤（实读确认无，仅 *.mjs）。
2. **补入库现有 13 个未跟踪 .mjs**：`git add -f scripts/tauri-mcp-driver.mjs scripts/tauri-mcp-client.mjs scripts/send-test-message.mjs scripts/mcp-*.mjs scripts/bundle-daemon.mjs scripts/cdp-*.mjs scripts/check-chat-state.mjs scripts/check-coverage-threshold.mjs scripts/check-tsc-threshold.mjs scripts/check-line-counts.mjs scripts/test-provider-tools.mjs`（白名单生效后无需 -f）。
3. **新冒烟脚本立即入库**：`smoke-real-app.mjs` 与 `npm run smoke`/`smoke:ci` 脚本随首个提交一并入库；报告产物 `scratch/reports/` 保持忽略（.gitignore:191 scratch/）。
4. 冒烟脚本头部注明运行前置（应用需 debug 构建 + Windows），与 `test-real-provider-api.mjs` 的 env 说明风格一致。

### 5.5 验收标准（供落地任务引用）

- `npm run smoke` 本机全绿：S1-S8 全部通过，无 `--full` 亦无 skip 项（除 S6-A）。
- 人为注入故障可被抓：① 停掉 MCP 注册（改 env 不设 `CRISH_MCP_SOCKET=1`）→ S1/S3 失败；② 删除 sessions.db 后启动 → S2 日志断言失败或 S7 恢复失败；③ 快照测试改一处 CSS → CI vitest-fast 失败。
- 慢层 `real-app-smoke` job 运行 ≤ 15min，失败产物（smoke-app.log + 报告 JSON）随 workflow artifact 保留。

---

## 附：引用索引（文件:行号）

- `.gitignore:167/362` `*.mjs` 忽略；`.gitignore:162-167` 注释块「Antigravity/CDP/local dev temp logs」
- `apps/agent-workbench/src-tauri/src/dev_mcp.rs:21-71` MCP 开关/端口/token；`:12-13,24-29` execute_js 二次 env 与接线在途
- `apps/agent-workbench/src-tauri/src/main.rs:224-254` open_session_db 降级；`:283-286` MCP 注册；`:351-353` 快照路径；`:376-384` restore 异步
- `apps/agent-workbench/src-tauri/src/host_paths.rs:5-15` dev 模式 app_dir = apps/agent-workbench
- `apps/agent-workbench/src-tauri/src/session_commands.rs:115-152` list_sessions/load_session_body/save_session_body
- `apps/agent-workbench/src-tauri/src/core_commands.rs:244-262` core_compact_messages（纯内存）
- `apps/agent-workbench/src-tauri/src/core_run_commands.rs:1380-1408` 摘要完成回调落 compression_blocks
- `crates/conex-db/src/migrate.rs:524-563` v7 compression_blocks 迁移；`crates/conex-db/src/blocks.rs:102-140` 缺表降级
- `vitest.config.ts:60-97` unit/integration include 未覆盖 tests/snapshots（.tsx）
- `apps/crish-desktop/vitest.config.ts:1-33` 无 css.modules 定制
- `apps/crish-desktop/tests/snapshots/__snapshots__/ChatToolCallBlock.test.tsx.snap:5-8` `_toolStack_3f3761` 哈希类名实证
- `.github/workflows/ci.yml`、`ci-mid.yml`、`ci-slow.yml` 三层全 ubuntu-latest
- `playwright.config.ts:55-76` webServer 5174/5173（dev server + mock 引擎）
- `tests/e2e/tauri-native-smoke.spec.ts:111-225` 进程级冒烟模式
- `docs/stability-closure/10-analysis/02-runtime-health-observability.md:12` MCP 假成功根因（socket_server.rs:305,341-344）
- `docs/stability-closure/10-analysis/01-data-migration-stability.md:31-35` 事故修复与回归测试；`:62` V3-NO-EVENTS 活雷
