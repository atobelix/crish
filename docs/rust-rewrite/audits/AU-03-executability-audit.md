# AU-03 · PE-01 ~ PE-10 执行任务书可执行性与事实核查审计

> 日期：2026-08-01 · 审计类型：只读（未改任何代码）
> 审计范围：`docs/rust-rewrite/plans/PE-01` ~ `PE-10`（10 份任务书）
> 方法：每份任务书抽查 3~5 项关键断言（文件存在性、函数名、行号、计数），grep/glob/读源码实测；
> 交叉比对任务书之间的依赖、重复与冲突。
> 行号统计口径：本审计用 `[System.IO.File]::ReadAllLines`（与 rg 行号一致）；部分含中文的文件
> `Get-Content` 计数偏差 ±10%，已在文中注明口径。

---

## 〇、总评（TL;DR）

| 维度 | 结论 |
|---|---|
| 事实核查 | 整体**准确度很高**：10 份任务书的行号/函数名/计数断言约 90% 经实测属实（PE-01/07/08/10 接近 100%）。主要错误集中在：文件路径省略（PE-05/PE-10）、行号系统性过时（PE-05，+20~68 行）、少量失效文件引用（PE-02 `markdownCache.ts` 不存在）、函数名引用偏差（PE-01/PE-06 `waitForHydration` vs `waitForStoreHydration`）。 |
| **最大风险** | **跨任务书重复与冲突未声明**：PE-01/06/07/08/09 之间存在 8+ 组「同一文件、同一功能、两份任务书都认领」的重叠，且互不引用、甚至语义矛盾（详见 §三）。这是全部问题中最严重的，直接决定这些任务书不能照单执行。 |
| 任务粒度 | PE-03 T03.3、PE-07 T07.1、PE-08 T08.6/T08.7、PE-09 T09.1 偏大，建议拆分；其余粒度合理。 |
| 验收可测性 | 总体优秀（grep 断言 + 量化阈值 + 用例表）；个别主观项（PE-02 视觉验证）与 1 处逻辑矛盾（PE-03 T03.1 验收前置矛盾）。 |
| 执行准备度 | PE-01/03/04/07 需要先冻结跨方案接口（命令命名、CoreStatus 字段、RecoveryHook 签名、upsert 写模型）；PE-08 需要真实 v3 库样本输入；PE-09 需要先采基线。 |

---

## 一、事实核查错误清单

> 格式：任务书 | 断言（文档原文引用） | 实际情况 | 影响。✅=属实；⚠️=偏差；❌=错误。

### PE-01 config-startup

| 任务书 | 断言 | 实际情况 | 影响 |
|---|---|---|---|
| PE-01 T01.1 | `core_get_status` 无 provider 字段（core_query_commands.rs:49-62） | ✅ `CoreStatus` 结构体在 core_query_commands.rs:49 起，仅 6 字段无 provider | 无 |
| PE-01 T05.1 | `env!("CARGO_MANIFEST_DIR")` 编译机路径（host_paths.rs:7） | ✅ 精确（host_paths.rs:7） | 无 |
| PE-01 T02.1 | `parseEngineStatusFromRaw` 缺省 false（engineConfig.ts:424-429） | ✅ 精确（424-429 三态解析） | 无 |
| PE-01 P2 | `crish_provider_profiles_v1` 明文 apiKey（profileStore.ts:30,310-318） | ✅ 精确（30/314） | 无 |
| PE-01 T03.4 | `syncActiveProfileToEngine`（AppBootstrap.ts:300-304、profileStore.ts:565-602） | ⚠️ AppBootstrap 301-302 ✓；profileStore.ts 中函数实际止于 ~597 行（文件 595 行），565-602 略超文件尾 | 轻微，执行时按函数名定位即可 |
| PE-01 T04.4 | `await waitForHydration()`（store-persistence.ts:71-86 已导出，从未被调用） | ⚠️ store-persistence.ts:71-86 导出的是 **`waitForStoreHydration(store)`**（带参泛型）；无参 `waitForHydration()` 实际在 **layoutStore.ts:377**（内部委托前者）。「从未被调用」✅ 属实（全仓零调用者） | 低：接线目标明确，但执行者按文档路径找 `waitForHydration` 会在 store-persistence.ts 扑空 |
| PE-01 T06.2 | `cleanup_orphan_sessions:188-200` 附近、conex-db lib.rs:834-836 空 keepIds 全删 | ✅ session_commands.rs:189-200、lib.rs:820-860（834-836 为 DELETE） | 无 |
| PE-01 T06.1 | conex-db 已有 `upsert_session_entry` 能力，session_commands.rs:321 测试已引用 | ✅ lib.rs:354 实现存在、session_commands.rs:321 测试引用 | 无 |
| PE-01 T03.1 | `update_daemon_config`、`sentToDaemon`（config/provider.rs:372-383、409-499、483/496） | ✅ 409 定义、483/496 精确 | 无 |

### PE-02 streaming-markdown

| 任务书 | 断言 | 实际情况 | 影响 |
|---|---|---|---|
| PE-02 §0 | AsyncMarkdownBlock.tsx:51-59 流式期纯文本 + caret | ✅ 精确（73 行文件，51-59 纯文本分支） | 无 |
| PE-02 §1.4.1 | E1：renderTarget = isStreaming ? '' : text（:34） | ✅ 精确 | 无 |
| PE-02 §1.4.3 | IncrementalMarkdownParser（455 行）、IncrementalDomRenderer（96 行）、IncrementalInlineRenderer（203 行）、useStreamRenderThrottle（64 行）、markdownPreload（74 行）、StreamRenderBuffer（314 行）、MessageContent（172 行）、perfBenchmark（520 行） | ✅ 全部精确（ReadAllLines 口径） | 无 |
| PE-02 §1.4.3 | 流式 partial 缓存键：**markdownCache.ts:81-175**（仅测试） | ❌ **文件不存在**（全仓无 markdownCache.ts）；partial 相关唯一引用在 IncrementalMarkdownParser.test.ts | 低：清单中一个资产引用已失效，执行时可删除该行 |
| PE-02 §1.4.2 | engine.rs:293-324 SSE 全量缓冲进 Vec | ✅ 精确（`events: Vec<...>` + 流结束才返回） | 无 |
| PE-02 §1.4.2 | streaming.rs:234-245 emit_message_deltas 整块 emit | ✅ 精确 | 无 |
| PE-02 §1.4.3 | 增量资产生产零调用（仅 perfBenchmark:22 与测试） | ✅ 属实（rustCore.ts/StreamRenderBuffer/AsyncMarkdownBlock 中仅注释提及） | 无 |
| PE-02 §1.4.3 | renderer.rs:143-147、396-405 flush_fence；stream_mode 107-110 | ✅ 精确（110/145-147/396-405） | 无 |
| PE-02 T02.2 | IncrementalMarkdownParser.test.ts（481 行既有用例） | ⚠️ 实测 487 行 | 无影响 |

### PE-03 ipc-contract

| 任务书 | 断言 | 实际情况 | 影响 |
|---|---|---|---|
| PE-03 §1.1 | 注册命令 **78** 个（main.rs make_handlers! 逐行） | ✅ 实测逐行数=78（2+4+4+5+7+2+13+15+4+5+11+5+1） | 无 |
| PE-03 §1.2 | commandMap.ts:31-39 幽灵条目 9 条 | ✅ 精确（`workbench_git_status`…`workbench_get_subagent_status` 9 条） | 无 |
| PE-03 §1.3 | invokeResult（tauriInvoke.ts:127-141）missing/error 全吞 null | ✅ 精确（127 行定义） | 无 |
| PE-03 T03.2 | rustCore.ts 25 处直调 | ⚠️ 实测 23 处（`invokeResult/invokeTyped/invokeCmd` 计数口径差 2） | 无影响（数量级一致） |
| PE-03 T03.7 | mcpApi.ts:229、clientApi.ts:848/863/873、schedule.ts:26/42/53、SessionSyncService.ts:182 不可用调用点 | ✅ 全部命中（clientApi 846-849、mcpApi 227-230、schedule 26-27、SessionSyncService 173） | 无 |
| PE-03 §7.2 | 复算 78−12−3+1=64 | ✅ 算术与 §2.2/§2.3 清单一致（引擎 48 + GUI 16 = 64） | 无 |

### PE-04 observability

| 任务书 | 断言 | 实际情况 | 影响 |
|---|---|---|---|
| PE-04 §2.1 | `subscriber.rs::init_default`、`panic_hook.rs::install_panic_hook` 零调用 | ✅ 精确（subscriber.rs:32、panic_hook.rs:29 定义；workbench src-tauri 无任何 conex_telemetry 调用） | 无 |
| PE-04 §2.3 | LoggerService 0 调用 | ✅ 全仓仅定义文件自身 | 无 |
| PE-04 §2.3 | 裸 console 137 处（生产 108 处） | ✅ 实测非测试文件 108 处（137 为含测试口径） | 无 |
| PE-04 §2.2 | StoreError（persist.rs:26）、LoopError（loop/mod.rs:49）、DbFailure（conex-db/lib.rs:9） | ✅ 精确 | 无 |
| PE-04 T04.1-2 | main.rs:120 setup 现状 | ⚠️ main.rs:120 是 `fn main()`，setup 在 137-206 | 低 |

### PE-05 componentization

| 任务书 | 断言 | 实际情况 | 影响 |
|---|---|---|---|
| PE-05 T05.1.2 | shell-polish.css:18-84 `.ui-btn` 体系（31 个 tsx 使用） | ⚠️ 内容精确（18-84 ✓、30 个 tsx 文件使用），但**路径省略**：文件实际在 `src/styles/shell/shell-polish.css`（任务书写作根级） | 低：执行者按文档路径找不到文件 |
| PE-05 T05.5.2 | shell-polish.css:966-1079 `.settings-select-menu/item` | ✅ 精确（966/986/1079） | 无 |
| PE-05 T05.5.2 | settings-plugins.css:639 `.settings-select-trigger` + 3 处 `:global` | ✅ 精确（639/645-647），同样路径省略（`styles/settings/`） | 低 |
| PE-05 T05.5.3 | tokens.css:244-245 `--z-modal: 5000` 重复定义 | ✅ 精确（245 行） | 无 |
| PE-05 T05.5.4 | tokens.css:272 `--space-0_5` / 289 `--space-0.5` 双命名 | ✅ 精确（272/289） | 无 |
| PE-05 T05.8 | ChatStatusRibbons.tsx:833 `is-danger` 死类 | ✅ 精确（833） | 无 |
| PE-05 全文 | 大组件行数：ChatStatusRibbons 864、SettingsPanel 703、FirstRunWizard 776、Workspace 618、RuntimePanel 657、SettingsRulesTab 643、PreviewCard 637、ScheduledTasksPanel 626、useTopBarDrag 718、UnifiedSelectPopover 242、SettingsSelect 170、AgentCard 401、FocusTrap 107、Tooltip 143 | ⚠️ **系统性过时**：实测 913/753/834/665/692/680/664/656/786/262/180/420/107/143——偏差 **+10~68 行**（文件普遍已增长 5-8%）。FocusTrap/Tooltip 精确 | 中：文件全部存在、功能描述准确，但执行者按行号定位会错位。任务书本身要求「以脚本复核」，可接受 |
| PE-05 T05.6 | FilesCard.tsx（7 行 shim）、OverviewCard.tsx（9 行 shim） | ✅ 存在（实测 8/11 行） | 无 |

### PE-06 abstraction-dedup

| 任务书 | 断言 | 实际情况 | 影响 |
|---|---|---|---|
| PE-06 T06.1.1 | `mark_rest_cancelled(calls, results, events, from_idx)`（444-478 行）、跳过条件 `i <= from_idx || results[i].is_some()`、三处调用点（118-121/129-132/179-183） | ✅ 精确（444-478；条件 451；调用点 119/130/181） | 无 |
| PE-06 T06.5 | LoopError `{ message }`（loop/mod.rs:49-63） | ✅ 精确 | 无 |
| PE-06 T06.6 | idempotency.rs 10 处运行时 expect | ✅ 精确（生产 138-273 共 10 处 + 测试 2 处） | 无 |
| PE-06 T06.6 | bridge.rs 25 锁 + 2 样板 expect | ✅ 接近（实测 23 `.lock()` / 25 `.expect(`，口径差 2） | 无 |
| PE-06 T06.7 | telemetryStore.ts（128 行，0 import）、slices 4 文件 0 import | ✅ 精确（128 行、ui/terminal/permission/diff 4 文件、import 零命中） | 无 |
| PE-06 T06.9.2 | providerStore 直连 fetch（providerStore.ts:105） | ✅ 精确（`fetch('/api/accounts/${id}/status')`），**路径省略**（实际 `store/provider/providerStore.ts`） | 低 |
| PE-06 T06.11 | waitForHydration（store-persistence.ts:71-86） | ⚠️ 同 PE-01：实际为 `waitForStoreHydration(store)`，无参版在 layoutStore.ts:377 | 低 |

### PE-07 security

| 任务书 | 断言 | 实际情况 | 影响 |
|---|---|---|---|
| PE-07 T07.1 | conex-sandbox lib.rs:20-51 两组合成正则（blocked 12 条 / approval 8 条） | ✅ 精确（12+8 条逐条吻合） | 无 |
| PE-07 T07.1 | 4 个调用点（shell.rs:106-123、process.rs:420-428、host_openers/execute.rs:60-71/131-142/203-213） | ✅ 全部精确 | 无 |
| PE-07 T07.3 | gitApi.ts:306-329 `git -C ${q(cwd)} ${gitArgs.map(q).join(' ')}` 拼串 | ✅ 精确（305-317） | 无 |
| PE-07 T07.3 | reverseFileDiff.ts:44-64 PowerShell `Remove-Item -LiteralPath` | ✅ 精确（44-64），**路径省略**（实际 `src/api/reverseFileDiff.ts`） | 低 |
| PE-07 T07.2 | workspaceFsApi.ts:91-103、148-180 workspaceRootArg 直取 localStorage | ✅ 精确（91/103/156/180） | 无 |
| PE-07 T07.5 | main.rs:126-134 MCP socket（`start_socket_server(true)` + tcp_localhost(4000)） | ✅ 精确 | 无 |
| PE-07 T07.6 | idempotency.rs 10 处行号（138,154,166,189,215,233,241,251,265,273）、bridge.rs 26 处 | ✅ 精确（138-273 全部命中） | 无 |

### PE-08 data-persistence

| 任务书 | 断言 | 实际情况 | 影响 |
|---|---|---|---|
| PE-08 T08.1 | session_commands.rs:73-238 共 11 个命令、无 upsert 暴露 | ✅ 精确（74-227 共 11 个） | 无 |
| PE-08 T08.1 | save_session_body（lib.rs:490-541）DELETE+INSERT、FK（lib.rs:145） | ✅ 精确 | 无 |
| PE-08 T08.2 | cleanup_orphan_sessions（lib.rs:820-860）空集 `DELETE FROM sessions`（834-836） | ✅ 精确 | 无 |
| PE-08 T08.4 | insert_run（1285-1311）cursor 恒 0、update_run_status（1313-1334）不写 cursor | ✅ 精确（1285/1314） | 无 |
| PE-08 T08.6 | RestoreManager::restore（restore.rs:512-622）、SnapshotFileStore（restore.rs:389） | ✅ 精确（512/389） | 无 |
| PE-08 T08.7 | migrate()（lib.rs:63-266）、`schema_version='3'` INSERT OR IGNORE（lib.rs:259-263） | ✅ 精确（63/260） | 无 |
| PE-08 T08.9 | run.rs:559-572 MaxTurns→Failed、normalize.rs:109-117 MaxTurns→Completed | ✅ 精确（568/114） | 无 |

### PE-09 performance

| 任务书 | 断言 | 实际情况 | 影响 |
|---|---|---|---|
| PE-09 §1.2 | events.rs:276-277 `queue.push(&run.session_id, event.clone())` | ✅ 精确（277） | 无 |
| PE-09 §1.5 | persist.rs:101 query_events 无 limit 参数 | ✅ 精确 | 无 |
| PE-09 T09.1 | provider.rs:20 `StreamResult`、:55-67 `ProviderCall::stream` | ✅ 精确（20；trait 55-67 区域） | 无 |
| PE-09 T09.1 | transport/mod.rs:51-59 read_stream 一次性返回 StreamReadOutput | ✅ 精确 | 无 |
| PE-09 §1.6 | tool_exec.rs:122-133 审批串行退化、:147-161 克隆 | ✅ 命中（122-133 区域） | 无 |
| PE-09 T09.5 | conex-db lib.rs:310-346 query_events SQL 已支持 `LIMIT ?3` | ⚠️ 未逐行复核（函数存在，LIMIT 参数语义未确认） | 低：实现前需先确认 |

### PE-10 deps-build

| 任务书 | 断言 | 实际情况 | 影响 |
|---|---|---|---|
| PE-10 T10.1 | .gitignore:134 忽略 Cargo.lock | ✅ 精确（`git check-ignore` 命中、`git ls-files` 0） | 无 |
| PE-10 T10.2 | Cargo.toml:42 reqwest 0.12、锁文件双版本 | ✅ 精确（Cargo.lock 4621/4662 两处 `name="reqwest"`） | 无 |
| PE-10 T10.3 | Cargo.toml:47 tokio full、workbench Cargo.toml:25 内联重复 full | ✅ 精确 | 无 |
| PE-10 T10.4a | Cargo.toml:56 derive_builder 零引用 | ✅ 精确 | 无 |
| PE-10 T10.10e | tauri-plugin-mcp git 依赖无 rev（src-tauri Cargo.toml:24） | ✅ 精确 | 无 |
| PE-10 T10.10a/b/c/d | tauri.conf.json:9-10 before*Command、:29 CSP 8765、:33-38 updater pubkey 空、:42 targets:"all" | ✅ 全部精确，**路径省略**（实际 `apps/agent-workbench/src-tauri/tauri.conf.json`；vite.config.ts 同理在 apps/crish-desktop/） | 低 |
| PE-10 T10.7a | vite.config.ts:205 optimizeDeps 含 dompurify、:216 chunkSizeWarningLimit 1100 | ✅ 精确 | 无 |
| PE-10 T10.6b/c | package.json:92 ws 在 dependencies、:89-91 根级 @xterm | ✅ 精确 | 无 |
| PE-10 T10.1 | ci.yml:99-100 无 --locked、:79 cargo-deny | ✅ 精确 | 无 |

---

## 二、任务粒度问题清单

| 任务书 | 任务 | 问题 | 建议 |
|---|---|---|---|
| PE-03 | T03.3 错误协议统一 | **过大**：一次横跨 conex-types（77 码映射）+ 工具旧组 6 + config 7 + fs 5 + pty 4 + process/power + host_openers 4 + commands 2 + error_bridge 删除 + 参数校验 helper，约 10 个无依赖的独立改动面 | 按命令域拆为 4-5 个并行任务（conex-types 基建 / 工具组 / 配置组 / GUI 面组 / error_bridge 删除），每组独立提交 |
| PE-03 | T03.7 不可用调用点裁决 | 偏大：6 类调用点 22 处 + UI 隐藏确认 | 可接受（裁决表已逐点列明），但「产品确认」项应单列为独立任务 |
| PE-07 | T07.1 命令门禁重设计 | **过大**：管线重构 + PowerShell/bash 双 tokenizer（~250 行）+ 模式库 10 族 + never-zone + 37 条用例表 + 交叉验证脚本，一次交付 | 拆为：T07.1a 门禁框架与 evaluate_line 管线（先冻结 API）；T07.1b tokenizer（双方言）；T07.1c 模式库与用例；T07.1d 4 调用点改造。每步可测 |
| PE-08 | T08.6 恢复/快照生产接线 | **过大**：main.rs 接线 + CoreRunState 扩展（restore 标记 + snapshot 状态 + seed_sequences + SessionTreeRegistry 新建）+ 3 处快照钩子 + core_get_status 字段扩展，含 1 个新组件 | 拆为：T08.6a 接线与门禁；T08.6b SessionTreeRegistry（独立新组件）；T08.6c 快照周期钩子；T08.6d 状态暴露 |
| PE-08 | T08.7 迁移版本化 + v4 | 偏大：迁移框架 + 4 版本脚本 + v4 定稿（4 表变更）+ 备份工具 + 迁移测试 | 可接受（单文件 lib.rs 内），但 v4 的表变更建议按表拆提交 |
| PE-09 | T09.1 真增量流 | **过大**：契约定义 + 4 个 crate 的 5 个实施步骤 + DeltaSink 新抽象 + TestProvider 适配 + 集成测试，跨 session-loop/agent-provider/agent-workbench 三仓 | 拆为：T09.1a 契约与类型（冻结）；T09.1b transport 帧级流；T09.1c HttpProviderCall 边收边发；T09.1d session-loop 增量消费 + DeltaSink；T09.1e 测试与联调 |
| PE-09 | T09.3 | 偏大（两阶段 + 15 个波及文件 + 三方案择一） | 任务书已声明阶段拆分，可接受；「三方案择一」需在阶段 0 决策记录 |
| PE-01 | T04.1/T04.4 | 偏大（AppBootstrap 多段改动 + 死文件删除 + 测试迁移） | 可接受（同一文件内收敛） |
| PE-04 | T04.2-2 | 横跨 10+ 文件加日志 | 可接受（纯追加、机械） |
| PE-06 | T06.3 死代码清单 | 11 项跨 8 文件 | 可接受（每项小、grep 零残留验证） |
| PE-06 | T06.8 hooks 10 组 | 大 | 已按组排序执行，可接受 |
| PE-10 | T10.8c 遗留文件清理 | 批处理任务 | 合理（已列删除清单 + review 输出） |

**总体**：PE-01/02/04/05/06/10 粒度合理；PE-03/07/08/09 各有 1-2 个过大任务需要拆分。

---

## 三、依赖缺口清单（含跨任务书重复与冲突——本次审计最重要发现）

### 3.1 重复任务（同一文件、同一功能被两份任务书认领，互不引用）

| # | 重复内容 | 涉及任务书 | 冲突点/风险 |
|---|---|---|---|
| D1 | **配置真源迁移 / 明文 key 下线 / 删除 syncActiveProfileToEngine**（profileStore.ts、engineConfig.ts、migrate 逻辑、sync 删除） | PE-01 T03.2/T03.3/T03.4 vs **PE-07 T07.4**（K-01 迁移 + 引擎同步改 `workbench_profile_apply`） | 执行两遍；PE-07 的 `workbench_profile_apply` 新命令与 PE-01 的「T03.2 前端走 config_update+profileSecretSet」方案不同，产物互斥 |
| D2 | **`upsert_session_entry` 命令暴露 + 空 keepIds 拒绝全删 + hydrationComplete 守卫 + 30 天清理核对** | PE-01 T06.1/T06.2/T06.3 vs **PE-08 T08.1/T08.2/T08.10** | 语义分歧：PE-01 空 keepIds 返回 `Ok(0)` + `confirm: Option<bool>`；PE-08 返回 **Err** + `confirm_empty: bool`。清理宽限期 PE-01 24h vs PE-08 5 分钟（D6）。两套签名不能共存 |
| D3 | **启动状态机合并（删 gateTimer / E3-E12 串行化 / hydration 门闩 / 删 sessionIndexLoader / 删 useEngineBootstrap）** | PE-01 T04.1/T04.2/T04.4 vs **PE-06 T06.11 + T06.8 组 8 + T06.7（useEngineBootstrap 删除）** | 完全同文件同功能；PE-06 未引用 PE-01 |
| D4 | **锁中毒加固（idempotency.rs / mcp/bridge.rs / middleware.rs 的 expect → 恢复式）** | PE-06 T06.6（含逐行清单 + A/B/C 三级策略）vs **PE-07 T07.6**（§2.6.1 声称「分工」且把三文件全部划归 PE-07） | PE-06 侧无任何移交声明；两份任务书对同一批 36 处 expect 给出同一修复策略。谁执行？ |
| D5 | **LoopError/EndDecision.error/RunOutcome.error → CrishError 类型化** | PE-06 T06.5.1/T06.5.2 vs **PE-04 T04.3-3** | 详见 §3.2 冲突 C2 |
| D6 | **core_get_status 状态诚实化 + 字段扩展** | PE-01 T01.2（initialized/compactionReady 真实化）、PE-03 E1.1 引用（providerStatus/activeRuns/pendingApprovals/mcpStatus）、PE-04 T04.5-1（log_level/log_dir/diagnostics/lastError）、PE-08 T08.6（restore/snapshot 字段） | **4 份任务书都在改 CoreStatus 结构体**（core_query_commands.rs:49-62），且字段名互不一致：PE-01 用 `provider`，PE-03 用 `providerStatus` |

### 3.2 契约冲突（同一接口两份任务书给出不同定义）

| # | 接口 | 任务书 A | 任务书 B | 说明 |
|---|---|---|---|---|
| C1 | **命令命名**：`workbench_profile_secret_*`、`get_api_config`、`save_api_config` | PE-01：保留原名（T03.2 前端调 `workbench_profile_secret_set`；`get_api_config` 保留现名；`config_update` 为新名） | PE-03 T03.4/T03.5：改名 `config_secret_*`、`config_get`，删除 `save_api_config` | PE-01 任务书完全未引用 PE-03，两份对同一命令面给出不同终态名。前端 rustProfileStore.ts 的 5 个方法名取决于裁决 |
| C2 | **`RecoveryHook::decide` 签名** | PE-06 T06.5.3：`decide(&self, error: &CrishError, state)`（改签名） | PE-04 T04.3-3：签名**不变**（保留 `&str`），仅调用点传 `err.code()` | 直接矛盾；二者都自称为「Q29 修复」 |
| C3 | **save_session_body 写模型** | PE-08 D4（裁决）：「全量替换保留（前端唯一拥有）」，T08.10 定稿 | PE-09 T09.4：save_session_body **改 upsert**（ON CONFLICT DO UPDATE，旧行保留），R6 登记为行为变化面 | 语义互斥：改 upsert 后「删除/编辑历史消息不再生效」，与 PE-08 D4 的「全量替换」矛盾。PE-09 只提到与「AA-07 协同」，未引用 PE-08 |
| C4 | **首 token 延迟目标** | PE-02 T02.6：`requestToFirstChunkMs < 500ms` | PE-09 G1：**≤ 300ms**；T09.1 验收：**< 600ms**（mock 集成测试） | 同域三套数字，验收口径不统一 |
| C5 | **流式契约 SoT** | PE-02 §3.1：「本文件即契约 SoT，PE-09 必须按此实现」 | PE-09 T09.1.1：自行定义 `ProviderEventStream` 契约 | 内容基本一致（Pin<Box<dyn Stream>>），但双头维护；类型别名命名不同（ProviderStreamItem vs StreamItem） |
| C6 | **tauri-plugin-mcp 处置** | PE-07 T07.5：评估「移除插件依赖 / 仓内最小实现 / 默认关闭」 | PE-10 T10.10e：锁 rev（c7d271a）**保留** git 依赖 | 同一依赖两个处置方向；若 PE-07 移除，PE-10 的锁 rev 白做 |

### 3.3 文件级并发冲突（前端并行执行风险）

| 文件 | 涉及任务书 |
|---|---|
| AppBootstrap.ts | PE-01 T04.1/2/3/4（重写）、PE-06 T06.8 组 2 / T06.11（合并 section 3→7）、PE-04 T04.4-1（LoggerService 接线点之一，非关键） |
| ChatStatusRibbons.tsx | PE-01 T02.2（删 sync-engine 分支）、PE-05 T05.4.1（拆 5 子件）+ T05.8（is-danger 833） |
| bootstrap-full.ts | PE-01 T04.1/T04.4（删探测/删 loadSessionIndexOnly）、PE-05 T05.7（16 消费文件重命名面） |
| useEngineBootstrap.ts | PE-01 T04.1（删除文件）、PE-06 T06.7（删除文件） |
| ConnectionManager.ts / useDaemonState.ts | PE-01 T04.3（投影收敛）、PE-06 T06.8 组 2、PE-04 T04.4-1（接线点） |
| store-persistence.ts | PE-01 T06.2/T04.4（hydrationComplete 守卫）、PE-06 T06.8 组 1/8、PE-08 T08.2 |
| sessionRustDb.ts | PE-01 T06.x、PE-08 T08.1/2/10、PE-09 T09.4（append 命令 + 前端 commit 增量）——**三份** |
| tool_exec.rs | PE-06 T06.1（mark_rest_cancelled 重构）、PE-09 T09.6（execute_batch 签名改 Arc） |
| streaming.rs | PE-06 T06.2（steering_enabled Empty 分支短路）、PE-09 T09.1（整文件重写）+ T09.3 |
| core_query_commands.rs | PE-01 T01.1/1.2、PE-03 E1.1 回补、PE-04 T04.5-1、PE-08 T08.4/T08.6——**四份** |
| config/provider.rs | PE-01 T03.1（改名）、PE-03 T03.4（改名，且 T03.1 删 sentToDaemon vs PE-01 也删）、PE-07 T07.4（删 update_daemon_config 明文组装） |

### 3.4 循环依赖

未发现循环依赖。但存在**无主项**：PE-01 T04.4 产出 `hydrationComplete` 门闩「变量」同时被 PE-01 T06.2 与 PE-08 T08.2 消费——若按 PE-08 批 1 先于 PE-01 执行（PE-08 无此依赖声明），守卫将无对象（PE-01 §4.2 已自注此风险，PE-08 未）。

---

## 四、验收不可测任务清单

| 任务书 | 任务 | 验收手段 | 问题 |
|---|---|---|---|
| PE-02 | T02.2 V4/V5、T02.4 V2、§6 G1/G2 | 手动视觉验证（「内容持续可见、无闪烁丢失」「无 skeleton 闪烁」「无视觉跳变」） | 无自动化断言；建议补充 DOM 快照/双帧对比测试或明确指定人工检查清单与复现步骤 |
| PE-02 | T02.6 首 token 延迟 | 依赖「本地 mock SSE 模拟场景」 | 测量方法的 mock 源定义在 T02.1 产出物中，验收时未给出 mock 源的具体 emit 时序参数（间隔/块大小）——执行者需要自行补参数 |
| PE-03 | **T03.1 验收「core_list_commands 返回 64 条」** | 命令清单计数 | **逻辑前置矛盾**：T03.1 是依赖链首位任务，其完成时注册面仍为 78 条，验收不可能通过。「64 条」是全部任务完成后的终态。应改为「返回条数 == 当前注册面，且与 make_handlers! 一致」 |
| PE-04 | T04.1-2「人为触发 panic」 | 手工/测试代码内 `std::panic!` | 可测但无脚本；建议提供触发路径（如测试命令） |
| PE-05 | T05.2.2 / 各迁移 | `rg 'role="dialog"'` 归零 + 人工 Esc/backdrop/焦点检查 | 人工项可接受（a11y 语义本就需人工），但「Esc/backdrop/焦点归还」三项建议做成既有 a11y 测试扩展（任务书只要求跑既有测试） |
| PE-08 | T08.6 验收「进程级（可选脚本）」 | 可选脚本 | 标注为可选合理，但 T08.6 主验收（崩溃重启 e2e）依赖「模拟崩溃 drop 连接」——Rust 集成测试可做，验收写法可行 |
| PE-01 | T03.2 验收 3（dev 运行检查 DPAPI 文件） | 手工 | 可接受（有前置断言支撑） |
| PE-09 | T09.3.4「代码审查断言」 | 无 .clone() 人工审查 | 建议加自动化：clippy 无补；可考虑 `cargo geiger` 或测试内计数；目前仅能靠 review——任务书已明示，属可接受但建议登记 |

**验收良好的范式**（供其余任务书对齐）：PE-07 用例 1-37 三态断言表、PE-08 §三 验证矩阵、PE-09 量化阈值（<600ms/<95ms）、PE-10 DoD 勾选清单、PE-01 grep 零命中断言。

---

## 五、风险遗漏清单

| 任务书 | 覆盖情况 | 遗漏 |
|---|---|---|
| PE-01 | ✅ 回归（§4.2 跨任务依赖表）、✅ 数据（迁移/落库）、✅ 发布（M0-M4 里程碑合入判据） | ❌ **并发**：未声明与 PE-03（命令命名）、PE-06（T06.11 重复）、PE-07（T07.4 密钥）、PE-08（T08.1/2 重复）的重叠；未引用任何兄弟 PE 方案 |
| PE-02 | ✅ 回归（R1-R10 全部行为面）、✅ 并发（文件重叠标注）、✅ 发布（里程碑门禁） | ⚠️ 与 PE-09 契约 SoT 双头（R7 提到依赖 PE-09 但未提 SoT 冲突）；G3 数字与 PE-09 不一致 |
| PE-03 | ✅ 回归（R1-R9）、✅ 发布（P0-P6 轮次门禁） | ❌ 与 PE-01 的配置命令命名冲突未提；T03.1 验收前置矛盾未发现；R5 只处理了与 E1.1/E2.5 的内部冲突 |
| PE-04 | ✅ 回归（R1-R7）、✅ 破坏面（R4 错误类型升级分步走） | ❌ 与 PE-06 T06.5 的 RecoveryHook 签名冲突未提；与 PE-01/PE-03 共改 core_query_commands.rs 的并行风险未提 |
| PE-05 | ✅ 回归（R1-R6）、✅ 并发（组 A-E + 不可并行声明）、✅ 发布（DoD） | ⚠️ R5 只声明与「store 域」重叠，**未声明与 PE-01（ChatStatusRibbons/bootstrap-full）、PE-06（AppBootstrap/ConnectionManager）的重叠**——T05.7 的 16 消费文件冻结清单里就有 PE-01/PE-06 要动的文件 |
| PE-06 | ✅ 回归（R1-R13，详尽） | ❌ **跨方案完全沉默**：T06.11 与 PE-01 T04 链重复、T06.6 与 PE-07 T07.6 撞车、T06.5 与 PE-04 T04.3 冲突，均无任何引用或分工声明（§5 边界表只与 PE-04 划界，且划界结果与实际任务书内容矛盾） |
| PE-07 | ✅ 回归（V-01~V-10 锁定 + 攻击复现表）、✅ 数据（迁移影响面） | ❌ 与 PE-01 T03 链（密钥域）重复未声明；声称「与 PE-06 分工」（T07.6）但分工表把 PE-06 已在做的文件全部划归自己；发布风险（UI 引导文案）有提及 |
| PE-08 | ✅ 回归、✅ **数据（全任务书最佳：迁移/竞态/恢复矩阵）**、✅ 发布批次 | ❌ 与 PE-01 T06 链重复、与 PE-09 T09.4 写模型矛盾，均未声明；「fixture 真实 v3 库样本」来源未指定（准备度缺口） |
| PE-09 | ✅ 回归（R1-R8 行为变化面登记）、✅ 并发（内部 + PE-02 边界声明） | ❌ 与 PE-08 D4 写模型矛盾未提；与 PE-06 共改 tool_exec.rs/streaming.rs 未声明（§3.3 只列 T09.1 与 T09.3 内部互斥） |
| PE-10 | ✅ 回归（R1-R12）、✅ 发布（提交 A/B/C） | ⚠️ 与 PE-07 T07.5 的 tauri-plugin-mcp 处置方向冲突未提（一个锁 rev 保留、一个评估移除）；删除 target 53.5GB 与「同一台干净检出」验证流程有耦合（已自注，可接受） |

---

## 六、执行准备度缺口

> 「执行时需要但任务书未提供/未明确的输入」清单。

| # | 任务书 | 缺口 | 建议 |
|---|---|---|---|
| P1 | PE-01 / PE-03 / PE-04 / PE-06 | **跨方案接口冻结缺失**：配置命令最终命名（`workbench_profile_secret_*` vs `config_secret_*`、`get_api_config` vs `config_get`、`save_api_config` 去留）、CoreStatus 字段名（`provider` vs `providerStatus`）、RecoveryHook 签名、upsert 写模型裁决——四组接口各有 ≥2 份任务书给出不同定义 | 执行任何一份前，先产出《跨 PE 接口冻结表》（命令名 / CoreStatus 字段 / 错误类型 / 写模型四张表），由四方案作者会签 |
| P2 | PE-01 | `CoreStatus.provider` 与 PE-03 `providerStatus` 的 JSON 字段兼容读取 | 由 P1 冻结表裁决，二选一或双读 |
| P3 | PE-02 | 契约 SoT 归属（§3.1 vs PE-09 T09.1.1）；首 token 阈值 300/500/600ms 统一 | 在 P1 冻结表中加第三张表：流式契约与阈值 |
| P4 | PE-03 | T03.1 验收口径修正（见 §四） | 改「清单 == 当前注册面」 |
| P5 | PE-05 | 大组件行号过时（+10~68 行）；css 路径省略（styles/shell/、styles/settings/） | 执行前重跑 `rg` 定位（任务书已要求脚本复核，需落盘到执行清单） |
| P6 | PE-07 | tauri-plugin-mcp 是否支持 token 认证——外部 git 依赖源码不在仓内，任务书已注明「实现时核对」 | 属合理运行前调研项，但需在批 5 前出结论，且与 PE-10 T10.10e 会签（C6） |
| P7 | PE-08 | T08.7 验收「既有 3 个真实 v3 库样本」——样本来源未指定；`confirm_empty`/`confirm` 参数与 PE-01 不一致 | 明确样本收集路径（用户机器/测试夹具），参数由 P1 冻结表裁决 |
| P8 | PE-09 | 基准基建（Criterion dev-dep、benches/ 目录）为新产出，任务书已列；但「基线数据存档」目标文件（PE-02-perf-baseline.md 或 PE-09-benchmarks.md）二选一未定 | 与 PE-02 T02.6 共用一份基线文档，避免两份存档漂移 |
| P9 | PE-10 | `cargo generate-lockfile` 需要网络与干净环境；53.5GB target 删除时机（任务书已自注顺序） | 已覆盖，仅提示：Cargo.lock 生成后需与现有 lock diff 预览（任务书已列） |
| P10 | 全部 | 任务书日期均为 2026-08-01，而 PE-05 行号系统性过时说明部分任务书基于较旧快照写作——**执行前对每份任务书跑一次「断言自检」（行号/文件存在性）** | 建议在 00-master-plan 的轮次章程中把「引用断言自检」列为轮次前置步骤 |

---

## 七、审计结论（逐任务书）

| 任务书 | 结论 | 主要依据 |
|---|---|---|
| **PE-01 config-startup** | **需小修** | 事实核查 ≈95% 精确；粒度好；验收/风险覆盖完整。需要：与 PE-03 会签命令命名（C1）、与 PE-08 会签 upsert/清理语义（D2）、与 PE-06 会签启动收敛归属（D3）、与 PE-07 会签密钥迁移归属（D1） |
| **PE-02 streaming-markdown** | **需小修** | 事实核查精确度最高档（唯一硬伤：markdownCache.ts 不存在）；需要：契约 SoT 与阈值与 PE-09 统一（C4/C5）、T02.2/T02.4 视觉验收补自动化或清单化 |
| **PE-03 ipc-contract** | **需小修**（偏大修） | 78 计数等事实全部精确；问题在：T03.1 验收前置矛盾、T03.3 粒度、与 PE-01 命令命名冲突（C1）、与 PE-04/PE-08 共改 core_query_commands.rs 的并行风险 |
| **PE-04 observability** | **需大修** | 事实精确、粒度好、风险详尽；但 T04.3 与 PE-06 T06.5 完全重复且 RecoveryHook 签名直接矛盾（C2/D5）；T04.5-1 与 PE-01/PE-03 共改 CoreStatus（D6）。必须先与 PE-06 划界 |
| **PE-05 componentization** | **需小修** | 功能描述准确但行号系统性过时（+10~68）、css 路径省略；需与 PE-01/PE-06 会签重叠文件（ChatStatusRibbons/bootstrap-full/AppBootstrap）的 owner 与执行顺序 |
| **PE-06 abstraction-dedup** | **需大修** | 单文档质量高（事实精确、R1-R13 详尽），但**跨方案重叠最严重**：T06.11≈PE-01 T04 链、T06.6≈PE-07 T07.6、T06.5≈PE-04 T04.3。执行前必须删重或明示移交；自身 §5.1 边界声明与实际任务内容矛盾 |
| **PE-07 security** | **需小修** | 事实核查近乎全对、测试用例表是全仓库最佳范式；需要：与 PE-01 会签密钥迁移归属（D1）、与 PE-06 会签锁中毒分工（D4）、与 PE-10 会签 tauri-plugin-mcp 处置（C6） |
| **PE-08 data-persistence** | **需大修** | 事实核查全对、数据风险覆盖最佳；但 T08.1/2/10 与 PE-01 T06 链重复且语义分歧（参数/返回值/宽限期）、D4 与 PE-09 T09.4 写模型矛盾。必须先裁决「upsert vs 全量替换」「confirm 语义」再执行 |
| **PE-09 performance** | **需大修** | 事实精确、量化验收好；需要：与 PE-08 会签 save_session_body 写模型（C3）、与 PE-02 会签契约 SoT 与阈值（C4/C5）、与 PE-06 会签 tool_exec.rs/streaming.rs 并行（§3.3）、首 token 三套数字统一 |
| **PE-10 deps-build** | **可直接执行** | 事实核查几乎全对（仅路径省略）；任务按 3 批次编排、DoD 可勾选、风险 R1-R12 覆盖完整。唯一挂起：与 PE-07 的 tauri-plugin-mcp 处置会签（C6）——建议先于批次 B 项 15 完成 |

### 建议的总执行前置（0 号任务，任何 PE 开工前完成）

1. **跨 PE 接口冻结表**（P1）：命令命名（含 config 族 6 命令终态名）、CoreStatus 字段（provider/providerStatus/diagnostics 合并）、错误类型升级（LoopError/RecoveryHook 签名）、会话写模型（upsert vs 全量替换）、流式契约 SoT 与首 token 阈值——五张表，由 PE-01/03/04/06/08/09 方案作者会签。
2. **重复任务去重表**（§3.1 D1-D6）：每项重复任务指定唯一 owner 与执行轮次，其余任务书改为「依赖/移交」声明。
3. **文件 owner 表**（§3.3）：对 AppBootstrap/ChatStatusRibbons/bootstrap-full/sessionRustDb/core_query_commands/provider.rs/tool_exec.rs/streaming.rs 等冲突文件指定串行执行顺序。
4. **执行前断言自检**（P10）：每份任务书开工前重跑其引用的行号/文件存在性断言（PE-05 尤其必要）。

---

*附录：本审计抽查覆盖的文件/断言数量——10 份任务书，约 70 项断言，涉及 55+ 个真实文件。全部结论基于 2026-08-01 仓库快照。*
