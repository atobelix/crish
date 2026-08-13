# 伪 A-\* 处置登记（S3 · 会计诚实）

| 元数据   | 值                                             |
| -------- | ---------------------------------------------- |
| **契约** | `plans/08` §0.3 / §7；`20` L4；`plans/01` §1.6 |
| **包**   | 伪完成清理（配合 W1-H；**真 Undo 属 W1-U**）   |
| **日期** | 2026-08-11                                     |

> **纪律**：ID 锚点 / 测名存在 **≠** 断言关闭。本文件登记「已撤伪锚」与 W1-U 关闭证据。

---

## 1. 已撤伪锚（方案 B · 去 ID / 改名）→ **W1-U 已关语义**

| 断言 ID      | 应付语义（全文）                                            | 处置前表象                                                                   | 处置动作（伪完成闸）                                                          | **当前会计状态**                    | 关闭包   |
| ------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------- | -------- |
| **A-MEM-04** | undo 跨冷：结构正确；细粒度文本史允许截断且**契约测文档化** | `a_mem::A_MEM_04` + `a_mem_04_cold_readable_then_reheat_on_edit` 仅测 reheat | 曾删伪锚 + 测改名 `a_mem_reheat_*`；**W1-U 恢复** `A_MEM_04` + 真跨冷 undo 测 | **语义已交付**（W1-U）；测路径见 §2 | **W1-U** |
| **A-COL-04** | origin 可区分；**undo 可按 origin 过滤**                    | `Origin` 枚举 + harness「便于后续 undo」注释冒充                             | 曾去冒充注释；**W1-U** 交付 `DocSession::undo(filter)` + `a_col::A_COL_04`    | **语义已交付**（W1-U）；测路径见 §2 | **W1-U** |

### 代码落点（W1-U 后）

| 路径                                              | 说明                                                 |
| ------------------------------------------------- | ---------------------------------------------------- |
| `crates/conex-doc-collab/src/lib.rs` · `a_mem`    | `A_MEM_01…04`；04 文档指向跨冷 undo 测               |
| `crates/conex-doc-collab/src/lib.rs` · `a_col`    | `A_COL_04`；过滤见 `DocSession::undo`                |
| `crates/conex-doc-collab/src/session.rs`          | Undo 栈 + `undo` / `UndoError`；W1-U 测组            |
| `crates/conex-doc-collab/src/text_engine.rs`      | `a_mem_reheat_*` 仍 **≠ A-MEM-04**（仅 reheat 烟雾） |
| `crates/conex-doc-collab/src/op.rs` · `Origin`    | 标签；过滤见 `DocSession::undo`                      |
| `crates/conex-doc-collab/src/harness.rs` · `push` | Remote 不入栈；过滤见 `DocSession::undo`             |

---

## 2. 关闭证据（W1-U · 测路径）

| ID                 | 测路径::测名                                                                                             | 层   | 语义要点                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| **A-COL-04**       | `crates/conex-doc-collab/src/session.rs` · `a_col_04_undo_origin_filter`                                 | unit | User+Agent 入栈；栈顶 Agent 时 `undo(Some(User))` → `OriginMismatch`；`undo(None)` / `Some(User)` |
| **A-MEM-04**       | `crates/conex-doc-collab/src/session.rs` · `a_mem_04_undo_across_cold_restores_structure_and_plain_text` | unit | `max_hot=1` 逼冷后 undo；结构正确；文本 plain 快照恢复；**非** reheat 测                          |
| **A-INV-09c 后半** | `crates/conex-doc-collab/src/session.rs` · `a_inv_09c_undo_restores_deleted_block_and_text`              | unit | Insert+TextEdit → Delete → undo → 块与文本恢复                                                    |
| 辅                 | `session.rs` · `undo_persist_fail_rolls_back_stack_and_state`                                            | unit | undo persist 失败回滚栈与内存态                                                                   |

**redo**：本波 **未交付**（`DocSession::undo` 文档标注）。

**禁止**：用 reheat 测、Origin 枚举 alone、注释「便于后续」交差。reheat 测名须保持 `a_mem_reheat_*`。

---

## 3. 仍挂红的相关项（本闸不扩 scope）

| 表象                | 状态             | 备注                   |
| ------------------- | ---------------- | ---------------------- |
| Loro 对照 oracle    | 🟨 W0-L 已绿子集 | 满对照另见 `08`        |
| dual peer JSON 重放 | 骨架可           | 禁关 W6-D 满语义       |
| EL-04 全表          | **未关闭**       | A-COL-04 绿 ≠ EL-04 关 |

---

## 4. 检索门（防再冒充）

```text
rg "A_MEM_04|a_mem_04|A_COL_04|a_col_04" crates/conex-doc-collab
```

期望：仅真语义常量 / 真 undo 测名命中；`a_mem_reheat_*` 注释仍可写「≠ A-MEM-04」。

---

_2026-08-11 伪完成清理（方案 B）：撤锚 + 改名 + 会计登记。_  
_2026-08-11 W1-U Strict：真 Undo v1；A-MEM-04 / A-COL-04 / A-INV-09c 后半测绿；**EL 表 A 仍全未关**。_

---

## 5. G-HYD-5 / A-SURF-06 挡关（LR-H4-B · 选项 B · 2026-08-13）

> 权威：`audit/2026-08-13-launch-gap/00` §4 行 5；`01` LR-04 **选项 B**；`plans/09` §1.3 G-HYD-5。  
> 本段 **只追加诚实句**。**≠** 假装 intent 已落盘；**≠** 关 EL；**≠** 改表 A 关闭列。本波 **不做** H4-A 落盘。

| ID / 锁       | 写死口径                                                          | 证据（源码形状）                                                               | 会计                                  |
| ------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| **G-HYD-5**   | intent 幂等 **仅进程内**；杀进程 / 重开 `workspace.db` **可双插** | `store_backend.rs` `intents: Mutex<HashMap<…>>`；`store_apply_md.rs` 读/写该表 | 文档声明已交（选项 B）；**未** 持久化 |
| **A-SURF-06** | **挡关**                                                          | 不得用进程内 `send_intent_idempotent_no_double_insert` / `x01_*` 幂等关本断言  | **未关**                              |
| 产品 / 工具   | **禁止**宣称跨会话「不双插 / 不丢 intent」                        | —                                                                              | 违反即虚标                            |

**可引用验收句（选项 B）**：`StoreNoteBackend.intents` 是进程内 HashMap，**不**随 `workspace.db` 复活。同 `intent_id` 二次调用仅在**同一进程、同一后端实例**内返回 `idempotent=true` / `inserted=0`。杀进程、丢 session、重开库后再 apply **可以双插**。A-SURF-06 因此 **挡关**。进程内绿 **≠** 跨会话不双插 / 不丢 intent。

**禁止**：

- 用 `send_intent_idempotent_*` 关 A-SURF-06
- 把本段写成「已落盘 / 跨进程幂等已交」
- 改 `EL-dashboard.md` 表 A 关闭列
- 产品 UI / 工具文案写跨会话「不双插 / 不丢 intent」

_2026-08-13 · LR-H4-B：诚实声明挡关；intent **未**落盘；EL 表 A 仍全未关。_
