# 方案交叉评审报告：评审 05 - 防御性测试网与防腐探针体系审查

> **评审战役**：会话完整性与持久化收敛战役（`docs/session-integrity-repair/`）  
> **评审对象**：全量 7 份独立方案 `plan-01` 至 `plan-07`（核心聚焦 `plan-04-defensive-assertions.md` 与 `plan-07-architectural-guardrails.md`）  
> **比对一手源码与基建**：  
> - `crates/session-loop/src/loop/loop_tests.rs`、`crates/session-loop/src/loop/handlers/executing_tools.rs`、`crates/session-loop/src/exec_batch.rs`  
> - `crates/conex-db/src/tests.rs`、`crates/conex-db/src/messages.rs`、`crates/conex-db/src/import.rs`  
> - `scripts/check-db-write-bypass.mjs`、`scripts/check-guard-system.mjs`、`package.json`、`.husky/pre-commit`  
> - `FULL_CHECK_COMMANDS.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`、`AGENTS.md`  
> **纪律准则**：纯逻辑规划、零工期/同权裁决（严禁 P0/P1、人天或工期排期）、穿透根因杜绝假安全感与补丁、反过度设计零容忍。

---

## 目录

- [一、评审概述与总体架构裁决](#一评审概述与总体架构裁决)
- [二、核心维度一：防御性测试网立体性与中断盲区穷查](#二核心维度一防御性测试网立体性与中断盲区穷查)
  - [2.1 工具批次中断全场景拓扑的覆盖度与盲区剖析](#21-工具批次中断全场景拓扑的覆盖度与盲区剖析)
  - [2.2 Provider 导线序列化守门断言网的合理性与架构冲突](#22-provider-导线序列化守门断言网的合理性与架构冲突)
  - [2.3 数据库全量清空（DELETE）负向拦截断言的真实性审查](#23-数据库全量清空delete负向拦截断言的真实性审查)
- [三、核心维度二：静态防腐探针体系刚性与长效性审查](#三核心维度二静态防腐探针体系刚性与长效性审查)
  - [3.1 规划探针的白名单收敛陷阱与自相矛盾 Bug](#31-规划探针的白名单收敛陷阱与自相矛盾-bug)
  - [3.2 形式主义探针、伪 AST 解析与“纸面绿灯”漏洞](#32-形式主义探针伪-ast-解析与纸面绿灯漏洞)
  - [3.3 工程流水线接入现状断层与五元契约治理](#33-工程流水线接入现状断层与五元契约治理)
- [四、核心维度三：反过度设计红线与架构净收敛审查](#四核心维度三反过度设计红线与架构净收敛审查)
  - [4.1 对照《反过度设计硬性红线指南 v2.0》逐项排查](#41-对照反过度设计硬性红线指南-v20逐项排查)
  - [4.2 坏测试与历史妥协断言清理清退审查](#42-坏测试与历史妥协断言清理清退审查)
- [五、全量 7 份方案测试网与探针规划横向交叉比对矩阵](#五全量-7-份方案测试网与探针规划横向交叉比对矩阵)
- [六、整改与定稿统合裁决指南](#六整改与定稿统合裁决指南)

---

## 一、评审概述与总体架构裁决

本评审聚焦会话完整性战役的“免疫系统”——**防御性测试网**与**静态防腐探针体系**。在现代复杂智能体架构中，测试与门禁绝非辅助装饰，而是锁定系统架构契约、防止逻辑退避与腐化的刚性法律。

经过对全量 7 份独立方案的横向交叉检视，并对照一手源码及工程流水线现场实测，形成如下总体架构裁决：

### 1.1 总体裁决评估：黄色警告（通过但须重大整改）

```
┌────────────────────────────────────────────────────────────────────────┐
│                         评审 05 总体裁决结果                           │
├──────────────────────┬──────────────────────┬──────────────────────────┤
│ 维度                 │ 判定状态             │ 核心病灶                 │
├──────────────────────┼──────────────────────┼──────────────────────────┤
│ 1. 测试网立体性      │ ⚠️ 存在致命断层      │ 遗漏流式打断、捏造 Tracer│
│ 2. 探针体系刚性      │ ⚠️ 存在形式主义与Bug │ 正则自锁、伪 AST、漏掉写 │
│ 3. 反过度设计红线    │ ⚠️ 存在侵入式过度设计│ DB 挂钩子、序列化盲目 Panic │
└──────────────────────┴──────────────────────┴──────────────────────────┘
```

1. **测试网建设（以 `plan-04` 为代表）方向可嘉，但底层断言存在“纸面造假”与关键盲区**：
   - `plan-04` 正确识别了工具成对性断言与数据库增量化断言的重要性；
   - **致命漏洞**：在编写数据库负向拦截测试时，凭空捏造了生产代码中根本不存在的 `db.set_sql_tracer` API（`plan-04:345`），未通过真实 SQLite 机制进行物证检验；且测试用例遗漏了“流式输出中途被 Abort（`streaming.rs`）”以及“冷启动恢复时无事件终态（无 tool-end）”的悬挂自愈验证。
2. **静态防腐探针体系（以 `plan-07` 为代表）逻辑存在明显漏洞与形式主义倾向**：
   - **自相矛盾的正则 Bug**：`plan-07:165` 设计的截断白名单正则 `seq\s*>\s*\S+`（严格大于），与自身生产代码改造中采用的 `seq >= ?2`（大于等于，`plan-07:201`）直接冲突，探针一跑就会误杀自己的生产代码；
   - **假闭环与写旁路漏检**：`plan-07` 宣称清退 `check-db-write-bypass.mjs` 白名单，却遗漏了真实存在的 `import.rs`（持锁事务全量写）与 `imported.rs`，若照搬方案落地，探针将立即在本地和 CI 爆出 10+ 违规；
   - **形式主义伪探针**：`check-tool-pairing-invariants.mjs` 试图用 Node.js 正则做 Rust 控制流分析，并硬编码检查汉字日志 `"只上报不修正"` 与函数名是否存在，属于典型的脆弱“贴纸型门禁”，极易被语义绕过。
3. **架构冲突与过度设计隐患**：
   - `plan-04` 主张在 Provider 序列化入口通过 `panic!` 强阻断（`build_anthropic.rs`），而 `plan-06` 主张在序列化层就地静默合成补齐 `(interrupted)`，二者存在严重架构冲突；
   - 向 `LocalDb` 核心结构侵入测试专用的动态跟踪函数，违反了《反过度设计硬性红线指南 v2.0》禁令 3 与单机简洁架构原则。

---

## 二、核心维度一：防御性测试网立体性与中断盲区穷查

### 2.1 工具批次中断全场景拓扑的覆盖度与盲区剖析

`plan-04` §2.1 尝试将工具执行中断划分为 5 个场景（前置取消、审批等待/超时、运行中并发打断、单项执行超时、兄弟级联取消）。该拓扑具有一定的完备性，但深入 `session-loop` 状态转移一手代码后，发现其遗漏了两个关键的中断断面：

#### 盲区 1：流式阶段打断伴随工具调用的处理黑洞（Streaming Abort Blind Spot）
- **一手源码断裂面**：[`crates/session-loop/src/loop/handlers/streaming.rs:271-278`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/streaming.rs#L271-L278)
  ```rust
  if aborted || consumed.stop_reason() == Some(StopReason::Abort) {
      return streaming_aborted(state);
  }
  ```
- **盲区剖析**：
  在大模型流式输出过程中，模型可能已经吐出了前半段 `tool_use` 块，甚至完整的多个 `tool_use`，并已经被 `state.conversation` 暂存。此时用户点击 Stop，状态机在 `streaming.rs` 直接调用 `streaming_aborted(state)` 并将决策置为 `EndDecision::aborted(state)`，直接流向 `turn-complete` 甚至直接结束退出。
  **`executing_tools.rs` 根本没有机会被调用！**
  `plan-04` 的全部测试（如 `test_orphan_prevention_on_preflight_abort`）均建立在“已经处于 `ExecutingTools` 状态且调用其 `handle` 函数”的前提下。对于在 `Streaming` 阶段即被中止、留下孤儿工具调用的场景，`plan-04` 没有任何测试用例覆盖。该漏洞在 `plan-01` §4 第 5 项被提及，但在 `plan-04` 的测试套件中彻底沦为盲区。

#### 盲区 2：审批拒绝（User Deny）引发兄弟级联取消的断言缺失
- **一手源码断裂面**：[`crates/session-loop/src/exec_batch.rs:388-403`](file:///c:/Software/conex/crates/session-loop/src/exec_batch.rs#L388-L403)
- **盲区剖析**：
  当一个批次包含 3 个工具（`[call_1, call_2, call_3]`），且策略配置为 `FailStrategy::CancelSiblings` 时：
  - 用户审批工具 1 时显式点击“拒绝（Deny）”；
  - 工具 1 应当被标记为 `ToolErrorKind::UserDenied`；
  - 剩余的工具 2 和工具 3 尚未进入审批，应当被标记为 `ToolErrorKind::Cancelled`（由于兄弟失败被级联取消）；
  - `plan-04` 仅在 I8 不变量类型定义中列出了 `ToolErrorKind::UserDenied`，但在其测试用例矩阵中，**完全没有编写“审批拒绝导致未审批兄弟工具级联取消，且各自产出正确成对结果”的集成测试**。

#### 盲区 3：冷启动恢复期“有 tool-start 无 tool-end”的自愈测试缺失
- **一手源码对比**：[`crates/orchestrator/src/restore_manager.rs:178-195`](file:///c:/Software/conex/crates/orchestrator/src/restore_manager.rs#L178-L195) vs `plan-04:388-392`
- **盲区剖析**：
  `plan-04` 宣称设计了“多源数据冲突下 Events 单向强制收敛恢复测试（`test_unidirectional_events_ssot_recovery_convergence`）”，但查看其代码设计（lines 388–392）：
  ```rust
  let events_authoritative = vec![
      (1, "user-message", ...),
      (2, "assistant-message", ...),
      (3, "tool-result", json!({"id": "tool-result-call_99", ...})), // 已经在 events 表里写全了！
  ];
  ```
  该测试输入中，`events` 表内**天然已经包含**完整的 `tool-result` 事件！这根本没有测试“由于进程崩溃，`events` 表里只有 `assistant-message` 或只有 `tool-start`，而完全缺失 `tool-end`”的极端故障。真正的考验在于：当数据库只有半截事件时，恢复管理器是否能够合成确定性的 `ToolOutcomeUnknown` 补偿事件将其闭合？`plan-04` 的测试在这方面是完全脱靶的伪测试，反而是 `plan-03` 的 `test_orphaned_tool_call_healing` 抓住了要害。

---

### 2.2 Provider 导线序列化守门断言网的合理性与架构冲突

在 `plan-04` §3 与 `plan-06` §4.4 中，两个方案在 Provider 协议序列化层的守门机制上产生了致命冲突：

```
                    ┌──────────────────────────────────────────────┐
                    │       Provider 导线序列化守门设计分歧        │
                    └──────────────────────┬───────────────────────┘
                                           │
                 ┌─────────────────────────┴─────────────────────────┐
                 ▼                                                   ▼
      【方案 04 路径】：硬阻断                               【方案 06 路径】：隐式就地修补
 ┌───────────────────────────────────┐               ┌───────────────────────────────────┐
 │ build_anthropic 检测到未配对 tool │               │ build_anthropic 检测到未配对 tool │
 │ 直接 panic! 并在测试中 should_panic│               │ 就地追加 (interrupted) user 块    │
 └─────────────────┬─────────────────┘               └─────────────────┬─────────────────┘
                   │                                                   │
                   ▼                                                   ▼
       ❌ 缺陷：生产环境直接崩溃进程                       ❌ 缺陷：隐蔽掩盖上游状态机漏洞
```

#### 2.2.1 `plan-04` 滥用 `panic!` 的生产环境高危缺陷
- `plan-04:203, 225, 237` 在 `assert_wire_messages_integrity` 函数中使用了硬编码 `panic!`：
  ```rust
  panic!("FATAL [WireGatekeeper]: 连续出现 Assistant 消息，但前序工具调用未闭环！");
  ```
- **危害**：虽然 `plan-04:193` 口头声称“在 debug_assertions 中拦截，在 release 中执行自愈”，但其给出的真实代码实现（lines 194–242）**根本没有任何 `#[cfg(debug_assertions)]` 宏分叉或 Result 结构化错误返回**。若原样照搬，一旦有存量历史脏数据进入该函数，将导致 Tauri 整个后台执行线程直接发生不可恢复的 Panic，造成应用崩溃。
- **正规做法**：协议序列化层（`build_anthropic.rs` / `messages.rs`）必须返回强类型结构化错误 `Result<Value, RequestBuildError::UnpairedToolCalls { ... }>`，严禁在生产编译分支触发 panic。

#### 2.2.2 `plan-06` 隐式就地修补导致的“掩耳盗铃”漏洞
- `plan-06:575-577` 规划：如果发现孤儿工具，在导线序列化层“自动就地构造一个 user 消息并填入缺失的 tool_result 块”。
- **架构危害**：这属于典型的“底层漏水，表层涂胶水”。如果在序列化层神不知鬼不觉地把孤儿工具补齐发给了 Anthropic，那么虽然网络请求没有报 400，但核心状态机 `session-loop` 和数据库 `conex-db` 内部残留的孤儿数据依然存在，UI 依然处于悬挂或状态撕裂状态。
- **统合裁决**：
  - **核心层（Session Loop & Restore Manager）**：负责 100% 合成与落盘，确保进入 `state.conversation` 的数据天然具备双向闭包（I7 不变量）；
  - **导线层（Provider Wire Gatekeeper）**：充当**物理校验防火墙**——在 `debug_assertions` / 单元测试中执行刚性校验；在 Release 中返回 `Err(RequestBuildError)` 拦截网络出站，并将错误反馈给会话管理器执行重投影，绝不允许随意静默篡改消息流。

#### 2.2.3 兼容协议（OpenAI / DeepSeek）成对断言网缺失
- `plan-04` 仅在 `build_anthropic_tests.rs` 中编写了测试，但在 OpenAI / DeepSeek 使用的 `to_chat_messages_with_compat`（[`crates/agent-provider/src/request/messages.rs`](file:///c:/Software/conex/crates/agent-provider/src/request/messages.rs)）中，完全没有设计断言代码。
- OpenAI 协议对 `role: "assistant"` 中的 `tool_calls` 要求其后紧随的一批消息必须角色为 `tool`，且 `tool_call_id` 严格覆盖。测试网若仅测试 Anthropic，等于对多 Provider 架构敞开了 50% 的协议漏洞。

---

### 2.3 数据库全量清空（DELETE）负向拦截断言的真实性审查

在审查 `plan-04` §4.1 的负向断言测试设计时，发现了本战役中最严重的**虚假测试设计（Phantom Mock）**：

#### 2.3.1 凭空捏造的 `db.set_sql_tracer` API
- `plan-04:345-347` 编写的代码：
  ```rust
  let sql_log = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
  let sql_log_clone = Arc::clone(&sql_log);
  
  db.set_sql_tracer(Box::new(move |sql| {
      sql_log_clone.lock().unwrap().push(sql.to_uppercase());
  }));
  ```
- **现场实证比对**：
  1. 检索 `crates/conex-db/src/` 全文，**根本没有任何 `set_sql_tracer`、`sql_tracer` 或类似接口**；
  2. 查阅 [`crates/conex-db/Cargo.toml`](file:///c:/Software/conex/crates/conex-db/Cargo.toml)：`rusqlite = { workspace = true }`，并没有开启 `trace` 特性；
  3. `LocalDb` 的底层核心连接为 `Arc<Mutex<Connection>>`，结构体没有任何挂载 trace 回调的字段；
  4. 该测试代码纯属作者主观臆造的“伪代码”，无法通过编译。

#### 2.3.2 真正优雅、零侵入的 SQLite 原生负向断言方案
要对 `session_messages` 表的破坏性 `DELETE` 进行 100% 物理拦截与负向断言，根本无须在生产 `LocalDb` 结构中侵入任何动态 trait 回调或锁开销。应采用 SQLite 原生支持的 **触发器防护网（Trigger Guard）**：

```rust
/// 生产级无侵入负向断言：利用 SQLite 原生触发器拦截破坏性清空
#[test]
fn negative_assertion_no_blanket_delete_via_sqlite_trigger() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    // 在测试用内存数据库中安装刚性自爆触发器：
    // 一旦触发无 seq 界限的 DELETE FROM session_messages，直接由 SQLite 内核抛出致命异常！
    db.conn().lock().unwrap().execute(
        "CREATE TRIGGER enforce_no_blanket_delete
         BEFORE DELETE ON session_messages
         WHEN OLD.seq IS NOT NULL
         BEGIN
             SELECT RAISE(ABORT, 'FATAL: Blanket DELETE on session_messages is strictly forbidden by SSOT invariant!');
         END;",
        [],
    ).unwrap();

    // 无论执行初次保存还是版本演进，底层若敢执行 DELETE FROM session_messages WHERE session_id = ?，
    // SQLite 内核将直接中止并返回 DbFailureKind，测试立刻红灯爆炸！
    let msg1 = sample_message("m1", "user", 1);
    assert!(db.save_session_body_versioned("s1", &[msg1], Some(1)).is_ok());
    
    let msg2 = sample_message("m2", "assistant", 2);
    assert!(db.save_session_body_versioned("s1", &[msg1, msg2], Some(2)).is_ok());
}
```
**收益**：
1. 0 生产代码侵入，不需要在 `LocalDb` 加任何测试专用字段；
2. 物理由 SQLite C 引擎原生拦截，真实有效，杜绝字符串模拟判断。

---

## 三、核心维度二：静态防腐探针体系刚性与长效性审查

### 3.1 规划探针的白名单收敛陷阱与自相矛盾 Bug

#### 3.1.1 `plan-07` 正则自相矛盾：自己写探针拦死自己的生产代码
- `plan-07:164-165` 在 `check-session-message-upsert.mjs` 中定义了唯一合法的截断正则：
  ```javascript
  // 允许的唯一合法尾部截断（必须携带 seq 上界，用于严格的时间线撤回）
  const BOUNDED_TRUNCATE_RE =
    /DELETE\s+FROM\s+session_messages\s+WHERE\s+session_id\s*=\s*\S+\s+AND\s+seq\s*>\s*\S+/i;
  ```
- 但在 `plan-07:201` 给出的真实 Rust 改造示例中：
  ```rust
  conn.execute(
      "DELETE FROM session_messages WHERE session_id = ?1 AND seq >= ?2",
      rusqlite::params![session_id, new_len as i64],
  )?;
  ```
- **矛盾实证**：
  注意运算符！Rust 代码使用的是 `seq >= ?2`（大于等于），而探针正则写的是 `seq\s*>\s*\S+`（严格大于，不包含等号）。
  **后果**：该脚本一旦上线运行，会把方案自身规划的 `AND seq >= ?2` 判定为非法清空，直接 Exit 1 导致 CI 门禁永久瘫痪！
- **修复断言**：正则必须修正为允许 `>=`：
  `/DELETE\s+FROM\s+session_messages\s+WHERE\s+session_id\s*=\s*\S+\s+AND\s+seq\s*>=\s*\S+/i`。

#### 3.1.2 `check-db-write-bypass.mjs` 升级遗漏真实写路径，白名单清退虚假闭环
- `plan-07:244-248` 规定：升级后的探针白名单只保留迁移和测试文件，清空所有业务文件。
- **现实代码实证**：
  查阅 [`crates/conex-db/src/import.rs:35-42`](file:///c:/Software/conex/crates/conex-db/src/import.rs#L35-L42) 与 [`crates/conex-db/src/imported.rs`](file:///c:/Software/conex/crates/conex-db/src/imported.rs)：
  ```rust
  let mut conn = self.conn.lock().map_err(...)?;
  let tx = conn.transaction().map_err(...)?;
  // 内部大量执行 tx.execute("INSERT INTO ...") / tx.execute("DELETE FROM ...")
  ```
  `import.rs` 承担从 LocalStorage 导入历史数据的职责，其内部持有 `conn.lock()` 并开启了事务执行写操作。
  在现行 `check-db-write-bypass.mjs:29-44` 中，`import.rs` 和 `imported.rs` 在 `EXEMPT_FILES` 中，`import_from_localstorage` 在 `EXEMPT_FNS` 中。
- **缺陷**：`plan-07` 在第三节的清理明细中（lines 238–242）**完全没有对 `import.rs` 提出改道 `write_blocking` 的具体方案**，却在白名单清册中擅自删除了对它的豁免。
- **后果**：只要运行升级后的探针，立即会因 `import.rs` 报出未豁免的 `conn.lock()` 写旁路，导致门禁失败。方案必须显式明确：要么将 `import.rs` 纳入 `write_blocking` 改造，要么在探针中对批量初始化路径给予合规且有限的白名单约束。

---

### 3.2 形式主义探针、伪 AST 解析与“纸面绿灯”漏洞

`plan-07` §3.2 设计的 `check-tool-pairing-invariants.mjs` 存在典型的“形式主义门禁”通病：

#### 3.2.1 极其脆弱的正则与伪 AST 分支扫描
- `plan-07:216-220` 试图用 JS 正则从 `executing_tools.rs` 中提取 `return Ok(HandlerOutcome::end(...))` 分支，并检查是否调用了 `synthesize_cancelled_tool_results`。
- **致命弱点**：
  1. Rust 的控制流极为丰富（`?` 问号操作符短路、`match` 模式匹配、辅助宏、早期 `return` 等）；
  2. 只要开发者重构代码，把返回逻辑封装进一个私有辅助函数 `handle_abort_flow(state, end)?`，该 JS 脚本就会直接误报或被完全绕过；
  3. 这种“在 Node.js 里徒手解析 Rust 代码控制流”的做法极其业余且脆弱，维护成本极高。

#### 3.2.2 检查汉字日志字符串的“贴纸防腐”
- `plan-07:223-225` 规则：在 `restore_manager.rs` 中正则匹配字符串 `"只上报不修正"`、`"只上报不修"`。
- **形式主义实证**：
  如果后续开发者将日志改为 `"检测到终态冲突，跳过本轮同步"` 或改为英文 `"conflict reported without mutation"`，该探针就会瞬间判定为“合规通过”！这种仅靠匹配特定中文字符串来防腐的手段是纯粹的自我欺骗。

#### 3.2.3 仅检查函数名存在的“字面搜索”漏洞
- `plan-07:227-229` 规则：在 `invariants.rs` 中检测是否存在 `assert_tool_pairing_invariants` 字符串。
- **致命弱点**：
  函数存在并不等于函数被调用！开发者完全可以在 `invariants.rs` 声明一个空函数或未接线的函数，探针直接亮绿灯，而生产状态机依然没有任何不变量守卫。

---

### 3.3 工程流水线接入现状断层与五元契约治理

#### 3.3.1 现场审计实证：门禁系统自身的严重缺口
在当前仓库根目录真实执行 `node scripts/check-guard-system.mjs --list`，暴露出当前工程基建的严峻现实（见前置执行日志）：
```text
=== unwired_guard（未接入 husky/CI 且未豁免）: 23 ===
  check-db-write-bypass.mjs   [npm 脚本=(无 npm 脚本)]
  ... (共 23 个门禁处于脱网状态)

=== guide_capable_missing（无 --list 也无 --guide）: 44 ===
  check-db-write-bypass.mjs
  ... (共 44 个门禁不具备标准指引能力)

=== unreleased_guard（守卫资产未被 .gitignore 放行）: 4 ===
  scripts/check-db-write-bypass.mjs
  ... (现行 check-db-write-bypass.mjs 甚至无法被 git 跟踪！)
```

#### 3.3.2 刚性治理契约（纳入本评审裁决）
任何声称建立防腐探针的方案，必须在以下 4 个工程卡点完成闭环，杜绝产生“第 24 个脱网门禁”：
1. **解除 Git 屏蔽**：在 `.gitignore` 显式追加 `!scripts/<probe-name>.mjs`，断言 `git check-ignore -v` 零命中；
2. **五元诊断契约**：必须完整支持 `--list` 与 `--guide <metric>`，严禁只输出 `FAIL: X > 0`；
3. **调用闭环**：
   - 必须在 `package.json` 注册独立命令 `check:<name>`；
   - 必须挂入 `.husky/pre-commit`；
   - 必须登入 `FULL_CHECK_COMMANDS.md` 结构性检查表格；
4. **自审校验**：执行 `node scripts/check-guard-system.mjs`，断言新增探针不增加任何 `unwired_guard`、`guide_capable_missing`、`unreleased_guard` 计数。

---

## 四、核心维度三：反过度设计红线与架构净收敛审查

### 4.1 对照《反过度设计硬性红线指南 v2.0》逐项排查

依据根目录 [`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)，对所有方案进行逐条过筛：

| 禁令条款 | 涉及方案 | 审查事实与判决依据 | 合规结论 |
|:---|:---|:---|:---:|
| **禁令 3：严禁单机桌面引入分布式共识与 2PC** | `plan-02` / `plan-04` | 审查持久化与测试方案。`plan-02` 严格基于“单写者 Actor + SQLite WAL Group Commit + CAS 版本控制”，未引入分布式两阶段提交。但在 `plan-04` 中试图为 SQLite 引入动态全局 Tracer，有引入重度事务拦截层倾向，须予以制止。 | **整改后通过** |
| **禁令 7：上下文全链路可审计与单一真理源 (SSOT)** | `plan-01` / `plan-06` | `plan-06` 试图在 `build_anthropic.rs` 导线层直接静默合成 `(interrupted)` 消息注入上下文，这绕过了 `state.conversation` 与 `events` 表的留痕审计，违反了“单一真理源”原则；必须收敛至 `plan-01` 的核心循环主动合成。 | **红线违规，必须否决** |
| **禁令 10：严禁 6 阶段洋葱 Hook 链** | `plan-04` | 测试网方案未新增洋葱中间件，依托既有 `beforeExecute` 与 `onResult` 锚点完成状态核验，符合精简原则。 | **合规** |
| **禁令 11：严禁同进程微服务套娃与假解耦** | `plan-07` | `plan-07` 试图构建跨 Node.js 外部进程的 Rust 伪 AST 分析链，将简单的运行时单元测试外包给脆弱的外部正则脚本，构成了工具链层面的假解耦与套娃。 | **红线预警，予以精简** |

---

### 4.2 坏测试与历史妥协断言清理清退审查

在会话完整性战役中，**清理把缺陷当契约的“坏测试”与建立新测试同样重要**。经过一手代码排查，必须强制清退以下测试资产：

#### 4.2.1 彻底重构 `executing_tools_tests.rs:87-143`
- **代码现场**：[`crates/session-loop/src/loop/handlers/executing_tools_tests.rs:87-143`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/executing_tools_tests.rs#L87-L143)
  ```rust
  /// 同一 tool-call id 复用时消息 id 相同（已知冲突，F3-10 观察项）——本测试钉住现状形态
  #[test]
  fn tool_result_message_id_derivation_documented() {
      ...
      assert_eq!(
          tool_result_message(&ok).id,
          tool_result_message(&ClassifiedToolResult { id: "call_x".into(), ..ok }).id,
          "同 tool-call id 派生相同消息 id（F3-10 现状契约：冲突形态已知）"
      );
  }
  ```
- **审查裁决**：该测试明知相同 `tool_call_id` 派生相同消息 ID 会导致消息链 ID 冲突，却消极将其锁定为“已知形态”。必须在本次战役中**彻底删除该断言**，改为按调用序号消歧派生的单调唯一性断言。

#### 4.2.2 彻底重构 `crash_consistency.rs:1340-1426`
- **代码现场**：[`crates/orchestrator/tests/crash_consistency.rs:1340-1426`](file:///c:/Software/conex/crates/orchestrator/tests/crash_consistency.rs#L1340-L1426)
  ```rust
  // 不自动修正：runs 表状态保持打断结果（failed + daemon-restarted）
  assert_eq!(runs[0].status, RunStatus::Failed);
  assert_eq!(outcome.reconcile_conflicts.len(), 1);
  ```
- **审查裁决**：该测试是导致系统长期处于“表级脑裂、只上报不修正”的罪魁祸首。必须彻底重写断言，断言恢复后 `runs` 表状态已被物理纠正为与 `events` 表严格一致（`RunStatus::Completed`），脑裂数清零。

#### 4.2.3 前端截断守卫测试的陪葬删除纪律（`plan-05` 对照）
- `plan-05:74-75` 提出删除前端 [`sessionRustDbTruncationGuard.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionRustDbTruncationGuard.test.ts)（213 行）与 `sessionAgentsTruncation.test.ts`（260 行）。
- **审查依据**：遵循 `AGENTS.md` §9“测试资产保护铁律”与 `docs/agent-roles/review/review.md` §7。
- **裁决**：前端这两个测试的存在理由是防御后端的 `DELETE FROM session_messages` 全量清空风险。**只有在后端 Rust 层 `tests_messages_incremental.rs` 与 SQLite 原生触发器负向断言完全跑通生效后**，才允许对前端这两个测试执行陪葬删除；严禁在后端断言尚未落地前提前删除前端防护测试。

---

## 五、全量 7 份方案测试网与探针规划横向交叉比对矩阵

以下矩阵针对全部 7 份方案在测试网与防腐层面的设计做出纯逻辑横向对齐：

| 评估维度 | Plan-01 | Plan-02 | Plan-03 | Plan-04 (核心) | Plan-05 | Plan-06 | Plan-07 (核心) |
|:---|:---|:---|:---|:---|:---|:---|:---|
| **中断场景拓扑覆盖** | 覆盖执行期与退出阶段 | 仅涉及存储层 | 关注恢复期中断 | 覆盖 5 场景，但**遗漏流式打断与拒绝级联** | 梳理清理点 | 关注端到端大链路 | 覆盖 executing_tools 退出 |
| **Provider 序列化守门** | 提及防 400 | 无涉及 | 无涉及 | **设计了守门器，但滥用 panic!** | 无涉及 | **设计就地隐式修补，存在掩盖风险** | 运行时纯函数校验 |
| **DELETE 负向断言** | 无独立断言 | 提议字符串扫描 | 无涉及 | **设计了负向测试，但捏造 sql_tracer** | 提议静态正则 | 无涉及 | **提议静态正则，但存在 >= 运算符 Bug** |
| **静态防腐探针体系** | 无独立探针 | 无独立探针 | 无独立探针 | 依托测试网 | 清退门禁豁免 | 依托集成测试 | **规划 3 大探针，但存在伪 AST 形式主义** |
| **坏测试/妥协代码清理** | 清理魔法值 | 提议重构 CAS | **精准定位 crash 矛盾测试** | **精准定位 id 派生冲突测试** | **系统列出 5 个废弃测试** | 无涉及 | 清理豁免名单 |
| **工程管网接线完整性** | 未涉及 | 未涉及 | 未涉及 | 未涉及 | 强调全量命令 | 未涉及 | **详尽规划 package/husky/CI 接线** |
| **综合评分与采纳建议** | 部分采纳（合成逻辑） | 采纳（介质测试） | 采纳（恢复测试重写） | **大幅整改后采纳断言** | 采纳（严格序陪葬） | 废弃（否决序列化静默修补） | **大幅重构探针实现后采纳** |

---

## 六、整改与定稿统合裁决指南

为保证后续阶段（总方案定稿与分维详案落地）具备刚性、可执行的真理基准，特下达如下纯逻辑统合裁决：

### 裁决 1：统一工具成对性断言网拓扑（补齐流式与拒绝盲区）
1. 在 `crates/session-loop/src/loop/handlers/executing_tools_tests.rs` 与 `streaming_tests.rs` 中，必须补齐两套硬断言：
   - **用例 A**：验证在 `Streaming` 流式输出包含部分/全部 `ToolCall` 时触发 `abort`，收敛后 `conversation` 依然保持 100% 工具成对；
   - **用例 B**：验证在用户对批次中某一项点击 `Deny` 拒绝时，未决工具按策略级联产生包含原始 ID 的 `Cancelled` 结果；
2. 彻底废除 `exec_batch.rs:188-191` 中的空 ID 兜底，断言所有结果 `id` 非空且与入参严格一致。

### 裁决 2：收敛 Provider 序列化守门策略（坚决废弃 Panic 与静默修补）
1. **否决 `plan-04` 的 `panic!` 机制**：将 `assert_wire_messages_integrity` 改造为返回 `Result<(), WireIntegrityError>` 的纯校验器；
2. **否决 `plan-06` 的序列化层隐式合成**：导线层只做保真序列化与防御拦截，不擅自向消息流注入伪造的 `tool_result`；
3. 在 `crates/agent-provider/src/request/` 中同时针对 Anthropic 与 OpenAI 兼容轨补齐未成对工具拦截测试。

### 裁决 3：重塑数据库 DELETE 负向拦截（废弃 Tracer，改用 SQLite 原生触发器）
1. 坚决废除向 `LocalDb` 侵入 `set_sql_tracer` 的过度设计方案；
2. 在 `crates/conex-db/src/tests.rs` 中，统一使用测试期注入 `CREATE TRIGGER enforce_no_blanket_delete` 的方式实施物理负向断言；
3. 结合物理落盘断言：单条追加写消息时，断言 SQLite 物理文件 `changes()` 恒等于 1。

### 裁决 4：重构长效防腐探针脚本体系（消除形式主义与自相矛盾 Bug）
1. **修正 `check-session-message-upsert.mjs`**：
   - 正则放行 `seq >= ?`，与生产代码保持绝对一致；
   - 保持全仓零豁免；
2. **重构 `check-tool-pairing-invariants.mjs`**：
   - **废除脆弱的 JS 正则 Rust 控制流分析**与汉字日志匹配；
   - 改为**轻量且刚性的结构性探针**：
     - 检查 `invariants.rs` 中 I7/I8 运行时校验函数是否被 `loop_runner.rs` 或 `turn_complete.rs` 真实调用；
     - 检查 `restore_manager.rs` 中是否存在任何返回包含 `without_mutation` 或未被写回覆盖的逻辑分支；
3. **闭环升级 `check-db-write-bypass.mjs`**：
   - 将 `import.rs` 纳入方案考量，明确其要么改道 `write_blocking`，要么作为专有数据迁移函数保留在极简、严格的白名单内；
   - 彻底清退 `cas_gc.rs`（22 处直接持锁写）与 `cleanup_orphan_sessions` 的特权豁免；
4. **全面履行工程管网四要素**：
   - 探针脚本支持 `--list` 与 `--guide`；
   - `.gitignore` 显式放行；
   - 接入 `package.json` 与 `.husky/pre-commit`；
   - 接入 `FULL_CHECK_COMMANDS.md` 并通过 `check-guard-system.mjs` 零缺陷自审。

### 裁决 5：严格按依赖序执行坏测试清退
1. 优先在 `executing_tools_tests.rs` 建立出现序消歧断言，随即删除 `tool_result_message_id_derivation_documented`；
2. 优先在 `crash_consistency.rs` 落地强制收敛断言，随即删除容忍脑裂的消极测试；
3. 在数据库增量化断言与触发器防护完全绿灯后，再行清退前端的 `sessionRustDbTruncationGuard.test.ts`。
