# 06 · SR-05 background 拆分补验记录

- 战役：2026-08-13-wave · 轮 6 · 单元 SR-05 补验
- 任务：background.rs 拆分（5188→129 门面 + 7 模 + 测试外置）真跑补验
- 模式：纯只读验证（background*.rs 文件域锁）+ 补验记录产出；未改任何代码、未做 git 操作
- 日期：2026-08-13
- 结论摘要：**cargo check/test 仍被并行域 orchestrator 半拆状态阻断（非本单元阻塞，已记录错误归属）；同时静态核验发现本单元存在测试旁挂文件缺失缺口（4/5 旁挂未落盘），需上报主控裁决**。

---

## 1. 验证命令与真实结果

### 1.1 cargo check -p crish-agent-workbench → **未通过（被并行域阻断）**

```
Checking orchestrator v0.1.0 (C:\Software\conex\crates\orchestrator)
error[E0583]: file not found for module `restore_manager`
error[E0583]: file not found for module `restore_snapshot`
error[E0425]: cannot find type `SessionRecord` in this scope
  --> crates\orchestrator\src\restore.rs:109:23
warning: unused import: `RunStatus`
  --> crates\orchestrator\src\restore.rs:35:30
error: could not compile `orchestrator` (lib) due to 3 previous errors; 1 warning emitted
```

**阻塞归属（非本单元）**：错误全部位于 `crates/orchestrator/src/restore.rs`（并行域 orchestrator 半拆残留，`restore.rs` 引用尚未落盘的 `restore_manager` / `restore_snapshot` 子模块，且 `SessionRecord` 未定义）。workbench 本体尚未进入编译阶段，background 相关代码未被检查到。

### 1.2 cargo test -p crish-agent-workbench → **无法真跑（依赖编译失败前置阻断）**

依赖链上 orchestrator 编译失败，测试目标无法进入。background 测试未能执行。

### 1.3 行数复核 → **通过（静态）**

- `background.rs` 实测 **129 行**（直接读取，与任务预期 129 一致）；
- `node scripts/check-crate-size.mjs`：未报告 background.rs 超限（129 < 600 限额，不进入超限名单），符合预期；check-crate-size 脚本整体 FAIL 项为 `subagent_spawner.rs 1656 行`（非本单元，未登记豁免）。

### 1.4 接线核验（静态）→ **部分缺口**

| 项                                                                                                                  | 结果                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.rs:33` `mod background;`                                                                                      | ✅ 存在                                                                                                                                                                                                                                                                                         |
| background.rs 内 7 个模块声明（`mod bg_commands/bg_events/bg_kill/bg_log/bg_registry/bg_task/bg_writer`，行 78-84） | ✅ 齐全                                                                                                                                                                                                                                                                                         |
| 7 个 bg_*.rs 实体文件                                                                                               | ✅ 全部存在（bg_commands 7258B / bg_events 19045B / bg_kill 13204B / bg_log 22741B / bg_registry 26229B / bg_task 16730B / bg_writer 13509B）                                                                                                                                                   |
| re-export 门面（background.rs 行 100-109）                                                                          | ✅ 存在                                                                                                                                                                                                                                                                                         |
| **测试旁挂 5 文件**                                                                                                 | ❌ **仅 1/5 落盘**：`background_tests.rs`（530 行）存在；`background_tests_log.rs` / `background_tests_kill.rs` / `background_tests_resource.rs` / `background_tests_events.rs` **不存在**（git ls-files、git log --all 均无任何记录，提交 fdb512d4 只新增了 background_tests.rs 一个测试文件） |

### 1.5 测试用例数核验（静态）→ **重大缺口**

- 拆分前（fdb512d4^）：原 background.rs 内 `#[tokio::test]` **40 个**（点名清单见 §2）；
- 拆分后：background_tests.rs 内 `#[tokio::test]` **仅 8 个**；
- 7 个 bg_*.rs 模块内测试：**0 个**；
- 全仓库搜索 32 个缺失测试名（`log_*` / `send_input_*` / `kill_*` / `retention_*` / `resource_*` / `health_*` / `task_seven_*` / `list_wire_*` / `suspicious_*` / `workbench_send_input_contract` 等）：**全部无定义**。

**结论**：声称「测试 5 旁挂 46 用例零删除」，实际仅 8 用例 + 1 旁挂落盘；32 个测试用例（约对应 log/kill/resource/events 四个域）在提交 fdb512d4 后全库不存在——**疑似丢失，需上报主控**（恢复源：`git show fdb512d4^:apps/agent-workbench/src-tauri/src/background.rs` 尾部 40 个测试用例完整可捞）。

---

## 2. 点名测试（现状可核验的 8 个）

background_tests.rs（background.rs:111-113 `#[path = "background_tests.rs"] mod tests;` 接线）：

| #   | 测试名                                        | 归属域     |
| --- | --------------------------------------------- | ---------- |
| 1   | registry_adopt_and_list                       | 注册表契约 |
| 2   | registry_no_entry_on_sync_complete            | 注册表契约 |
| 3   | registry_state_machine                        | 注册表契约 |
| 4   | task_ids_are_unique_and_prefixed              | 注册表契约 |
| 5   | registry_methods_error_contract               | 注册表契约 |
| 6   | workbench_list_background_tasks_contract      | 命令面契约 |
| 7   | workbench_get_background_task_output_contract | 命令面契约 |
| 8   | workbench_cancel_background_task_contract     | 命令面契约 |

**未能真跑**（orchestrator 依赖编译阻断）。且 background.rs 行 115-129 另声明了 4 个 `#[cfg(test)] #[path]` 模块（tests_log / tests_kill / tests_resource / tests_events）指向不存在的文件——即使 orchestrator 修复，**cargo test 编译必然失败（E0583 file not found for module）**，除非补齐 4 个旁挂文件或删除死引用。

---

## 3. 阻塞归属汇总

| 阻塞                                                  | 归属                                                       | 性质                                            |
| ----------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| cargo check 3 错（E0583 ×2 + E0425 ×1）               | `crates/orchestrator/src/restore.rs`                       | **非本单元**（并行域 orchestrator 半拆残留）    |
| cargo test 无法运行                                   | 同上（依赖链前置失败）                                     | **非本单元**                                    |
| 测试旁挂 4 文件缺失（tests_log/kill/resource/events） | `apps/agent-workbench/src-tauri/src/background.rs:115-129` | **本单元缺口**（SR-05 拆分未落全）              |
| 32 个测试用例全库无定义                               | 同上                                                       | **本单元缺口**（疑似丢失，可自 fdb512d4^ 恢复） |

---

## 4. 建议（供主控裁决，非本 Agent 执行）

1. orchestrator 半拆残留（restore_manager / restore_snapshot / SessionRecord）由对应并行域收口后，重跑本补验；
2. SR-05 需补齐 background_tests_log/kill/resource/events.rs 四个旁挂（自 `fdb512d4^` 的原 background.rs 尾部 40 用例按域搬移），否则 cargo test 编译必失败；
3. 补齐后复跑 `cargo check -p crish-agent-workbench` + `cargo test -p crish-agent-workbench` 点名 40 用例全绿，本补验才算闭环。

---

## 5. 产出

- 本记录：`docs/review-md-audit/2026-08-13-wave/execution/06-SR05-background补验.md`
- 未改任何业务代码；未做 git 操作。
