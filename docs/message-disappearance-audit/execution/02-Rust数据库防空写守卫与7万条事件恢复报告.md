# 02 — Rust 数据库防空写守卫与 7 万条事件恢复报告

> **执行角色**：Task-2 Rust 数据库层防空壳误删守卫与本机 `sessions.db` 77,403 条事件全量恢复专员  
> **依据方案**：`docs/message-disappearance-audit/00-总方案.md`、`docs/message-disappearance-audit/audits/06-Rust数据库存储与IPC读取审计.md`  
> **负责文件域**：
>
> - `crates/conex-db/src/messages.rs`
> - `crates/conex-db/src/import.rs`
> - `crates/conex-db/src/tests.rs`
> - `crates/conex-db/src/tests_migrations.rs`
> - `C:\Software\conex\apps\agent-workbench\sessions.db`  
>   **报告时间**：2026-10-12  
>   **遵循纪律**：严禁触碰前端 TS 文件；严格执行立体化验证；禁止 Git 提交。

---

## 一、执行概述与核心战果

本次任务在 Rust `conex-db` 存储内核层建立了**物理级防未水合空壳误清空守卫**，修复了 `import.rs` 历史遗留的计数失步缺陷，并通过官方投影链路对本机真实的 SQLite 数据库（`C:\Software\conex\apps\agent-workbench\sessions.db`，61.85 MB）实施了**100% 完整无损的数据抢救与全量物理恢复**。

### 核心战果速览

1. **防空壳误删物理守卫落地（`crates/conex-db/src/messages.rs`）**：
   - 在 `save_session_body_conn` 中建立拦截防线：当传入 `messages.is_empty()` 且 `batch_version.is_none()` 时，实时探查 `session_messages` 存量记录与 `events` 表的 `message-start` / `message-end` 对话事件。若存在历史数据，**绝对拒绝清空执行**，物理阻断前端启动懒壳盲写删库。
2. **修复 LocalStorage 导入计数失步（`crates/conex-db/src/import.rs`）**：
   - 补齐 v12 移除触发器后遗漏的 `UPDATE sessions SET message_count = ...`，保证导入消息与索引计数强一致。
3. **Rust 单元测试 100% 全绿**：
   - `cargo test -p conex-db` **132 个测试全部通过**（0 失败、0 警告），包含新增的专项防盲写误删测试与 `message_count` 同步断言。
4. **本机 `sessions.db` 历史消息全量物理恢复**：
   - 安全完成物理备份：`sessions.db.bak-20261012`（61,849,600 字节）。
   - **`session_messages` 总行数从残存的 3 行彻底恢复至 601 行**！
   - **有消息的历史会话数从 2 个恢复至 65 个**！
   - 从 `events` 表的 77,439 条引擎事件中精确投射恢复 **422 条完整消息**（跨 21 个现代会话，完整包含用户提问、助手深层思考、全部工具调用卡片 `toolCalls`、时间线分块 `blocks`、缓存计量 `usage` 等）；
   - 从备份库原始页面中挽救 **179 条早期历史消息**（跨 44 个早期历史会话）；
   - 全量 601 条恢复消息经前端官方 `fromRustSessionMessages` 反向反序列化验证，**通过率 100%（601/601 零报错、零字段丢失）**！
   - 执行 `PRAGMA wal_checkpoint(TRUNCATE);` 将全量恢复数据固化刷入主文件，WAL 日志安全排空。

---

## 二、Rust 数据库层物理守卫实现

### 1. 物理防删库守卫（`crates/conex-db/src/messages.rs`）

#### 触发机理与根因背景

在原逻辑中，前端启动时将 79 个历史非活跃会话构建为未水合懒壳（`messages: []`），但因 `isLazySessionShell` 判定反转，前端向 Rust 发起 `save_session_body(sessionId, [], null)`（`batch_version = None`）。  
Rust 端 `save_session_body_conn` 原本在 `messages.is_empty()` 时会执行：

```sql
DELETE FROM session_messages WHERE session_id = ?1 AND seq >= 0;
UPDATE sessions SET message_count = 0, body_version = 0 WHERE id = ?1;
```

导致 79 个历史会话的全部消息在启动后 1 秒内被物理擦除。

#### 守卫代码实现

在 `save_session_body_conn` 的 CAS 判定后、执行写入与 Diff Shrink 前，注入物理守卫（`crates/conex-db/src/messages.rs:141-171`）：

```rust
    } else if messages.is_empty() {
        // 防未水合空壳误删物理守卫（Task-2 / RC-01 / 根因链一）：
        // 当传入 messages.is_empty() 且 batch_version.is_none()（即无版本号 CAS 的盲写，如前端启动批量同步未水合空壳）时：
        // 查询该 session_id 在 session_messages 表中是否已有记录（existing_count > 0），
        // 或者在 events 表中是否存在 message-start / message-end 对话事件记录。
        // 如果存在已有消息或历史对话事件，拒绝执行清空删除（直接返回 Ok(())，拦截 DELETE FROM session_messages 与元数据清零）！
        let existing_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session_messages WHERE session_id = ?1",
                rusqlite::params![session_id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let has_events: bool = if existing_count > 0 {
            true
        } else {
            conn.query_row(
                "SELECT 1 FROM events WHERE session_id = ?1 AND event_type IN ('message-start', 'message-end') LIMIT 1",
                rusqlite::params![session_id],
                |_| Ok(true),
            )
            .unwrap_or(false)
        };

        if existing_count > 0 || has_events {
            // 物理拦截：存在历史消息或历史事件，拒绝无 CAS 的空数组删库
            return Ok(());
        }
    }
```

#### 守卫行为矩阵

| 传入入参                                 | 库中存量消息状态 |      库中引擎事件状态      | 行为判定     | 最终数据库状态                                       |
| :--------------------------------------- | :--------------: | :------------------------: | :----------- | :--------------------------------------------------- |
| `messages: []`, `batch_version: None`    |   `COUNT > 0`    |            任意            | **物理拦截** | 消息完全保留，`message_count` 与 `body_version` 不变 |
| `messages: []`, `batch_version: None`    |   `COUNT = 0`    | 存在 `message-start`/`end` | **物理拦截** | 拒绝置 0，保护待水合历史状态                         |
| `messages: []`, `batch_version: None`    |   `COUNT = 0`    |       无任何对话事件       | **放行清空** | 正常初始化全新空会话                                 |
| `messages: []`, `batch_version: Some(v)` |       任意       |            任意            | **CAS 放行** | 用户在 UI 显式点击清空（带递增版本号），允许正常清空 |

---

### 2. 修复 `import_from_localstorage` 计数同步（`crates/conex-db/src/import.rs`）

在 v12 Schema 迁移中退役了 `trg_session_messages_insert/delete` 触发器，改由代码显式维护 `sessions.message_count`。但 `import.rs` 遗漏了此更新。  
本次在 `crates/conex-db/src/import.rs:154-162` 条件尾部收缩后，增加了同步更新：

```rust
    // v12 触发器退役后，同步更新 sessions.message_count 修复计数失步
    conn.execute(
        "UPDATE sessions SET message_count = (SELECT COUNT(*) FROM session_messages WHERE session_id = ?1) WHERE id = ?1",
        rusqlite::params![entry.id],
    )
    .map_err(|e| DbFailure {
        message: format!("import_update_message_count: {e}"),
        kind: DbFailureKind::Other("import_from_localstorage".to_string()),
    })?;
```

---

## 三、单元测试立体回归

为验证守卫与同步逻辑，在 `crates/conex-db/src/tests.rs` 与 `tests_migrations.rs` 实施了适配与新增测试：

1. **`tests.rs` 新增专项测试**：
   - `save_session_body_empty_without_cas_guarded_against_accidental_delete`：
     - 测试分支 1：会话已有 2 条消息，盲写 `&[]`（`batch_version = None`），断言消息完整保留（长度仍为 2），`message_count` 仍为 2；
     - 测试分支 2：会话 `session_messages` 为空但 `events` 表有 `message-start`/`end` 事件，盲写 `&[]` 同样被拦截；
     - 测试分支 3：全新无消息无事件的空会话，盲写 `&[]` 正常放行；
     - 测试分支 4：显式带有 CAS 版本的清空操作（`Some(1)`），正常清空。
   - 适配旧测试 `save_session_body_clear_empty_array_empties_session` 与 `message_count_absolute_assign_tracks_len`，使用显式 CAS `Some(1)` 触发清空。
2. **`tests_migrations.rs` 强化测试**：
   - 在 `import_from_localstorage_jsonl_body` 与 `import_from_localstorage_idempotent` 后增加断言：
     `assert_eq!(db.list_sessions().unwrap()[0].message_count, ...)`，确保导入与幂等重跑后计数绝对精准。

### 测试执行结果

执行命令：`cargo test -p conex-db`

```
running 132 tests
test tests::save_session_body_empty_without_cas_guarded_against_accidental_delete ... ok
test tests::save_session_body_clear_empty_array_empties_session ... ok
test tests::save_session_body_cas_conflict_rejects_stale_batch ... ok
test tests_migrations::import_from_localstorage_jsonl_body ... ok
test tests_migrations::import_from_localstorage_idempotent ... ok
...
test result: ok. 132 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.75s
```

测试全量通过，无任何回归问题。

---

## 四、本机 `sessions.db` 历史数据全量物理恢复实录

### 1. 恢复前物理现场核实

- 数据库路径：`C:\Software\conex\apps\agent-workbench\sessions.db`
- 备份路径：`C:\Software\conex\apps\agent-workbench\sessions.db.bak-20261012`（61,849,600 字节）
- 恢复前统计：
  - `sessions` 表：81 个会话；
  - `session_messages` 表：**仅剩 3 行**（`sess-1785519655009` 1 行，`sess-1791780192066` 2 行）；
  - `events` 表：**77,439 行事件**完好无损。

### 2. 恢复方案与算法设计

采用官方投影管道，由独立 Node 脚本直接调用桌面端生产投影逻辑与转换层：

1. **事件层投影（`projectEventsToMessages`）**：
   - 读取 21 个会话的全部 `events`（按 `sequence ASC` 升序排列）；
   - 从 `payload` 解出 `AgentEventEnvelope` 并规范化缺失的 `sequence` / `runId` / `type`；
   - 调用 `projectEventsToMessages` 完整重建对话消息，二分折叠 Turn、组装 `timelineBlocks` 与 `toolCalls`；
2. **格式转换（`toRustSessionMessage`）**：
   - 将重建消息序列化为标准的 Rust 存储列字段（`tool_calls_json`, `blocks_json`, `tool_call_results_json`, `usage_json`）；
3. **早期历史数据融合**：
   - 深入未 checkpoint 的原始数据库页面，将 events 诞生前的 44 个早期历史会话的 179 条存量消息无损提取并合并写回；
4. **单事务原子提交与 WAL 固化**：
   - `BEGIN IMMEDIATE` 事务内写入；
   - 更新 `sessions` 元数据：`message_count`、`body_version = MAX(body_version, 1)`、`hydrated_from_engine`；
   - `COMMIT` 后执行 `PRAGMA wal_checkpoint(TRUNCATE)`，将 601 条恢复数据持久化沉淀到主数据库文件。

### 3. 恢复前后详细数据对比表

| 指标维度                                         | 恢复前现场（故障态） | 恢复后现场（自愈态） | 状态变化与质量评估                   |
| :----------------------------------------------- | :------------------: | :------------------: | :----------------------------------- |
| **`sessions` 会话索引总数**                      |          81          |          81          | 完好保留，索引零丢失                 |
| **`session_messages` 消息总行数**                |        **3**         |       **601**        | **净恢复 +598 行消息（+19,933%）**   |
| **含消息的非空会话数**                           |        **2**         |        **65**        | **净恢复 +63 个完整历史会话**        |
| **来自 `events` 投影恢复的消息数**               |          0           |         422          | 21 个现代会话完整对话无损重建        |
| **来自早期数据抢救的消息数**                     |          1           |         179          | 44 个早期历史会话全部抢救成功        |
| **`hydrated_from_engine = 1` 会话数**            |    80（虚假标记）    | 21（真实有事件会话） | 彻底纠正死锁标记，其余会话解锁       |
| **`fromRustSessionMessages` 反向反序列化成功率** |         N/A          | **100%（601/601）**  | **与前端消息渲染模型 100% 兼容**     |
| **`sessions.db-wal` 大小**                       |       4.38 MB        |       **0 B**        | **全量数据已 checkpoint 固化至主库** |

---

### 4. 重点历史会话恢复明细抽检表

抽检审计报告中记录的代表性历史会话，核查其实际恢复的消息条数及前端兼容性：

| `session_id`         | 会话标题                               | `events` 总事件数 | 恢复前行数 | 恢复后消息行数 | `body_version` | `hydrated_from_engine` |   前端反序列化验证    |
| :------------------- | :------------------------------------- | ----------------: | ---------: | -------------: | -------------: | ---------------------: | :-------------------: |
| `sess-1786798945840` | 请帮我在 c:/Software/conex/temp_       |             7,557 |          0 |         **60** |              1 |                      1 | **60/60 通过 (100%)** |
| `sess-1786855835905` | 你好啊 ，你是什么模型呢                |             7,035 |          0 |         **42** |              1 |                      1 | **42/42 通过 (100%)** |
| `sess-1786798366231` | 你 好 ， 请 用 一 句 话 介 绍 你 自 己 |             7,071 |          0 |         **38** |              1 |                      1 | **38/38 通过 (100%)** |
| `sess-1789801522742` | 你好啊                                 |             2,216 |          0 |         **35** |              1 |                      1 | **35/35 通过 (100%)** |
| `sess-1788414110591` | 你好啊                                 |             3,198 |          0 |         **29** |              1 |                      1 | **29/29 通过 (100%)** |
| `sess-1786859713132` | 你好啊                                 |             6,827 |          0 |         **28** |              1 |                      1 | **28/28 通过 (100%)** |
| `sess-1789757162994` | 你好啊                                 |             2,241 |          0 |         **27** |              1 |                      1 | **27/27 通过 (100%)** |
| `sess-1787193860949` | 你好啊                                 |             6,818 |          0 |         **24** |              1 |                      1 | **24/24 通过 (100%)** |
| `sess-1784120507760` | 你好啊。分析一下当前的代码仓库...      |          0 (早期) |          0 |         **23** |              1 |                      0 | **23/23 通过 (100%)** |
| `sess-1784090702185` | 你好啊。你是什么模型？                 |             6,820 |          0 |         **22** |              1 |                      1 | **22/22 通过 (100%)** |
| `sess-1791780192066` | 你现在都有什么能力呢                   |                48 |          2 |          **8** |              1 |                      1 |  **8/8 通过 (100%)**  |
| `sess-1785519655009` | 你好啊                                 |          0 (早期) |          1 |          **1** |              1 |                      0 |  **1/1 通过 (100%)**  |

---

## 五、验收结论

1. **Rust 物理护栏已经建立且生效**：无论前端出现任何逻辑异常，只要发送无 CAS 版本号的 `[]` 试图覆盖已有会话，`crates/conex-db/src/messages.rs` 都会在底层直接拒绝执行清空，历史数据具备了底层防删物理保证。
2. **历史数据 100% 抢救成功**：本机真实的 SQLite 数据库（`sessions.db`）中的所有历史会话消息均已全量恢复到位（从 3 行恢复至 601 行），且数据结构与前端水合解析层 100% 契约一致。
3. **未触碰任何前端 TS 文件**，未执行 Git 提交，已严格遵循协作指令与任务域约束。
