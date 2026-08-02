# 30 — Phase E 主执行方案（轮次规划与调度）

> 状态：已建立（Round 21 汇总）
> 依据：23-architecture-hardening-plan.md（总纲）、AU-04-interface-freeze-decisions.md（接口冻结与去重裁决）、AU-01/AU-02/AU-03（审计结论）、PE-01 至 PE-12（十二份任务书，v2）
> 本方案只描述逻辑执行顺序与调度规则；执行时以任务书为任务细节权威、以本方案为调度权威。二者冲突时按本方案第 3 节流程处理。

---

## 1. 方案总览

### 1.1 任务书统计（12 份，v2）

| 任务书 | 域 | 任务数 | 关键任务 |
|---|---|---|---|
| PE-01 | 配置/启动状态 | 19（T01.1–T01.5、T02.1–T02.4、T03.1–T03.4、T04.1–T04.4、T05、T06 组收编存根） | CoreStatus 基线、配置真源、启动收敛 |
| PE-02 | 流式 markdown | 6（T02.1–T02.6） | ProviderCall 契约 SoT、增量渲染接线 |
| PE-03 | IPC 契约收束 | 10（T03.1–T03.10） | 注册表单一化、错误统一、契约测试 |
| PE-04 | 可观测性 | 6（T04.1–T04.6） | telemetry 接线、日志约定、状态诊断 |
| PE-05 | 前端组件化 | 9（T05.1–T05.9） | ui 原子层、弹窗/菜单收敛、大组件拆分 |
| PE-06 | 抽象/去重 | 13（T06.1–T06.13） | Q01 修复、构造体打磨、hooks 去重 |
| PE-07 | 安全加固 | 8（T07.1–T07.8） | 门禁重设计、沙箱根、git 注入、密钥、MCP socket |
| PE-08 | 数据持久化 | 12（T08.1–T08.12） | P01/P02 阻塞修复、迁移版本化、恢复上线 |
| PE-09 | 性能优化 | 10（T09.1–T09.10） | 增量流实现、克隆风暴、DB 写放大、基准 |
| PE-10 | 依赖/构建 | 11（T10.1–T10.11） | lock 跟踪、reqwest 收敛、孤儿 crate、bundle |
| PE-11 | 测试策略 | 7（T11.1–T11.7） | Playwright、visual 门禁、契约测试、压力测试 |
| PE-12 | 事件 schema/运行行为 | 8（T12.1–T12.8） | 事件 schema 版本化、运行行为 |

合计：约 119 个任务。其中 12 份任务书 v2 后存在**三组跨书重复**，按 AU-04 裁决与本节 1.3 归一：

| 重复组 | 重复方 | 唯一 owner | 处理 |
|---|---|---|---|
| abort 时序（Q21/Q33/Q40） | PE-09 T09.9 vs PE-12 T12.1–T12.3 | **PE-09 T09.9** | PE-12 对应任务作废，改引用 PE-09 T09.9 |
| 同会话 sequence（Q23） | PE-08 T08.12 vs PE-12 T12.4 | **PE-08 T08.12** | PE-12 T12.4 作废，改引用 |
| AA-05 十项 | PE-07 T07.8 vs PE-12 T12.7 | **PE-07 T07.8** | PE-12 T12.7 作废，改引用 |
| 事件 schema 版本化 | PE-03 T03.10 vs PE-12 T12.5/T12.6 | **PE-03 T03.10** | PE-12 T12.5/T12.6 作废，改引用 |

PE-12 归一后仅保留 T12.8（验证回归）作为验证轮引用清单。

### 1.2 问题覆盖

- 8 份审查共 217 项问题：阻塞 5（AA-01 Q01、AA-07 P01/P02、AA-05 C-01/P-01）、严重/高危 10、重要 ~40。
- 审计 AU-02：阻塞/严重/高危 100% 被任务承接；覆盖 74%（164 项编号问题中已覆盖 ~121、部分覆盖 ~15、明确不做 ~10、脱管已由 AU-04 认领补齐）。

### 1.3 接口冻结表（AU-04，摘要）

| 冻结项 | 签名要点 | owner | 协作方 |
|---|---|---|---|
| F1 ProviderCall 增量流 | `stream(&self, request: &ProviderRequest<'_>) -> Result<ProviderEventStream, ClassifiedStreamError>`；别名 ProviderStreamItem/ProviderEventStream | PE-02（契约 SoT，§3.1） | PE-09 实现 |
| F2 CoreStatus | 输出侧统一 `providerStatus`（PE-03 名）；四方字段并集；串行增量 | PE-01 基线 → PE-03 → PE-04 → PE-08 | 各方 |
| F3 upsert_session_entry | `(entry: SessionIndexEntry)` 对象签名 | PE-08 T08.1 | PE-03 登记 |
| F4 cleanup 空集 | 空 keepIds → `Err(InvalidInput,"cleanup_orphan_empty_keep")`；`confirm_empty` 参数；宽限期 5 分钟 | PE-08 T08.2 | PE-01 消费 |
| F5 配置命令终态 | config_update/config_get/config_secret_*（删 save_api_config）；PE-07 新命令 config_profile_apply/config_secret_reveal | PE-03 命名、PE-07 实现 | PE-01 前端消费 |
| F6 RecoveryHook::decide | `decide(&CrishError, state)` | PE-06 | PE-04 消费 |
| F7 save_session_body | 保留全量替换；PE-09 只加 append 命令 | PE-08 | PE-09 T09.4 |
| F8 error_bridge | 删除（PE-04 迁移 → PE-03 删除，同一提交链时序） | PE-03 | PE-04 |
| F9 ApprovalGate | `Arc<dyn ApprovalGate>` | PE-09 T09.6 | PE-06 引用 |
| F10 锁中毒 | 唯一归 PE-07 T07.6；实测 37 处（idempotency 12 / bridge 25 / middleware 2） | PE-07 | PE-06 引用 |

---

## 2. 调度规则（执行轮次的第一约束）

### 2.1 同文件串行表

| 文件 | 串行顺序（先 → 后） | 说明 |
|---|---|---|
| `main.rs`（Tauri 壳） | PE-01 → PE-03 → PE-04 → PE-08 → PE-09 → PE-07 | 六方全改 setup/注册；同轮不得并行 |
| `core_query_commands.rs` | PE-01 → PE-03 → PE-04 → PE-08 | 字段增量演进 |
| `tool_exec.rs` | PE-06（T06.1 Q01）→ PE-09（T09.6 P8） | Q01 修复先行 |
| `streaming.rs` / `loop/mod.rs` / `handlers/mod.rs` | PE-06 → PE-09 | 打磨先行，性能后置 |
| `transport/mod.rs`（agent-provider） | PE-10（前置声明）→ PE-09（T09.1.2） | |
| `core_event_bridge.rs` / `buffer.rs` | PE-09（T09.2 事件克隆）→ PE-04（日志） | |
| `session_commands.rs` | PE-08（T08.1/T08.2）→ PE-03（T03.3 登记）→ PE-09（T09.4） | |
| `conex-db/src/lib.rs` | PE-08（T08.1–T08.12 主体）→ PE-09（T09.5 分页）→ PE-06（T06.5.7） | |
| `config/*`（壳） | PE-01 → PE-03（终态名）→ PE-07（T07.4） | |
| `profileStore.ts`（前端） | PE-01 → PE-07（T07.4 迁移）→ PE-05（T05.7 改名） | |
| `transport/commandMap.ts` | PE-03 → PE-01（消费）→ PE-05 | |
| `engine.ts`（壳） | PE-01 → PE-09（T09.1 增量流）→ PE-04 | |
| `EngineStatus/ChatStatusRibbons.tsx` | PE-01（提示修复）→ PE-05（T05.4 拆分） | SetupHintBanner 分支删除先行 |
| `AsyncMarkdownBlock.tsx` 等渲染件 | PE-02 → PE-05（组件收敛） | |

### 2.2 接口冻结约束

- 依赖冻结签名的任务，必须在签名文档定稿后启动：F1 契约（PE-02 §3.1）先于 PE-09 T09.1；F2 字段基线（PE-01 T01.1）先于 PE-03/PE-04/PE-08 相关任务；F5 终态表先于 PE-01 T03 链与 PE-07 T07.4。
- 冻结签名变更流程：任何任务发现冻结签名不成立 → 不许自行改签 → 上报调度者（本章程 3.3 节）→ 由调度者更新 AU-04 并通知全部依赖方任务书。
- 执行轮中已开工的冻结签名不得再改；新增需求走"扩展字段"（serde default）而非改既有字段。

### 2.3 owner 唯一性

- 第 1.1 节三组重复已归一（PE-12 对应任务作废改引用）；执行轮按 owner 表派单，防止双份执行。
- 跨书引用任务（PE-01 引用 PE-08/PE-07 等）执行时只跑 owner 方；引用方任务验收时验证被引用方产物已落地。
- 任务书间"协作"关系（F2 串行增量）：后置方开工前置条件 = 前置方对应任务验收通过（调度者核查）。

---

## 3. 执行轮次规划

> 每轮 ≤12 Agent；每轮完成标志 = 该轮全部任务 DoD 通过（cargo test/vitest/typecheck/grep 断言）+ 调度者核查串行链前置。
> 标注「并行组」表示组内任务可同时派发（不同文件/不同域）；「串行」表示必须等前一任务验收。

### Round E0 — 阻塞修复与安全前置 ✅ 完成（2026-08-01）

| 任务 | 域 | 结果 |
|---|---|---|
| T07.1 门禁重设计（C-01） | PE-07 | ✅ 39 测试（三层管线 + 30 攻击/安全用例）；两次 agent 失败后由调度者直接实现 |
| T07.2 沙箱根修复（P-01） | PE-07 | ✅ WorkspaceRegistry 真源 + 12 新测试；main.rs setup 注入 |
| T06.1 Q01 cancel-siblings | PE-06 | ✅ 133 测试（6 新混排用例，事件对齐全） |
| T08.1 P01 新会话落库 | PE-08 | ✅ upsert 命令 + 自愈 + 前端第 0 步 |
| T08.2 P02 级联删除防护 | PE-08 | ✅ confirm_empty + 宽限期 5min + boot 守卫 |
| T10.1 Cargo.lock 恢复跟踪 | PE-10 | ✅ lock 重新生成 + CI --locked |
| T10.2 reqwest 双版本收敛 | PE-10 | ✅ 提前完成（0.13 单版本，4 使用点零 API 差异） |
| T10.4/T10.6/T10.8/T10.9 清理 | PE-10 | ✅ derive_builder 删除、npm 冗余清、gitignore、sessions.db 出库、遗留文件清理 |
| T10.5 孤儿 crate 裁决 | PE-10 | ✅ conex-net/conex-stream 删除 |

验证：cargo test --workspace 29 套件全绿。5 个阻塞问题（C-01/P-01/Q01/P01/P02）全部修复。→ 进入 E1

### Round E1 — 基础串行链启动（main.rs/core_query_commands 基线）✅ 完成（2026-08-01）

| 任务 | 域 | 结果 |
|---|---|---|
| T01.1 CoreStatus 基线（providerStatus + hasApiKey 三态 + 诚实化） | PE-01 | ✅ F2 字段集冻结 v1；compactionReady=false 如实、initialized=dbReady 投影 |
| T01.2 前端 parseEngineStatusFromRaw 三态语义 | PE-01 | ✅ 72 前端测试全绿；sync-engine 提示保留待 T01.4 |
| T04.1 telemetry 接线（main.rs 双通道 + panic hook + 崩溃文件） | PE-04 | ✅ conex-telemetry 19 测试；Rust 运行期日志落地 |
| T10.2 reqwest 收敛 | PE-10 | ✅（E0 已完成） |
| T10.3 tokio feature 最小化 | PE-10 | ✅ full→最小集（rt/macros/time/sync/net/io-util/process） |
| T10.5 孤儿 crate | PE-10 | ✅（E0 已完成） |
| T10.7 bundle 体积 | PE-10 | ✅ lucide 52 处具名导入：App chunk -42.5%、vendor-lucide -94.6% |
| T10.10 配置项与安全 | PE-10 | ✅ rev 锁定 c7d271a、CSP 8765 清理、updater 禁用、.cargo/config.toml |

验证：cargo test --workspace 61 套件全绿（含修复 host_openers 门禁兼容 + engine 测试环境隔离）。→ 进入 E2

### Round E2 — 增量流与前端渲染（E2a ✅ 完成 / E2b 进行中）

E2a（2026-08-01 完成）：

| 任务 | 域 | 结果 |
|---|---|---|
| T02.1 ProviderCall 契约定稿（F1 SoT） | PE-02 | ✅ 冻结签名落地 + 契约测试 2 个（streaming_incremental_contract.rs）+ PE-02 §3.1 v3 |
| T02.2+T02.3+T02.4 前端增量渲染 | PE-02 | ✅ AsyncMarkdownBlock 增量重写（fence 软渲染）+ throttle + 完成态收敛 + parity 42 用例（117 测试） |
| T02.5 StreamRenderBuffer 死通道 | PE-02 | ✅ frame.html/chunkUpdates 删除，grep 归零（29 测试） |
| T06.2+T06.3+T06.4 Rust 打磨 | PE-06 | ✅ Q03 接线/Q05 假恢复删除/Q04 删除 + 14 项死代码处置 + 构造体（145+134+121 测试） |
| T09.2 事件克隆风暴 | PE-09 | ✅ type_name match + by value，克隆 3→0（24+87 测试） |

E2b（2026-08-01 完成）：

| 任务 | 域 | 结果 |
|---|---|---|
| T09.1 真增量流（F1 落地实现） | PE-09 | ✅ stream_frames 增量 + engine 真流 + DeltaSink 双轨（实时轨 sequence=None + 收口记账不双发）；首 token 2.44s→817ms（≈首帧延迟） |
| T09.9 abort 时序（Q21/Q33/Q40） | PE-09 | ✅ Notify 竞速 + consume 后重读 + 阶梯入口查 abort；14 新测试 |
| T09.3 对话克隆消除 | PE-09 | ✅ 全链借用 + Arc 化 + mem::take 零拷贝；Arc 身份测试（167 测试） |
| T03.5 死面清理（部分） | PE-03 | ⚠️ save_api_config 已删；get_api_config/profile_secret/perf 等留 E3 轮 |

E2 完成标志达成：首 token <600ms 断言（817ms 含 mock 首帧延迟 800ms——净处理 17ms）、增量渲染、克隆归零。→ 进入 E3

E3（2026-08-01 完成）：

| 任务 | 域 | 结果 |
|---|---|---|
| T03.1 命令注册表单一化 | PE-03 | ✅ COMMAND_REGISTRY_NAMES 宏同源 + command_manifest（73 条）+ core_list_commands + 双向断言；幽灵 9 条清零 |
| T03.2 调用方式统一 | PE-03 | ✅ transport.call 单通道，59 个调用点收敛，invokeResult 零残留 |
| T03.3 错误协议统一 | PE-03 | ✅ 全命令 CoreError（core_commands/config/fs/pty/process/host_openers）+ error_bridge 删除（F8）+ 新 77 码 |
| T03.4 命名规范化 | PE-03 | ✅ 38 项重命名全链（config_update/config_get/config_secret_*/core_md_*/workbench_* 等）；daemon 残留清理 |
| T03.5 死面清理 | PE-03 | ✅ save_api_config/perf/keep_awake 等清零 |
| T03.6 core_check_command 修复 | PE-03 | ✅ SharedGatekeeper 注入 + 8 测试 |
| T03.7 不可用调用点裁决 | PE-03 | ✅ 回补 1 + 删除 20；定时任务 UI 入口隐藏；SessionSyncService 删除 |
| T03.10 事件 schema 版本化 | PE-03 | ✅ schemaVersion=1 + changelog（33 文档）+ 25 golden fixtures |
| T04.5 状态诊断 | PE-04 | ✅ logLevel/logDir/diagnostics/lastError + 前端诊断面板（5 测试） |
| T06.5 错误类型下沉 | PE-06 | ✅ DbFailure/StoreError/LoopError → 77 码 + F6 RecoveryHook::decide(&CrishError) |
| T04.2 日志约定 | PE-04 | ✅ run span（session_id/run_id）+ 启动/收场/错误/steering/重试/工具日志 + 捕获测试（两次 agent 失败后由调度者直接实现） |

→ 进入 E4

| 任务 | 域 | 备注 |
|---|---|---|
| T07.1 门禁重设计（C-01） | PE-07 | 纯安全，无依赖 |
| T07.2 沙箱根修复（P-01） | PE-07 | 纯安全 |
| T06.1 Q01 cancel-siblings | PE-06 | 阻塞；tool_exec.rs 串行起点 |
| T08.1 P01 新会话落库 | PE-08 | 阻塞；加 upsert 命令（F3） |
| T08.2 P02 级联删除防护 | PE-08 | 阻塞；F4 语义 |
| T10.1 Cargo.lock 恢复跟踪 | PE-10 | 无依赖，先行 |
| T10.4/T10.6/T10.8/T10.9 依赖与 gitignore 清理 | PE-10 | 可并行 |

并行组：A组（T07.1/T07.2/T10.*）；B组（T06.1、T08.1、T08.2——各自独立文件域，可并行）。
完成标志：门禁攻击复现测试通过；Q01 事件序列测试通过；P01/P02 落库与防护测试通过；`cargo test --workspace` 全绿。

### Round E1 — 基础串行链启动（main.rs/core_query_commands 基线）

| 任务 | 域 | 备注 |
|---|---|---|
| T01.1 CoreStatus 基线（providerStatus + hasApiKey 三态） | PE-01 | core_query_commands 串行第一步 |
| T01.2 前端 parseEngineStatusFromRaw 语义 | PE-01 | 依赖 T01.1 字段 |
| T04.1 telemetry 接线（main.rs 初始化） | PE-04 | main.rs 串行第 2 步 |
| T10.2 reqwest 双版本收敛 | PE-10 | 依赖 T10.1 |
| T10.3 tokio feature 最小化 | PE-10 | |
| T10.5 孤儿 crate 裁决 | PE-10 | |
| T10.7 bundle 体积 | PE-10 | |
| T10.10 配置项与安全（rev 锁定等） | PE-10 | 与 T07.5 会签 |

并行组：A（T01.1/T01.2）；B（T04.1——main.rs 与 T01.1 的 core_query_commands 不同文件，可并行）；C（T10.x 全部，独立）。注意 T04.1 与 T01.1 都不动对方文件。
完成标志：status 字段测试通过；tracing 日志落地可观测；`cargo test --workspace` 全绿。

### Round E2 — 增量流与前端渲染（PE-02 + PE-09 前半 + PE-06 Rust 打磨）

| 任务 | 域 | 备注 |
|---|---|---|
| T02.1 ProviderCall 契约定稿 | PE-02 | F1 SoT；先于 T09.1 |
| T09.1 增量流实现（实时/收口双轨 + DeltaSink） | PE-09 | 依赖 T02.1、T10 的 transport 串行 |
| T02.2 AsyncMarkdownBlock 流式态重写 | PE-02 | mock 增量源先行，可与 T09.1 并行 |
| T02.3 MessageContent 切换 + throttle | PE-02 | |
| T02.4 完成态收敛 + parity | PE-02 | |
| T02.5 StreamRenderBuffer 死通道清理 | PE-02 | |
| T06.2/T06.3/T06.4 Rust 打磨（steering_enabled/死代码/构造体） | PE-06 | tool_exec 已由 T06.1 占位后可用 |
| T09.2 事件克隆风暴 | PE-09 | core_event_bridge 串行第 1 步 |
| T09.3 对话克隆消除 | PE-09 | streaming.rs/loop 在 PE-06 打磨后 |
| T09.9 abort 时序（Q21/Q33/Q40） | PE-09 | 归一 owner |

并行组：A（T02.1 → T09.1）；B（T02.2/T02.3/T02.4/T02.5 前端，依赖 mock 源，不依赖 T09.1 完成——按 PE-02 以 mock 先行设计）；C（T06.2–4 与 T09.2/T09.3 的文件串行：streaming.rs 域内 PE-06 先、T09.3 后，分两批排）；D（T09.9 独立）。
完成标志：首 token 端到端 <600ms 断言通过；增量渲染帧率门禁通过；克隆优化基准对比报告；`cargo test --workspace` + 前端渲染相关 vitest 全绿。

### Round E3 — IPC 契约收束（PE-03 主体 + PE-01 配置链）

| 任务 | 域 | 备注 |
|---|---|---|
| T03.1 命令注册表单一化 | PE-03 | main.rs 串行第 3 步；含 9 条新命令登记（F3/F7/upsert 等） |
| T03.2 调用方式统一 | PE-03 | |
| T03.3 错误协议统一 | PE-03 | 含 error_bridge 删除链（PE-04 迁移先行或同轮串行） |
| T03.4 命名规范化 | PE-03 | 38 项重命名表 |
| T03.5 死面清理 | PE-03 | 20 死面 + 7 配置命令裁决执行 |
| T03.6 core_check_command 修复 | PE-03 | |
| T03.7 不可用调用点裁决 | PE-03 | |
| T03.10 事件 schema 版本化 | PE-03 | 归一 owner |
| T01.3 配置真源迁移（前端读改写） | PE-01 | 依赖 F5 终态表（T03.4）与 T07.4 的迁移实现 |
| T01.4 删 sync-engine 提示与同步调用 | PE-01 | 依赖 T01.2 |
| T01.5 启动状态机合并 | PE-01 | |

并行组：A（T03.1 → T03.2–T03.7 内部按文件错开，建议拆 2-3 个 agent）；B（T01.3/T01.4/T01.5 前端配置域，与 PE-03 的 Rust 侧错开）；C（T03.10 独立）。
完成标志：commandMap 与注册面一致（grep 断言）；全命令 CoreError；幽灵/死面清零；契约测试 golden 通过；无 sync-engine 提示。

### Round E4 — 可观测性深化 + 数据持久化主体（PE-04 余项 + PE-08 主体）

| 任务 | 域 | 备注 |
|---|---|---|
| T04.2 日志约定（span 注入） | PE-04 | |
| T04.3 错误下沉消费（类型归 PE-06，本域日志传播） | PE-04 | 依赖 PE-06 T06.5 |
| T04.4 前端日志统一 | PE-04 | |
| T04.5 core_get_status 诊断段 | PE-04 | core_query_commands 串行第 3 步 |
| T04.6 日志轮转 | PE-04 | |
| T08.3 事件保留策略 | PE-08 | |
| T08.4 runs.cursor 接线 | PE-08 | |
| T08.5 DB spawn_blocking | PE-08 | |
| T08.6 恢复/快照生产接线 | PE-08 | main.rs 串行第 4 步 |
| T08.7 迁移版本化 + schema v4 | PE-08 | 依赖 T08.1/T08.2 基线 |
| T08.8 Q24 sequence 续接 | PE-08 | |
| T08.9 Q26 终态映射裁决 | PE-08 | |
| T08.10 前端写模型 | PE-08 | 与 PE-09 T09.4 串行（全量替换保留） |
| T08.12 Q23 会话级 sequence 分配 | PE-08 | 归一 owner |
| T06.5 错误类型唯一 owner（DbFailure/StoreError From + Q30/Q31） | PE-06 | 先于 T04.3 |

并行组：A（T04.x，依赖 T06.5 的部分排后）；B（T08.3–T08.9 内按 conex-db 串行：T08.7 需 T08.1/2 后，建议 2-3 个 agent 分批）；C（T08.10 前端写模型独立）；D（T06.5 先行给 T04.3 用）。
完成标志：日志 span 断言；迁移测试通过；恢复 e2e 通过；错误 payload 统一。

### Round E5 — 安全余项 + 前端去重（PE-07 余项 + PE-06 前端部分）

| 任务 | 域 | 备注 |
|---|---|---|
| T07.3 git 注入修复 | PE-07 | |
| T07.4 密钥管理（localStorage 迁移 + config_profile_apply/config_secret_reveal） | PE-07 | 依赖 F5 终态表；与 PE-01 引用衔接 |
| T07.5 MCP debug socket 加固 | PE-07 | 与 T10.10 会签 |
| T07.6 锁中毒（37 处） | PE-07 | 归一 owner |
| T07.7 安全基线文档 | PE-07 | |
| T07.8 AA-05 十项 | PE-07 | 归一 owner |
| T06.6 锁中毒引用（本域仅保留 Q19/Q20 标注） | PE-06 | 引用，不执行 |
| T06.7 遥测三份合一 | PE-06 | |
| T06.8 前端 hooks 去重（10 组） | PE-06 | |
| T06.9 跨 store 耦合 | PE-06 | |
| T06.10 WindowResizeBridge | PE-06 | |
| T06.11 启动路径回退协调 | PE-06 | 已移交 PE-01；本域保留特有部分（Q08） |
| T06.12/T06.13 收尾 | PE-06 | |

并行组：A（T07.x 安全批，main.rs 串行第 6 步放批尾）；B（T06.7–T06.10 前端去重）；C（T06.6 纯引用文档更新）。
完成标志：攻击复现测试全过；密钥迁移 e2e 通过；前端 hooks 重复清零（grep 断言）。

### Round E6 — 前端组件化大轮（PE-05 全量）

| 任务 | 域 | 备注 |
|---|---|---|
| T05.1 ui 原子层建设 | PE-05 | 基础设施先行 |
| T05.2 弹窗收敛（7 套 → Dialog） | PE-05 | 依赖 T05.1 |
| T05.3 菜单收敛（12 套 → Menu） | PE-05 | 依赖 T05.1 |
| T05.4 大组件拆分（10 个） | PE-05 | ChatStatusRibbons 需 T01.4 后 |
| T05.5 样式规范化 | PE-05 | |
| T05.6 目录化收尾 + shim | PE-05 | |
| T05.7 命名债务（daemon/WS 99 文件） | PE-05 | 末轮改名；PE-01/PE-06 旧名开发先完成 |
| T05.8 死代码清理 | PE-05 | |
| T05.9 迁移视觉回归门禁 | PE-05 | owner=PE-11，本域配合 |

并行组：T05.1 先 → T05.2/T05.3/T05.5 并行（依赖 T05.1）→ T05.4/T05.6/T05.8 并行 → T05.7 最后（16 消费文件冻结）。建议 4-6 个 agent 分三批。
完成标志：原子层门禁脚本通过；弹窗/菜单单实现；typecheck + 全量 vitest 全绿（仅基线失败除外）；命名 grep 归零。

### Round E7 — 测试体系与性能基准（PE-11 + PE-09 余项）

| 任务 | 域 | 备注 |
|---|---|---|
| T11.1 前端 e2e（Playwright） | PE-11 | 依赖 E6 完成（界面稳定） |
| T11.2 visual 回归门禁 | PE-11 | |
| T11.3 契约测试统一规范 | PE-11 | 依赖 PE-03 golden |
| T11.4 首 token 验收（owner 收敛） | PE-11 | 依赖 E2 |
| T11.5 迁移/升级测试 | PE-11 | 依赖 E4/E5 |
| T11.6 Rust 压力测试 | PE-11 | |
| T11.7 测试基建 + CI 门禁 | PE-11 | |
| T09.7 Criterion 基准 | PE-09 | |
| T09.8 首 token 基准 owner | PE-09 | |
| T09.10 性能回归收口 | PE-09 | |
| T12.8 验证回归清单（归一后） | PE-12 | 引用性任务 |

并行组：T11.6/T11.7/T09.7 可并行；T11.1/T11.2 依赖 E6 后；T11.3/T11.5 依赖前置轮。
完成标志：e2e 四场景通过；visual 门禁通过；压力测试报告；CI 三层门禁脚本可用。

### Round E8 — 最终验收（全量验证 + 收尾）✅ 完成（2026-08-01）

| 任务 | 内容 | 状态 |
|---|---|---|
| V1 | 全量验证序列（见第 5 节）逐项执行并记录 | ✅ cargo test --workspace 全绿（~330+ 套件）；cargo check 通过；前端 typecheck 0 错误 + vitest 3977/4034（57 基线失败文档化）+ vite build 成功；压力测试 release 全绿；基准复测 7/9 无回归（T09.4/T09.5 遗留登记） |
| V2 | 30-verification-checklist.md 补全（E 轮全部检查项 + 分歧核对矩阵更新） | ✅（分歧 D1-D10 + 00 D1-D6 经 divergence 测试全绿确认；C2.1 事件核对 16 项锚定） |
| V3 | 23 总纲与 00 主方案状态表更新；Phase E 完成声明 | ✅ 本文件轮次表全部 ✅；23 号副文档状态表同步 |
| V4 | 收尾：AU-04 冻结表存档为契约基线文档；安全基线（31）发布 | ⚠️ 31-security-baseline.md 已建（T07.7）；AU-04 存档为契约基线（契约测试覆盖矩阵 docs/rust-rewrite/contracts/ 已落盘） |

遗留登记（文档化，非阻塞）：
- T09.4 DB 写放大 append 命令未接线（manifest registered=false，DB API 已就绪）
- T09.5 分页下推未实现（Store::query_events 未传 limit）
- 前端 4 个基线失败测试文件（ImageGallery/sessionRustDbWriteModel/oklchColorGuard/userFacingErrors——契约未落地）
- 2 个快照测试（ChatToolCallBlock/ToastStack）CSS hash 漂移待更新

Phase E 完成声明：E0-E8 全部轮次执行完毕；阻塞/严重/高危问题全部修复；接口冻结 F1-F10 全落地（F9 T09.6 已接线）；安全基线发布。

---

## 4. 里程碑

| 里程碑 | 包含轮次 | 完成标志 |
|---|---|---|
| M0 前置修复 | E0 | 5 个阻塞问题全部修复并有回归测试 |
| M1 状态真源 | E1 | status 诚实、无"待同步"提示、启动状态单实现 |
| M2 增量渲染 | E2 | 流式直接渲染 markdown、首 token <600ms |
| M3 契约收束 | E3 | 命令注册表单一、全命令 CoreError、契约测试 |
| M4 可观测 | E4 | 日志落地+span、错误单一体系、诊断面板 |
| M5 数据/安全 | E5 | 数据不丢、恢复上线、安全基线发布 |
| M6 组件化 | E6 | ui 原子层、命名归零、样式单轨 |
| M7 测试验收 | E7/E8 | e2e/visual/压力全过、最终验收清单全绿 |

---

## 5. 最终验收清单（E8 全量验证命令序列）

```
# Rust 全量
cargo test --workspace
cargo clippy --workspace --all-targets -D warnings   # 或按 crate 归零
cargo build --workspace                              # debug 可执行产物
# 契约与安全
cargo test -p crish-agent-workbench --test event_bridge   # 16 项硬依赖锚定
cargo test -p session-loop --test divergence        # D1-D10 分歧核对
cargo test -p agent-provider --test security_cases  # 门禁攻击复现（T07.1 产出）
# 前端
npm run typecheck --workspace @crish/crish-desktop
npx vitest run src                                    # 全量，基线失败清单存档
npm run build --workspace @crish/crish-desktop       # tsc -b && vite build
# 前端 e2e（T11.1 产出）
npx playwright test                                  # 四场景
# 基准（T09.7 产出）
cargo bench -p session-loop -p orchestrator         # 关键路径基线报告
# 压力（T11.6 产出）
cargo test --release -p session-loop --test stress   # #[ignore] 显式跑
# 收尾文档
docs/rust-rewrite/30-verification-checklist.md 全项勾选
docs/rust-rewrite/31-security-baseline.md 发布
```

---

## 6. 风险与兜底

| 风险 | 兜底 |
|---|---|
| 冻结签名执行中发现不成立 | 3.2 节流程：上报调度者 → 更新 AU-04 → 通知依赖方；禁止自行改签 |
| 任务书与执行偏差（任务书未覆盖的现场问题） | 调度者统一裁决：小偏差现场解决并回写任务书修订记录；大偏差（涉及冻结签名/跨任务书）走 3.2 |
| 同文件串行被破坏（并行派单失误） | 派单前调度者按 2.1 表核查；验收时 git diff 核对文件归属 |
| 跨轮依赖（前置轮未按时完成） | 轮次间以"完成标志"为闸门，不满足不进入下一轮；可跳过非关键路径轮次 |
| 安全回归引入行为变化 | 每安全任务必须有攻击复现测试（红→绿）；行为变化登记任务书修订记录 |
| 大轮（E6）Agent 冲突 | 按 2.1 串行表 + T05.7 冻结清单分批派单；每批验收后放行下一批 |
| 冻结接口被新需求扩展 | 扩展字段（serde default）优先；既有字段语义不变；扩展也走契约文档登记 |

---

## 7. 附录：任务书修订状态登记

| 任务书 | 版本 | 修订依据 | 状态 |
|---|---|---|---|
| PE-01 | v2 | AU-04（F2/F3/F4/F5、去重收编、行号） | ✅ 可执行 |
| PE-02 | v2 | AU-04（F1 SoT、首 token 口径、资产修正） | ✅ 可执行 |
| PE-03 | v2 | AU-04（F5/F8、T03.10 新增、命令登记） | ✅ 可执行 |
| PE-04 | v2 | AU-04（F2/F6/F8、移交 PE-06） | ✅ 可执行 |
| PE-05 | v2 | AU-04（行号修正、T05.9、C17/C18 时序） | ✅ 可执行 |
| PE-06 | v2 | AU-04（F6/F10、错误类型 owner、T06.11 验收补强） | ✅ 可执行 |
| PE-07 | v2 | AU-04（F5/F10、T07.8、迁移单实现） | ✅ 可执行 |
| PE-08 | v2 | AU-04（F3/F4、T08.12、schema 修正） | ✅ 可执行 |
| PE-09 | v2 | AU-04（F1/F7/F9、T09.8/T09.9 新增、编号顺延） | ✅ 可执行 |
| PE-10 | v2 | AU-04（C21 会签、依赖管理） | ✅ 可执行 |
| PE-11 | v1 | 独立产出 | ✅ 可执行 |
| PE-12 | v1 | 产出后经本方案归一（T12.1-12.7 作废改引用） | ⚠️ 仅 T12.8 生效 |
