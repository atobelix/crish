# AG · conex-agents

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. 先删零实现端口和重复码表，再改能力判定的数据来源。不留名称白名单与声明字段双轨。
> 2. 禁止作弊：不加 `allow`、不登记新基线、不删断言。测试里如果断言了「兄弟超限也返回 depth_exceeded」，改成断言新的独立错误码，不要删掉这条测试。
> 3. 测试只在 AG-P3。提交：`refactor(AG-P<n>): <摘要> [BATCH-CONEX-AGENTS]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-agents`，分支 `refactor/conex-agents`。不在主仓库改代码。
> 5. 进度写同目录 `conex-agents.progress.md`。
> 6. Rust 1.99.1，clippy `-D warnings`。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\agents`，`-j 3`。磁盘余量须 ≥ 25 GB，不要和其他 cargo 并行。
> 7. 行号会过期。下面凡是写了函数名的，开工前用 `rg` 重定位。

| 项 | 值 |
|---|---|
| 方案代号 | `AG` |
| 波次 | W5。AG-P1 可在 `conex-agents` 干净时先做。AG-P2 等 SB 不再改 `readonly.rs`，并排在 AT-P1 之后（两边都可能改 `definition.rs`） |
| 不重做 | EC 的生成器与 CI；TM 的时间函数；PL 的消息 id（`new_message_id`）；SB 的 shell 门禁 |

依据：g1 AG-01..05。2026-10-29 对照 `C:\Software\conex\crates\conex-agents` 重读。

## a. 范围

纳入：`crates/conex-agents` 的码表、能力名单、零实现端口、通信 id。为了把名单换成声明，允许改 `crates/agent-tools` 里读取这些名单的 `readonly.rs`、`lib.rs` 再导出，以及工具定义上的一个字段。

不纳入：
- `session-loop` 的 `new_message_id`（PL-P2 已收敛）
- 错误码生成脚本、`error-codes.json` 的生成管线（EC）。本方案只往**当前真源**补码，不自建第二套生成
- `readonly.rs` 里 SB 正在改的裁决消费。本方案只替换名单的数据来源

## b. 问题清单（已对照当前代码）

| # | 核实 | 证据 |
|---|---|---|
| AG-01 | 仍在 | `fault.rs` 的 `pub mod codes` 自带 7 个 `agent.*` 字符串：`CAPACITY_PRESSURE`、`CAPABILITY_DENIED`、`MODEL_UNAVAILABLE`、`COMM_THROTTLED`、`CONFIG_INVALID`、`INTERRUPTED`、`SPAWN_FAILED`。中心表在 `conex-types` 的 `error/codes.rs`（`subagent.*` 已在那里）。`denial_message` 还把 `agent.capability_denied` 拼进文案 |
| AG-02 | 仍在 | `capability.rs` 的 `READONLY_TOOL_NAMES`（12）、`WRITE_TOOL_NAMES`（4）、`EXECUTE_TOOL_NAMES`（1）。`tool_requirement` 的 `else` 分支返回 `ToolRequirement::Write`。注释写明未知工具按 Write。`agent-tools/src/readonly.rs` 的 `pub use` 复用这两张表，`filter_readonly_registry` 用名单做白名单 |
| AG-03 | 仍在，零实现 | `ports.rs` 的 `trait Clock`（`now_ms -> i64`）和 `trait PolicyStore`。全仓没有 `impl`，也没有 `conex_agents::ports` 的引用。`lib.rs` 仍 `pub mod ports`。这不是时间真源：TM 的真源是 `conex_shared::time`，浏览器的 `GateClock` 是另一套，不要动 |
| AG-04 | 仍在 | `RecursionGuardRejection::code` 把 `SiblingsExceeded` 和 `ConcurrentExceeded` 都映射到 `codes::SUBAGENT_DEPTH_EXCEEDED`。`agent-tools` 的 `subagent_tests_guard.rs` 断言了这个复用 |
| AG-05 | 仍在，且与 PL 的消息 id 不是同一函数 | `comm.rs` 的 `uuid_like(now_ms, from)` 只用时间戳加发送方哈希。唯一调用点在同文件构造 `agent-msg-{now_ms}-…`。同一发送方在同一毫秒内 id 相同。不要把它并进 session-loop 的消息计数器 |

## c. 目标架构

1. `agent.*` 与 `subagent.*` 只存在于中心错误码表（EC 落地前是 `conex_types::error::codes`；EC 落地后是 `contracts/error-codes.json` 生成物）。`fault::codes` 删除。`AgentFault` 继续携带码字符串，但常量从中心表引用。
2. 能力不看工具名字。`ToolRequirement` 留在 `conex-agents`（它是领域类型）。每个内置工具在自己的定义上写明 `Read` / `Write` / `Execute`。`tool_requirement` 改为接收 `Option<ToolRequirement>`：`Some` 原样返回，`None`（未登记）返回 `Execute`。不再有按名字查表的函数，也不再默认 Write。
3. 只读过滤看声明，不看名单。今天 `READONLY_TOOL_NAMES` 能通过过滤的那一组名字，改完后必须仍然通过。通信工具（`report_progress`、`ask_parent`、`request_capability`）今天按 Read 处理，改完后仍是 Read。
4. `ports.rs` 整文件删除，`lib.rs` 去掉 `pub mod ports`。不引入 `Clock` trait，不把 `now_ms` 改成 i64 时间服务。
5. 代理消息 id 在 `comm.rs` 内用 `AtomicU64` 序号做后缀。不新增 uuid crate，不与 PL 的消息 id 共用计数器。

未登记工具从「ReadWrite 档可用」变成「需要 Execute 档」。这是 AG-02 要修的放宽，不是另加一层兼容。只读过滤的现有成员集合保持不变。

## d. 删除清单

- `crates/conex-agents/src/ports.rs` 与 `lib.rs` 的 `pub mod ports`
- `fault.rs` 的 `pub mod codes`（常量迁到中心表后）
- `READONLY_TOOL_NAMES`、`WRITE_TOOL_NAMES`、`EXECUTE_TOOL_NAMES` 三个数组，以及 `readonly.rs` / `lib.rs` 对它们的再导出
- `uuid_like` 这个函数（由序号后缀替换）

保留：`ToolRequirement`、`allows_tool`、`denial_message`、`CapabilityCell`、`COMMUNICATION_TOOL_NAMES` 所表达的「通信工具任何子代理都可用」这一规则（改成声明为 Read，数组可以删）。保留 `AgentPolicy`。不要删 `GateClock`。

## e. 分阶段步骤

**AG-P1 · 码表并入中心、删端口、修消息 id**（只碰 `conex-agents` 与中心码表）

```powershell
git -C C:\Software\conex status --porcelain -- crates/conex-agents crates/conex-types/src/error
# 必须为空。error 目录非空则本阶段停，等 EC 或在写批次提交后再做
```

1. 读 `conex-types/src/error/codes.rs` 首行。若已是生成文件，不要手改它：把下面的字符串补进 `contracts/error-codes.json`，用 EC 的生成脚本重写。若仍是手写且 JSON 尚不存在，就写进 `codes.rs`，并在进度文件逐字记下这些字符串，供 EC 收进 JSON。不要两处各写一套不同的拼写。
2. 补上已在生产使用、但只活在 `fault::codes` 的 7 个 `agent.*`。再补两个新码，字符串就用 `subagent.siblings_exceeded` 与 `subagent.concurrent_exceeded`。`RecursionGuardRejection::code` 按变体各返回一个码：深度、兄弟、并发、嵌套、死锁五条路径互不相同。
3. `denial_message` 使用中心常量，不要在格式串里再写一遍字面量。
4. 删除 `ports.rs`。全仓 `rg "ports::Clock|ports::PolicyStore|conex_agents::ports"` 必须为 0。
5. `uuid_like` 改为进程内 `AtomicU64`。同一毫秒、同一发送方连续两次 `id` 必须不同。不要改 id 的 `agent-msg-` 前缀（已有测试或日志若匹配前缀，保持前缀）。

完成判据：

```powershell
rg -n "pub mod codes" crates/conex-agents/src/fault.rs
# 无匹配
rg -n "trait Clock|trait PolicyStore" crates/conex-agents
# 无匹配
rg -n "fn uuid_like" crates/conex-agents
# 无匹配
```

**AG-P2 · 能力改声明**（等 SB 合入，且下面路径干净）

```powershell
git -C C:\Software\conex status --porcelain -- crates/agent-tools/src/readonly.rs crates/agent-tools/src/definition.rs crates/conex-agents/src/capability.rs
# 必须为空。AT-P1 若正在改 definition.rs，等它的提交落在分支上再做
```

1. 在工具定义上增加 `requirement: ToolRequirement`。现有内置工具按今天三个数组的成员赋值，通信工具赋 `Read`。不要留「缺字段就查旧数组」。
2. `tool_requirement` 只看这个声明。未登记返回 `Execute`。删除三个数组。
3. `filter_readonly_registry` 改为保留声明为 `Read` 的工具。改完后对当前内置注册表跑一遍：通过过滤的名字集合与改前一致（现有测试已断言 `READONLY_TOOL_NAMES.len()`，把期望改成这份名字集合，不要放宽成「至少这么多」）。
4. `agent-tools` 的 `lib.rs` 停止再导出两张表。外部若 `rg` 到桌面或别的 crate 还在引用 `READONLY_TOOL_NAMES`，改那些调用点到声明，不要留类型别名。

`readonly.rs` 在 SB 合入前禁止修改。

**AG-P3 · 验证**

只跑本 crate 与直接断言了这些码或名单的测试：

```powershell
$env:CARGO_TARGET_DIR = "C:\Users\orange\conex-tgt\agents"
cargo test -j 3 -p conex-agents -p agent-tools --lib --tests
cargo clippy -j 3 -p conex-agents -p agent-tools --all-targets -- -D warnings
```

`subagent_tests_guard.rs` 里原来断言兄弟/并发超限等于 `SUBAGENT_DEPTH_EXCEEDED` 的用例，改为断言新码。深度超限的用例仍断言 `SUBAGENT_DEPTH_EXCEEDED`。

## f. 禁止的捷径

- 不把未知工具继续默认成 Write，也不要做成「未知则 Read」（那会让只读代理能调未分类工具）。
- 不保留名字数组作为声明字段的后备。
- 不新增 `Clock` trait，不把 `now_ms: i64` 接到 `conex_shared::time` 以外的第二套时钟。AG 本阶段不改时间。
- 不把 `uuid_like` 换成 session-loop 的消息 id 函数（会让两个 crate 为了不同类型的 id 缠在一起）。
- 不把 `SiblingsExceeded` 继续复用深度码，也不要只改文案、不改 `code()`。
- 不在 `readonly.rs` 上加 `allow` 来压 SB 未完成时的编译错误。门控未满足就停。

## g. 规范

clippy `-D warnings`。本 crate 生产体量小，拆分后仍须满足仓库的 crate-size（lib ≤ 800、mod ≤ 600）和函数长度（≤ 150）。不要为了过线把名单挪到 `#[path]` 文件。

## h. 测试集中点

AG-P1、AG-P2 不跑全仓 cargo。AG-P3 是唯一测试阶段。断言改的是期望码和期望名字集合，用例个数不得减少。

## i. 审计

对照 §e 的 rg。额外确认：`denial_message` 的格式串里不再出现硬编码 `agent.capability_denied`；`lib.rs` 没有 `pub mod ports`。

## j. 冲突与门控

| 对方 | 关系 |
|---|---|
| EC | 码的真源与生成归 EC。AG 只补字符串。EC 之后禁止手改生成的 `codes.rs` |
| SB | `readonly.rs` 归 SB，直到 SB 合入且 `git status --porcelain -- crates/agent-tools/src/readonly.rs` 为空 |
| AT | AT-P1 可能改 `definition.rs`。AG-P2 在其后，保留 AT 已做的执行面收敛，只加 `requirement` 字段 |
| TM | 不改 `conex_shared::time`，不改 `GateClock` |
| PL | 不改 `new_message_id` |

## k. 已决事项

| 项 | 结论 |
|---|---|
| 未知工具 | 未声明按 `Execute`，不再按 `Write` |
| 端口 | 删除 `Clock` 与 `PolicyStore`。零实现，不是时间真源 |
| 错误码 | 并入中心表。兄弟超限与并发超限使用独立码 |
| 消息 id | 只修 `comm.rs` 的代理消息。不与 PL 合并 |
| 只读过滤成员 | 现有内置工具的通过集合保持不变 |
