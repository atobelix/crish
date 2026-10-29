# OR · orchestrator 残余

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. 先删空 trait 和兼容别名，再去掉向下转型。不留 `as_local_db` 的默认空实现当后备。
> 2. 禁止作弊：不加 `allow`、不新增 `unwrap`、不用 `#[path]` 把 `restore` 挪走。解析失败必须返回错误，不准再编造终态字符串。
> 3. 测试只在 OR-P4。提交：`refactor(OR-P<n>): <摘要> [BATCH-ORCHESTRATOR]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-orchestrator`，分支 `refactor/orchestrator`。不在主仓库改代码。
> 5. 进度写同目录 `orchestrator.progress.md`。
> 6. Rust 1.99.1，clippy `-D warnings`。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\orchestrator`，`-j 3`。磁盘余量须 ≥ 25 GB。
> 7. 行号会过期。开工前用 `rg` 重定位。

| 项 | 值 |
|---|---|
| 方案代号 | `OR` |
| 波次 | W5。OR-P1 在 orchestrator 干净时即可做。OR-P2 等 TD 合入。OR-P3 等 `crates/conex-run` 干净，且排在 RN-P2 之后（两边都可能碰 `run_core.rs`） |
| 不重做 | TD 的 `InMemoryStore` 测试钩子移出生产；TM 的 `now_ms` / `iso_from_millis` / `parse_iso8601_epoch_ms`；MP 的 `#[path]`；SL 的循环内队列 |

依据：g1 OR-01/02/03/05/07。OR-04 归 TD，OR-06 归 TM，OR-08 的 `#[path]` 归 MP。2026-10-29 对照 `crates/orchestrator`。

## a. 范围

纳入：`crates/orchestrator` 的存储 trait 空洞、`as_local_db` 向下转型、`RestoreManager::restore` 吞掉 JSON 解析错误、重复的 pending-input 适配、以及与 session-loop 队列的边界说明。

OR-P3 只允许改 conex-run 里直接调用 `as_local_db` 的那几处（编写时是 `run/run_core.rs` 与 `engine_handle.rs`）。不改 `src/run` 的其他逻辑。门控见 §e。

不纳入：
- 把 `AgentInputQueue` 与 `ControlBus` 并进来（SL 已决：不合并）
- `steering_queue.rs` 里的时间函数（TM）。本方案若必须改这个文件，不得碰那些函数体
- `flow_graph` 的 `#[path]` 与超长 `advance`（MP 拆文件；函数拆分若 MP 没做，本方案也不要在 P1 顺手拆，避免和 MP 抢文件）

## b. 问题清单（已对照当前代码）

| # | 核实 | 证据 |
|---|---|---|
| OR-01 | 仍在 | `persist.rs` 的 `Store::as_local_db` 默认返回 `None`。`LocalDbStore` 覆写。调用方在 `None` 时跳过：`blocks.rs` 的压缩块写入与 `update_compression_block_summary`；`restore_manager.rs` 里 heal 用 `if let Some(db)`。`conex-run` 的 `run_core.rs`、`engine_handle.rs` 把下转结果当可选数据库。测试替身因此不跑 heal 和块写入 |
| OR-02 | 仍在，且有一个同名陷阱 | `persist.rs` 的 `trait MetaStore`、空的 `trait RunStore`、空的 `trait EventStore`。注释写「保守路线，仅签名对齐，待主控协调再合并」。全仓没有 `impl` 这三个 trait。另有真 trait：`recovery_store.rs` 的 `RecoveryStore`、`flow_graph_scheduler.rs` 的 `FlowMetaStore`（`LocalDb` 与测试存储都实现了）。同文件还有 `pub use FlowMetaStore as MetaStore`，注释写「历史名保留，路径不 break」。这是兼容别名，不是 persist 里那个空 trait |
| OR-03 | 仍在 | `RestoreManager::restore` 在终态 payload 上 `serde_json::from_str(...).ok()`，失败就 `unwrap_or_else` 成字符串 `"run-terminal"`。其后 `RunStatus::from_str` 失败才变成 `RunStatus::Unknown(字面量)`。解析失败被编造成一个终态词，和「未知字面量保持 Unknown」不是一回事。函数仍很长，`RestoreManager` 仍是只有 `new` 的单元结构体。文件头附近的文档若仍写「恢复只读」，与 `update_run_status` 的写入矛盾，改文档以匹配「有一个明确的写入阶段」 |
| OR-04 | 归 TD | `InMemoryStore` 的 `fail_next_append` 一类测试钩子不在这里删 |
| OR-05 | 仍在 | `persist.rs` 后部为 `LocalDbStore` 与 `InMemoryStore` 各写一份 pending-input 适配，错误用 `.map_err(|e| e.message)` 收成字符串。`StoreError` 的 kind 仍是字符串的，要在本方案改成枚举的，只限这两份适配里新产生的错误，不要全仓替换每一个 `StoreError::new("...")` 调用（那会和 TD 抢 `persist.rs`）。P0 重读：若 TD 已经删掉 `InMemoryStore` 的生产可见钩子但类型还在，两份适配仍要收成一份 |
| OR-06 | 归 TM | 不改时间函数 |
| OR-07 | 无需新抽象 | `PendingMessageQueue` 是跨 run 持久队列。session-loop 的两个队列元素类型不同（SL 方案 §c）。本方案不把它们收成一个 trait。只保证本 crate 不再提供第二套「把同一条用户消息再排进循环内队列」的写入。具体双写由 SL-P0 的调用图判定；OR 不改 `input.rs` / `control.rs` |
| OR-08 | 归 MP（path） | 超长函数在 MP 拆文件之后若仍超过 150 行，另开 OR 的 fixup，不和 P1 绑在一起。`cancel_node` / `reset_flow` 若 `rg` 仍为零调用，在那个 fixup 里删除，不在 P1 删 |

## c. 目标架构

1. 存储能力在 `Store` 的方法上，不在下转型上。压缩块的插入与摘要更新是 `Store` 的方法：`LocalDbStore` 做现在的 SQLite 写入；`InMemoryStore` 记在内存结构里，返回 `Ok`，并且之后读得回来。禁止再出现「没有连接就 `return Ok(())` 当作没发生」。
2. `as_local_db` 在 OR-P3 删除。OR-P1 与 OR-P2 不保留它作为「过渡 API」。因此 OR-P2 与 OR-P3 合成一次提交序列时，P3 必须紧跟，且只有 `conex-run` 干净才能开始 P2。若 run crate 不干净，P2/P3 一起等，不要先在 orchestrator 加新方法、又把 `as_local_db` 留着给 run 用。
3. 空的 `persist::MetaStore`、`RunStore`、`EventStore` 删除。`FlowMetaStore as MetaStore` 别名删除，调用方改写为 `FlowMetaStore`。`RecoveryStore` 与 `FlowMetaStore` 保留，它们有实现。不要把这三个真 trait 再合成一个超级 trait。
4. `restore` 拆成同文件的私有阶段：装载、按事件分类、修补、重建内存态、写入、报告。写入只发生在写入阶段。JSON 解析失败返回 `StoreError`（带 run id 与原始 payload 的截断，截断长度沿用本文件已有的日志截断习惯，不要新发明无限拼接）。`RunStatus::from_str` 不认识的**已成功解析出来的**终态字面量，仍用 `RunStatus::Unknown(该字面量)`，这是保真，不是吞错。
5. pending-input 的两份适配收成 `Store` 上已有的方法的单一路径。错误使用 `StoreError`，kind 用枚举变体表示「读写失败 / 序列化失败」，不要 `.map_err` 成 `String` 再包回去。若今天 `StoreError.kind` 已经是 `String`，就在 `StoreError` 上改成枚举，并改本 crate 的构造点。conex-run 里若要跟着改构造，计入 OR-P3 的门控，不能在 run 脏的时候改。
6. `PendingMessageQueue` 继续是会话级入口。不新增队列类型。

`touch_session` 的默认空实现可以留下：内存存储没有 sessions 表，刷新更新时间是无操作，这和「跳过块写入还假装成功」不同。不要把 `touch_session` 改成返回错误。

## d. 删除清单

- `persist.rs` 的空 `MetaStore`、`RunStore`、`EventStore`
- `pub use FlowMetaStore as MetaStore`
- `Store::as_local_db` 及其 `LocalDbStore` 覆写（OR-P3）
- `blocks.rs` / `restore_manager.rs` 里 `let Some(db) = store.as_local_db() else { return Ok(()) }` 或等价的跳过
- restore 里把解析失败变成 `"run-terminal"` 的 `unwrap_or_else`
- 重复的那一份 pending-input impl 里的字符串抹平

不删除：`RecoveryStore`、`FlowMetaStore`、`PendingMessageQueue`、`InMemoryStore` 类型本身（测试钩子的归宿由 TD 决定）。

## e. 分阶段步骤

**OR-P1 · 空 trait 与别名**（orchestrator 干净即可，不碰 conex-run）

```powershell
git -C C:\Software\conex status --porcelain -- crates/orchestrator
# 必须为空
```

1. 删除三个空 trait。先 `rg "persist::MetaStore|RunStore|EventStore"` 确认没有 impl 和泛型约束。`flow_graph.rs` 目前从 scheduler 导入的 `MetaStore` 是别名，改成 `FlowMetaStore`。
2. 删除别名。`rg "MetaStore"` 剩下的必须是零匹配，或只出现在进度文件不关心的历史注释里——注释也改掉，不留「又称 MetaStore」。

```powershell
rg -n "trait RunStore|trait EventStore|as MetaStore" crates/orchestrator
# 无匹配
```

**OR-P2 + OR-P3 · 去掉下转型，并改 restore**（一起做，避免留下双轨）

```powershell
git -C C:\Software\conex status --porcelain -- crates/orchestrator crates/conex-run
# 必须为空
# 且 TD 已合入（InMemoryStore 的测试钩子不再要求生产 trait 带 set_append_delay 一类方法）
# 若 RN-P2 即将或正在拆 run_core.rs，等 RN-P2 提交后再改其中的 as_local_db 调用点
```

1. 在 `Store` 上增加块写入与块摘要更新所需的方法，签名用现有的 `BlockState`、session id、block id，不把 `LocalDb` 暴露到方法参数里。
2. `LocalDbStore` 把今天 `blocks.rs` 里 spawn_blocking 的 SQLite 调用移入这些方法。`InMemoryStore` 用 `Vec` 或已有的内存事件结构记住块，使随后的读取能看见这次写入。
3. 改 `conex-run` 里 `store.as_local_db()` 的调用点：它们要的是 usage / timer 所用的库连接时，改成 `Store` 上对应的窄方法（例如保存 run usage），同样由两个实现分别完成。不要把 `LocalDb` 克隆传到 run crate 作为「暂时还需要」。若某个调用点在 RN-P2 之后换了文件，跟着新位置改，在进度文件记录偏离。
4. 删除 `as_local_db`。
5. 按 §c.4 拆 `restore` 并停止编造 `"run-terminal"`。文档改成与写入阶段一致。
6. 按 §c.5 合并 pending-input 适配。

```powershell
rg -n "fn as_local_db|as_local_db\(" crates
# 无匹配
rg -n "run-terminal" crates/orchestrator/src/restore_manager.rs
# 无「解析失败就填这个词」的路径。若字面量仍作为 Unknown 的测试夹具出现在 tests 里，可以留
rg -n "trait MetaStore" crates/orchestrator/src/persist.rs
# 无匹配
```

**OR-P4 · 验证**

```powershell
$env:CARGO_TARGET_DIR = "C:\Users\orange\conex-tgt\orchestrator"
cargo test -j 3 -p orchestrator
cargo clippy -j 3 -p orchestrator --all-targets -- -D warnings
```

P3 改了 conex-run 的调用点时，加 `-p conex-run` 的相关测试只在 OR-P4，并且 target 目录用上面的路径，不要再开一个 20 GB 的 target。若磁盘不够，停，不要换到主仓库的 target。

## f. 禁止的捷径

- 不在 `as_local_db` 仍存在的情况下加一套新方法「两边都能用」。
- 不把 InMemory 的块方法实现成 `Ok(())` 且不保存。
- 不把解析失败映射成 `RunStatus::Unknown("run-terminal")` 或 `Failed`。未知但已解析的字面量才用 `Unknown`。
- 不新增 `InputChannel`，不改 session-loop 的队列。
- 不把 `RecoveryStore` 和 `FlowMetaStore` 合并。
- 不留 `MetaStore` 别名。
- 不在 restore 的错误路径上 `unwrap` / `expect`。
- 不改 TM 的时间函数，不加 `#[path]`。
- 门控非空不写。尤其不要在主仓库的脏 `src/run` 上改 `as_local_db`。

## g. 规范

clippy `-D warnings`。`restore` 拆完后每个阶段函数 ≤ 150 行。不要用 `#[path]` 满足行数。`StoreError` 的 kind 枚举放在 `persist.rs` 或它的子模块，不新建只为这一个枚举服务的 crate。

## h. 测试集中点

只有 OR-P4。原来断言「内存存储的 `as_local_db` 是 None，因此块写入被跳过」的测试（`blocks.rs` 内的断言）改成断言内存里能读回写入。不要删掉这些测试。restore 增加一条：非法 JSON 终态 payload 使 `restore` 返回 `Err`，且不把该 run 写成某种成功终态。

## i. 审计

核对全仓 `as_local_db` 为零、persist 无空 trait、别名消失、`restore` 不再把 `.ok()` 的失败变成 `"run-terminal"`。进度文件写明 RN-P2 是否改变了调用点文件名。

## j. 冲突与门控

| 对方 | 关系 |
|---|---|
| TD | 先合入。OR 不删 TD 负责的测试钩子，也不把钩子留在生产 trait 上 |
| TM | `steering_queue.rs`、`session/time.rs`、`lib.rs` 的 `now_ms` 归 TM。OR 的 diff 不要包含这些函数的重写 |
| MP | `#[path]` 与 flow_graph 文件搬迁归 MP。OR-P1 不搬文件 |
| RN | OR-P3 在 RN-P2 之后，只改 `as_local_db` 调用点。不拆 `CoreRunState`，不改 context_injection |
| SL | 队列不合并。SL 不改 `PendingMessageQueue` 的字段 |
| conex-db | SQL 语句仍调用现有 `LocalDb` 方法。不在本方案改 `crates/conex-db` |

## k. 已决事项

| 项 | 结论 |
|---|---|
| 下转型 | 删除。能力变成 `Store` 方法。内存实现真的保存块 |
| 空 trait | 删除 persist 的三个空 trait 与 `MetaStore` 别名。保留 `RecoveryStore` 与 `FlowMetaStore` |
| restore 解析失败 | 返回 `StoreError`。不编造 `run-terminal`。已解析但不认识的字面量仍是 `Unknown` |
| 队列 | 不与 session-loop 合并 |
| 时机 | P2 与 P3 之间不留下 `as_local_db` 过渡期。run crate 不干净就整段等待 |
