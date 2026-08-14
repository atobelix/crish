# D-06 · 维度详案 · 契约核心 CT-01（持久层最小面 CAS）

| 元数据       | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **角色**     | 维度详案 Agent（R2 方案轮第四步 · 维度 6）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **输入**     | `00-总计划框架.md`（维度 6 + 裁决 7/8/13/17）+ `05-独立方案-一致性契约视角.md`（CT-01 源案）+ `REV-01/02/03-评审-*.md`（断言硬化与串行裁决）+ `07-测试真实性-契约-可维护性.md` §8 + 相关代码（本会话亲读，行号以当前工作树为准）                                                                                                                                                                                                                                                                                          |
| **纪律**     | 只读代码 + 只写本文件；未改业务代码；无 git 操作；未派生子 Agent                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **性质**     | 维度 6（CT-01）详细执行方案：逻辑递进的任务单元拆解、完成定义、验收断言；**不含时间表 / 人员 / 优先级**；未真跑任何测试                                                                                                                                                                                                                                                                                                                                                                                                   |
| **修订注记** | 2026-08-13 · ① 裁决 7 落点修正确认：err_outcome 映射真实改动点 = `note_types_error.rs`（新变体 + `note.persist_conflict` 码）+ `store_backend.rs:124-139 map_commit_err`（加一臂），**非** note_commands.rs——SR-06 批⑥（note_commands 拆分）**不再是 CT-01b 前置**；串行约束更新为「与 store 家族锁串行」（B2 spawn_blocking 与 store 家族仍串行，文档中「排 SR-06 批⑥ 后」相关表述已按此修正）。② U6 白名单断言限定为 `git diff HEAD -- <限定路径列表>`（禁止裸 `git diff`——工作区有 109 项并行 Agent 改动会污染白名单） |

---

## 〇、详案总览（一句）

**把 `doc_meta.rev` 从「LWW 单调计数器」升级为「可期望版本比对的条件更新」：trait 新增一个带默认实现的方法 `on_committed_expect`（默认走旧逻辑，既有全部实现零改动），`conex-workspace-store` 覆写为 `ON CONFLICT … DO UPDATE … WHERE doc_meta.rev = 期望`（受影响行数 = 0 → `PersistError::Conflict`），`session.rs` 三个写路径（apply / undo / 远端文本合入）经同一 `emit_commit` 面传入「本次 apply 前 rev」作期望，冲突经既有 P-H2 快照回滚整体回滚（updates 零追加、seq 不空洞），并新增长错误码 `PersistError::Conflict` 承载结构化冲突信号——无新表、无新服务、无新抽象层。**

---

## 一、维度目标

| #   | 目标                                                                                                                                                                       | 对应问题池/裁决                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | `doc_meta.rev` 具备版本争用检测：陈旧写入者（跨进程或同进程双会话）不得无声顶掉已提交的 rev                                                                                | 问题池 #19（持久层无乐观锁）；07 §8 黄项                                |
| 2   | 冲突产生**结构化错误码** `PersistError::Conflict`，并确认其可经既有错误渗透链（ApplyError → CommitPipelineError → NoteBackendError → err_outcome → 前端 coerceString）承载 | 05 §五.1（审计未覆盖缺口：PersistError 无 Conflict 变体）；总框架裁决 7 |
| 3   | 冲突时**零副作用**：`doc_meta.rev` 保持 N+1、`doc_updates` 零追加（同一事务内整体回滚，复用 P-H2，不新写回滚机制）、`seq` 不空洞                                           | 05 §五.3（审计未覆盖断言面）；00 维度 6 验收                            |
| 4   | **行为兼容**：既有调用路径（`on_committed` 直调 / 测试实现 / MemoryPersistence / 无 persistence 会话）行为零变化；新方法仅由 session.rs 三写路径显式启用                   | REV-02 断言硬化（diff 白名单）；05 禁止项（trait 必选签名不动）         |
| 5   | **最小面**：不新建表/服务/抽象层；不把 CAS 与 mirror 语义、collab Op 级冲突混为一谈；不宣称「冲突已解决/自动合并」                                                         | 05 CT-01 禁止项；REV-03 §二.2 四审                                      |
| 6   | 失败分支测全分支落地：匹配成功 / 期望不匹配 / 无行首写 / None 兼容 / seq 不空洞 / undo 路径 / 双会话陈旧写主场景                                                           | 00 维度 6 验收（diff 白名单 + 双会话测）                                |

---

## 二、问题现状（LWW 证据 · 本会话亲读）

### 2.1 核心病灶：rev 无争用检测

`crates/conex-workspace-store/src/persist_plugin.rs:70-80`（`on_committed` 内）：

```sql
INSERT INTO doc_meta(doc_id, rev, updated_at)
VALUES (?1, 1, strftime('%s','now'))
ON CONFLICT(doc_id) DO UPDATE SET
    rev = rev + 1,
    updated_at = strftime('%s','now')
```

**纯 LWW**：`ON CONFLICT DO UPDATE SET rev = rev + 1` 无任何客户端期望版本比对。跨进程（或同进程双会话）并发写同一 doc 时，陈旧写入者会把自己的 rev 抬升并覆盖已提交内容对应的版本线；`mirror_detect.rs` 依赖的 `authority_rev` 语义（转引 07 §8）随之失真。

### 2.2 相关现状（逐项亲读确认）

| 面                                   | 现状                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 证据                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `PersistError`                       | **仅 3 变体**：`NotFound / Io / Corrupt`，**无 Conflict**                                                                                                                                                                                                                                                                                                                                                                                                                              | `persistence.rs:36-44`                                             |
| 持久层 trait                         | `PersistencePlugin { load_doc, on_committed, flush_hint }`，3 必选方法，无默认方法                                                                                                                                                                                                                                                                                                                                                                                                     | `persistence.rs:47-51`                                             |
| 实现者清单                           | `WorkspaceStore`（persist_plugin.rs:19-132）、`SharedWorkspaceStore`（:171-183，**独立 impl 块，转发 `self.0`**）、`MemoryPersistence`（persistence.rs:64-92）、session.rs 测试内 8 个 impl（:1711/:1778/:2168/:2241/:2330/:2420/:2496/:2877）                                                                                                                                                                                                                                         | 全仓 `rg "on_committed"` 全量清单                                  |
| **生产接线**                         | **会话挂的是 `SharedWorkspaceStore`，不是裸 `WorkspaceStore`**：`store_hydrate.rs:29,40` `with_persistence(Box::new(store.clone()))`，`store: &SharedWorkspaceStore`                                                                                                                                                                                                                                                                                                                   | `conex-note-runtime/src/store_hydrate.rs`                          |
| session 写锥                         | 三个写路径全部汇入同一 `emit_commit` 面（session.rs:480-509）：`apply_after_validate`（:802-812）、`undo`（:634-653）、`apply_remote_text_update_inner`（:437-455）；`emit_commit` 收 `rev: u64`（**新 rev**，即 increment 后）                                                                                                                                                                                                                                                        | session.rs 亲读                                                    |
| P-H2 回滚                            | 在轨：`capture_memory_snapshot` / `restore_memory_snapshot`（:460-477）；`apply` 失败 → 整域回滚（:589-604）；`undo` 失败 → 回滚 + 栈深度还原（:648-653）；钉测 `p_h2_persist_fail_rolls_back_tree_and_text`、`undo_persist_fail_rolls_back_stack_and_state`                                                                                                                                                                                                                           | session.rs + `docs/block-workspace-architecture/` 审计记录（转引） |
| seq 分配                             | `SELECT COALESCE(MAX(seq),0)+1 FROM doc_updates WHERE doc_id=?1`（persist_plugin.rs:84-90），事务内串行，本身安全；**审计未覆盖**「冲突回滚后 seq 不空洞、updates 零追加」断言面                                                                                                                                                                                                                                                                                                       | 05 §五.3 佐证                                                      |
| cas.rs                               | `blob_cas` 内容寻址去重（SHA-256 put/get/link），**非乐观锁**；文件域本详案不碰                                                                                                                                                                                                                                                                                                                                                                                                        | `cas.rs:1-17,30-91`                                                |
| 表结构                               | `doc_meta(doc_id PK, rev NOT NULL DEFAULT 0, updated_at)`；`doc_updates(id AUTOINCREMENT, doc_id, seq, blob, kind, tx_id, UNIQUE(doc_id,seq))`                                                                                                                                                                                                                                                                                                                                         | `migrate.rs:30-51`                                                 |
| 错误渗透链                           | `PersistError` → `ApplyError::Persist(String)`（**session.rs:506-507 直接 stringify**）→ `CommitPipelineError::Apply`（projection.rs:47-52）→ `map_commit_err`（**string 派生码 chokepoint**，store_backend.rs:124-139）→ `NoteBackendError`（note_types_error.rs，9 变体 + `code()`）→ `err_outcome {ok:false, code, reason}`（**泛化实现**，note_commands.rs:59-65）→ 前端 `coerceString(rec.code)`（noteApplyOpsIpc.wire.ts:69 / noteApi.ts:322 / noteHydrateIpc.ts:150，泛化消费） | 全链亲读                                                           |
| ApplyError / NoteBackendError 穷举面 | ApplyError 外部全部 `matches!(...)` 非穷举；NoteBackendError 消费面含通配臂（note_backend_json.rs:36 `other =>`）、其余 `matches!`/`Err(e @ …)` 非穷举                                                                                                                                                                                                                                                                                                                                 | 全仓 grep                                                          |

---

## 三、方案设计（核心决策）

### D1 · Trait 面：新增带默认实现的 `on_committed_expect`（persistence.rs）

```rust
/// CAS 版 on_committed：`expect_rev = Some(期望)` 时按期望版本条件更新，
/// 版本不符 → `PersistError::Conflict`。默认实现忽略期望值（旧行为），
/// 既有实现者零改动。CAS = 检测并报错，**不自动合并**。
fn on_committed_expect(
    &self,
    doc_id: &str,
    commit: &CommitBatch,
    expect_rev: Option<u64>,
) -> Result<(), PersistError> {
    self.on_committed(doc_id, commit)
}
```

- 默认体 = 直接调 `self.on_committed`：**MemoryPersistence 与 session.rs 测试内 8 个 impl 零改动**（trait 方法解析到各自 impl，行为与现状逐字节一致）。
- 同步新增 `PersistError` 变体：

```rust
#[error("conflict: rev 已前进，期望 {expect} 不匹配")]
Conflict { expect: u64 },
```

- Display 含稳定可辨标识 `conflict`（透传链消费依据，见 D5）。**注意**：serde 序列化不涉及（PersistError 非 wire 类型，仅 Display/错误链用；`PersistError` 无 `Serialize` 派生——亲读确认 :36-44 无派生，新增变体不影响任何 wire 形状）。
- 头注释声明：「CAS = 检测并报错，不自动合并；跨进程陈旧写与同进程双会话写同一 doc 均受保护」。

### D2 · 存储面：条件更新 SQL + 单实现点（persist_plugin.rs）

**单实现点设计**：`WorkspaceStore` 把完整逻辑放在 `on_committed_expect`，`on_committed` 收敛为一行委托（`self.on_committed_expect(doc_id, commit, None)`）——同一 SQL 体，杜绝双份漂移。

`expect_rev = Some(expect)` 时（其余逻辑——updates 追加 / compact / commit——与现 `on_committed` 完全相同）：

```sql
INSERT INTO doc_meta(doc_id, rev, updated_at)
VALUES (?1, 1, strftime('%s','now'))
ON CONFLICT(doc_id) DO UPDATE SET
    rev = rev + 1,
    updated_at = strftime('%s','now')
WHERE doc_meta.rev = ?2          -- ?2 = expect（旧行版本比对）
```

- **受影响行数语义**：INSERT 分支恒 1 行（行不存在 = 从未写入 = 无争用可能，无条件放行，首写 rev=1 语义不变）；UPDATE 命中（旧行 rev == expect）为 1；**WHERE 不命中（旧行 rev ≠ expect）为 0 → 返回 `Err(PersistError::Conflict)`，tx 随 drop 自动回滚**（rusqlite `Transaction` 未 commit 即回滚；无需手动 rollback）。
- `expect_rev = None` 时用**原 SQL 原样**（无 WHERE 子句）——None 兼容路径行为零变化。
- **关键增量（05 方案遗漏、本详案亲读补足）**：`SharedWorkspaceStore` 的 impl 块（persist_plugin.rs:171-183）**必须同样覆写** `on_committed_expect` 并转发：

```rust
fn on_committed_expect(
    &self,
    doc_id: &str,
    commit: &CommitBatch,
    expect_rev: Option<u64>,
) -> Result<(), PersistError> {
    self.0.on_committed_expect(doc_id, commit, expect_rev)
}
```

> **为什么必须**：生产会话挂的是 `SharedWorkspaceStore`（store_hydrate.rs:40）。若不覆写，trait 默认方法会调 `SharedWorkspaceStore::on_committed` → 转发 `self.0.on_committed`（**纯 LWW**）——CAS 在**生产路径静默失效**。`Deref` 不参与 trait 方法解析，此坑亲读确认。

### D3 · 会话面：`emit_commit` 带期望版本（session.rs）

- `emit_commit` 增参 `expect_rev: Option<u64>`，调用 `p.on_committed_expect(&self.doc_id, &batch, expect_rev)`（:506 一行改）。
- 三个写路径统一传 `Some(期望)`，期望 = **本次写前会话 rev**（increment 前的 `self.rev`）：

| 写路径                                       | 现状（亲读）                                                               | 期望值                                |
| -------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------- |
| `apply_after_validate`（:802-812）           | `self.rev += 1; let rev = self.rev;` 后 emit                               | `Some(rev - 1)`（= increment 前 rev） |
| `undo`（:634-653）                           | `rev_before = self.rev`；`self.rev = rev_before.saturating_add(1)` 后 emit | `Some(rev_before)`                    |
| `apply_remote_text_update_inner`（:437-455） | `self.rev += 1; let rev = self.rev;` 后 emit                               | `Some(rev - 1)`                       |

- P-H2 回滚机制**不动**（已覆盖「on_committed 失败 → 整域回滚」，Conflict 只是又一种失败）：apply 失败 → `restore_memory_snapshot`（树/文本/rev/last_tx 全回滚）；undo 失败 → 回滚 + entry 压回栈。**零新回滚代码**。
- `undo` 的期望语义说明：undo 恢复旧树但 rev 单调 +1——期望 = 发起 undo 前的会话 rev（`rev_before`），陈旧会话（另一进程已写）的 undo 同样被 Conflict 拦截，这是正确的（跨进程共享同一持久层时，undo 必须基于最新权威）。

### D4 · 错误码：`PersistError::Conflict`（含 `expect` 字段）承载信号

- 变体带 `expect: u64` 便于测试断言与日志诊断（「期望 N，实际 ≠ N」）。
- `StoreError` **不改**（亲读 lib.rs:129-145：`From<StoreError> for PersistError` 把 StoreError 全映射为 `PersistError::Io`；`on_committed_expect` 直接构造 `PersistError::Conflict`，不经 StoreError，无需新 StoreError 变体——最小面）。

### D5 · 透传链（分两段：CT-01 本体完成 crate 边界内，命令层面标注依赖后置）

**链上各层现状与改动点（全链亲读）**：

```
PersistError::Conflict（新增）
  └→ session.rs:506-507  `p.on_committed_expect(...).map_err(|e| ApplyError::Persist(e.to_string()))`
       （stringify：消息 = "persist: conflict: rev 已前进…"——含稳定 "conflict" 标识）
  └→ CommitPipelineError::Apply（projection.rs:49，#[from] 自动）
  └→ map_commit_err（store_backend.rs:124-139）   ← ★ 真实映射 chokepoint
  └→ NoteBackendError（note_types_error.rs）      ← ★ 需新变体 + 新码
  └→ err_outcome（note_commands.rs:59-65）        ← ★ 零改动（泛化 err.code()/err.message()）
  └→ 前端 coerceString(rec.code)（noteApplyOpsIpc.wire.ts:69 等） ← 零改动（泛化消费）
```

- **段 1（CT-01 本体 · 本轮执行）**：`PersistError::Conflict` 在 conex-doc-collab crate 边界内**已可区分**（session/undo 回滚、store 级测试断言均以它为准）；crate 外经 `ApplyError::Persist` 字符串承载，消息含稳定标识 `conflict`。
- **段 2（CT-01b · 标注依赖，不执行）**：在 `map_commit_err` 扩展一臂 `s.to_lowercase().contains("conflict") → NoteBackendError::Conflict(s)`（**沿用既有 string 派生码模式**，store_backend.rs:129/131 现成先例），`NoteBackendError` 增变体 `Conflict(String)` + `code()` 返回 `"note.persist_conflict"`。**note_commands.rs 零改动**（亲读确认 err_outcome 只调 `err.code()/err.message()`，任何新码自动透传）；前端零改动（coerceString 泛化）。
- **对本轮框架的修正说明（亲读实证 · 2026-08-13 主 Agent 裁决确认）**：总框架裁决 7 与 05 方案预期「err_outcome 映射 = note_commands.rs 加分支」——**实测 note_commands.rs 无需任何改动**；真正改动点是 `note_types_error.rs`（新变体 + `note.persist_conflict` 码）与 `store_backend.rs:124-139`（map_commit_err 加一臂）。该两文件与 note_commands.rs 无文件重叠，但 store_backend.rs 属 store 家族（B1 store 片 / B2 / B3 / S3 同域）——CT-01b 的**串行约束为「与 store 家族锁串行」**：**SR-06 批⑥（note_commands 拆分）不再是 CT-01b 前置**（note_commands.rs 全程零 diff），**B2（spawn_blocking，同域 store_backend.rs）仍与 CT-01b 串行**。
- **备选设计（已评估未采用）**：新增 `ApplyError::Conflict` 结构化变体替代 string 标识——会破坏 `p_h2_persist_fail_rolls_back_tree_and_text` 既有断言（session.rs:2556 `matches!(err, ApplyError::Persist(_))` 需改）并扩大公共 API 面；string 标识在现有链上无假阳性（`CommitPipelineError::Apply` 只承载 ApplyError 四变体 Display：`schema/not found/persist/invariant` + PersistError 三变体 Display，`conflict` 一词仅 Conflict 变体产出），**沿用既有模式为最小面**。

### D6 · seq 不空洞与零追加的机制保证（测试断言依据）

- 冲突返回发生在 rev UPSERT **之后、updates 追加循环之前**；tx 未 commit → 两步（rev 抬升 + 任何写入）整体回滚：`doc_meta.rev` 保持原值、`doc_updates` 零追加。
- `seq` 由 `MAX(seq)+1` 显式计算（persist_plugin.rs:84-90），失败事务未插入行 → 后续成功写从原 max 继续，**无空洞**（`doc_updates.id` 的 AUTOINCREMENT 是 rowid 非 seq，不参与断言）。

---

## 四、任务单元详案表（逻辑递进序，单 Agent 顺序执行）

> 全部单元文件域均落在 CT-01 白名单内；行号锚点为 2026-08-13 工作树实测，**执行前按总框架裁决 13 重定位**（尤其 SR-06 批⑦ 拆分 session.rs 后）。

### U1 · 契约面：PersistError::Conflict + trait 默认方法（persistence.rs）

| 要素                     | 内容                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **目标边界（文件域锁）** | `crates/conex-doc-collab/src/persistence.rs`（仅 :36-51 区域 + 头注释）；不碰其它文件                                                                                                                                                                                                                                            |
| **完成定义**             | ① `PersistError::Conflict { expect: u64 }` 变体就位（Display 含稳定 `conflict` 标识）② `on_committed_expect` 默认方法就位（默认体 = `self.on_committed(...)`，不展开无谓逻辑）③ 头注释声明「CAS = 检测并报错，不自动合并；默认实现忽略期望值（兼容）」。**既有实现零改动即可编译**（MemoryPersistence + 8 个测试 impl 一行不动） |
| **验收断言**             | ① `cargo check -p conex-doc-collab` 绿 ② `git diff` 仅 persistence.rs 一个文件（U1 提交点）③ `rg "on_committed_expect" crates/conex-doc-collab` 命中 trait 定义与默认体，无其它                                                                                                                                                  |
| **禁止项**               | 禁止改 3 个既有必选方法签名（逼实现者重写）；禁止给 PersistError 加 Serialize/Clone 派生（非 wire 类型，面外需求）；禁止在此层做任何 SQL / 策略逻辑                                                                                                                                                                              |

### U2 · 存储面：条件更新 + Conflict 判定 + SharedWorkspaceStore 转发（persist_plugin.rs）

| 要素                     | 内容                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **目标边界（文件域锁）** | `crates/conex-workspace-store/src/persist_plugin.rs`（仅两个 impl 块；`compact_snapshot`/`kind_to_str`/`decode_encoded_update` 不动）；不碰 `cas.rs` / `lib.rs` / `migrate.rs` / `projection.rs` / mirror_*                                                                                                                                                                                                                       |
| **完成定义**             | ① `WorkspaceStore::on_committed_expect` 完整实现（D2 SQL：Some → WHERE 比对 + affected==0 → `Err(PersistError::Conflict { expect })`；None → 原 SQL 原样；updates 追加/compact/commit 复用现逻辑）② `WorkspaceStore::on_committed` 收敛为 `self.on_committed_expect(doc_id, commit, None)` 委托 ③ **`SharedWorkspaceStore::on_committed_expect` 转发覆写**（生产路径必需，D2 论证）④ 头注释声明 CAS 语义 + 与 blob_cas 去重的区别 |
| **验收断言**             | ① `cargo check -p conex-workspace-store` 绿 ② 头注释含「CAS = 检测并报错，不自动合并」且与 blob CAS 区分 ③ 代码形状复核：`WHERE doc_meta.rev =` 仅一处（Some 分支）、None 分支与原 SQL 逐字一致 ④ `SharedWorkspaceStore` 覆写存在（`rg "on_committed_expect"` 命中 3 处：trait 默认 + WorkspaceStore + SharedWorkspaceStore）                                                                                                     |
| **禁止项**               | 禁止新表/新列（migrate.rs 零 diff）；禁止新 trait/新抽象/连接池；禁止把 CAS 与 blob_cas、mirror 三路、collab Op 级冲突（NotFound/delete-wins）互改；禁止在 None 分支夹带任何行为变化                                                                                                                                                                                                                                              |

### U3 · 会话面：emit_commit 期望版本接线（session.rs · 排 SR-06 批⑦ 后）

| 要素                     | 内容                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **目标边界（文件域锁）** | `crates/conex-doc-collab/src/session.rs`（仅 `emit_commit` 签名 + :506 调用行 + 三个写路径调用点各一行 + 头注释 P-H2 段补充一句「Conflict 亦走 P-H2 回滚」）；**行号以 SR-06 批⑦ 拆分后为准**（拆分只切不修，本单元在拆后文件上接线）                                                                                                                   |
| **完成定义**             | ① `emit_commit(&self, origin, tx_id, rev, expect_rev: Option<u64>, text_payloads)` 增参 ② 三调用点分别传 `Some(rev - 1)` / `Some(rev_before)` / `Some(rev - 1)`（D3 表）③ `p.on_committed` 改 `p.on_committed_expect(&self.doc_id, &batch, expect_rev)`（错误映射不变：`ApplyError::Persist(e.to_string())`，D5 段 1）④ P-H2 代码零改动（回滚机制复用） |
| **验收断言**             | ① `cargo check -p conex-doc-collab` 绿 ② `rg "on_committed\(" crates/conex-doc-collab/src` 仅剩 persistence.rs trait 定义 + MemoryPersistence impl + 测试 impl（**session.rs 生产代码零命中 `on_committed(`**，全部走 `on_committed_expect`）③ 三调用点期望值语义复核（undo 用 `rev_before`，两处 apply 用 increment 前 rev）                           |
| **禁止项**               | 禁止改 `capture/restore_memory_snapshot` 或 apply/undo 回滚结构（P-H2 是既有资产）；禁止在 emit_commit 内吞掉/改写错误类型（D5 段 1 语义保持）；禁止顺手重构 emit_commit 其它部分                                                                                                                                                                       |

### U4 · 测试面：store 级 CAS 测 + 双会话陈旧写全分支（测试文件）

| 要素                     | 内容                                                                                                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **目标边界（文件域锁）** | `crates/conex-workspace-store/src/persist_plugin_tests.rs`（T1-T4 追加）+ 双会话测所在文件（见 §五：建议 `crates/conex-workspace-store/src/projection_tests.rs` 追加，或新增 `crates/conex-workspace-store/tests/cas_dual_session.rs`——二选一由执行 Agent 按拆分后结构定，**白名单内**） |
| **完成定义**             | §五全部用例落盘并真跑绿（T1-T7）                                                                                                                                                                                                                                                         |
| **验收断言**             | ① `cargo test -p conex-workspace-store -p conex-doc-collab` 全绿（新增测 + 既有 persist/load_doc/hydrate/P-H2/undo 测零回退）② T5 主场景三断言齐备（Conflict + rev 保持 + updates 零追加）③ T4 seq 不空洞断言在列 ④ 无 `--no-verify`                                                     |
| **禁止项**               | 禁止删除/改写既有任一测试（P-H2 双钉测、`on_committed_pending_ordered_on_load` 等必须原样绿）；禁止用 `sleep`/真并发做伪双会话（同进程顺序双会话即可确定性复现，无需线程）；禁止 mock SQLite 行为断言                                                                                    |

### U5 · 错误码透传面 CT-01b（**标注依赖 · 本轮不执行**）

| 要素                     | 内容                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **目标边界（文件域锁）** | `crates/agent-tools/src/note_types_error.rs`（新变体 + code()）；`crates/conex-note-runtime/src/store_backend.rs`（map_commit_err :124-139 加 conflict 臂）                                                                                                                                                                                          |
| **依赖/串行**            | **与 store 家族锁串行**（框架裁决 7 落点修正，2026-08-13 主 Agent 确认）：store_backend.rs 属 store 家族，与 B2（spawn_blocking）/ B1 store 片 / B3 / S3 同域串行，**排 B2 之后**；SR-06 批⑥（note_commands 拆分）**不再是 CT-01b 前置**——err_outcome 映射不在 note_commands.rs（该文件 CT-01 全程零 diff）                                          |
| **完成定义**             | ① `NoteBackendError::Conflict(String)` + `code()` → `"note.persist_conflict"`（错误码命名与既有 `note.*` 蛇形族一致）② `map_commit_err` 增加 `else if s.to_lowercase().contains("conflict") → NoteBackendError::Conflict(s)` 臂（置于 IdConflict 臂之后、ApplyFailed 兜底之前）③ 命令层/前端**零改动**（err_outcome 与 coerceString 泛化，亲读确认） |
| **验收断言**             | ① 双会话陈旧写经真命令面（如 note_apply_ops）返回 `{ok:false, code:"note.persist_conflict"}`（执行轮真跑记录）② `rg "persist_conflict" crates` 命中 code() 一处 ③ note_commands.rs 该轮 `git diff` 为空 ④ 既有 `note.id_conflict`（IdConflict 臂）行为不回退（新增臂在其后，先命中 IdConflict 的场景不变）                                           |
| **禁止项**               | 禁止在 note_commands.rs 写任何代码；禁止新增第六种错误派生机制（沿用 map_commit_err 既有 string 模式一臂）；禁止给前端加分支消费（coerceString 已泛化）                                                                                                                                                                                              |

### U6 · 白名单核验 + 全量回归（收口）

| 要素                     | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **目标边界（文件域锁）** | 只读核验 + 本详案更新；不写业务代码                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **完成定义**             | 全部白名单断言通过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **验收断言**             | ① **diff 白名单（限定路径）**：`git diff HEAD -- crates/conex-doc-collab/src/persistence.rs crates/conex-workspace-store/src/persist_plugin.rs crates/conex-doc-collab/src/session.rs crates/conex-workspace-store/src/persist_plugin_tests.rs <双会话测所在文件，U4 二选一>` 的 `--stat` 仅上述文件、限定路径内其余零 diff（含 w2c_structure_gate.rs 等 on_committed 调用方）——**禁止裸 `git diff`**（工作区有 109 项并行 Agent 改动会污染白名单，一律 `git diff HEAD -- <限定路径列表>`）② `cargo test -p conex-workspace-store -p conex-doc-collab` 真跑绿 ③ 全仓 `rg "on_committed"` 调用面清单复核（trait 定义 / 实现 / emit_commit→on_committed_expect / 测试 impl 各自零行为变化）④ 无新超限文件（crate-size / line-counts 现状不回退）⑤ 诚实边界句：CT-01 ≠ 冲突解决 / ≠ 自动合并 / ≠ EL 关账 |
| **禁止项**               | 禁止以本单元名义登记基线豁免或改门禁脚本；禁止 `--no-verify`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

---

## 五、测试设计（双会话陈旧写全分支）

> 命名遵循仓库风格（`cas_*` / `dual_session_*`），全部确定性顺序执行（同进程两会话即复现跨进程语义，无需线程）。

### T1 · store 级：期望不匹配 → Conflict + rev 保持 + updates 零追加（persist_plugin_tests.rs）

```
store.on_committed_expect("doc", batch(u1), Some(0)) → Ok      // 无行首写，INSERT 放行，rev=1
store.on_committed_expect("doc", batch(u2), Some(0)) → Err(Conflict{expect:0})  // 陈旧期望
assert load_rev("doc") == 1                                    // rev 不被覆盖
assert load_pending_count("doc") == u1 条数                     // updates 零追加
```

### T2 · store 级：期望匹配 → 单调前进；再冲突

```
call1 Some(0) → Ok, rev=1；call2 Some(1) → Ok, rev=2；call3 Some(1) → Err(Conflict)；rev 仍 2
```

### T3 · store 级：None 兼容 = 旧 LWW 行为（回归护栏）

```
on_committed 直调两次（None 路径）→ rev=2（与现状完全一致）；on_committed_expect(None) 同理
```

### T4 · store 级：seq 不空洞

```
A: Some(0) Ok（2 条 update，seq=1,2）→ B: Some(0) Err(Conflict)（零追加）
→ C: Some(1) Ok（seq=3，紧接 max+1，无空洞；doc_updates 计数恰为 3）
```

### T5 · 会话级主场景：双会话陈旧写失败分支（签名验收 · 三断言）

```
store = SharedWorkspaceStore::open(tmp)
sessionA = hydrate("doc", load_doc("doc")).with_persistence(store.clone())   // rev=0
sessionB = hydrate("doc", load_doc("doc")).with_persistence(store.clone())   // rev=0（陈旧）
A.apply(User, [Insert...]) → Ok；DB rev=1；updates=N
B.apply(User, [Insert...]) → Err（ApplyError::Persist，消息含 "conflict"）
断言①：doc_meta.rev == 1（不被 B 覆盖）      → store.load_rev("doc")==1
断言②：doc_updates 计数 == N（B 零追加）      → load_pending_count 前后相等
断言③：B.rev() == 0 且 B.tree() 无 B 的块    → P-H2 内存态回滚生效
再断言：A 继续 apply → Ok，rev=2（权威线未断）；load_doc 后 hydrate 树 ≡ A 的树
```

### T6 · 会话级：陈旧会话 undo 路径

```
同 T5 构造 → B.undo(None) → Err（UndoError::Persist 含 conflict）→ B.rev()/栈深度回滚
（undo 期望 = rev_before，陈旧会话被拦截；栈 entry 压回）
```

### T7 · 会话级：MemoryPersistence 默认实现忽略期望（兼容护栏）

```
DocSession::new.with_persistence(MemoryPersistence) apply 两次 → 均 Ok（默认方法忽略 expect，行为与现状一致）
```

**未真跑声明**：以上用例为设计形态（基于亲读的 trait/回滚/错误链语义），**未在本次方案轮真跑**；真跑绿灯由执行轮验收记录承担。

---

## 六、依赖串行图（逻辑序 · 非时间表）

```
SR-06 批⑦（doc-collab session.rs 拆分，只切不修）
   └──→ CT-01 本体（U1 → U2 → U3 → U4 → U6，单 Agent 顺序；U3 依赖批⑦ 后行号）
         ├── 与 B3（store 锁粒度）错峰：同 crate 编译串行 + B3 须保持 on_committed 原子域
         │    （05 §四.1：条件更新 + updates 追加同一锁持有周期），不得同轮
         └── U1/U2/U4 与批⑦ 无文件重叠（persistence.rs/persist_plugin.rs vs session.rs）
             但同为 conex-* crate，编译窗口串行即可

CT-01b（错误码透传面：note_types_error.rs + store_backend.rs）
   ├── 串行约束 = 与 store 家族锁串行（框架裁决 7 落点修正，2026-08-13 主 Agent 确认）：
   │   排 B2（spawn_blocking）后，且与 B1 store 片 / B3 / S3 同家族串行（store_backend.rs 同域）
   ├── SR-06 批⑥（note_commands 拆分）不再是 CT-01b 前置（err_outcome 映射不在该文件）
   └── note_commands.rs / 前端：零改动（实测 err_outcome / coerceString 泛化）

并发安全集（与 CT-01 无文件重叠可并行）：CT-02 / CT-03 / CT-04 / CT-05、
G-* 脚本面、S1/S4/S5、CONN-*（以总框架矩阵为准）
```

**批⑦ 后行号重定位为强制开工动作**（框架裁决 13）：session.rs 拆分后 `emit_commit`、三写路径、P-H2 函数行号全部漂移；U3/U4 派单前以工作树实测重定位。

---

## 七、反过度设计自查

| 红线（ANTI_OVERENGINEERING_GUARDRAILS + AGENTS.md §8） | 本方案                                                                                                                       | 结论 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---- |
| 新表 / 新列 / schema 迁移                              | **零**：复用 `doc_meta(doc_id, rev)`，migrate.rs 零 diff                                                                     | ✅   |
| 新服务 / 连接池 / 新 crate 依赖                        | **零**：SQLite UPSERT 原子比对即检测，无新锁、无新依赖（Cargo.lock 零 diff）                                                 | ✅   |
| 新抽象层                                               | **零**：trait 只加一个带默认实现的**方法**，不新增 trait、不新增 impl 家族                                                   | ✅   |
| 新错误机制                                             | 透传链**复用**既有五层 + map_commit_err 既有 string 派生模式扩展一臂（CT-01b）；不另起错误通道                               | ✅   |
| 与既有概念混改                                         | 不碰 blob_cas（内容去重）、mirror 三路（人/git 视图）、collab Op 级 NotFound/delete-wins——CAS 只做「检测并报错，不自动合并」 | ✅   |
| 补丁式魔术                                             | SQL 为原生 `WHERE rev = 期望` 条件更新，无坐标/延时/猜测补偿；期望值 = 会话 increment 前 rev，O(1) 可得                      | ✅   |
| 强制验证责任                                           | 验收全部命令化（cargo test / rg / git diff --stat），无「人工复核」伪断言（REV-02 硬化）；未真跑处显式声明                   | ✅   |
| 会计诚实                                               | 头注释「CAS = 检测并报错，不自动合并」；≠ 冲突解决 / ≠ 自动合并 / ≠ EL 关账；双会话测 ≠ 跨进程实测（同进程复现，诚实标注）   | ✅   |

---

## 八、证据声明（实测 vs 转引 vs 未真跑）

| 类别                               | 项                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **本会话亲读实测**                 | `persist_plugin.rs` 全文（LWW :70-80、seq :84-90、on_committed :58-116、SharedWorkspaceStore impl :171-183、compact :186-225）；`persistence.rs` 全文（PersistError :36-44 无 Conflict、trait :47-51、MemoryPersistence :64-92）；`session.rs` 关键区（persistence 字段 :193、with_persistence :330、emit_commit :480-509 与 :506-507 stringify、三写路径 :437-455/:634-653/:802-812、P-H2 :460-477/:589-604/:648-653、ApplyError :134-143、UndoError :147-156）；`store_hydrate.rs:27-43`（生产接线 = SharedWorkspaceStore :29/:40）；`lib.rs`（StoreError :129-145、conn 锁 :156-160、load_rev :208-221）；`migrate.rs:30-51`（doc_meta/doc_updates DDL）；`cas.rs:1-100`（blob 去重非锁）；`note_types_error.rs` 全文（9 变体 + code()）；`store_backend.rs:116-139`（map_commit_err string 派生）；`note_commands.rs:50-65`（err_outcome 泛化，**零改动结论依据**）；`note_backend_json.rs:20-40`（通配臂）；`projection.rs:45-52`（CommitPipelineError）；前端 `noteApplyOpsIpc.wire.ts:69` / `noteApi.ts:322` / `noteHydrateIpc.ts:150`（coerceString 泛化）；`persist_plugin_tests.rs` 头 70 行（测试基建形态）；全仓 `rg "on_committed"` 完整调用面清单 |
| **转引（报告实测，本会话未重跑）** | 07 §8 mirror_detect.rs:130 authority_rev 语义与边界错误渗透绿；07 §1 noteApplyOpsIpc.rs:224/290 真 IPC adapter；P-H2 钉测名与「已焊 + 残留 🟨」审计记录（docs/block-workspace-architecture/audit/post-w3d-w2a/02）；01 审计 82 passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **未真跑（显式声明）**             | 本会话未运行 cargo test / vitest / typecheck / 门禁脚本（只读方案轮，工作区脏树避免误导）；§五 T1-T7 为设计形态，真跑绿灯由执行轮验收记录承担                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

---

## 九、对 00 框架 / 05 方案的增量修正（供主控定稿参考）

1. **SharedWorkspaceStore 转发覆写为必需项**（05 遗漏）：生产接线是 `SharedWorkspaceStore`（store_hydrate.rs:40），trait 默认方法经其转发会**静默回退 LWW**；不覆写 = 生产路径 CAS 失效。已并入 U2 完成定义。
2. **「err_outcome 映射」不在 note_commands.rs**（00 裁决 7 / 05 §3.2 预期修正，2026-08-13 主 Agent 裁决确认）：实测 note_commands.rs:59-65 只调 `err.code()/err.message()`，新码自动透传；真正改动点 = `note_types_error.rs`（新变体+码）+ `store_backend.rs:124-139`（map_commit_err 加一臂）。串行约束为「与 store 家族锁串行」：**SR-06 批⑥（note_commands 拆分）不再是 CT-01b 前置**（note_commands.rs 全程零 diff），**B2（spawn_blocking）与 store 家族仍串行**。
3. **无行首写 + 期望不匹配的语义边界**：INSERT 分支无条件放行（行不存在 = 无争用史）；仅「行存在且 rev ≠ 期望」判 Conflict——SQL 受影响行数 0 为唯一冲突信号，测试 T1/T2 钉死该边界。
4. **`PersistError` 不带 serde 派生**（亲读 :36-44），新增变体对 wire 形状零影响——05 方案未明示，此处确认。
5. **apply 期望值取 `rev - 1`**（increment 前值）而非重读 DB：会话内自洽，O(1)，与 P-H2 快照语义一致；undo 用 `rev_before`（05 已预告，本详案给出具体行）。

_2026-08-13 · 维度详案 Agent · D-06 契约核心 CT-01 CAS · 只写本文件 · 未改业务代码 · 无 git 操作 · 未派生子 Agent_
