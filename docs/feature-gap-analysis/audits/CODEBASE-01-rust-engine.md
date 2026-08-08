# CODEBASE-01 Rust 引擎层现状审计

- 审计角色：A1（Rust 引擎层，只读）
- 审计日期：2026-08-08
- 范围：`crates/` 全部 14 个 crate（含 15 个 workspace member，另 1 个为 `apps/agent-workbench/src-tauri` 壳）
- 方法：规模盘点（文件/行数/导出面/依赖）+ 重点域深挖（缓存/流式/持久化）+ 并行阵营改动交叉核对（git log）+ 死代码扫描 + 编译健康（cargo check --workspace）

## 1. 规模盘点

### 1.1 各 crate 规模与导出面

| crate | .rs 文件数 | 行数 | Cargo.toml deps | lib.rs `pub use` | lib.rs `pub mod` | 测试标记数 |
|---|---|---|---|---|---|---|
| agent-provider | 42 | 20,491 | 10 | 0 | 11 | 511 |
| agent-tools | 36 | 24,892 | 13 | 21 | 20 | 531 |
| conex-compaction | 3 | 3,182 | 2 | 1 | 3 | 70 |
| conex-db | 17 | 6,032 | 2 | 4 | 0 | 91 |
| conex-diff | 1 | 225 | 2 | 0 | 1 | 8 |
| conex-fs | 4 | 2,216 | 7 | 0 | 4 | 53 |
| conex-markdown | 9 | 2,826 | 7 | 2 | 6 | 112 |
| conex-sandbox | 4 | 2,236 | 2 | 1 | 2 | 117 |
| conex-search | 1 | 369 | 1 | 0 | 3 | 17 |
| conex-telemetry | 17 | 2,007 | 2 | 4 | 6 | 78 |
| conex-test-utils | 3 | 571 | 6 | 2 | 2 | 20 |
| conex-types | 21 | 8,848 | 4 | 15 | 15 | 166 |
| orchestrator | 29 | 19,443 | 8 | 2 | 12 | 289 |
| session-loop | 46 | 22,930 | 12 | 18 | 19 | 392 |
| **合计** | **233** | **122,268** | — | — | — | **2,455** |

### 1.2 结论

- 引擎层约 12.2 万行 Rust、233 个源文件、2,455 个测试标记；三大核心域为 agent-tools（工具执行面）、session-loop（循环内核）、agent-provider（协议适配），合计约 6.8 万行，占引擎层 56%。
- 依赖最重的是 agent-tools（13）/session-loop（12）/agent-provider（10）；conex-db 仅 2 个依赖（rusqlite + 内部），符合叶子约束设计。
- `pub use` 最多的 session-loop（18）/agent-tools（21）/conex-types（15）是引擎对外（壳层）的主要消费面，均与前端 TS 侧语义对齐（`tool-update`/`cache-stats-updated` 等 wire kind 在 conex-types/events.rs:815-831 注册）。

## 2. 重点域健康度

### 2.1 crates/agent-provider

**models/（模型目录 v2）——健康，F 系列未触及**

- catalog.json：151 条条目，UTF-8 无 BOM 解码干净（0 替换字符），JSON 有效，已入库（57a6d4ad force-added）。注意：catalog 内 `notes` 等字段含中文，经 Python 字节级验证无损（PowerShell 终端显示乱码是显示层问题，文件本身健康）。
- 消费链完整：`cache_behavior_for` / `infer_vendor` / `cache_ttl_for_provider_model` / `derive_prompt_cache_key` 被 request/cache.rs、request/vendor.rs、deepseek_invariants.rs、session-loop/cache_tracker.rs、壳层 engine.rs:1464 消费；查询函数（context_window_for / prompt_cache_min_tokens_for / input_price_for 等 20+ 个）均在 catalog.rs 有定义且被 request 层或前端数据面消费。
- git log 验证：models/ 最后提交全部为 R 系列缓存任务（f8316a11/57a6d4ad/182052e5/21191a0d/656d67c6），**F1-F16/P2 批次未触及**，无契约漂移。

**request/（缓存注入框架）——健康**

- cache.rs:269 `build_cache_policy`：4 步分流（能力判定→硬关→none 档→DeepSeek 省略→机制分流），catalog 路径与内置兜底表双源一致（G2 会话亲和头两路径行为对齐），注释与实现一致。
- vendor.rs（947 行）推理链完整：`infer_thinking_capability` / `resolve_thinking_params` / `reasoning_effort_object` 等 G7 自适应思考参数接线存在。
- schema.rs：`canonicalize_schema` / `canonical_json_string`（R1/R2 确定性，供缓存键派生）。
- build.rs：`build_chat_completions_request_body` + `affinity_http_headers`（cache.rs:271 定义的 CachePolicy 注入 HTTP header 面）。
- 流内 error 帧：F3 #4 修复（0aec841c）已在 consume/mod.rs:359-365 `classify_stream_error` 接入统一分类管线（429/5xx 文案未产出内容可重试），与缓存流无冲突。
- retry.rs：F3-11 year 钳制 [1970,9999]（retry.rs:258）、F3-16 钳制均已落地，有红→绿测试链。

### 2.2 crates/session-loop

**tool_exec.rs（4,289 行）——S1 流式接线完整**

- 文档注释详尽记录了 F1-02（审批竞速 120s 收场）、T09.6/P8（审批并行组）、R4 T10（权限判定）等历史修复，注释无过期迹象。
- S1 接线：tool_exec.rs:987-1005 消费 `execute_stream_with_output_policy`（agent-tools/executor.rs），进度回调经 `progress_buffer` 缓冲 → tool_exec.rs:1426 `tool_progress_update` 映射为 `ToolProgressUpdate`（Text→text 承载 + metadata.kind="tool-progress"；Custom→subkind 透传；Content→None 预留）→ ToolEvent::ToolProgress → AgentEvent::ToolUpdate（wire kind "tool-update" 注册于 conex-types/events.rs:375）。
- 流式专项测试：tool_exec.rs:1652-1811（流式工具 + 进度事件顺序断言，Progress 严格夹在 start/end 之间）。

**loop/（预算/压缩/护栏）——健康**

- loop/mod.rs:197-211：context_budget / compaction_policy / max_auto_compactions_per_run（默认 1）全部装配到 LoopState（mod.rs:444-448）。
- F2-02 max_turns=0 起始拦截：loop/mod.rs:601-617（run 起始显式收场，独立 pre-run reason）。
- 压缩护栏：compactions_this_run 单 run 计数 + 时间戳护栏重置（handlers/mod.rs:350-352）；C13 缓存基线作废接线于 handlers/mod.rs:356-358（`tracker.on_compaction()`），与 cache_tracker.rs:239 实现一致。
- invariants.rs（304 行）为纯只读不变量测试面。

**cache_tracker.rs（716 行）——完整接线，仅 1 处悬空**

- LoopState 装配：loop/mod.rs:450-452 / 644（构造与 run 起始复位）；收口：loop/mod.rs:861-863（RunOutcome.cache_stats）；请求前签名捕获：loop/handlers/streaming.rs:61-64；usage 消费：streaming.rs:371+ `consume_cache_usage`（C9 口径经 conex-telemetry/cache 纯函数模块）。
- 壳层 engine.rs:1202 `cache_tracking_config` + 1464 `build_cache_tracking_config` 已实现 P3 TTL 路由表查询注入；core_run_commands.rs:3144 `.with_cache_tracking(...)` 接线。
- **悬空点**：`set_ttl`（cache_tracker.rs:148）零消费——已登记 F3-03（8c831309），注释自洽但接口长期未接线（详见问题清单 P1-01）。

### 2.3 crates/conex-db —— 健康

- v5 schema（schema.rs:121-267）完整：runs 的 9 个 usage/cache 列、session_messages.usage_json（v5/C8）、session_sequence 原子分配表、session_agents v6 新列（task_type/display_label/allowed_write_paths_json）。
- 迁移护栏：migrate.rs 幂等化（d4d8853b T3.1 D1：user_version 入事务 + 全步骤幂等）、v4 孤儿过滤并计数落 session_meta（migrate.rs:284-302，`migration_v4_dropped_orphans`）、迁移前备份 + warn-not-block（f182ccd1）。
- 孤儿清理：sessions.rs 带宽限期（lib.rs:52-55 `ORPHAN_GRACE_MS_KEY`）与 7e2cde0f 三层护栏（LS cleanup guard vs SQLite / orphan cleanup 3-tier guards / subagent session exempt）。
- usage_json：写入面 runs.rs:193 `save_run_usage` + messages.rs 读写列齐备，往返测试齐全（tests.rs:775-866，含旧行 NULL 兼容断言）。

### 2.4 crates/orchestrator —— 健康

- restore.rs：逐会话锚点（StateSnapshot.session_last_sequence，restore.rs:304-309）+ 旧快照 serde default 回退全局 last_sequence（PERSIST-02 P1-1）；快照三触发互斥（5a67825a：锁内 build+保存+generation 原子化 + tmp 文件 generation 唯一）；快照损坏回退备份 → 全量重放三级降级（restore.rs:497-506）。
- persist.rs：PersistedEvent / SessionSequencer / InMemoryStore / LocalDbStore 完整；LocalDbStore 并发安全测试（persist.rs:923）。
- ToolProgress 相关：`ToolProgress` 事件在 session-loop/tool_events.rs:63-65 定义（orchestrator 无 tool_events.rs，任务书中的路径归属 session-loop），AgentEvent::ToolUpdate 归一化在 orchestrator/normalize.rs:48 等完成——职责无重复。

### 2.5 crates/agent-tools —— 健康

- streaming.rs（157 行）：ToolStream 协议（Progress* + Terminal 恒末项）、terminal_only / with_progress 构造助手、ToolProgress 三变体（serde tag="kind" snake_case），含 5 个流形状测试。
- tools/shell.rs：execute_stream 完整重写（shell.rs:393 + run_command_streaming:1028，预检/abort/超时与 execute 对齐，逐行 push_chunk:1270），步进状态机（step():1162-1236 处理 Terminated/Timeout/Spawning/Done 等终态），流式测试 200ms 间隔块断言（shell.rs:2996）。
- registry/middleware：ToolRegistry（register/get/list/list_definitions 等 12 API）+ ToolMiddleware trait + RecordingMiddleware 完整。
- 并行修复交叉验证：F3 #9 TOCTOU（88fb7c32，write_paths.rs:330 冲突检测与插入同锁原子化 + release 补偿）、F8-02 write_path_conflict 码注册（conex-types/error.rs:109/394 + 测试 1264-1278）、F-009 定时器 flaky 修复（0a85d8fc）——均已落地，与缓存/流式代码无同文件覆盖。

## 3. 并行阵营改动交叉检查（契约漂移）

对 git log 中 F1-F16/P2 系列提交逐一核对其触及文件与缓存/流式代码的交互：

| 提交 | 触及面 | 与缓存/流式交叉 | 结论 |
|---|---|---|---|
| ca70da84（死代码删除） | session-loop 顶层 | 删除 AfterCompaction 相位 / StreamResult 别名 / escape_watch_config getter | 无残留引用（rg 0 匹配），cache_tracker 未受影响 |
| d47e16f1（F1-03/F2-01/F2-02） | state.rs/prepare_turn/run 起始 | turn_index saturating、length 阶梯、max_turns=0 拦截 | 与缓存测量正交，loop/mod.rs 集成无冲突 |
| a081bf1f（F1 测试盲区） | session-loop 测试 | max_turns 外 6 项补全 | 测试面增强，无生产代码改动 |
| 0aec841c（F3 #4） | agent-provider/consume | 流内 error 帧分类 | 接入统一分类管线，与缓存注入无交互 |
| 0d9f9b74（F3-11/05/16） | agent-provider retry / tools | 年份钳制/聚合上限/u64 钳制 | provider 层，不触碰缓存断点注入面 |
| 88fb7c32（F3 #9） | agent-tools write_paths + conex-db | 写配额 TOCTOU | 原子 reserve-before-write，独立于缓存 |
| bbef13fb（P2 批3 类型对齐） | conex-types 错误码/事件类型 | write_path_conflict 双向注册 | 错误码面，缓存事件载荷（RunCacheStats）未受影响 |
| c142e19d（PS-04 T4.1/T4.2） | session-loop 审批 | 恢复决策 Fatal 收场、批级审批超时 | 审批面，与缓存正交 |
| 7e2cde0f（数据丢失 P0s） | conex-db/orchestrator/session-loop | 孤儿清理护栏/重放锚点 | 持久化面，与 v5 usage_json 写入并存无冲突 |
| 3feffd4c（R5 wave2） | cache_tracker/conex-db v5/TS 事件 | 缓存测量收口 | 缓存系列自身提交，与 F 系列无覆盖 |

**结论：并行阵营（F1-F16/P2/PS-04）未对缓存（R0-R7）与流式（S1）代码造成契约漂移**。所有修复均落在正交面（错误分类/钳制/审批/配额/持久化护栏），models/ 与 request/cache.rs 的最后提交均属 R 系列自身；注释也未发现过期矛盾（唯一过期的注释见问题 P2-03）。

## 4. 死代码 / 未接线面

- `#[allow(dead_code)]` 全仓统计：**仅 3 处**（非 cfg_attr 形式）：
  - crates/conex-fs/src/watch.rs:110（excludes_glob 预留位）
  - crates/conex-fs/src/watch.rs:115（tx 通道持有锚，无读取消费者）
  - crates/conex-types/tests/events_schema_version.rs:378（测试内）
- 其余 16 处均为 `#[cfg_attr(not(...), allow(...))]` 平台（windows/unix）或 `#[cfg_attr(not(test), allow(dead_code))]` 测试豁免，均带理由，合理。
- PlaceholderCatalog（T-13 占位目录）：**零残留**（rg 0 匹配），已由 672a7505/ff544421 迁移到真实 catalog。
- 已登记未接线面核对（8c831309 声明）：
  - set_ttl（F3-03）：cache_tracker.rs:148，零消费，登记与实际一致 ✅
  - C7 恢复阶梯（F2-08）/ deadlock detector（F9-05）/ session_id 占位（F3-08）：在 TS/壳侧，Rust 侧无对应残留（deadlock 检测实际已实装于 agent-tools/tools/subagent.rs:620-632 `DeadlockCheckInput`/`check_ancestor_chain`，死锁码 SUBAGENT_DEADLOCK_DETECTED 注册于 conex-types/error.rs:121）

## 5. 编译健康

- `cargo check --workspace`：**0 错误、0 警告**（crates/ 内）。
- 唯一警告在壳层：`apps/agent-workbench/src-tauri/src/host_openers/execute.rs:393` 的 unsafe block（`-W unsafe-code` 主动启用），为已允许的 unsafe 用法，非我们域。
- clippy 基线：clippy.toml（49 行）为 G2 安全禁令的机器化形态（disallowed-methods 禁裸删除/裸子进程），豁免面注释完整；CI 由 ci-mid.yml clippy job + check-clippy-baseline.mjs 守门（f180a137 建立）。

## 6. 问题清单

### P1（契约漂移 / 隐患）

| # | 严重度 | 问题 | 证据 |
|---|---|---|---|
| P1-01 | P1 | `set_ttl` 长期零消费：缓存测量的最后一个悬空接线点。注释声明"T-40 引擎接线点（跨 run 缓存基线持久化）落地后由 engine 侧调用"，但 T-40 未落地，`from_config` 走的是 `with_ttl`（cache_tracker.rs:135），`set_ttl` 成为重复 API——未来引擎侧接线时存在"哪个 TTL 写入点生效"的歧义 | cache_tracker.rs:144-150；F3-03 已登记（8c831309） |
| P1-02 | P1 | `ModelCatalog::bundled()` 硬编码 `version: 0`（catalog.rs:294），丢弃文件级 `ModelCatalogFile.version`——内置目录版本不可区分，运行时 `upsert_from_scan`/`with_overrides` 会 +1，但无法判断内置表相对磁盘缓存是否过期 | catalog.rs:291-299；models/catalog.json version=0 |

### P2（整洁度）

| # | 严重度 | 问题 | 证据 |
|---|---|---|---|
| P2-01 | P2 | `excludes_glob` 预留位（watch.rs:110）注释称"P3 装配面注入预留"，但 P3 装配面（session-loop/escape_watch.rs:352 `WorkspaceWatcher::start`）已实装且恒不传排除 glob——escape 追踪的排除面无配置入口，预留注释与实现脱节 | watch.rs:108-111；escape_watch.rs:352 |
| P2-02 | P2 | cache_tracker.rs:146 注释"T-40 在 P3 查询结果可及后调用"部分过期：P3 TTL 查询实际已在壳层 engine.rs:1464 `build_cache_tracking_config` 落地（经 with_ttl 路径），`set_ttl` 的"engine 侧调用"愿景已被 with_ttl 覆盖 | cache_tracker.rs:144-147 vs engine.rs:1464-1472 |
| P2-03 | P2 | watch.rs:115 tx 字段（通道持有锚）带 allow(dead_code)，虽注释解释了结构语义，但"无读取消费者"说明事件通道消费面不完整——rename 聚合通道的 Receiver 侧在 session-loop 有消费（escape_watch.rs:41 引入 FileChangeEvent），该 allow 可复核是否已可移除 | watch.rs:113-116 |

### 非问题（核查过，无需处理）

- 目录 catalog.json 中文显示乱码 → 文件健康（UTF-8 字节级验证 0 替换字符），纯终端显示问题。
- cargo check 警告数 3 条日志含 PowerShell 管道噪音，实际 rustc 警告仅壳层 1 条。
- orchestrator 无 tool_events.rs → ToolProgress 归属 session-loop/tool_events.rs，架构上无重复职责。

## 7. 最值得关注 5 项

1. **P1-01 `set_ttl` 悬空 + T-40 跨 run 缓存基线持久化未落地**（cache_tracker.rs:148）——缓存测量链路（签名捕获→miss 审计→RunCacheStats 收口）已全部实装，但"基线跨 run 持久化 + cache-waste-alert 阈值发射"依赖的 T-40 是唯一未接线点，前端 cache 面板的预警功能停在观测层。
2. **P1-02 catalog bundled() version 硬编码 0**（catalog.rs:294）——151 条内置目录已入库，但版本号不可区分；一旦引入磁盘缓存刷新（catalog_get/refresh 已有 3 处注册），无法判断内置表是否过期，是模型目录 v2 的下一个数据一致性风险。
3. **壳层唯一编译警告（execute.rs:393 unsafe block）**——全仓编译健康度极高（crates 0 警告），该处是 `-W unsafe-code` 主动检查下的既有 allow，需与 31-security-baseline.md 的安全口径核对是否应保留。
4. **escape 追踪排除面无配置入口**（watch.rs:108-111）——WorkspaceWatcher 已实装并被 escape_watch 消费，但 excludes_glob 恒空，逃逸追踪对"预期外目录"（如日志、构建产物）无豁免通道，误报敞口存在（G11a 备注的"接线后移除"未执行）。
5. **并行阵营零冲突但历史债务密集**——F1-F16/P2/PS-04 共 40+ 提交均落在正交面，缓存/流式代码未被污染，但修复密度高说明领域护栏（typecheck/红测试驱动）正在起效；建议后续会话保持"红测试→修复→登记"节奏，避免无测试支撑的整文件暂存吸收（F-013 教训，db617a95 已登记同类事故）。

## 附：验证命令记录

- `cargo check --workspace`（0 错误；crates 内 0 警告，壳 1 处 unsafe 警告）
- `git log --oneline --all -- <path>` 于 agent-provider/models|request、session-loop/tool_exec|cache_tracker、orchestrator/restore、conex-db、agent-tools（交叉核对）
- `rg -c '#\[(tokio::)?test\]'`（测试标记统计，2,455）
- Python 字节级校验 catalog.json（UTF-8 解码 OK、0 替换字符、JSON 有效、151 条目）
- `rg 'allow\(dead_code\)'`（3 处全仓 + 16 处 cfg_attr 豁免）
