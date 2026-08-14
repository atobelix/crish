# R3-00 桌面侧全量验证记录（R1/R3 桌面全量验证）

> 战役：多端互通（R1 桌面服务端）+ 推送（R3）
> 验证日期：2026-08-14
> 验证类型：桌面侧全量测试状态（bin 面 + lib 面 + 集成面 + workspace）
> 验证基线：R3-03b 实测 lib 192/192 已绿；bin 面长期被并行阵营阻塞（computer/note/bg 域）
> 执行纪律：**只运行测试与记录，未修改任何源码/测试文件**；并行阵营文件零触碰。
> 权威命令说明：任务书 `cargo check -p crish-agent-workbench --bin` 语法不完整（`--bin` 需目标名），实测使用 `cargo check -p crish-agent-workbench --bin crish-agent-workbench`。

---

## 0. 结论摘要

| 面             | 命令                                                               | 结果                      | 说明                                                                                                                 |
| -------------- | ------------------------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| lib 面         | `cargo test -p crish-agent-workbench --lib`                        | ✅ **绿 192/192**         | R3-01 决策面 + R3-03 vendor 全绿；R3-02 关联（core_event_bridge/wait_channel）绿                                     |
| bin 面         | `cargo check -p crish-agent-workbench --bin crish-agent-workbench` | ❌ **红/阻塞 43–52 错误** | computer 模块已出现（并行阵营落地中，验证期间错误数持续变化 52→46→44→43）；R1 server 自身 7 个错误 + 并行阵营 5 个域 |
| bin 测试       | `cargo test ... --bin`（阻塞未跑）                                 | ❌ **不可运行**           | bin 编译失败 → R1 server 59 个内联测试全部无法运行                                                                   |
| 集成面         | `cargo test -p crish-agent-workbench --test server_integration`    | ❌ **红/阻塞**            | server 未登记入 lib（`crish_agent_workbench::server` 不存在）+ bin 连带编译失败                                      |
| 集成面（其余） | `--test event_bridge_contract` 等                                  | ❌ **红/阻塞**            | `#[path]` 独立编译也被 cargo 连带构建 bin 单元测试目标拦死                                                           |
| workspace      | `cargo check --workspace --keep-going`                             | ⚠️ **部分绿**             | 唯一失败成员 crish-agent-workbench（bin）；其余 23 个成员无错误（关键 crate 单独复核全过）                           |

**一句话结论**：R3 可验收面（lib 192/192，含 R3-01 全量 + R3-03 vendor 全量）已真实跑绿；R1 全链（server/pairing/router/ws 等 59 内联测试 + server_integration 集成契约）仍被 bin 编译面整体阻塞——阻塞源 = R1 server 自身 7 个编译错误 + 并行阵营正在重构的 computer/note/bg/run 域。

---

## 1. lib 面（✅ 绿 192/192）

**命令**：`cargo test -p crish-agent-workbench --lib`

**结果**：`test result: ok. 192 passed; 0 failed; 0 ignored; finished in 2.06s`

**模块覆盖**（lib.rs 仅登记 3 个模块：`core_event_bridge` / `push` / `wait_channel`，实测 192 全部来自这三者）：

| 模块                                                                              | 测试数 | 说明                                                                           |
| --------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| push::intent                                                                      | 24     | R3-01 S1~S12 场景决策 + S8e 矩阵（kill-source/timeout/force 注入）             |
| push::engine                                                                      | 20     | 场景归并 / 去重 / 静默 / 节流 / 跨午夜夜报折叠 / SQLite 去重后端               |
| push::coalesce                                                                    | 13     | 合批（approval/cron/run-terminal/subagent）                                    |
| push::dedupe                                                                      | 7      | TTL 去重 + SQLite 持久化                                                       |
| push::quiet                                                                       | 10     | 静默窗口跨午夜 / 时区偏移                                                      |
| push::throttle                                                                    | 6      | 每设备/每会话/每分钟配额                                                       |
| push::online                                                                      | 6      | 30s 在线窗 / 时钟回拨                                                          |
| push::pusher                                                                      | 17     | 直推 / 离线 pending / 重放抑制 / 序单调                                        |
| push::scenes / schema                                                             | 3 + 16 | Z0-7.4 场景类与 M8 18 行登记对齐 / wire 序列化                                 |
| push::vendor（apns/apns_sender/hms/hms_sender/consumer/credentials/test_support） | 30+    | R3-03 厂商通道：APNs JWT/403 重签/429/410、HMS OAuth 缓存/401 刷新、消费批路由 |
| wait_channel                                                                      | 11     | 子代理等待通道（等待终态/超时/落库恢复）                                       |
| core_event_bridge                                                                 | 4      | 事件发射契约（fanout 路由/信封平铺/serialize 对齐）                            |

**警告**：6 个 unused-import（`src/push/vendor/mod.rs:60-78`，R3-03 收尾遗留，不影响测试）。

**结论**：R3-01（推送决策面）+ R3-03（厂商通道）lib 面**可验收**；与 R3-03b 基线 192/192 一致。

---

## 2. bin 面（❌ 红/阻塞）

**命令**：`cargo check -p crish-agent-workbench --bin crish-agent-workbench`

**结果**：编译失败。验证期间错误数**持续变化**（并行阵营正在落地 computer 域）：

- 第 1 次（bin check）：**52 错误**，含 `E0583: file not found for module computer / computer_commands`（main.rs:44-45）
- 第 2 次（集成面连带）：**46 错误**——`src/computer/mod.rs` 与 `src/computer_commands.rs` **已出现**（E0583 消失，转为自身编译错误 E0609/E0631）
- 第 3 次（workspace keep-going）：**46 错误**
- 第 4、5 次（--test 连带）：**44 → 43 错误**（computer 面错误仍在增减：新增 E0004 non-exhaustive match，E0631 3→1）

> ⚠️ 工作区为活跃战场：`computer/` 目录在验证过程中从"缺失"变为"存在但自身报错"。本记录为**验证时刻快照**，以最后一次（43 错误）稳定分类为准。

### 2.1 错误分类（最近一次 43 错误）

| 类别               | 数量      | 位置                                                                                                               | 根因                                                                                                                                                                   |
| ------------------ | --------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E0432 未解析导入   | 3         | `server/backend.rs:29`、`server/core_backend.rs:25`、`server/router.rs:55`                                         | `conex_types::device::SettingsConfirm*` 已移至 `device::commands::*`，R1 server 侧 import 未跟随（**R1 自身错误**）                                                    |
| E0061 参数个数     | 6         | `run/run_core.rs:1052,1071`、`run/run_launch.rs:358,1137`、`run/run_snapshot.rs:303`、`server/core_backend.rs:463` | orchestrator API 漂移：`query_events` 增第 3 参 `Option<u64>`（persist.rs:179）、`EventQueue::new` 增 `run_id`（events.rs:106）——引擎侧先改，bin 侧未跟随              |
| E0599+E0282        | 4+4       | `bg_commands.rs:97,107,143,155`                                                                                    | `BackgroundTaskManager` trait 未导入（并行阵营 bg 域重构中）                                                                                                           |
| E0425 函数未找到   | 4         | `bg_log.rs:413,427,430,505`                                                                                        | `file_info`/`read_chunk` 缺失导入（应为 `crate::perf::fs::*`）                                                                                                         |
| E0433 符号未解析   | 11+2      | `main.rs:138,290-303`（note 7 + computer 4 命令）、`bg_task.rs:48`（Ordering）、`bg_writer.rs:326`（PathBuf）      | note 命令已拆至 note_commands_apply/hydrate 但 re-export 未生效（note_commands.rs:84-89 为私有 use，`__cmd__*` 未导出）；computer 命令引用尚不存在；bg 缺原子/路径导入 |
| E0119 冲突实现     | 1         | `bg_task.rs:37` vs `bg_kill.rs:20`                                                                                 | `BackgroundTaskRegistry` 对 `BackgroundTaskManager` 重复 impl                                                                                                          |
| E0631 map_err 签名 | 1（曾 3） | `computer_commands.rs:62`                                                                                          | `ComputerError::as_command_err(&self)` 与 `map_err` 期望 `fn(ComputerError)` 不匹配（**并行阵营新写文件自身错误**）                                                    |
| E0609 字段不存在   | 1         | `computer/mod.rs:283`                                                                                              | `ActivationError` 无 `current` 字段                                                                                                                                    |
| E0004 非穷尽 match | 1         | `computer/mod.rs:288`                                                                                              | `EnablementError::NotEnabled` 未覆盖                                                                                                                                   |
| E0560 字段不存在   | 1         | `run/run_resume.rs:438`                                                                                            | `SubagentSpawnRequest.timeout_ms` 已被并行阵营删除（LK 子代理链路收口）                                                                                                |
| E0308 类型不匹配   | 1         | `server/core_backend.rs:939`                                                                                       | `pause_for(u32)` vs `u64`                                                                                                                                              |
| E0716 临时值借用   | 2         | `server/core_backend.rs:142,172`                                                                                   | `root.replace(...).trim_*` 链需 let 绑定                                                                                                                               |

### 2.2 按归属域汇总

| 域                                              | 错误数                                      | 归属                                                                                                |
| ----------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **R1 server**（backend/core_backend/router）    | **7**（E0432×3、E0061×1、E0308×1、E0716×2） | R1 交付侧自身——conex-types `commands::` 结构调整未跟随 + orchestrator API 漂移未跟随 + 2 个借用错误 |
| run 装配面（run_core/launch/snapshot/resume）   | 6                                           | 引擎侧（orchestrator 恢复域）API 变化未同步，非 R1/R3 交付域                                        |
| bg 面（bg_task/kill/log/writer/commands）       | 15                                          | 并行阵营 background 重构中（冲突 impl、缺导入）                                                     |
| note 面（main.rs 7 命令引用）                   | 7                                           | 并行阵营 note 命令拆分中（re-export 未完成）                                                        |
| computer 面（computer/mod + computer_commands） | 4–7                                         | 并行阵营 computer 域**新写中**（验证期间文件才落盘，自身有编译错）                                  |

**结论**：bin 面**未解除阻塞**。computer 文件缺失已解除（文件已存在），但 computer 自身 + note/bg/run/server 共 43 个错误仍阻塞整个 bin 目标。

---

## 3. 集成面（❌ 红/阻塞）

### 3.1 `--test server_integration`（R1-11 集成契约，任务书指定）

**命令**：`cargo test -p crish-agent-workbench --test server_integration`

**结果**：编译失败。

失败清单（该测试自身 4 个错误，均为**模块登记缺口**）：

- `tests/server_integration.rs:44` E0433：`could not find server in crish_agent_workbench`
- `tests/server_integration.rs:45` E0433：同上（pairing）
- `tests/server_integration.rs:46` E0433 + E0432：同上

**根因**：`src/lib.rs` 仅登记 3 个模块（`core_event_bridge`/`push`/`wait_channel`），**`server` 模块未登记进 lib**（server 全部模块只在 bin 侧 main.rs 声明）。外部集成测试无法消费 `crish_agent_workbench::server::*`。此为 R1 交付侧 T-CF-10 装配收口的登记缺口。

连带：cargo 构建集合包含 bin 单元测试目标 → bin 的 43 个错误一并阻塞。

### 3.2 `--test event_bridge_contract` / `config_command_names_contract`

**结果**：同样失败（bin 连带编译，43 错误）。`event_bridge_contract` 本可 `#[path]` 独立编译（src/core_event_bridge.rs），但 cargo test 构建集合连带 bin unittests，被 bin 编译失败拦死。

### 3.3 R1 server 内联测试存量（被阻塞，未运行）

server 模块 6 个文件共 **59 个内联测试**全部在 bin 目标内，bin 不编译则全部不可运行：

| 文件              | 内联测试数 |
| ----------------- | ---------- |
| server/ws.rs      | 10         |
| server/router.rs  | 6          |
| server/pairing.rs | 12         |
| server/pair.rs    | 11         |
| server/fanout.rs  | 15         |
| server/gateway.rs | 5          |
| **合计**          | **59**     |

---

## 4. workspace 面（⚠️ 部分绿）

**命令**：`cargo check --workspace`（默认：在第一个失败成员中止）→ `cargo check --workspace --keep-going`（继续其余成员）

**结果**（keep-going）：

- ❌ `crish-agent-workbench`（bin）：43–46 错误（同 §2）
- ✅ **其余 23 个成员全部通过**（无任何 error 输出；关键依赖已缓存 fresh）
- 关键 crate 单独复核（`cargo check -p conex-types -p orchestrator -p session-loop -p agent-provider -p conex-computer`）：**Finished 全绿**（15.84s）
  - 背景提到的「orchestrator 恢复域 / computer 模块缺失」crate 级阻塞**已不存在**（crate 本身编译通过；阻塞转移到了 workbench bin 侧装配域）

---

## 5. 与 R1/R3 任务包对应关系

| 任务包                                                                                            | 内容                                      | 验证状态                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R3-01**（推送决策面：intent/engine/coalesce/dedupe/quiet/throttle/online/pusher/scenes/schema） | lib 面 99+ 测试                           | ✅ **可验收**（192/192 全绿的一部分）                                                                                                                                        |
| **R3-02**（WS 直推装配：push_wiring / WsRegistry presence / events.push 接线）                    | 在 bin 侧（main.rs 装配）                 | ❌ 被 bin 阻塞；lib 侧关联（pusher/pusher emitter/online）已绿                                                                                                               |
| **R3-03**（厂商通道：APNs JWT+403 重签 / HMS OAuth+401 刷新 / consumer 批路由）                   | lib 面 30+ vendor 测试                    | ✅ **可验收**（全绿；仅剩 unused-import 警告）                                                                                                                               |
| **R3-03b**（vendor senders 落地）                                                                 | 同上                                      | ✅ 与基线 192/192 一致                                                                                                                                                       |
| **R1 全链**（server：auth/pair/pairing/router/ws/backend/fanout/gateway/limiter/config）          | 59 内联测试 + server_integration 集成契约 | ❌ **全部被阻塞**——R1 自身 7 个编译错误（conex-types `commands::` 未跟随 ×3、query_events 漂移 ×1、pause_for ×1、借用 ×2）+ server 未入 lib（集成面 4 错）+ bin 整体 43 错误 |
| 并行阵营域（computer/note/bg/run）                                                                | 未提交工作区                              | ⚠️ 阻塞 bin；computer 文件验证期间才落盘，自身仍有编译错                                                                                                                     |

---

## 6. 建议：阻塞解除后需补跑的命令清单

按依赖顺序（阻塞源 = §2.2 的 5 个域 + server 入 lib 登记）：

```bash
# 1) bin 面编译恢复（前置门禁）
cargo check -p crish-agent-workbench --bin crish-agent-workbench

# 2) R1 全量 bin 测试（server/pairing/router/ws 等 59 内联测试 + 全部 bin 单元测试）
cargo test -p crish-agent-workbench --bin

# 3) 集成面：R1-11 集成契约（server_integration——需先修复 §3.1 模块登记缺口：
#    lib.rs 登记 server 模块，或将该测试改为 bin 内联/#[path] 方式）
cargo test -p crish-agent-workbench --test server_integration

# 4) 其余集成测试（event_bridge_contract / config_command_names_contract）
cargo test -p crish-agent-workbench --test event_bridge_contract --test config_command_names_contract

# 5) lib 回归（防 R3-01/R3-03 回归）
cargo test -p crish-agent-workbench --lib

# 6) workspace 全量
cargo check --workspace --keep-going
cargo test --workspace
```

**阻塞面修复归属建议**：

- R1 交付侧（本战役）：server 3 文件 import 修正（`conex_types::device::commands::*`）、core_backend 3 处（query_events 第 3 参、pause_for 类型、2 处借用）、lib.rs 登记 server 模块；
- 并行阵营侧（不触碰）：note re-export（note_commands.rs:84-89 改 `pub use`）、bg 冲突 impl/导入、computer 自身 4 错、run 面 orchestrator 漂移 6 处。

---

## 7. 验证环境与纪律声明

- 平台：Windows；命令统一经 **pwsh 7** 执行；日志留存：`%TEMP%\opencode\r3-*.log`
- 工作区状态：大量未提交改动（并行阵营活跃，git status 40+ 文件）；验证期间 computer/ 文件由并行阵营落盘（本验证零写入源码）
- **零修改声明**：本任务未修改任何源文件/测试文件/Cargo 文件；仅产出本文档（docs 域）
- 编码：本文档中文 UTF-8 无 BOM
